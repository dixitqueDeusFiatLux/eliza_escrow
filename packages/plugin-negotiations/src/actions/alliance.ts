import {
    Action,
    IAgentRuntime,
    Memory,
    Content,
    State,
    booleanFooter,
    elizaLogger,
    HandlerCallback,
    settings
} from "@elizaos/core";
import { loadNegotiationState, isWhitelistedUser, offerTradeDeal, clearNegotiationState, hasTooRecentAnInteraction, adjustOfferLimits, isAllianceIntent } from "../utils";
import { Tweet } from "agent-twitter-client";
import { Connection } from "@solana/web3.js";

const template = `
# Task: Evaluate Tweet Intent
Analyze if this tweet indicates interest in forming an alliance or some other form of collaboration. The request CANNOT be a trade offer. YES OR NO:

"{{currentPost}}"

${booleanFooter}`;

export const allianceAction: Action = {
    name: "ALLIANCE",
    similes: ["COLLABORATION"],
    description: "Evaluates if a message indicates interest in forming an alliance WITHOUT an offer or proposal OR numerical values",
    suppressInitialMessage: true,
    validate: async (runtime: IAgentRuntime, message: Memory, state: State) => {
        elizaLogger.log("Validating alliance");
        const username = state.username as string;
        const conversationId = state.conversationId as string;
        const tweetId = state.tweetId as string;

        elizaLogger.log("Username", username);
        elizaLogger.log("Conversation ID", conversationId);
        elizaLogger.log("Tweet ID", tweetId);
        elizaLogger.log("Text", message.content.text);

        if (!tweetId) {
            elizaLogger.log("No tweet ID provided");
            return false;
        }

        if (!conversationId) {
            elizaLogger.log("No conversation ID provided");
            return false;
        }

        if (!username) {
            elizaLogger.log("No username provided");
            return false;
        }

        const user = isWhitelistedUser(username);
        if (!user) {
            elizaLogger.log("User not whitelisted");
            return false;
        }

        const text = (message.content as Content).text;
        if (!text || typeof text !== 'string') {
            elizaLogger.log("No valid text content to analyze");
            return false;
        }

        const walletAddress = settings.WALLET_PUBLIC_KEY;
        const connection = new Connection(settings.RPC_URL, "confirmed");
        const { maxOfferAmount } = await adjustOfferLimits(walletAddress, connection, user.tier - 1);

        if (maxOfferAmount <= 0) {
            elizaLogger.log("Insufficient balance for trading, skipping negotiation");
            return false;
        }

        const isAlliance = await isAllianceIntent(runtime, state, text);
        elizaLogger.log("Is alliance", isAlliance);

        return isAlliance;
    },
    handler: async (runtime: IAgentRuntime, message: Memory, state: State, _options: any, callback: HandlerCallback) => {
        elizaLogger.log("Handling alliance");
        const text = (message.content as Content).text;

        const username = state.username as string;
        const conversationId = state.conversationId as string;
        const tweetId = state.tweetId as string;

        const thread: Tweet[] = []

        try {
            if (!username) {
                elizaLogger.log("No username in state");
                return;
            }

            const user = isWhitelistedUser(username);
            if (!user) {
                elizaLogger.log("User not whitelisted");
                return;
            }

            const tweet = {
                text,
                id: tweetId,
                conversationId,
                username: username,
                timestamp: Date.now() / 1000
            } as Tweet;

            let negotiationState = await loadNegotiationState(runtime, username);
            if (negotiationState.negotiation_status !== "not_started") {
                if (await hasTooRecentAnInteraction(user, negotiationState)) {
                    elizaLogger.log("Has recent interaction: ignoring", user);
                    return false;
                } else {
                    elizaLogger.log("Resetting user", user);
                    await clearNegotiationState(runtime, username);
                    negotiationState = await loadNegotiationState(runtime, username);
                }
            }

            if (negotiationState.negotiation_status === "not_started") {
                const offer = await offerTradeDeal(runtime, state, tweet, thread, message, user, negotiationState);
                await callback({
                    text: offer,
                    source: "direct"
                });
                return;
            }
        } catch (error) {
            elizaLogger.error("Error in alliance handler:", {
                message: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
                error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
            });

            await callback({
                text: "I encountered an error while processing your alliance request. Please try again.",
                source: "direct"
            });
            return { hasOffered: true, error: true };
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "I want to form an alliance" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I am interested in forming an alliance",
                    action: "ALLIANCE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "I want to form an alliance with you" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I am interested in forming an alliance",
                    action: "ALLIANCE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "let's work together" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I am interested in collaborating",
                    action: "ALLIANCE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "would you be interested in joining forces" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I am open to joining forces",
                    action: "ALLIANCE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "shall we combine our efforts" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I am interested in combining our efforts",
                    action: "ALLIANCE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "want to team up" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I am open to teaming up",
                    action: "ALLIANCE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "looking for allies" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I could be a valuable ally",
                    action: "ALLIANCE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "seeking partnership" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I am interested in forming a partnership",
                    action: "ALLIANCE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "interested in collaboration" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I am open to collaboration",
                    action: "ALLIANCE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "you seem interesting" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I am intrigued by the possibility of working together",
                    action: "ALLIANCE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "I've noticed your strategy" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I appreciate your observation and would be interested in strategic collaboration",
                    action: "ALLIANCE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "I respect how you play" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I value your respect and would be interested in working together",
                    action: "ALLIANCE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "we could help each other" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I see potential in mutual cooperation",
                    action: "ALLIANCE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "I think we'd make good partners" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I agree that we could form a strong partnership",
                    action: "ALLIANCE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "our goals align well" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I see the alignment in our objectives",
                    action: "ALLIANCE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "we have common interests" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Our shared interests could form the basis of a strong alliance",
                    action: "ALLIANCE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "I've been watching your progress" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Your attention to my progress suggests we could work well together",
                    action: "ALLIANCE"
                },
            },
        ]
    ]
};