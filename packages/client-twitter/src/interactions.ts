import { SearchMode, Tweet } from "agent-twitter-client";
import {
    composeContext,
    generateMessageResponse,
    generateShouldRespond,
    messageCompletionFooter,
    shouldRespondFooter,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
    stringToUuid,
    elizaLogger,
    getEmbeddingZeroVector,
} from "@elizaos/core";
import { ClientBase } from "./base";
import { buildConversationThread, sendTweet, wait } from "./utils.ts";
import path from "path";
import fs from "fs";
import { promises as fsPromises } from 'fs';

const __dirname = path.resolve();

export const twitterMessageHandlerTemplate =
    `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

{{recentPosts}}

# TASK: Generate a post/reply in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}) while using the thread of tweets as additional context. Do NOT @ the user in your response:

Current Post:
{{currentPost}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Generate a post in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}). You MUST include an action if the current post text includes a prompt that is similar to one of the available actions mentioned here:
{{actionNames}}
{{actions}}

Here is the current post text again. Remember to include an action if the current post text includes a prompt that asks for one of the available actions mentioned above (does not need to be exact)
{{currentPost}}
` + messageCompletionFooter;

export const twitterShouldRespondTemplate = (targetUsersStr: string) =>
    `# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation. Do not comment. Just respond with "true" or "false".

Response options are RESPOND, IGNORE and STOP.

PRIORITY RULE: ALWAYS RESPOND to these users regardless of topic or message content: ${targetUsersStr}. Topic relevance should be ignored for these users.

For other users:
- {{agentName}} should RESPOND to messages directed at them
- {{agentName}} should RESPOND to conversations relevant to their background
- {{agentName}} should IGNORE irrelevant messages
- {{agentName}} should IGNORE very short messages unless directly addressed
- {{agentName}} should STOP if asked to stop
- {{agentName}} should STOP if conversation is concluded
- {{agentName}} is in a room with other users and wants to be conversational, but not annoying.

IMPORTANT:
- {{agentName}} (aka @{{twitterUserName}}) is particularly sensitive about being annoying, so if there is any doubt, it is better to IGNORE than to RESPOND.
- For users not in the priority list, {{agentName}} (@{{twitterUserName}}) should err on the side of IGNORE rather than RESPOND if in doubt.

Recent Posts:
{{recentPosts}}

Current Post:
{{currentPost}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Respond with [RESPOND] if {{agentName}} should respond, or [IGNORE] if {{agentName}} should not respond to the last message and [STOP] if {{agentName}} should stop participating in the conversation.
` + shouldRespondFooter;

export class TwitterInteractionClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    private homeTimelineCacheFilePath = __dirname + "/tweetcache/latest_home_timeline_id.txt";
    private interactionCacheFilePath = __dirname + "/tweetcache/latest_interaction_id.txt";
    private lastCheckedHomeTimelineId: string | null = null;
    private lastCheckedInteractionId: string | null = null;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;

        try {
            if (fs.existsSync(this.homeTimelineCacheFilePath)) {
                const data = fs.readFileSync(this.homeTimelineCacheFilePath, "utf-8");
                this.lastCheckedHomeTimelineId = data.trim();
            }
        } catch (error) {
            console.error("Error loading latest home timeline tweet ID:", error);
        }

        try {
            if (fs.existsSync(this.interactionCacheFilePath)) {
                const data = fs.readFileSync(this.interactionCacheFilePath, "utf-8");
                this.lastCheckedInteractionId = data.trim();
            }
        } catch (error) {
            console.error("Error loading latest interaction tweet ID:", error);
        }

        const dir = path.dirname(this.homeTimelineCacheFilePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    async start() {
        const handleTwitterInteractionsLoop = () => {
            this.handleTwitterInteractions();
            setTimeout(
                handleTwitterInteractionsLoop,
                // Defaults to 2 minutes
                this.client.twitterConfig.TWITTER_POLL_INTERVAL * 1000
            );
        };
        handleTwitterInteractionsLoop();

        const handleHomeTimelineInteractionsLoop = () => {
            this.handleHomeTimelineInteractions();
            setTimeout(
                handleHomeTimelineInteractionsLoop,
                // Defaults to 2 minutes
                this.client.twitterConfig.TWITTER_POLL_INTERVAL * 1000
            );
        };
        handleHomeTimelineInteractionsLoop();
    }

    async handleTwitterInteractions() {
        elizaLogger.log("Checking Twitter interactions");

        const twitterUsername = this.client.profile.username;
        try {
            // Check for mentions
            const mentionCandidates = (
                await this.client.fetchSearchTweets(
                    `@${twitterUsername}`,
                    20,
                    SearchMode.Latest
                )
            ).tweets;

            elizaLogger.log(
                "Completed checking mentioned tweets:",
                mentionCandidates.length
            );
            let uniqueTweetCandidates = [...mentionCandidates];
            // Only process target users if configured
            if (this.client.twitterConfig.TWITTER_TARGET_USERS.length) {
                const TARGET_USERS = this.client.twitterConfig.TWITTER_TARGET_USERS;

                elizaLogger.log("Processing target users:", TARGET_USERS);

                if (TARGET_USERS.length > 0) {
                    // Create a map to store tweets by user
                    const tweetsByUser = new Map<string, Tweet[]>();

                    // Fetch tweets from all target users
                    for (const username of TARGET_USERS) {
                        try {
                            const userTweets = (
                                await this.client.twitterClient.fetchSearchTweets(
                                    `from:${username}`,
                                    3,
                                    SearchMode.Latest
                                )
                            ).tweets;

                            // Filter for unprocessed, non-reply, recent tweets
                            const validTweets = userTweets.filter((tweet) => {
                                const isUnprocessed =
                                    !this.client.lastCheckedTweetId ||
                                    parseInt(tweet.id) >
                                        this.client.lastCheckedTweetId;
                                const isRecent =
                                    Date.now() - tweet.timestamp * 1000 <
                                    2 * 60 * 60 * 1000;

                                elizaLogger.log(`Tweet ${tweet.id} checks:`, {
                                    isUnprocessed,
                                    isRecent,
                                    isReply: tweet.isReply,
                                    isRetweet: tweet.isRetweet,
                                });

                                return (
                                    isUnprocessed &&
                                    !tweet.isReply &&
                                    !tweet.isRetweet &&
                                    isRecent
                                );
                            });

                            if (validTweets.length > 0) {
                                tweetsByUser.set(username, validTweets);
                                elizaLogger.log(
                                    `Found ${validTweets.length} valid tweets from ${username}`
                                );
                            }
                        } catch (error) {
                            elizaLogger.error(
                                `Error fetching tweets for ${username}:`,
                                error
                            );
                            continue;
                        }
                    }

                    // Select one tweet from each user that has tweets
                    const selectedTweets: Tweet[] = [];
                    for (const [username, tweets] of tweetsByUser) {
                        if (tweets.length > 0) {
                            // Randomly select one tweet from this user
                            const randomTweet =
                                tweets[
                                    Math.floor(Math.random() * tweets.length)
                                ];
                            selectedTweets.push(randomTweet);
                            elizaLogger.log(
                                `Selected tweet from ${username}: ${randomTweet.text?.substring(0, 100)}`
                            );
                        }
                    }

                    // Add selected tweets to candidates
                    uniqueTweetCandidates = [
                        ...mentionCandidates,
                        ...selectedTweets,
                    ];
                }
            } else {
                elizaLogger.log(
                    "No target users configured, processing only mentions"
                );
            }

            // Sort tweet candidates by ID in ascending order
            uniqueTweetCandidates
                .sort((a, b) => a.id.localeCompare(b.id))
                .filter((tweet) => tweet.userId !== this.client.profile.id);

            // for each tweet candidate, handle the tweet
            for (const tweet of uniqueTweetCandidates) {
                if (
                    !this.lastCheckedInteractionId ||
                    BigInt(tweet.id) > BigInt(this.lastCheckedInteractionId)
                ) {
                    elizaLogger.log("New Tweet found", tweet.permanentUrl);

                    const roomId = stringToUuid(
                        tweet.conversationId + "-" + this.runtime.agentId
                    );

                    const userIdUUID =
                        tweet.userId === this.client.profile.id
                            ? this.runtime.agentId
                            : stringToUuid(tweet.userId!);

                    await this.runtime.ensureConnection(
                        userIdUUID,
                        roomId,
                        tweet.username,
                        tweet.name,
                        "twitter"
                    );

                    const thread = await buildConversationThread(
                        tweet,
                        this.client
                    );

                    const message = {
                        content: { text: tweet.text },
                        agentId: this.runtime.agentId,
                        userId: userIdUUID,
                        roomId,
                    };

                    await this.handleTweet({
                        tweet,
                        message,
                        thread,
                    });

                    // Update the last checked tweet ID after processing each tweet
                    this.lastCheckedInteractionId = tweet.id;

                    try {
                        if (this.lastCheckedInteractionId) {
                            fs.writeFileSync(
                                this.interactionCacheFilePath,
                                this.lastCheckedInteractionId,
                                "utf-8"
                            );
                        }
                    } catch (error) {
                        elizaLogger.error(
                            "Error saving latest checked interaction tweet ID to file:",
                            error
                        );
                    }
                }
            }

            elizaLogger.log("Finished checking Twitter interactions");
        } catch (error) {
            elizaLogger.error("Error handling Twitter interactions:", error);
        }
    }

    async handleHomeTimelineInteractions() {
        elizaLogger.log("Checking home timeline interactions");
        try {
            // Fetch home timeline tweets
            const timelineTweets = await this.client.fetchHomeTimeline(20, true);

            // de-duplicate tweets with a set
            const uniqueTweets = [...new Set(timelineTweets)];

            // Filter out undefined/null tweets and sort by ID
            const sortedTweets = uniqueTweets
                .filter(tweet => tweet && tweet.id) // Remove any null/undefined tweets
                .sort((a, b) => a.id.localeCompare(b.id))
                .filter((tweet) => tweet.userId !== this.client.profile.id);

            // for each tweet, handle it if it's new
            for (const tweet of sortedTweets) {
                if (
                    !this.lastCheckedHomeTimelineId ||
                    BigInt(tweet.id) > BigInt(this.lastCheckedHomeTimelineId)
                ) {
                    const conversationId =
                        tweet.conversationId + "-" + this.runtime.agentId;

                    const roomId = stringToUuid(conversationId);

                    const userIdUUID = stringToUuid(tweet.userId as string);

                    await this.runtime.ensureConnection(
                        userIdUUID,
                        roomId,
                        tweet.username,
                        tweet.name,
                        "twitter"
                    );

                    const thread = await buildConversationThread(tweet, this.client);

                    const message = {
                        content: { text: tweet.text },
                        agentId: this.runtime.agentId,
                        userId: userIdUUID,
                        roomId,
                    };

                    await this.handleTweet({
                        tweet,
                        message,
                        thread,
                    });

                    this.lastCheckedHomeTimelineId = tweet.id;

                    try {
                        if (this.lastCheckedHomeTimelineId) {
                            fs.writeFileSync(
                                this.homeTimelineCacheFilePath,
                                this.lastCheckedHomeTimelineId,
                                "utf-8"
                            );
                        }
                    } catch (error) {
                        elizaLogger.error(
                            "Error saving latest checked home timeline tweet ID to file:",
                            error
                        );
                    }
                }
            }

            elizaLogger.log("Finished checking Twitter home timeline interactions");
        } catch (error) {
            elizaLogger.error("Error handling home timeline interactions", {
                message: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
                error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
            });

        }
    }


    private async handleTweet({
        tweet,
        message,
        thread,
    }: {
        tweet: Tweet;
        message: Memory;
        thread: Tweet[];
    }) {
        if (tweet.userId === this.client.profile.id) {
            // Skip processing if the tweet is from the bot itself
            return;
        }

        if (!message.content.text) {
            elizaLogger.log("Skipping Tweet with no text", tweet.id);
            return { text: "", action: "IGNORE" };
        }

        elizaLogger.log("Processing Tweet: ", tweet.id);
        const formatTweet = (tweet: Tweet) => {
            return `  ID: ${tweet.id}
  From: ${tweet.name} (@${tweet.username})
  Text: ${tweet.text}`;
        };
        const currentPost = formatTweet(tweet);

        elizaLogger.debug("Thread: ", thread);
        const formattedConversation = thread
            .map(
                (tweet) => `@${tweet.username} (${new Date(
                    tweet.timestamp * 1000
                ).toLocaleString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                    month: "short",
                    day: "numeric",
                })}):
        ${tweet.text}`
            )
            .join("\n\n");

        elizaLogger.debug("formattedConversation: ", formattedConversation);

        let state = await this.runtime.composeState(message, {
            twitterClient: this.client.twitterClient,
            twitterUserName: this.client.twitterConfig.TWITTER_USERNAME,
            username: tweet.username,
            tweetId: tweet.id,
            conversationId: tweet.conversationId,
            currentPost,
            formattedConversation,
        });

        // check if the tweet exists, save if it doesn't
        const tweetId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
        const tweetExists =
            await this.runtime.messageManager.getMemoryById(tweetId);

        if (!tweetExists) {
            elizaLogger.log("tweet does not exist, saving");
            const userIdUUID = stringToUuid(tweet.userId as string);
            const roomId = stringToUuid(tweet.conversationId);

            const message = {
                id: tweetId,
                agentId: this.runtime.agentId,
                content: {
                    text: tweet.text,
                    url: tweet.permanentUrl,
                    inReplyTo: tweet.inReplyToStatusId
                        ? stringToUuid(
                              tweet.inReplyToStatusId +
                                  "-" +
                                  this.runtime.agentId
                          )
                        : undefined,
                },
                userId: userIdUUID,
                roomId,
                createdAt: tweet.timestamp * 1000,
            };
            this.client.saveRequestMessage(message, state);
        }

        const context = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.twitterMessageHandlerTemplate ||
                this.runtime.character?.templates?.messageHandlerTemplate ||
                twitterMessageHandlerTemplate,
        });

        elizaLogger.debug("Interactions prompt:\n" + context);

        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        const removeQuotes = (str: string) =>
            str.replace(/^['"](.*)['"]$/, "$1");

        const stringId = stringToUuid(tweet.id + "-" + this.runtime.agentId);

        response.inReplyTo = stringId;

        response.text = removeQuotes(response.text);

        if (response.text) {
            try {
                let actionMessage: Content | null = null;

                const callback: HandlerCallback = async (response: Content) => {
                    actionMessage = response;
                    // Just store the message without sending tweet
                    return [];
                };

                state = (await this.runtime.updateRecentMessageState(
                    state
                )) as State;

                const responseMessage: Memory = {
                    id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                    agentId: this.runtime.agentId,
                    userId: this.runtime.agentId,
                    roomId: message.roomId,
                    content: response,
                    createdAt: Date.now(),
                };

                await this.runtime.messageManager.createMemory(responseMessage);

                // Check if we have an action
                const action = this.runtime.actions.find(
                    (a) => a.name === response.action
                );

                if (action) {
                    // Handle action-based response
                    await this.runtime.processActions(
                        message,
                        [responseMessage],
                        state,
                        callback
                    );

                    await this.runtime.evaluate(message, state);

                    const shouldSuppressInitialMessage = action?.suppressInitialMessage;

                    elizaLogger.log("Action:", action?.name);
                    elizaLogger.log("Should suppress initial message:", shouldSuppressInitialMessage);

                    if (!shouldSuppressInitialMessage) {
                        // Send initial response
                        await sendTweet(
                            this.client,
                            response,
                            message.roomId,
                            this.client.twitterConfig.TWITTER_USERNAME,
                            tweet.id
                        );
                    }

                    if (actionMessage) {
                        // Send action message
                        await sendTweet(
                            this.client,
                            actionMessage,
                            message.roomId,
                            this.client.twitterConfig.TWITTER_USERNAME,
                            tweet.id
                        );
                    }
                } else {
                    // No action found, fall back to regular tweet handling
                    // get usernames into str
                    const validTargetUsersStr = this.client.twitterConfig.TWITTER_TARGET_USERS.join(",");
                    state.actions = "";

                    const shouldRespondContext = composeContext({
                        state,
                        template:
                            this.runtime.character.templates
                                ?.twitterShouldRespondTemplate ||
                            this.runtime.character?.templates?.shouldRespondTemplate ||
                            twitterShouldRespondTemplate(validTargetUsersStr),
                    });

                    const shouldRespond = await generateShouldRespond({
                        runtime: this.runtime,
                        context: shouldRespondContext,
                        modelClass: ModelClass.MEDIUM,
                    });

                    if (shouldRespond !== "RESPOND") {
                        elizaLogger.log("Not responding to message");
                        return { text: "Response Decision:", action: shouldRespond };
                    }

                    // For regular responses, send tweet
                    const memories = await sendTweet(
                        this.client,
                        response,
                        message.roomId,
                        this.client.twitterConfig.TWITTER_USERNAME,
                        tweet.id
                    );

                    for (const memory of memories) {
                        if (memory === memories[memories.length - 1]) {
                            memory.content.action = response.action;
                        } else {
                            memory.content.action = "CONTINUE";
                        }
                        await this.runtime.messageManager.createMemory(memory);
                    }

                    await this.runtime.processActions(
                        message,
                        memories,
                        state,
                        callback
                    );
                }

                const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`;

                await this.runtime.cacheManager.set(
                    `twitter/tweet_generation_${tweet.id}.txt`,
                    responseInfo
                );

                await wait();
            } catch (error) {
                elizaLogger.error(`Error sending response tweet: ${error}`);
            }
        }
    }

    async buildConversationThread(
        tweet: Tweet,
        maxReplies: number = 10
    ): Promise<Tweet[]> {
        const thread: Tweet[] = [];
        const visited: Set<string> = new Set();

        async function processThread(currentTweet: Tweet, depth: number = 0) {
            elizaLogger.log("Processing tweet:", {
                id: currentTweet.id,
                inReplyToStatusId: currentTweet.inReplyToStatusId,
                depth: depth,
            });

            if (!currentTweet) {
                elizaLogger.log("No current tweet found for thread building");
                return;
            }

            if (depth >= maxReplies) {
                elizaLogger.log("Reached maximum reply depth", depth);
                return;
            }

            // Handle memory storage
            const memory = await this.runtime.messageManager.getMemoryById(
                stringToUuid(currentTweet.id + "-" + this.runtime.agentId)
            );
            if (!memory) {
                const roomId = stringToUuid(
                    currentTweet.conversationId + "-" + this.runtime.agentId
                );
                const userId = stringToUuid(currentTweet.userId);

                await this.runtime.ensureConnection(
                    userId,
                    roomId,
                    currentTweet.username,
                    currentTweet.name,
                    "twitter"
                );

                this.runtime.messageManager.createMemory({
                    id: stringToUuid(
                        currentTweet.id + "-" + this.runtime.agentId
                    ),
                    agentId: this.runtime.agentId,
                    content: {
                        text: currentTweet.text,
                        source: "twitter",
                        url: currentTweet.permanentUrl,
                        inReplyTo: currentTweet.inReplyToStatusId
                            ? stringToUuid(
                                  currentTweet.inReplyToStatusId +
                                      "-" +
                                      this.runtime.agentId
                              )
                            : undefined,
                    },
                    createdAt: currentTweet.timestamp * 1000,
                    roomId,
                    userId:
                        currentTweet.userId === this.twitterUserId
                            ? this.runtime.agentId
                            : stringToUuid(currentTweet.userId),
                    embedding: getEmbeddingZeroVector(),
                });
            }

            if (visited.has(currentTweet.id)) {
                elizaLogger.log("Already visited tweet:", currentTweet.id);
                return;
            }

            visited.add(currentTweet.id);
            thread.unshift(currentTweet);

            elizaLogger.debug("Current thread state:", {
                length: thread.length,
                currentDepth: depth,
                tweetId: currentTweet.id,
            });

            if (currentTweet.inReplyToStatusId) {
                elizaLogger.log(
                    "Fetching parent tweet:",
                    currentTweet.inReplyToStatusId
                );
                try {
                    const parentTweet = await this.twitterClient.getTweet(
                        currentTweet.inReplyToStatusId
                    );

                    if (parentTweet) {
                        elizaLogger.log("Found parent tweet:", {
                            id: parentTweet.id,
                            text: parentTweet.text?.slice(0, 50),
                        });
                        await processThread(parentTweet, depth + 1);
                    } else {
                        elizaLogger.log(
                            "No parent tweet found for:",
                            currentTweet.inReplyToStatusId
                        );
                    }
                } catch (error) {
                    elizaLogger.log("Error fetching parent tweet:", {
                        tweetId: currentTweet.inReplyToStatusId,
                        error,
                    });
                }
            } else {
                elizaLogger.log(
                    "Reached end of reply chain at:",
                    currentTweet.id
                );
            }
        }

        // Need to bind this context for the inner function
        await processThread.bind(this)(tweet, 0);

        elizaLogger.debug("Final thread built:", {
            totalTweets: thread.length,
            tweetIds: thread.map((t) => ({
                id: t.id,
                text: t.text?.slice(0, 50),
            })),
        });

        return thread;
    }
}
