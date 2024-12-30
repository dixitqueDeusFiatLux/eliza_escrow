import fs from 'fs';
import path from 'path';
import { Tweet } from "agent-twitter-client";
import { Content, Memory, ModelClass, booleanFooter, composeContext, elizaLogger, generateTrueOrFalse, messageCompletionFooter, settings, stringToUuid } from "@ai16z/eliza";
import { generateMessageResponse } from "@ai16z/eliza";
import { TwitterInteractionClient } from "./interactions";
import { sendTweet } from "./utils";
import { fetchTokenData, getAveragedPrice } from "@ai16z/plugin-solana";
import { getSplTokenHoldings } from '@ai16z/plugin-solana';
import yaml from 'js-yaml';
import { Connection, PublicKey } from '@solana/web3.js';
import { TokenPollingService, PollingTask } from "@ai16z/plugin-solana";
import { Keypair } from "@solana/web3.js";
import { promises as fsPromises } from 'fs';
import bs58 from "bs58";

const __dirname = path.resolve();

interface WhitelistedUser {
    username: string;
    wallet_address: string;
    token_symbol: string;
    contract_address: string;
    tier: number;
}

interface CounterpartyTier {
    refractory_period_days: number;
    min_offer_percentage: number;
    max_offer_percentage: number;
    max_offer_amount: number;
    max_negotiations: number;
}

interface NegotiationSettings {
    whitelisted_users: WhitelistedUser[];
    counterparty_tiers: CounterpartyTier[];
    our_token: {
        symbol: string;
        contract_address: string;
        minimum_balance: number;
    };
}

interface TokenAction {
    counterparty_token_amount: number;
    our_token_amount: number;
}

interface NegotiationState {
    negotiation_count: number;
    max_negotiations: number;
    conversation_id: string;
    tier: number;
    token_symbol: string;
    last_interaction: string;
    current_offer: {
        amount: number;
        usd_value: number;
        counterparty_amount: number;
    };
    max_offer_amount: number;
    counterparty_is_initiator: boolean;
    negotiation_status?: string;
}

interface BlacklistedUsers {
    usernames: string[];
}

const isTradeTweetTemplate =
    `# Task: Evaluate Tweet Intent
    Analyze if this tweet indicates interest in forming an alliance or some other form of collaboration, this can range from directly referring to trades or users. YES OR NO:

    "{{currentPost}}"

    ` + booleanFooter;

export class NegotiationHandler {
    private whitelistedUsers: WhitelistedUser[];
    private counterpartyTiers: CounterpartyTier[];
    private acceptDealTemplate: string;
    private finalTradeOfferTemplate: string;
    private initialTradeOfferTemplate: string;
    private nextTradeOfferTemplate: string;
    private negotiationsFailedTemplate: string;
    private escrowCompleteTemplate: string;
    private initiatedTransferTemplate: string;
    private nonWhitelistedUserTemplate: string;
    private hasTooRecentAnInteractionTemplate: string;
    private blacklistPath: string;
    private blacklistedUsers: string[] = [];
    private connection: Connection;

    constructor(private client: TwitterInteractionClient) {
        const negotiationSettings = this.loadNegotiationSettings();
        this.blacklistPath = path.resolve(__dirname, 'engagement', 'blacklisted_interactions.yaml');
        this.whitelistedUsers = negotiationSettings.whitelisted_users;
        this.counterpartyTiers = negotiationSettings.counterparty_tiers;
        this.acceptDealTemplate = this.loadTemplate('acceptDealTemplate');
        this.finalTradeOfferTemplate = this.loadTemplate('finalTradeOfferTemplate');
        this.initialTradeOfferTemplate = this.loadTemplate('initialTradeOfferTemplate');
        this.nextTradeOfferTemplate = this.loadTemplate('nextTradeOfferTemplate');
        this.negotiationsFailedTemplate = this.loadTemplate('negotiationsFailedTemplate');
        this.escrowCompleteTemplate = this.loadTemplate('escrowCompleteTemplate');
        this.initiatedTransferTemplate = this.loadTemplate('initiatedTransferTemplate');
        this.nonWhitelistedUserTemplate = this.loadTemplate('nonWhitelistedUserTemplate');
        this.hasTooRecentAnInteractionTemplate = this.loadTemplate('hasTooRecentAnInteractionTemplate');

        this.connection = new Connection(settings.RPC_URL, "confirmed");
        const pollingService = TokenPollingService.getInstance(this.connection);
        pollingService.setNegotiationHandler(this);
    }

    private loadTemplate(templateName: string): string {
        const filePath = path.resolve(__dirname, 'negotiation_templates', `${templateName}.yaml`);
        const fileContents = fs.readFileSync(filePath, 'utf-8');
        const templateData = yaml.load(fileContents) as { template: string };
        return templateData.template + messageCompletionFooter;
    }
   
    private loadNegotiationSettings(): NegotiationSettings {
        const negotiationSettingsPath = path.resolve(__dirname, 'negotiation_settings.json');
        const negotiationSettingsData = fs.readFileSync(negotiationSettingsPath, 'utf-8');
        return JSON.parse(negotiationSettingsData);
    }

    private async saveAllyInformation(username: string, tradeDetails: string) {
        const allyKey = `ally_${username}`;
        const roomId = stringToUuid("ally_room");
        const userId = this.client.runtime.agentId;

        await this.client.runtime.ensureConnection(
            userId,
            roomId,
            this.client.runtime.character.name,
            this.client.runtime.character.name,
            "twitter"
        );

        const existingMemory = await this.client.runtime.messageManager.getMemoryById(stringToUuid(allyKey));
        let allyInfo;

        if (existingMemory) {
            allyInfo = JSON.parse(existingMemory.content.text);
            allyInfo.trades.push({
                tradeDetails,
                date: new Date().toISOString()
            });

            await this.client.runtime.messageManager.removeMemory(stringToUuid(allyKey));
        } else {
            allyInfo = {
                username,
                trades: [{
                    tradeDetails,
                    date: new Date().toISOString()
                }]
            };
        }

        await this.client.runtime.messageManager.createMemory({
            id: stringToUuid(allyKey),
            agentId: this.client.runtime.agentId,
            userId: userId,
            content: {
                text: JSON.stringify(allyInfo),
                source: "ally_info",
            },
            roomId: roomId,
            createdAt: Date.now(),
        });

        elizaLogger.log(`Ally information updated for user ${username}`);
    }

    private async getCounterpartyTierSettings(user: WhitelistedUser): Promise<CounterpartyTier> {
        const tierIndex = user.tier - 1;
        const counterpartyTierSettings = this.counterpartyTiers[tierIndex];

        const connection = new Connection(settings.RPC_URL, "confirmed");
        const walletAddress = settings.WALLET_PUBLIC_KEY;

        const { maxOfferAmount } = await this.adjustOfferLimits(walletAddress, connection, tierIndex);

        return {
            ...counterpartyTierSettings,
            max_offer_amount: maxOfferAmount
        };
    }

    private async hasTooRecentAnInteraction(user: WhitelistedUser, negotiationState: NegotiationState): Promise<boolean> {
        if (!negotiationState.last_interaction) {
            return false;
        }

        const counterpartyTierSettings = await this.getCounterpartyTierSettings(user);

        const refractoryPeriodDays = counterpartyTierSettings.refractory_period_days;

        const lastInteraction = new Date(negotiationState.last_interaction);
        const refractoryPeriodAgo = new Date();
        refractoryPeriodAgo.setDate(refractoryPeriodAgo.getDate() - refractoryPeriodDays);

        return lastInteraction > refractoryPeriodAgo;
    }

    private async nonWhitelistedUserPost(tweet: Tweet, thread: Tweet[], message: Memory): Promise<boolean> { 
        try {
            const formattedConversation = this.getFormattedConversation(thread);
                  
            const state = await this.client.runtime.composeState(message, {
                nonWhitelistedUserPostExamples: this.client.runtime.character.nonWhitelistedUserPostExamples,
                twitterClient: this.client.twitterClient,
                twitterUserName: settings.TWITTER_USERNAME,
                currentPost: tweet.text,
                formattedConversation: formattedConversation,
                username: tweet.username,
            });

            elizaLogger.log(`Rejected trade request from ${tweet.username}`);
            const context = composeContext({
                state,
                template: this.nonWhitelistedUserTemplate 
            });

            const response = await generateMessageResponse({
                runtime: this.client.runtime,
                context,
                modelClass: ModelClass.MEDIUM,
            });

            await this.sendReply(tweet, message, response.text, tweet.id);
            return true;
        } catch (error) {
            elizaLogger.error("Error in nonWhitelistedUserPost:", {
                message: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
                error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
            });
            throw error;
        }
    }

    private async hasTooRecentAnInteractionPost(tweet: Tweet, thread: Tweet[], message: Memory, negotiationState: NegotiationState): Promise<boolean> { 
        try {
            const formattedConversation = this.getFormattedConversation(thread);
                  
            const state = await this.client.runtime.composeState(message, {
                hasTooRecentAnInteractionPostExamples: this.client.runtime.character.hasTooRecentAnInteractionPostExamples,
                negotiationState: negotiationState,
                twitterClient: this.client.twitterClient,
                twitterUserName: settings.TWITTER_USERNAME,
                currentPost: tweet.text,
                formattedConversation: formattedConversation,
                username: tweet.username,
            });

            elizaLogger.log(`Rejected trade request from ${tweet.username}`);
            const context = composeContext({
                state,
                template: this.hasTooRecentAnInteractionTemplate 
            });

            const response = await generateMessageResponse({
                runtime: this.client.runtime,
                context,
                modelClass: ModelClass.MEDIUM,
            });

            await this.sendReply(tweet, message, response.text, tweet.id);
            return true;
        } catch (error) {
            elizaLogger.error("Error in hasTooRecentAnInteractionPost:", {
                message: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
                error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
            });
            throw error;
        }
    }

    async isNegotiation(tweet: Tweet, message: Memory): Promise<boolean> {
        // Either someone is offering tokens, in which case it's a negotiation
        // Or it's part of an existing negotiation, in which case it's a negotiation if the status is active and the conversation id matches
        await this.reloadNegotiationSettings();

        const shouldStartNegotiation = await this.shouldStartNegotiation(tweet).catch(() => false);
        const hasOfferedTokens = await this.evaluateHasOfferedTokens(tweet, message);
        if (shouldStartNegotiation || hasOfferedTokens) {
            return true;
        }

        let user = this.whitelistedUsers.find((u) => u.username.toLowerCase() === tweet.username.toLowerCase());
        if (user) {
            let negotiationState = await this.loadNegotiationState(user.username);

            if (negotiationState && negotiationState.negotiation_status !== "not_started") { 
                if (tweet.conversationId === negotiationState.conversation_id) {
                    if (negotiationState.negotiation_status === "failed" || negotiationState.negotiation_status === "completed") {
                        return false;
                    }
                    return true;
                } else {
                    return !await this.hasTooRecentAnInteraction(user, negotiationState);
                }
            } 
        }

        return false;
    }

    async handleNegotiation(tweet: Tweet, thread: Tweet[], message: Memory): Promise<boolean> {
        try {
            await this.reloadNegotiationSettings();

            if (this.blacklistedUsers.includes(tweet.username.toLowerCase())) {
                elizaLogger.log(`User ${tweet.username} is blacklisted - ending negotiation`);
                const success = await this.nonWhitelistedUserPost(tweet, thread, message);
                return success;
            }

            let user = this.whitelistedUsers.find((u) => u.username.toLowerCase() === tweet.username.toLowerCase());
            if (!user) {
                elizaLogger.log("User not found", tweet);
                const success = await this.nonWhitelistedUserPost(tweet, thread, message);
                return success;
            }

            const walletAddress = settings.WALLET_PUBLIC_KEY;
            const { maxOfferAmount } = await this.adjustOfferLimits(walletAddress, this.connection, user.tier - 1);
            
            if (maxOfferAmount <= 0) {
                elizaLogger.log("Insufficient balance for trading, skipping negotiation");
                return false;
            }

            let negotiationState = await this.loadNegotiationState(user.username);
            elizaLogger.log("Full negotiation state", negotiationState);
            elizaLogger.log("Negotiation status", negotiationState.negotiation_status);

            if (negotiationState.negotiation_status !== "not_started") {
                if (tweet.conversationId === negotiationState.conversation_id) {
                    if (negotiationState.negotiation_status === "pending") {
                        return await this.processNegotiationResponse(tweet, thread, message, negotiationState, user);
                        //return true;
                    } else if (negotiationState.negotiation_status === "waiting_for_escrow") {
                        const success = await this.initiateTransfer(tweet, thread, message, user);
                        return success;
                    } else if (negotiationState.negotiation_status === "completed") {
                        elizaLogger.log("Negotiation was completed, not responding", tweet); // dont respond?
                        return true;
                    } else if (negotiationState.negotiation_status === "failed") {
                        elizaLogger.log("Negotiation had failed, not responding", tweet); // dont respond?
                        return true;
                    } else if (negotiationState.negotiation_status === "initiated_escrow") {
                        elizaLogger.log("Escrow was initiated, not responding", tweet); // dont respond?
                        return true;
                    }
                }

                if (await this.hasTooRecentAnInteraction(user, negotiationState)) {
                    if (tweet.mentions.some(mention => mention.username === this.client.runtime.getSetting("TWITTER_USERNAME"))) {
                        elizaLogger.log("Has recent interaction: ignoring", user);
                        //elizaLogger.log("Has recent interaction: responding with hasTooRecentAnInteractionPost", user);
                        //const success = await this.hasTooRecentAnInteractionPost(tweet, thread, message, negotiationState);
                        //return success;
                        return true;
                    } else {
                        return false; // dont respond? From home timeline
                    }
                } else {
                    // Reset user since he can do a new negotiation
                    elizaLogger.log("Resetting user", user);
                    await this.clearNegotiationState(user.username);
                    negotiationState = await this.loadNegotiationState(user.username);
                }
            } 

            if (negotiationState.negotiation_status === "not_started") {
                const hasOfferedTokens = await this.evaluateHasOfferedTokens(tweet, message);
                elizaLogger.log("Has offered tokens", hasOfferedTokens);
                if (hasOfferedTokens) {
                    negotiationState.counterparty_is_initiator = true;
                    const { shouldAccept, counterpartyTokenAmount, ourTokenAmount } = await this.evaluateProposedDeal(tweet.text, user, tweet);
                    negotiationState.current_offer.amount = ourTokenAmount;
                    negotiationState.current_offer.counterparty_amount = counterpartyTokenAmount;

                    if (shouldAccept) {
                        const wasAccepted = await this.acceptDeal(tweet, thread, message, user, negotiationState);
                        return wasAccepted; // if false then it failed somehow, retry
                    } else {
                        const success = await this.offerTradeDeal(tweet, thread, message, user, negotiationState);
                        if (!success) {
                            elizaLogger.error("Failed to send counter-proposal");
                            return false;
                        }
                        elizaLogger.log(`Made counter-proposal to ${user.username}`);
                        return true;
                    }
                } else {
                    const shouldStartNegotiation = await this.shouldStartNegotiation(tweet);
                    elizaLogger.log("Should start negotiation", shouldStartNegotiation);
                    if (shouldStartNegotiation) {
                        const success = await this.offerTradeDeal(tweet, thread, message, user, negotiationState);
                        if (!success) {
                            elizaLogger.error("Failed to send initial trade offer");
                            return false;
                        }
                        return true;
                    }
                }
            }
            
            elizaLogger.log("Negotiation not handled", tweet);
            return false;
        } catch (error) {
            elizaLogger.error("Error in handleNegotiation", {
                message: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
                error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
            }, tweet);
            return false;
        }
    }

    private async shouldStartNegotiation(tweet: Tweet): Promise<boolean> {
        try {
            const message = {
                content: { text: tweet.text },
                agentId: this.client.runtime.agentId,
                userId: stringToUuid(tweet.userId),
                roomId: stringToUuid(tweet.conversationId),
            };

            const state = await this.client.runtime.composeState(message, {
                twitterClient: this.client.twitterClient,
                twitterUserName: settings.TWITTER_USERNAME,
                currentPost: tweet.text,
                allianceIntents: this.client.runtime.character.allianceIntents
            });

            const evaluationContext = composeContext({
                state,
                template: isTradeTweetTemplate
            });

            const evaluation = await generateTrueOrFalse({
                runtime: this.client.runtime,
                context: evaluationContext,
                modelClass: ModelClass.SMALL,
            });

            return evaluation;
        } catch (error) {
            elizaLogger.error("Error in shouldStartNegotiation:", {
                message: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
                error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
            });
            throw error;
        }
    }

    private async saveNegotiationState(username: string, newState: Partial<NegotiationState>) {
        const stateKey = `negotiation_state_${username}`;
        const negotiationRoomId = stringToUuid("negotiation_room");
        
        try {
            await this.client.runtime.ensureConnection(
                this.client.runtime.agentId,
                negotiationRoomId,
                this.client.runtime.character.name,
                this.client.runtime.character.name,
                "twitter"
            );

            const existingMemory = await this.client.runtime.messageManager.getMemoryById(stringToUuid(stateKey));
            const existingState = existingMemory ? JSON.parse(existingMemory.content.text) : {};

            const mergedState = {
                ...existingState,
                ...newState
            };

            elizaLogger.log("Saving merged negotiation state", mergedState);

            if (existingMemory) {
                await this.client.runtime.messageManager.removeMemory(stringToUuid(stateKey));
            }

            await this.client.runtime.messageManager.createMemory({
                id: stringToUuid(stateKey),
                agentId: this.client.runtime.agentId,
                userId: this.client.runtime.agentId,
                content: {
                    text: JSON.stringify(mergedState),
                    source: "negotiation_state",
                },
                roomId: negotiationRoomId,
                createdAt: Date.now(),
            });

            elizaLogger.log(`Negotiation state updated for user ${username}`);
        } catch (error) {
            elizaLogger.error(`Error saving negotiation state for ${username}:`, {
                message: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
                error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
            });
            throw error;
        }
    }

    private async loadNegotiationState(username: string): Promise<NegotiationState> {
        const stateKey = `negotiation_state_${username}`;
        const memory = await this.client.runtime.messageManager.getMemoryById(stringToUuid(stateKey));
        
        if (memory) {
            return JSON.parse(memory.content.text);
        }

        return {
            negotiation_count: 0,
            max_negotiations: 3,
            conversation_id: "",
            tier: -1,
            token_symbol: "",
            last_interaction: null,
            current_offer: {
                amount: 0,
                usd_value: 0,
                counterparty_amount: 0
            },
            max_offer_amount: 0,
            counterparty_is_initiator: false,
            negotiation_status: "not_started"
        };
    }

    private async clearNegotiationState(username: string) {
        const stateKey = `negotiation_state_${username}`;
        await this.client.runtime.messageManager.removeMemory(stringToUuid(stateKey));
        elizaLogger.log(`Negotiation state cleared for user ${username}`);
    }

    private async sendReply(tweet: Tweet, message: Memory, text: string, inReplyToId: string) {
        const responseContent: Content = {
            text: text,
            inReplyTo: stringToUuid(inReplyToId),
        };
        
        const memories = await sendTweet(
            this.client, 
            responseContent, 
            message.roomId, 
            settings.TWITTER_USERNAME, 
            inReplyToId
        );

        for (const memory of memories) {
            await this.client.runtime.messageManager.createMemory(memory);
        }

        elizaLogger.log(`Sent reply to ${tweet.username}: ${text}`);
    }

    private async getTokenPrices(user: WhitelistedUser): Promise<{ our_token_price: number, counterparty_token_price: number } | null> {
        const negotiationSettings = this.loadNegotiationSettings();
        
        const our_token = await fetchTokenData(negotiationSettings.our_token.contract_address, this.client.runtime);
        const counterparty_token = await fetchTokenData(user.contract_address, this.client.runtime);

        if (!our_token || !counterparty_token) {
            elizaLogger.error("Failed to fetch token prices");
            return null;
        }

        const our_price_info = getAveragedPrice(our_token);
        const counterparty_price_info = getAveragedPrice(counterparty_token);

        return {
            our_token_price: parseFloat(our_price_info.averagePriceUsd),
            counterparty_token_price: parseFloat(counterparty_price_info.averagePriceUsd)
        };
    }

    private async adjustOfferLimits(walletAddress: string, connection: Connection, tierIndex: number) {
        const negotiationSettings = this.loadNegotiationSettings();
        const holdings = await getSplTokenHoldings(connection, new PublicKey(walletAddress));

        const tokenHolding = holdings.find(h => h.mintAddress === negotiationSettings.our_token.contract_address);
        const balance = tokenHolding ? tokenHolding.amount : 0;
        
        let maxOfferAmount = negotiationSettings.counterparty_tiers[tierIndex].max_offer_amount;

        if (balance < maxOfferAmount) {
            elizaLogger.warn("Balance is less than max offer amount", balance, maxOfferAmount);
            maxOfferAmount = Math.floor(balance * 0.25);
        }

        if (balance <= negotiationSettings.our_token.minimum_balance) {
            elizaLogger.warn("Balance is less than minimum balance", balance, negotiationSettings.our_token.minimum_balance);
            maxOfferAmount = 0;
        }

        return { maxOfferAmount };
    }

    private calculateOffer(counterpartyTierSettings: CounterpartyTier, our_token_price: number, counterparty_token_price: number, negotiationState: NegotiationState) {
        // Calculate how many counterparty tokens one of our tokens is worth
        const fair_price = our_token_price / counterparty_token_price;
        
        // Calculate how many counterparty tokens we should get for our max offer
        const max_fair_counterparty_amount = counterpartyTierSettings.max_offer_amount * fair_price;

        if (!negotiationState.current_offer?.amount) {
            // For initial offer, we offer between min_offer_percentage and max_offer_percentage of our max
            const randomFactor = Math.random() * 
                ((counterpartyTierSettings.max_offer_percentage / 100) - (counterpartyTierSettings.min_offer_percentage / 100)) + 
                (counterpartyTierSettings.min_offer_percentage / 100);

            // Calculate our token offer amount as a percentage of our max
            const our_offer = counterpartyTierSettings.max_offer_amount * randomFactor;
            
            const counterparty_amount = max_fair_counterparty_amount; 

            negotiationState.current_offer = {
                amount: Math.floor(our_offer),
                usd_value: Number((our_offer * our_token_price).toFixed(6)),
                counterparty_amount: Math.floor(counterparty_amount)
            };
        } else {
            // For subsequent offers, increase our offer by 10-100% of remaining room to max
            const current_amount = negotiationState.current_offer.amount;
            const room_to_max = counterpartyTierSettings.max_offer_amount - current_amount;
            const randomFactor = Math.random() * 0.9 + 0.1; // Random between 0.1 and 1.0
            
            // Calculate our new token offer
            const additional_offer = room_to_max * randomFactor;
            elizaLogger.log("Adding on additional offer", additional_offer);
            const new_our_offer = current_amount + additional_offer;
            
            const counterparty_amount = max_fair_counterparty_amount; 

            negotiationState.current_offer = {
                amount: Math.floor(new_our_offer),
                usd_value: Number((new_our_offer * our_token_price).toFixed(6)),
                counterparty_amount: Math.floor(counterparty_amount)
            };
        }

        elizaLogger.log("Calculated offer details:", {
            our_side: {
                amount: negotiationState.current_offer.amount,
                usd_value: negotiationState.current_offer.usd_value,
                token_price: our_token_price,
                max_amount: counterpartyTierSettings.max_offer_amount
            },
            counterparty_side: {
                amount: negotiationState.current_offer.counterparty_amount,
                usd_value: negotiationState.current_offer.counterparty_amount * counterparty_token_price,
                token_price: counterparty_token_price
            }
        });
    }

    private getFormattedConversation(thread: Tweet[]) {
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

        return formattedConversation;
    }

    private async offerTradeDeal(tweet: Tweet, thread: Tweet[], message: Memory, user: WhitelistedUser, negotiationState: NegotiationState): Promise<boolean> {
        try {
            // Should consider locking the agent token amount or our prices so that price-fluxuations in-between negotiations don't affect the deal as much
            const counterpartyTierSettings = await this.getCounterpartyTierSettings(user);
            
            const prices = await this.getTokenPrices(user);
            if (!prices) {
                elizaLogger.error("Failed to fetch token prices");
                return false;
            }

            const { our_token_price, counterparty_token_price } = prices;

            this.calculateOffer(counterpartyTierSettings, our_token_price, counterparty_token_price, negotiationState);

            if (negotiationState?.current_offer?.amount > 0.95 * counterpartyTierSettings.max_offer_amount) {
                negotiationState.negotiation_count = negotiationState.negotiation_count + 1;
                elizaLogger.log(`Iterating negotiation count for final offer to ${user.username}`);
            }

            let tradeTemplate = this.initialTradeOfferTemplate;
            if (negotiationState.negotiation_status == "pending") {
                tradeTemplate = this.nextTradeOfferTemplate;
            }
            if (negotiationState.negotiation_count > 0) {
                tradeTemplate = this.finalTradeOfferTemplate;
            }

            const formattedConversation = this.getFormattedConversation(thread);
                    
            const negotiationSettings = this.loadNegotiationSettings();
            const state = await this.client.runtime.composeState(message, {
                initialTradeOfferPostExamples: this.client.runtime.character.initialTradeOfferPostExamples,
                nextTradeOfferPostExamples: this.client.runtime.character.nextTradeOfferPostExamples,
                finalTradeOfferPostExamples: this.client.runtime.character.finalTradeOfferPostExamples,
                twitterClient: this.client.twitterClient,
                twitterUserName: settings.TWITTER_USERNAME,
                currentPost: tweet.text,
                formattedConversation: formattedConversation,
                username: user.username,
                ourTokenAmount: negotiationState.current_offer.amount,
                ourTokenSymbol: negotiationSettings.our_token.symbol,
                counterPartyTokenAmount: negotiationState.current_offer.counterparty_amount,
                counterPartyTokenSymbol: user.token_symbol
            });

            const context = composeContext({
                state,
                template: tradeTemplate
            });

            const tradeOffer = await generateMessageResponse({
                runtime: this.client.runtime,
                context: context,
                modelClass: ModelClass.MEDIUM,
            });

            const responseContent: Content = {
                text: tradeOffer.text,
                inReplyTo: stringToUuid(tweet.id),
            };
            
            await sendTweet(this.client, responseContent, message.roomId, settings.TWITTER_USERNAME, tweet.id);

            const conversationId = tweet.conversationId;
            const last_interaction = negotiationState.last_interaction ?? new Date().toISOString();

            await this.saveNegotiationState(user.username, {
                conversation_id: conversationId,
                tier: user.tier,
                token_symbol: user.token_symbol,
                last_interaction: last_interaction,
                current_offer: negotiationState.current_offer,
                max_offer_amount: counterpartyTierSettings.max_offer_amount,
                negotiation_count: negotiationState.negotiation_count,
                max_negotiations: counterpartyTierSettings.max_negotiations,
                counterparty_is_initiator: negotiationState.counterparty_is_initiator,
                negotiation_status: "pending"
            });

            elizaLogger.log(`Trade offer sent to ${user.username}`);
            return true;
        } catch (error) {
            elizaLogger.error("Error in offerTradeDeal:", {
                message: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
                error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
            });
            throw error;
        }
    }

    private async evaluateProposedDeal(proposalText: string, user: WhitelistedUser, tweet: Tweet): Promise<{ shouldAccept: boolean, counterpartyTokenAmount: number, ourTokenAmount: number }> {
        try {
            const negotiationSettings = this.loadNegotiationSettings();
            const message = {
                content: { text: proposalText },
                agentId: this.client.runtime.agentId,
                userId: stringToUuid(user.username),
                roomId: stringToUuid(tweet.conversationId),
            };

            const state = await this.client.runtime.composeState(message, {
                twitterClient: this.client.twitterClient,
                twitterUserName: settings.TWITTER_USERNAME,
                proposalText: proposalText
            });

            const extractTokensTemplate = `
            # Task: Extract Token Information from Trade Proposal

            Current proposal:
            {{proposalText}}

            Extract the following information about token amounts:
            - ${user.token_symbol} tokens offered 
            - ${negotiationSettings.our_token.symbol} tokens requested

            Format the response as a JSON object with these fields:
            - token_amounts: {
                - counterparty_token_amount: number (amount of ${user.token_symbol} tokens)
                - our_token_amount: number (amount of ${negotiationSettings.our_token.symbol} tokens)
            }

            ${messageCompletionFooter}`;

            const evaluationContext = composeContext({
                state,
                template: extractTokensTemplate
            });

            const tokenInfo = await generateMessageResponse({
                runtime: this.client.runtime,
                context: evaluationContext,
                modelClass: ModelClass.SMALL,
            });

            if (!tokenInfo?.token_amounts) {
                elizaLogger.error("Failed to extract token amounts from proposal");
                return { shouldAccept: false, counterpartyTokenAmount: 0, ourTokenAmount: 0 };
            }

            const action = (tokenInfo.token_amounts as unknown) as TokenAction;

            const counterpartyTokenAmount = action.counterparty_token_amount || 0;
            const ourTokenAmount = action.our_token_amount || 0;

            const counterpartyTierSettings = await this.getCounterpartyTierSettings(user);

            if (ourTokenAmount > counterpartyTierSettings.max_offer_amount) {
                elizaLogger.log(`Proposed amounts exceed maximums - ${negotiationSettings.our_token.symbol}: ${ourTokenAmount}/${counterpartyTierSettings.max_offer_amount}`);
                return { shouldAccept: false, counterpartyTokenAmount: 0, ourTokenAmount: 0 };
            }

            if (ourTokenAmount == 0 || counterpartyTokenAmount == 0) {
                elizaLogger.log(`Proposed amounts are 0 - ${negotiationSettings.our_token.symbol}: ${ourTokenAmount}/${counterpartyTierSettings.max_offer_amount}`);
                return { shouldAccept: false, counterpartyTokenAmount: 0, ourTokenAmount: 0 };
            }

            const prices = await this.getTokenPrices(user);
            if (!prices) {
                elizaLogger.error("Failed to fetch token prices in evaluateProposedDeal");
                throw new Error("Failed to fetch token prices");
            }

            const { our_token_price, counterparty_token_price } = prices;

            const counterpartyTokenValue = counterpartyTokenAmount * counterparty_token_price;
            const ourTokenValue = ourTokenAmount * our_token_price;

            const shouldAccept = counterpartyTokenValue >= ourTokenValue * 0.95; // Within 5% of the fair value for us

            if (!shouldAccept) {
                elizaLogger.log(`Deal rejected - Values: Counterparty=${counterpartyTokenValue}, Our=${ourTokenValue}, ${negotiationSettings.our_token.symbol}=${ourTokenAmount}/${counterpartyTierSettings.max_offer_amount}`);
            } else {
                elizaLogger.log(`Deal accepted - Values: Counterparty=${counterpartyTokenValue}, Our=${ourTokenValue}, ${negotiationSettings.our_token.symbol}=${ourTokenAmount}/${counterpartyTierSettings.max_offer_amount}`);
            }

            return {
                shouldAccept,
                counterpartyTokenAmount,
                ourTokenAmount
            };
        } catch (error) {
            elizaLogger.error("Error in evaluateProposedDeal:", {
                message: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
                error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
            });
            throw error;
        }
    }

    private async initiateSmartContractAndPolling(user: WhitelistedUser, negotiationState: NegotiationState, tweet: Tweet, thread: Tweet[], message: Memory) {
        try {
            const negotiationSettings = this.loadNegotiationSettings();
            const pollingService = TokenPollingService.getInstance(this.connection);

            const privateKeyString = settings.WALLET_PRIVATE_KEY!;
            const secretKey = bs58.decode(privateKeyString);
            const initializer = Keypair.fromSecretKey(secretKey);
            const taker = new PublicKey(user.wallet_address);

            const mintA = new PublicKey(negotiationSettings.our_token.contract_address);
            const mintB = new PublicKey(user.contract_address);

            const accounts = await pollingService.setupEscrow(
                negotiationState.current_offer.amount,
                negotiationState.current_offer.counterparty_amount,
                initializer,
                taker,
                mintA,
                mintB
            );
            
            pollingService.addPollingTask(
                accounts.vaultB.toString(),
                accounts.mintB.toString(),
                negotiationState.current_offer.counterparty_amount.toString(),
                {
                    escrow: accounts.escrow.toString(),
                    initializer: accounts.initializer.publicKey.toString(),
                    taker: accounts.taker.toString(),
                    mintA: accounts.mintA.toString(),
                    initializerAtaA: accounts.initializerAtaA.toString(),
                    initializerAtaB: accounts.initializerAtaB.toString(),
                    takerAtaA: accounts.takerAtaA.toString(),
                    takerAtaB: accounts.takerAtaB.toString(),
                    vaultA: accounts.vaultA.toString(),
                    initializerSecretKey: Array.from(accounts.initializer.secretKey),
                    tweet: {
                        id: tweet.id,
                        text: tweet.text,
                        username: tweet.username,
                        timestamp: tweet.timestamp,
                        conversationId: tweet.conversationId
                    },
                    thread: thread.map(t => ({
                        id: t.id,
                        text: t.text,
                        username: t.username,
                        timestamp: t.timestamp
                    })),
                    message: {
                        content: message.content,
                        agentId: message.agentId,
                        userId: message.userId,
                        roomId: message.roomId
                    },
                    tradeDetails: {
                        sentAmount: negotiationState.current_offer.amount,
                        sentSymbol: negotiationSettings.our_token.symbol,
                        receivedAmount: negotiationState.current_offer.counterparty_amount,
                        receivedSymbol: user.token_symbol
                    }
                },
                0.95
            );

            return {
                status: "success",
                transactionId: accounts.transactionId,
                walletAddress: accounts.vaultB.toString()
            };
        } catch (error) {
            elizaLogger.error("Smart Contract Setup Error: ", {
                message: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
                error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
            }); 
            throw error;
        }
    }

    private async acceptDeal(
        tweet: Tweet,
        thread: Tweet[],
        message: Memory,
        user: WhitelistedUser,
        negotiationState: NegotiationState
    ): Promise<boolean> {
        try {
            const negotiationSettings = this.loadNegotiationSettings();

            elizaLogger.log(`Accepting deal with ${user.username}`);
            elizaLogger.log(`ourTokenAmount: ${negotiationState.current_offer.amount}, counterPartyTokenAmount: ${negotiationState.current_offer.counterparty_amount}`);
            const formattedConversation = this.getFormattedConversation(thread);

            let tradeMessage = '';
            let negotiationStatus = '';
            if (!negotiationState.counterparty_is_initiator) {
                const execution = await this.initiateSmartContractAndPolling(user, negotiationState, tweet, thread, message);
                if (execution.status === "success") {
                    elizaLogger.log("Escrow initiated");
                    tradeMessage = `Deal. I have sent ${negotiationState.current_offer.amount} $${negotiationSettings.our_token.symbol} \nTx ID: ${execution.transactionId} \nsend the ${negotiationState.current_offer.counterparty_amount} $${user.token_symbol} to the escrow address: \n${execution.walletAddress}. \n\n`;
                    negotiationStatus = 'initiated_escrow';
                } else {
                    elizaLogger.log("Escrow failed", tweet);
                    return false;
                }
            } else {
                // TODO: Add logic to handle non-initiator trades
                elizaLogger.log("Waiting for escrow to be initiated");
                negotiationStatus = 'waiting_for_escrow';
                tradeMessage = ``;
            }

            const state = await this.client.runtime.composeState(message, {
                acceptDealPostExamples: this.client.runtime.character.acceptDealPostExamples,
                twitterClient: this.client.twitterClient,
                twitterUserName: settings.TWITTER_USERNAME,
                currentPost: tweet.text,
                formattedConversation: formattedConversation,
                username: user.username,
                ourTokenSymbol: negotiationSettings.our_token.symbol,
                counterPartyTokenSymbol: user.token_symbol,
                ourTokenAmount: negotiationState.current_offer.amount,
                counterPartyTokenAmount: negotiationState.current_offer.counterparty_amount
            });

            elizaLogger.log(`Accepted deal with ${user.username}`);
            const context = composeContext({
                state,
                template: this.acceptDealTemplate 
            });

            const response = await generateMessageResponse({
                runtime: this.client.runtime,
                context,
                modelClass: ModelClass.MEDIUM,
            });

            const fullResponse = tradeMessage + response.text;

            await this.sendReply(tweet, message, fullResponse, tweet.id);
            const last_interaction = negotiationState.last_interaction ?? new Date().toISOString();

            await this.saveNegotiationState(user.username, {
                current_offer: negotiationState.current_offer,
                negotiation_status: negotiationStatus,
                conversation_id: tweet.conversationId,
                last_interaction: last_interaction
            });

            return true;
        } catch (error) {
            elizaLogger.error("Error in acceptDeal:", {
                message: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
                error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
            });
            throw error;
        }
    }

    private async endNegotiation(tweet: Tweet, thread: Tweet[], message: Memory, user: WhitelistedUser): Promise<boolean> {
        try {
            const formattedConversation = this.getFormattedConversation(thread);

            const state = await this.client.runtime.composeState(message, {
                negotiationFailedPostExamples: this.client.runtime.character.negotiationsFailedPostExamples,
                twitterClient: this.client.twitterClient,
                twitterUserName: settings.TWITTER_USERNAME,
                currentPost: tweet.text,
                formattedConversation: formattedConversation,
                username: user.username,
            });

            elizaLogger.log(`Negotiation ended with ${user.username} after reaching max negotiations`);
            const context = composeContext({
                state,
                template: this.negotiationsFailedTemplate 
            });

            const response = await generateMessageResponse({
                runtime: this.client.runtime,
                context,
                modelClass: ModelClass.MEDIUM,
            });

            await this.sendReply(tweet, message, response.text, tweet.id);
            await this.saveNegotiationState(user.username, {
                negotiation_status: "failed"
            });
            return true;
        } catch (error) {
            elizaLogger.error("Error in endNegotiation:", {
                message: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
                error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
            });
            throw error;
        }
    }

    private async evaluateAcceptance(tweet: Tweet, message: Memory, user: WhitelistedUser) {
        try {
            const state = await this.client.runtime.composeState(message, {
                twitterClient: this.client.twitterClient,
                twitterUserName: settings.TWITTER_USERNAME,
                proposalText: tweet.text 
            });
            
            const evalulateAcceptanceOrRejectionTemplate =
            `# Task: Evaluate The Message and Determine if the User is Accepting or Rejecting the Trade Proposal:
            {{proposalText}}

            Respond with YES ONLY if the user is accepting the trade
            Respond with NO for everything else (examples: the user is rejecting the trade, proposing a counter-offer, or offering a revision)
            ` + booleanFooter;

            const evaluationContext = composeContext({
                state,
                template: evalulateAcceptanceOrRejectionTemplate 
            });

            const evaluation = await generateTrueOrFalse({
                runtime: this.client.runtime,
                context: evaluationContext,
                modelClass: ModelClass.SMALL,
            });

            return evaluation;
        } catch (error) {
            elizaLogger.error("Error in evaluateAcceptance:", {
                message: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
                error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
            });
            throw error;
        }
    }

    private async evaluateHasOfferedTokens(tweet: Tweet, message: Memory) {
        try {
            const state = await this.client.runtime.composeState(message, {
                twitterClient: this.client.twitterClient,
                twitterUserName: settings.TWITTER_USERNAME,
                proposalText: tweet.text 
            });

            const evaluateOfferedTokensTemplate =
            `# Task: Evaluate The Message and Determine if the User has Offered Tokens as Part of a Trade Proposal:
            {{proposalText}}

            Respond with YES ONLY if the user has offered numeric amounts of tokens
            Respond with NO for everything else (examples: the user is rejecting the trade or asking for a better offer or more information, the user is not offering any amount of tokens)
            ` + booleanFooter;

            const evaluationContext = composeContext({
                state,
                template: evaluateOfferedTokensTemplate 
            });

            const evaluation = await generateTrueOrFalse({
                runtime: this.client.runtime,
                context: evaluationContext,
                modelClass: ModelClass.SMALL,
            });

            return evaluation;
        } catch (error) {
            elizaLogger.error("Error in evaluateHasOfferedTokens:", {
                message: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
                error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
            });
            throw error;
        }
    }

    private async processNegotiationResponse(tweet: Tweet, thread: Tweet[], message: Memory, negotiationState: NegotiationState, user: WhitelistedUser): Promise<boolean> {
        const hasInitiatedTransfer = await this.hasInitiatedTransfer(tweet, message);
        if (hasInitiatedTransfer) {
            await this.initiateTransfer(tweet, thread, message, user);
            return true;
        }

        const previousOffer = JSON.parse(JSON.stringify(negotiationState.current_offer));
        const hasOfferedTokens = await this.evaluateHasOfferedTokens(tweet, message);
        if (hasOfferedTokens) {
            const { shouldAccept, counterpartyTokenAmount, ourTokenAmount } = await this.evaluateProposedDeal(tweet.text, user, tweet);
            negotiationState.current_offer.amount = ourTokenAmount;
            negotiationState.current_offer.counterparty_amount = counterpartyTokenAmount;
            
            if (shouldAccept) {
                const wasAccepted = await this.acceptDeal(tweet, thread, message, user, negotiationState);
                return wasAccepted;
            } else {
                negotiationState.current_offer = previousOffer;
                const success = await this.offerTradeDeal(tweet, thread, message, user, negotiationState);
                if (!success) {
                    elizaLogger.error("Failed to send counter-proposal in processNegotiationResponse");
                    return false;
                }
                elizaLogger.log(`Made counter-proposal to ${user.username}`);
                return true;
            }
        } else {
            const evaluation = await this.evaluateAcceptance(tweet, message, user);
            console.log("Evaluated the counterparty's acceptance:", evaluation);

            if (evaluation) {
                const wasAccepted = await this.acceptDeal(tweet, thread, message, user, negotiationState);
                return wasAccepted;
            } else {
                if (negotiationState.negotiation_count == negotiationState.max_negotiations) {
                    elizaLogger.log("Max negotiations reached", tweet);
                    const success = await this.endNegotiation(tweet, thread, message, user);
                    if (!success) {
                        elizaLogger.error("Failed to end negotiation properly");
                        return false;
                    }
                    return true;
                } else {
                    negotiationState.current_offer = previousOffer;
                    const success = await this.offerTradeDeal(tweet, thread, message, user, negotiationState);
                    if (!success) {
                        elizaLogger.error("Failed to send counter-proposal after rejection");
                        return false;
                    }
                    elizaLogger.log(`Made counter-proposal to ${user.username}`);
                }
            }
        }

        return true;
    }

    private async sendEscrowCompleteNotification(task: PollingTask): Promise<void> {
        if (!task.tweet || !task.message) {
            elizaLogger.log('Missing tweet or message data for completed escrow task');
            return;
        }

        const formattedConversation = this.getFormattedConversation(task.thread as Tweet[]);

        const tradeMessage = `https://solscan.io/account/${task.escrow}\n\n`

        const state = await this.client.runtime.composeState(task.message as Memory, {
            escrowCompletePostExamples: this.client.runtime.character.escrowCompletePostExamples,
            twitterClient: this.client.twitterClient,
            twitterUserName: settings.TWITTER_USERNAME,
            currentPost: task.tweet.text,
            formattedConversation: formattedConversation,
            username: task.tweet.username,
            escrowId: task.escrow,
            transactionComplete: true
        });

        const context = composeContext({
            state,
            template: this.escrowCompleteTemplate
        });

        const response = await generateMessageResponse({
            runtime: this.client.runtime,
            context,
            modelClass: ModelClass.MEDIUM,
        });

        const fullResponse = tradeMessage + response.text;

        await this.sendReply(task.tweet as Tweet, task.message as Memory, fullResponse, task.tweet.id);
        elizaLogger.log(`Sent escrow completion notification for tweet ${task.tweet.id}`);

        const tradeDetails = `Completed escrow ${task.escrow}: Sent ${task.tradeDetails.sentAmount} $${task.tradeDetails.sentSymbol} and received ${task.tradeDetails.receivedAmount} $${task.tradeDetails.receivedSymbol}`;
        await this.saveAllyInformation(task.tweet.username, tradeDetails);
        await this.saveNegotiationState(task.tweet.username, {
            negotiation_status: "completed"
        });
    }

    public async notifyEscrowComplete(task: PollingTask): Promise<void> {
        await this.sendEscrowCompleteNotification(task);
    }

    public async getAllyInformation(username: string): Promise<string> {
        const allyKey = `ally_${username}`;
        
        const existingMemory = await this.client.runtime.messageManager.getMemoryById(stringToUuid(allyKey));
        
        if (existingMemory) {
            const allyInfo = JSON.parse(existingMemory.content.text);
            const tradeHistory = allyInfo.trades
                .map((trade: { tradeDetails: string, date: string }) => 
                    `- ${new Date(trade.date).toLocaleDateString()}: ${trade.tradeDetails}`)
                .join('\n');
            
            return `Trading History with ${username}:\n${tradeHistory}`;
        }
        
        return '';
    }

    // Can pass into post.ts etc
    private async getFormattedAllyList(): Promise<string> {
        const memories = await this.client.runtime.messageManager.getMemoriesByRoomIds({
            roomIds: [stringToUuid("ally_room")],
            agentId: this.client.runtime.agentId,
        });

        const allyList = memories.map(memory => {
            const allyInfo = JSON.parse(memory.content.text);
            const trades = allyInfo.trades.map(trade => `Date: ${trade.date}, Details: ${trade.tradeDetails}`).join("\n  ");
            return `Username: ${allyInfo.username}\n  Trades:\n  ${trades}`;
        });

        return allyList.join("\n\n");
    }

    private async hasInitiatedTransfer(tweet: Tweet, message: Memory) {
        const state = await this.client.runtime.composeState(message, {
            twitterClient: this.client.twitterClient,
            twitterUserName: settings.TWITTER_USERNAME,
            proposalText: tweet.text 
        });
        
        const hasInitiatedTransferTemplate =
        `# Task: Evaluate The Message and Determine if the User has Initiated a Transfer:
        {{proposalText}}

        Respond with YES ONLY if the user has initiated/sent a transfer and provided a transaction ID (Tx ID)
        Respond with NO for everything else 
        ` + booleanFooter;

        const evaluationContext = composeContext({
            state,
            template: hasInitiatedTransferTemplate 
        });

        const evaluation = await generateTrueOrFalse({
            runtime: this.client.runtime,
            context: evaluationContext,
            modelClass: ModelClass.SMALL,
        });

        return evaluation;
    }

    private async initiateTransfer(tweet: Tweet, thread: Tweet[], message: Memory, user: WhitelistedUser) {
        try {
            const negotiationSettings = this.loadNegotiationSettings();
            const txMatch = tweet.text.match(/Tx ID: ([^\s]+)/);
            if (!txMatch) {
                elizaLogger.error("Could not find transaction ID in tweet");
                return false;
            }

            const fullTransactionId = txMatch[1];
            const transactionId = fullTransactionId.slice(0, 88);

            const mintA = new PublicKey(user.contract_address);
            const mintB = new PublicKey(negotiationSettings.our_token.contract_address);

            const negotiationState = await this.loadNegotiationState(user.username);
            if (!negotiationState?.current_offer) {
                elizaLogger.error("No current offer found in negotiation state");
                return false;
            }

            const pollingService = TokenPollingService.getInstance(this.connection);

            const privateKeyString = settings.WALLET_PRIVATE_KEY!;
            const secretKey = bs58.decode(privateKeyString);
            const taker = Keypair.fromSecretKey(secretKey);

            const success = await pollingService.verifyAndCompleteEscrow(
                taker,
                transactionId,
                mintA,
                mintB,
                negotiationState.current_offer.counterparty_amount,
                negotiationState.current_offer.amount
            );

            if (success) {
                const formattedConversation = this.getFormattedConversation(thread);

                const state = await this.client.runtime.composeState(message, {
                    initiatedTransferPostExamples: this.client.runtime.character.initiatedTransferPostExamples,
                    twitterClient: this.client.twitterClient,
                    twitterUserName: settings.TWITTER_USERNAME,
                    currentPost: tweet.text,
                    formattedConversation: formattedConversation,
                    username: user.username,
                    transactionComplete: true
                });

                const context = composeContext({
                    state,
                    template: this.initiatedTransferTemplate
                });

                const response = await generateMessageResponse({
                    runtime: this.client.runtime,
                    context,
                    modelClass: ModelClass.MEDIUM,
                });

                await this.sendReply(tweet, message, response.text, tweet.id);
                
                const tradeDetails = `Completed escrow: Sent ${negotiationState.current_offer.amount} $${negotiationSettings.our_token.symbol} and received ${negotiationState.current_offer.counterparty_amount} $${user.token_symbol}`;
                await this.saveAllyInformation(user.username, tradeDetails);

                await this.saveNegotiationState(user.username, {
                    negotiation_status: "completed"
                });
                
                return true;
            } else {
                elizaLogger.log("Initiating transfer failed");
                return false;
            }

        } catch (error) {
            elizaLogger.error("Error initiating transfer:", {
                message: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
                error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
            });
            throw error;
        }
    }

    private async loadBlacklist(): Promise<string[]> {
        try {
            if (fs.existsSync(this.blacklistPath)) {
                const fileContents = await fsPromises.readFile(this.blacklistPath, 'utf-8');
                const data = yaml.load(fileContents) as BlacklistedUsers;
                return data.usernames.map(username => username.toLowerCase());
            }
        } catch (error) {
            elizaLogger.error('Error loading blacklisted users:', {
                message: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
                error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
            });
        }
        return [];
    }

    private async reloadNegotiationSettings() {
        const negotiationSettings = this.loadNegotiationSettings();
        this.whitelistedUsers = negotiationSettings.whitelisted_users;
        this.counterpartyTiers = negotiationSettings.counterparty_tiers;
        this.blacklistedUsers = await this.loadBlacklist();
    }
}
