import {
    Action,
    IAgentRuntime,
    Memory,
    Content,
    State,
    settings,
    HandlerCallback,
    elizaLogger
} from "@elizaos/core";
import { Tweet } from "agent-twitter-client";
import { acceptDeal, evaluateAcceptance, isWhitelistedUser, loadNegotiationState, hasInitiatedTransfer, initiateTransfer, hasTooRecentAnInteraction, clearNegotiationState } from "../utils";
import { Connection } from "@solana/web3.js";

export const hasAcceptedOfferAction: Action = {
    name: "HAS_ACCEPTED_OFFER",
    similes: ["ACCEPTED_TRADE", "ACCEPTED_DEAL", "INITIATED_TRANSFER"],
    description: "Evaluates if a message indicates acceptance of a trade offer",
    validate: async (runtime: IAgentRuntime, message: Memory, state: State) => {
        elizaLogger.log("Validating has accepted offer");
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

        const hasAccepted = await evaluateAcceptance(runtime, state, text);
        elizaLogger.log("Has accepted offer", hasAccepted);

        const hasInitiatedTransferResult = hasInitiatedTransfer(text);
        elizaLogger.log("Has initiated transfer", hasInitiatedTransferResult);

        return hasAccepted || hasInitiatedTransferResult;
    },
    handler: async (runtime: IAgentRuntime, message: Memory, state: State, _options: any, callback: HandlerCallback) => {
        elizaLogger.log("Handling has accepted offer");
        const username = state.username as string;
        const conversationId = state.conversationId as string;
        const tweetId = state.tweetId as string;

        const text = (message.content as Content).text;

        const user = isWhitelistedUser(username);

        const tweet = {
            text,
            id: tweetId,
            conversationId,
            username: username,
            timestamp: Date.now() / 1000
        } as Tweet;

        let negotiationState = await loadNegotiationState(runtime, username);

        if (negotiationState.negotiation_status !== "pending" && negotiationState.negotiation_status !== "waiting_for_escrow") {
            if (await hasTooRecentAnInteraction(user, negotiationState)) {
                elizaLogger.log("Has recent interaction: ignoring", user);
                return false;
            } else {
                elizaLogger.log("Resetting user", user);
                await clearNegotiationState(runtime, username);
                negotiationState = await loadNegotiationState(runtime, username);
            }
        }

        if (negotiationState.negotiation_status === "pending" || negotiationState.negotiation_status === "waiting_for_escrow") {
            if (negotiationState.conversation_id !== conversationId) {
                elizaLogger.log("Conversation id does not match: ignoring", user);
                return false;
            }
        }

        if (negotiationState.negotiation_status === "pending" || negotiationState.negotiation_status === "waiting_for_escrow") {
            const hasInitiatedTransferResult = hasInitiatedTransfer(text);
            if (hasInitiatedTransferResult) {
                const connection = new Connection(settings.RPC_URL, "confirmed");

                const initiateTransferResponse = await initiateTransfer(runtime, tweet, [], message, user, connection, state);
                if (initiateTransferResponse) {
                    await callback({
                        text: initiateTransferResponse,
                        source: "direct"
                    });
                    return {
                        hasAccepted: true,
                    };
                }
            } else {
                const acceptResponse = await acceptDeal(runtime, state, tweet, [], message, user, negotiationState);
                if (acceptResponse) {
                    await callback({
                        text: acceptResponse,
                        source: "direct"
                    });
                    return {
                        hasAccepted: true,
                    };
                } else {
                    elizaLogger.error("Failed to accept deal");
                    return { hasAccepted: true, error: true };
                }
            }
        }
    },
    suppressInitialMessage: true,
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "I accept the trade" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I accept the trade and have initiated the transfer",
                    action: "TRADE"
                },
            },
            {
                user: "{{user1}}",
                content: { text: "Deal. I have sent 131 $CAR Tx ID: send the 139 $DOGE to the escrow address: ." },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I accept the trade and have sent the tokens",
                    action: "TRADE"
                },
            },
        ],
    ]
};