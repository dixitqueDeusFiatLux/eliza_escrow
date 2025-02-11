import { IAgentRuntime, Memory, ModelClass, State, UUID, composeContext, elizaLogger, generateMessageResponse, getEmbeddingZeroVector, settings, stringToUuid } from "@elizaos/core";
import { TokenPollingService, PollingTask } from "@elizaos/plugin-solana";
import { Connection } from "@solana/web3.js";
import { getFormattedConversation, saveAllyInformation, saveNegotiationState, escrowCompleteTemplate } from "../utils";
import { Scraper, Tweet } from "agent-twitter-client";

export class NegotiationService {
    private static instance: NegotiationService;
    private pollingService: TokenPollingService;
    private runtime: IAgentRuntime;
    private scraper: Scraper;

    private constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
        const connection = new Connection(settings.RPC_URL, "confirmed");
        this.pollingService = TokenPollingService.getInstance(connection);
        this.scraper = new Scraper();
    }

    public static getInstance(runtime: IAgentRuntime): NegotiationService {
        if (!NegotiationService.instance) {
            NegotiationService.instance = new NegotiationService(runtime);
        }
        return NegotiationService.instance;
    }

    public async initialize(runtime: IAgentRuntime): Promise<void> {
        this.runtime = runtime;
        this.pollingService.setNegotiationHandler(this);
    }

    async getCachedCookies(username: string) {
        return await this.runtime.cacheManager.get<any[]>(
            `twitter/${username}/cookies`
        );
    }

    async cacheCookies(username: string, cookies: any[]) {
        await this.runtime.cacheManager.set(
            `twitter/${username}/cookies`,
            cookies
        );
    }

    async setCookiesFromArray(cookiesArray: any[]) {
        const cookieStrings = cookiesArray.map(
            (cookie) =>
                `${cookie.key}=${cookie.value}; Domain=${cookie.domain}; Path=${cookie.path}; ${
                    cookie.secure ? "Secure" : ""
                }; ${cookie.httpOnly ? "HttpOnly" : ""}; SameSite=${
                    cookie.sameSite || "Lax"
                }`
        );
        await this.scraper.setCookies(cookieStrings);
    }

    private async sendTweet(text: string, inReplyToId: string, roomId: UUID): Promise<Memory[] | false> {
        try {
            const username = process.env.TWITTER_USERNAME;
            const password = process.env.TWITTER_PASSWORD;
            const email = process.env.TWITTER_EMAIL;
            const twitter2faSecret = process.env.TWITTER_2FA_SECRET;

            if (!username || !password) {
                elizaLogger.error(
                    "Twitter credentials not configured in environment"
                );
                return false;
            }

            const cachedCookies = await this.getCachedCookies(username);

            if (cachedCookies) {
                elizaLogger.info("Using cached cookies");
                await this.setCookiesFromArray(cachedCookies);
            }

            elizaLogger.log("Waiting for Twitter login");
            try {
                if (await this.scraper.isLoggedIn()) { // cookies are valid, no login required
                    elizaLogger.info("Successfully logged in.");
                } else {
                    await this.scraper.login(
                        username,
                        password,
                        email,
                        twitter2faSecret
                    );
                    if (await this.scraper.isLoggedIn()) {  // fresh login, store new cookies
                        elizaLogger.info("Successfully logged in.");
                        elizaLogger.info("Caching cookies");
                        await this.cacheCookies(
                            username,
                            await this.scraper.getCookies()
                        );
                    }
                }
            } catch (error) {
                elizaLogger.error(`Login attempt failed: ${error.message}`);
            }

            // Login with credentials
            await this.scraper.login(username, password, email, twitter2faSecret);
            if (!(await this.scraper.isLoggedIn())) {
                elizaLogger.error("Failed to login to Twitter");
                return false;
            }

            // Send the tweet
            elizaLogger.log("Attempting to send tweet:", text);
            const result = await this.scraper.sendTweet(text, inReplyToId);

            const body = await result.json();
            elizaLogger.log("Tweet response:", body);

            // Check for Twitter API errors
            if (body.errors) {
                const error = body.errors[0];
                elizaLogger.error(
                    `Twitter API error (${error.code}): ${error.message}`
                );
                return false;
            }

            // Check for successful tweet creation
            if (!body?.data?.create_tweet?.tweet_results?.result) {
                elizaLogger.error(
                    "Failed to post tweet: No tweet result in response"
                );
                return false;
            }

            const tweetResult = body.data.create_tweet.tweet_results.result;

            const finalTweet: Tweet = {
                id: tweetResult.rest_id,
                text: tweetResult.legacy.full_text,
                conversationId: tweetResult.legacy.conversation_id_str,
                timestamp:
                    new Date(tweetResult.legacy.created_at).getTime() / 1000,
                userId: tweetResult.legacy.user_id_str,
                inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
                permanentUrl: `https://twitter.com/${username}/status/${tweetResult.rest_id}`,
                hashtags: [],
                mentions: [],
                photos: [],
                thread: [],
                urls: [],
                videos: [],
            };

            const memories: Memory[] = [{
                id: stringToUuid(finalTweet.id + "-" + this.runtime.agentId),
                agentId: this.runtime.agentId,
                userId: this.runtime.agentId,
                content: {
                    text: finalTweet.text,
                    source: "twitter",
                    url: finalTweet.permanentUrl,
                    inReplyTo: finalTweet.inReplyToStatusId
                        ? stringToUuid(
                            finalTweet.inReplyToStatusId + "-" + this.runtime.agentId
                        )
                        : undefined,
                },
                roomId: roomId,
                embedding: getEmbeddingZeroVector(),
                createdAt: finalTweet.timestamp * 1000,
            }];

            return memories;
        } catch (error) {
            elizaLogger.error("Error posting tweet:", {
                message: error.message,
                stack: error.stack,
                name: error.name,
                cause: error.cause,
            });
            return false;
        }
    }

    private async sendReply(tweet: Tweet, message: Memory, text: string, inReplyToId: string) {
        const memories = await this.sendTweet(
            text,
            inReplyToId,
            message.roomId,
        );

        if (memories) {
            for (const memory of memories) {
                await this.runtime.messageManager.createMemory(memory);
            }
            elizaLogger.log(`Sent reply to ${tweet.username}: ${text}`);
        } else {
            elizaLogger.error(`Failed to send reply to ${tweet.username}: ${text}`);
        }

    }

    public async notifyEscrowComplete(task: PollingTask): Promise<void> {
        await this.sendEscrowCompleteNotification(task);
    }

    private async sendEscrowCompleteNotification(task: PollingTask): Promise<void> {
        if (!task.tweet || !task.message) {
            elizaLogger.log('Missing tweet or message data for completed escrow task');
            return;
        }

        const formattedConversation = getFormattedConversation(task.thread as Tweet[]);

        const tradeMessage = `https://solscan.io/account/${task.escrow}\n\n`

        let state = await this.runtime.composeState(task.message as Memory, {});

        state.escrowCompletePostExamples = this.runtime.character.escrowCompletePostExamples;
        state.twitterUserName = settings.TWITTER_USERNAME;
        state.currentPost = task.tweet.text;
        state.formattedConversation = formattedConversation;
        state.username = task.tweet.username;
        state.escrowId = task.escrow;
        state.transactionComplete = true;
        state.actions = "";

        const context = composeContext({
            state: state,
            template: escrowCompleteTemplate
        });


        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.MEDIUM,
        });

        const fullResponse = tradeMessage + response.text;

        await this.sendReply(task.tweet as Tweet, task.message as Memory, fullResponse, task.tweet.id);
        elizaLogger.log(`Sent escrow completion notification for tweet ${task.tweet.id}`);

        const tradeDetails = `Completed escrow ${task.escrow}: Sent ${task.tradeDetails.sentAmount} $${task.tradeDetails.sentSymbol} and received ${task.tradeDetails.receivedAmount} $${task.tradeDetails.receivedSymbol}`;
        await saveAllyInformation(this.runtime, task.tweet.username, tradeDetails);
        await saveNegotiationState(this.runtime, task.tweet.username, {
            negotiation_status: "completed"
        });
    }

}