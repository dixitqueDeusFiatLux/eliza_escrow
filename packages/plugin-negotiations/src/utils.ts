import { IAgentRuntime, Memory, stringToUuid, elizaLogger, ModelClass, composeContext, generateTrueOrFalse, booleanFooter, State, Content, settings, generateText, generateMessageResponse, messageCompletionFooter } from "@elizaos/core";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import path from "path";
import fs from "fs";
import yaml from "js-yaml";
import { WhitelistedUser, CounterpartyTier, NegotiationSettings, NegotiationState } from "./types";
import { fetchTokenData, getAveragedPrice, getSplTokenHoldings, TokenPollingService, PollingTask } from "@elizaos/plugin-solana";
import { Tweet } from "agent-twitter-client";
import bs58 from "bs58";
import { text } from "stream/consumers";

const __dirname = path.resolve();

function loadTemplate(templateName: string): string {
    const filePath = path.resolve(__dirname, 'negotiation_templates', `${templateName}.yaml`);
    const fileContents = fs.readFileSync(filePath, 'utf-8');
    const templateData = yaml.load(fileContents) as { template: string };
    return templateData.template + messageCompletionFooter;
}

const acceptDealTemplate = loadTemplate('acceptDealTemplate');
const finalTradeOfferTemplate = loadTemplate('finalTradeOfferTemplate');
const initialTradeOfferTemplate = loadTemplate('initialTradeOfferTemplate');
const nextTradeOfferTemplate = loadTemplate('nextTradeOfferTemplate');
const negotiationsFailedTemplate = loadTemplate('negotiationsFailedTemplate');
export const escrowCompleteTemplate = loadTemplate('escrowCompleteTemplate');
const initiatedTransferTemplate = loadTemplate('initiatedTransferTemplate');
const nonWhitelistedUserTemplate = loadTemplate('nonWhitelistedUserTemplate');
const hasTooRecentAnInteractionTemplate = loadTemplate('hasTooRecentAnInteractionTemplate');

export async function evaluateHasOfferedTokens(runtime: IAgentRuntime, state: State, proposalText: string) {
    try {
        elizaLogger.log("Evaluating has offered tokens");

        state.proposalText = proposalText;
        state.twitterUserName = settings.TWITTER_USERNAME;

        state.actions = "";

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
            runtime,
            context: evaluationContext,
            modelClass: ModelClass.LARGE,
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


export function loadNegotiationSettings(): NegotiationSettings {
    try {
        const settingsPath = path.join(__dirname, 'negotiation_settings.json');
        const settingsData = fs.readFileSync(settingsPath, 'utf8');
        return JSON.parse(settingsData);
    } catch (error) {
        elizaLogger.error('Error loading negotiation settings:', error);
        return {
            whitelisted_users: [],
            counterparty_tiers: [],
            our_token: {
                symbol: '',
                contract_address: '',
                minimum_balance: 0
            }
        };
    }
}

export async function endNegotiation(runtime: IAgentRuntime, state: State, tweet: Tweet, thread: Tweet[], message: Memory, user: WhitelistedUser, negotiationState: NegotiationState): Promise<string> {
    try {
        const formattedConversation = getFormattedConversation(thread);

        state.currentPost = tweet.text;
        state.formattedConversation = formattedConversation;
        state.username = user.username;
        state.twitterUserName = settings.TWITTER_USERNAME;
        state.negotiationFailedPostExamples = runtime.character.negotiationsFailedPostExamples;

        elizaLogger.log(`Negotiation ended with ${user.username} after reaching max negotiations`);
        const context = composeContext({
            state,
            template: negotiationsFailedTemplate
        });

        const response = await generateMessageResponse({
            runtime,
            context,
            modelClass: ModelClass.MEDIUM,
        });

        await saveNegotiationState(runtime, user.username, {
            negotiation_status: "failed"
        });

        return response.text;
    } catch (error) {
        elizaLogger.error("Error in endNegotiation:", {
            message: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined,
            error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
        });
        throw error;
    }
}

export function isWhitelistedUser(username: string): WhitelistedUser | undefined {
    if (!username) {
        elizaLogger.debug("No username provided to isWhitelistedUser");
        return undefined;
    }

    const settings = loadNegotiationSettings();
    const user = settings.whitelisted_users.find(
        (u) => u.username.toLowerCase() === username.toLowerCase()
    );

    if (!user) {
        elizaLogger.debug(`User ${username} not found in whitelist`);
        return undefined;
    }

    return user;
}

export async function hasTooRecentAnInteraction(user: WhitelistedUser, negotiationState: NegotiationState): Promise<boolean> {
    if (!negotiationState.last_interaction) {
        return false;
    }

    const counterpartyTierSettings = await getCounterpartyTierSettings(user);
    const refractoryPeriodDays = counterpartyTierSettings.refractory_period_days;
    const refractoryPeriodMs = refractoryPeriodDays * 24 * 60 * 60 * 1000;

    const lastInteraction = new Date(negotiationState.last_interaction);
    const now = new Date();
    const refractoryPeriodAgo = new Date(now.getTime() - refractoryPeriodMs);

    return lastInteraction > refractoryPeriodAgo;
}

export async function isAllianceIntent(runtime: IAgentRuntime, state: State, text: string): Promise<boolean> {
    const template = `
    # Task: Evaluate Tweet Intent
    Analyze if this tweet indicates interest in forming an alliance or some other form of collaboration. The request CANNOT be a trade offer. YES OR NO:

    "{{currentPost}}"

    ${booleanFooter}`;
    state.currentPost = text;
    state.allianceIntents = runtime.character.allianceIntents;

    state.actions = "";

    const context = composeContext({
        state,
        template
    });

    const isAlliance = await generateTrueOrFalse({
        runtime,
        context,
        modelClass: ModelClass.LARGE
    });

    return isAlliance;
}


export async function saveNegotiationState(runtime: IAgentRuntime, username: string, newState: Partial<NegotiationState>) {
    const stateKey = `negotiation_state_${username}`;
    const negotiationRoomId = stringToUuid("negotiation_room");

    try {
        await runtime.ensureConnection(
            runtime.agentId,
            negotiationRoomId,
            runtime.character.name,
            runtime.character.name,
            "twitter"
        );

        const existingMemory = await runtime.messageManager.getMemoryById(stringToUuid(stateKey));
        const existingState = existingMemory ? JSON.parse(existingMemory.content.text) : {};

        const mergedState = {
            ...existingState,
            ...newState
        };

        elizaLogger.log("Saving merged negotiation state", mergedState);

        if (existingMemory) {
            await runtime.messageManager.removeMemory(stringToUuid(stateKey));
        }

        await runtime.messageManager.createMemory({
            id: stringToUuid(stateKey),
            agentId: runtime.agentId,
            userId: runtime.agentId,
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

export async function loadNegotiationState(runtime: IAgentRuntime, username: string): Promise<NegotiationState> {
    const stateKey = `negotiation_state_${username}`;
    const memory = await runtime.messageManager.getMemoryById(stringToUuid(stateKey));

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

export async function clearNegotiationState(runtime: IAgentRuntime, username: string) {
    const stateKey = `negotiation_state_${username}`;
    await runtime.messageManager.removeMemory(stringToUuid(stateKey));
    elizaLogger.log(`Negotiation state cleared for user ${username}`);
}

export async function saveAllyInformation(runtime: IAgentRuntime, username: string, tradeDetails: string) {
    const allyKey = `ally_${username}`;
    const roomId = stringToUuid("ally_room");
    const userId = runtime.agentId;

    await runtime.ensureConnection(
        userId,
        roomId,
        runtime.character.name,
        runtime.character.name,
        "twitter"
    );

    const existingMemory = await runtime.messageManager.getMemoryById(stringToUuid(allyKey));
    let allyInfo;

    if (existingMemory) {
        allyInfo = JSON.parse(existingMemory.content.text);
        allyInfo.trades.push({
            tradeDetails,
            date: new Date().toISOString()
        });

        await runtime.messageManager.removeMemory(stringToUuid(allyKey));
    } else {
        allyInfo = {
            username,
            trades: [{
                tradeDetails,
                date: new Date().toISOString()
            }]
        };
    }

    await runtime.messageManager.createMemory({
        id: stringToUuid(allyKey),
        agentId: runtime.agentId,
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

export async function getAllyInformation(runtime: IAgentRuntime, username: string): Promise<string> {
    const allyKey = `ally_${username}`;
    const existingMemory = await runtime.messageManager.getMemoryById(stringToUuid(allyKey));

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

export async function getFormattedAllyList(runtime: IAgentRuntime): Promise<string> {
    const memories = await runtime.messageManager.getMemoriesByRoomIds({
        roomIds: [stringToUuid("ally_room")]
    });

    const allyList = memories
        .filter(memory => memory.agentId === runtime.agentId)
        .map(memory => {
            const allyInfo = JSON.parse(memory.content.text);
            const trades = allyInfo.trades.map(trade => `Date: ${trade.date}, Details: ${trade.tradeDetails}`).join("\n  ");
            return `Username: ${allyInfo.username}\n  Trades:\n  ${trades}`;
        });

    return allyList.join("\n\n");
}

interface TokenAction {
    counterparty_token_amount: number;
    our_token_amount: number;
}

interface TokenPrices {
    our_token_price: number;
    counterparty_token_price: number;
}

export async function getTokenPrices(runtime: IAgentRuntime, user: WhitelistedUser): Promise<{ our_token_price: number, counterparty_token_price: number } | null> {
    const negotiationSettings = loadNegotiationSettings();

    const our_token = await fetchTokenData(negotiationSettings.our_token.contract_address, runtime);
    const counterparty_token = await fetchTokenData(user.contract_address, runtime);

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

export async function adjustOfferLimits(walletAddress: string, connection: Connection, tierIndex: number) {
    const negotiationSettings = loadNegotiationSettings();
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

export async function getCounterpartyTierSettings(user: WhitelistedUser): Promise<CounterpartyTier> {
    const negotiationSettings = loadNegotiationSettings();
    const tierIndex = user.tier - 1;
    const counterpartyTierSettings = negotiationSettings.counterparty_tiers[tierIndex];

    if (!counterpartyTierSettings) {
        throw new Error(`No tier settings found for user ${user.username} (tier ${user.tier})`);
    }

    const connection = new Connection(settings.RPC_URL, "confirmed");
    const walletAddress = settings.WALLET_PUBLIC_KEY;

    const { maxOfferAmount } = await adjustOfferLimits(walletAddress, connection, tierIndex);


    return {
        ...counterpartyTierSettings,
        max_offer_amount: maxOfferAmount
    };

}

export async function evaluateProposedDeal(
    runtime: IAgentRuntime,
    state: State,
    proposalText: string,
    user: WhitelistedUser
): Promise<{
    shouldAccept: boolean,
    counterpartyTokenAmount: number,
    ourTokenAmount: number
}> {
    try {
        const negotiationSettings = loadNegotiationSettings();

        state.proposalText = proposalText;
        state.twitterUserName = settings.TWITTER_USERNAME;

        state.actions = "";

        const extractTokensTemplate = `
        # Task: Extract Token Information from Trade Proposal

        Current proposal:
        {{proposalText}}

        Extract the following information about token amounts:
        - ${user.token_symbol} tokens offered
        - ${negotiationSettings.our_token.symbol} tokens requested

        ONLY respond with a JSON object:
        {
            "token_amounts": {
                "counterparty_token_amount": number,
                "our_token_amount": number
            }
        }

        ${messageCompletionFooter}`;

        const evaluationContext = composeContext({
            state,
            template: extractTokensTemplate
        });

        const tokenInfo = await generateMessageResponse({
            runtime,
            context: evaluationContext,
            modelClass: ModelClass.LARGE,
        });

        elizaLogger.log("Token info", tokenInfo);

        if (!tokenInfo?.token_amounts) {
            elizaLogger.error("Failed to extract token amounts from proposal");
            return { shouldAccept: false, counterpartyTokenAmount: 0, ourTokenAmount: 0 };
        }

        const action = tokenInfo.token_amounts as TokenAction;

        const counterpartyTokenAmount = action.counterparty_token_amount || 0;
        const ourTokenAmount = action.our_token_amount || 0;

        const counterpartyTierSettings = await getCounterpartyTierSettings(user);

        if (ourTokenAmount > counterpartyTierSettings.max_offer_amount) {
            elizaLogger.log(`Proposed amounts exceed maximums - ${negotiationSettings.our_token.symbol}: ${ourTokenAmount}/${counterpartyTierSettings.max_offer_amount}`);
            return { shouldAccept: false, counterpartyTokenAmount: 0, ourTokenAmount: 0 };
        }

        if (ourTokenAmount == 0 || counterpartyTokenAmount == 0) {
            elizaLogger.log(`Proposed amounts are 0 - ${negotiationSettings.our_token.symbol}: ${ourTokenAmount}/${counterpartyTierSettings.max_offer_amount}`);
            return { shouldAccept: false, counterpartyTokenAmount: 0, ourTokenAmount: 0 };
        }

        const prices = await getTokenPrices(runtime, user);
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
        elizaLogger.error("Error in evaluateProposedDeal:", error);
        throw error;
    }
}

export function calculateOffer(counterpartyTierSettings: CounterpartyTier, our_token_price: number, counterparty_token_price: number, negotiationState: NegotiationState) {
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

export function getFormattedConversation(thread: Tweet[]) {
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

export async function acceptDeal(
    runtime: IAgentRuntime,
    state: State,
    tweet: Tweet,
    thread: Tweet[],
    message: Memory,
    user: WhitelistedUser,
    negotiationState: NegotiationState
    ): Promise<string | false> {
    try {
        const negotiationSettings = loadNegotiationSettings();

        elizaLogger.log(`Accepting deal with ${user.username}`);
        elizaLogger.log(`ourTokenAmount: ${negotiationState.current_offer.amount}, counterPartyTokenAmount: ${negotiationState.current_offer.counterparty_amount}`);
        const formattedConversation = getFormattedConversation(thread);

        let tradeMessage = '';
        let negotiationStatus = '';
        if (!negotiationState.counterparty_is_initiator) {
            const connection = new Connection(settings.RPC_URL, "confirmed");

            const execution = await initiateSmartContractAndPolling(
                connection,
                user,
                negotiationState,
                tweet,
                thread,
                message
            );

            if (execution.status === "success") {
                elizaLogger.log("Escrow initiated");
                tradeMessage = `Deal. I have sent ${negotiationState.current_offer.amount} $${negotiationSettings.our_token.symbol} \nTx ID: ${execution.transactionId} \nsend the ${negotiationState.current_offer.counterparty_amount} $${user.token_symbol} to the escrow address: \n${execution.walletAddress}. \n\n`;
                negotiationStatus = 'initiated_escrow';
            } else {
                elizaLogger.log("Escrow failed", tweet);
                return false;
            }
        } else {
            elizaLogger.log("Waiting for escrow to be initiated");
            negotiationStatus = 'waiting_for_escrow';
            state.actions = "";
            const context = composeContext({
                state,
                template: acceptDealTemplate
            });

            const response = await generateMessageResponse({
                runtime,
                context,
                modelClass: ModelClass.MEDIUM,
            });

            tradeMessage = response.text;
        }

        state.acceptDealPostExamples = runtime.character.acceptDealPostExamples;
        state.twitterUserName = settings.TWITTER_USERNAME;
        state.currentPost = tweet.text;
        state.formattedConversation = formattedConversation;
        state.username = user.username;
        state.ourTokenAmount = negotiationState.current_offer.amount;
        state.ourTokenSymbol = negotiationSettings.our_token.symbol;
        state.counterPartyTokenAmount = negotiationState.current_offer.counterparty_amount;
        state.counterPartyTokenSymbol = user.token_symbol;

        elizaLogger.log(`Accepted deal with ${user.username}`);

        const last_interaction = negotiationState.last_interaction ?? new Date().toISOString();

        await saveNegotiationState(runtime, user.username, {
            current_offer: negotiationState.current_offer,
            negotiation_status: negotiationStatus,
            conversation_id: tweet.conversationId,
            last_interaction: last_interaction
        });

        return tradeMessage;
    } catch (error) {
        elizaLogger.error("Error in acceptDeal:", {
            message: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined,
            error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
        });
        return false;
    }
}


export async function offerTradeDeal(runtime: IAgentRuntime, state: State, tweet: Tweet, thread: Tweet[], message: Memory, user: WhitelistedUser, negotiationState: NegotiationState): Promise<string> {
    try {
        const counterpartyTierSettings = await getCounterpartyTierSettings(user);

        const prices = await getTokenPrices(runtime, user);
        if (!prices) {
            elizaLogger.error("Failed to fetch token prices");
            return "";
        }

        const { our_token_price, counterparty_token_price } = prices;

        calculateOffer(counterpartyTierSettings, our_token_price, counterparty_token_price, negotiationState);

        if (negotiationState?.current_offer?.amount > 0.95 * counterpartyTierSettings.max_offer_amount) {
            negotiationState.negotiation_count = negotiationState.negotiation_count + 1;
            elizaLogger.log(`Iterating negotiation count for final offer to ${user.username}`);
        }

        let tradeTemplate = initialTradeOfferTemplate;
        if (negotiationState.negotiation_status == "pending") {
            tradeTemplate = nextTradeOfferTemplate;
        }
        if (negotiationState.negotiation_count > 0) {
            tradeTemplate = finalTradeOfferTemplate;
        }

        const formattedConversation = getFormattedConversation(thread);

        const negotiationSettings = loadNegotiationSettings();

        state.initialTradeOfferPostExamples = runtime.character.initialTradeOfferPostExamples;
        state.nextTradeOfferPostExamples = runtime.character.nextTradeOfferPostExamples;
        state.finalTradeOfferPostExamples = runtime.character.finalTradeOfferPostExamples;
        state.twitterUserName = settings.TWITTER_USERNAME;
        state.currentPost = tweet.text;
        state.formattedConversation = formattedConversation;
        state.username = user.username;
        state.ourTokenAmount = negotiationState.current_offer.amount;
        state.ourTokenSymbol = negotiationSettings.our_token.symbol;
        state.counterPartyTokenAmount = negotiationState.current_offer.counterparty_amount;
        state.counterPartyTokenSymbol = user.token_symbol;

        state.actions = "";

        const context = composeContext({
            state,
            template: tradeTemplate
        });

        const tradeOffer = await generateMessageResponse({
            runtime,
            context,
            modelClass: ModelClass.MEDIUM,
        });

        const conversationId = tweet.conversationId;
        const last_interaction = negotiationState.last_interaction ?? new Date().toISOString();

        await saveNegotiationState(runtime, user.username, {
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
        return tradeOffer.text;
    } catch (error) {
        elizaLogger.error("Error in offerTradeDeal:", {
            message: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined,
            error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
        });
        throw error;
    }
}

export function hasInitiatedTransfer(proposalText: string) {
    return proposalText.includes("Deal. I have sent");
}

export async function initiateTransfer(runtime: IAgentRuntime, tweet: Tweet, thread: Tweet[], message: Memory, user: WhitelistedUser, connection: Connection, state: State): Promise<string | false> {
    try {
        const negotiationSettings = loadNegotiationSettings();
        const txMatch = tweet.text.match(/Tx ID: ([^\s]+)/);
        if (!txMatch) {
            elizaLogger.error("Could not find transaction ID in tweet");
            return false;
        }

        const fullTransactionId = txMatch[1];
        const transactionId = fullTransactionId.slice(0, 88);

        const mintA = new PublicKey(user.contract_address);
        const mintB = new PublicKey(negotiationSettings.our_token.contract_address);

        const negotiationState = await loadNegotiationState(runtime, user.username);
        if (!negotiationState?.current_offer) {
            elizaLogger.error("No current offer found in negotiation state");
            return false;
        }

        const pollingService = TokenPollingService.getInstance(connection);

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
            const formattedConversation = getFormattedConversation(thread);

            state.initiatedTransferPostExamples = runtime.character.initiatedTransferPostExamples;
            state.twitterUserName = settings.TWITTER_USERNAME;
            state.currentPost = tweet.text;
            state.formattedConversation = formattedConversation;
            state.username = user.username;
            state.transactionComplete = true;

            state.actions = "";

            const context = composeContext({
                state,
                template: initiatedTransferTemplate
            });

            const response = await generateMessageResponse({
                runtime,
                context,
                modelClass: ModelClass.MEDIUM,
            });

            const tradeDetails = `Completed escrow: Sent ${negotiationState.current_offer.amount} $${negotiationSettings.our_token.symbol} and received ${negotiationState.current_offer.counterparty_amount} $${user.token_symbol}`;
            await saveAllyInformation(runtime, user.username, tradeDetails);

            await saveNegotiationState(runtime, user.username, {
                negotiation_status: "completed"
            });

            return response.text;
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

export async function evaluateAcceptance(runtime: IAgentRuntime, state: State, proposalText: string) {
    try {
        state.proposalText = proposalText;
        state.twitterUserName = settings.TWITTER_USERNAME;

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
            runtime,
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

export async function initiateSmartContractAndPolling(
    connection: Connection,
    user: WhitelistedUser,
    negotiationState: NegotiationState,
    tweet: Tweet,
    thread: Tweet[],
    message: Memory
) {
    try {
        const negotiationSettings = loadNegotiationSettings();
        const pollingService = TokenPollingService.getInstance(connection);

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