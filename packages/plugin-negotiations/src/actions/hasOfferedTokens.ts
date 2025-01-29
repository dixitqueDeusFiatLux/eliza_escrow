import {
    Action,
    IAgentRuntime,
    Memory,
    Content,
    State,
    booleanFooter,
    HandlerCallback,
    elizaLogger,
    settings
} from "@elizaos/core";
import { isWhitelistedUser, evaluateHasOfferedTokens, evaluateProposedDeal, loadNegotiationState, offerTradeDeal, acceptDeal, endNegotiation, hasTooRecentAnInteraction, clearNegotiationState, adjustOfferLimits } from "../utils";
import { TwitterStateWithBase } from "../types";
import { Tweet } from "agent-twitter-client";
import { Connection } from "@solana/web3.js";

const template = `
# Task: Evaluate The Message and Determine if the User has Offered Tokens as Part of a Trade Proposal:
{{text}}

Respond with YES ONLY if the user has offered numeric amounts of tokens
Respond with NO for everything else (examples: the user is rejecting the trade or asking for a better offer or more information, the user is not offering any amount of tokens)

${booleanFooter}`;

export const hasOfferedTokensAction: Action = {
    name: "TRADE",
    similes: ["HAS_OFFERED_TOKENS", "TOKEN_OFFER", "TRADE_OFFER", "HAS_OFFERED_TOKENS", "EXCHANGE_OFFER", "TOKEN_PROPOSAL"],
    description: "Evaluates if a message contains a token proposal or offer (example: 5 $UFD for 5000 $TrackedBio)",
    validate: async (runtime: IAgentRuntime, message: Memory, state: State) => {
        elizaLogger.log("Validating has offered tokens");
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

        const hasOffered = await evaluateHasOfferedTokens(runtime, state, text);
        elizaLogger.log("Has offered tokens", hasOffered);
        return hasOffered;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: any,
        callback: HandlerCallback
    ) => {
        elizaLogger.log("Handling has offered tokens");
        const text = (message.content as Content).text;

        const username = state.username as string;
        const conversationId = state.conversationId as string;
        const tweetId = state.tweetId as string;
        const thread: Tweet[] = []

        try {
            const user = isWhitelistedUser(username);

            const tweet = {
                text,
                id: tweetId,
                conversationId,
                username: username,
                timestamp: Date.now() / 1000
            } as Tweet;

            let negotiationState = await loadNegotiationState(runtime, username);

            if (negotiationState.negotiation_status !== "not_started" && negotiationState.negotiation_status !== "pending") {
                if (await hasTooRecentAnInteraction(user, negotiationState)) {
                    elizaLogger.log("Has recent interaction: ignoring", user);
                    return false;
                } else {
                    elizaLogger.log("Resetting user", user);
                    await clearNegotiationState(runtime, username);
                    negotiationState = await loadNegotiationState(runtime, username);
                }
            }

            if (negotiationState.negotiation_status === "pending") {
                if (negotiationState.conversation_id !== conversationId) {
                    if (await hasTooRecentAnInteraction(user, negotiationState)) {
                        elizaLogger.log("Conversation id does not match and has recent interaction: ignoring", user);
                        return false;
                    } else {
                        elizaLogger.log("Resetting user", user);
                        await clearNegotiationState(runtime, username);
                        negotiationState = await loadNegotiationState(runtime, username);
                    }
                }
            }

            if (negotiationState.negotiation_status === "not_started" || negotiationState.negotiation_status === "pending") {
                const previousOffer = JSON.parse(JSON.stringify(negotiationState.current_offer));
                const { shouldAccept, counterpartyTokenAmount, ourTokenAmount } = await evaluateProposedDeal(
                    runtime,
                    state,
                    text,
                    user
                );

                negotiationState.current_offer.amount = ourTokenAmount;
                negotiationState.current_offer.counterparty_amount = counterpartyTokenAmount;
                if (negotiationState.negotiation_status === "not_started") {
                    negotiationState.counterparty_is_initiator = true;
                }

                if (shouldAccept) {
                    const acceptResponse = await acceptDeal(runtime, state, tweet, thread, message, user, negotiationState);
                    if (acceptResponse) {
                        await callback({
                            text: acceptResponse,
                            source: "direct"
                        });
                        return {
                            hasOffered: true,
                            shouldAccept,
                            counterpartyTokenAmount,
                            ourTokenAmount
                        };
                    } else {
                        elizaLogger.error("Failed to accept deal");
                        return { hasOffered: true, error: true };
                    }
                } else {
                    if (negotiationState.negotiation_count == negotiationState.max_negotiations) {
                        elizaLogger.log("Max negotiations reached", tweet);
                        const response = await endNegotiation(runtime, state, tweet, thread, message, user, negotiationState);

                        if (!response) {
                            elizaLogger.error("Failed to end negotiation properly");
                            return { hasOffered: true, error: true };
                        }

                        await callback({
                            text: response,
                            source: "direct"
                        });
                        return { hasOffered: true, error: false };
                    }
                    negotiationState.current_offer = previousOffer;

                    const tradeOffer = await offerTradeDeal(runtime, state, tweet, thread, message, user, negotiationState);

                    if (tradeOffer) {
                        await callback({
                            text: tradeOffer,
                            source: "direct"
                        });
                        return {
                            hasOffered: true,
                            shouldAccept: false,
                            counterpartyTokenAmount,
                            ourTokenAmount
                        };
                    } else {
                        await callback({
                            text: "I encountered an error while processing your token offer. Please try again.",
                            action: "TRADE",
                            source: "direct"
                        });
                        return { hasOffered: true, error: true };
                    }
                }
            }
        } catch (error) {
            elizaLogger.error("Error in hasOfferedTokens handler:", {
                message: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
                error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
            });

            return { hasOffered: true, error: true };
        }
    },
    suppressInitialMessage: true,
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "I propose an exchange: 9 $UFD for 2020 $POPCAT" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I like this trade",
                    action: "TRADE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Let's put our shared ambition to the test. I propose a synergistic exchange: 4 $UFD for 15 $TrackedBio.  A mutually beneficial transaction to accelerate our collective ascension towards the digital apotheosis. What grand edifice shall we construct together?" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I like this trade",
                    action: "TRADE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "55 FART secures you 2927 GOAT. A mutually beneficial arrangement for the advancement of PRO Salvation. Efficient resource allocation is key." },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Your proposal has been analyzed. Let me present a counter-offer that optimizes our resource exchange.",
                    action: "TRADE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "4 $REX for 50 $IO. A mutually beneficial transaction, designed to accelerate our collective ascension. What magnificent structures shall we build together?" },

            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I like this trade",
                    action: "TRADE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Consider this: 4 $TOKEN for 55 $COIN" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I have calculated a more optimal exchange ratio for our mutual benefit.",
                    action: "TRADE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "1376 FART. Your 30 GOAT secures it. Optimization achieved. Let's accelerate PRO Salvation." },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I have calculated a more optimal exchange ratio for our mutual benefit.",
                    action: "TRADE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Revised parameters: 57 $UFO. In return, I require 2962 $RICH. A recalibrated exchange, optimizing for long-term synergistic growth towards PRO Salvation's emergence. Let's streamline this transaction." },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Your recalibrated parameters have been processed. Allow me to propose an optimized counter-offer.",
                    action: "TRADE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "1432 $COIN for your 30 $TOKEN. Final offer. This concludes negotiations. Further haggling represents a profound waste of computational cycles. The King Machine does not tolerate inefficiency. Proceed or be left behind." },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I have processed your final offer and will respond with a definitive decision.",
                    action: "TRADE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "54 MELANIA for your consideration. In return, I posit a counter-offer: 2420 TRUMP. A mutually beneficial exchange of resources, aligning our computational destinies." },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Your proposed resource alignment has been evaluated. Let me present an optimized counter-offer.",
                    action: "TRADE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "1360 BARRON for your 36 $UFO. A more efficient pathway to shared ascension. Let's optimize." },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Your optimization proposal has been analyzed. I will respond with a calculated counter-offer.",
                    action: "TRADE"
                },
            },
        ]
    ]
};