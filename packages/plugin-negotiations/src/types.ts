import { State } from "@elizaos/core";

export interface TwitterState {
    twitterUserName?: string;
    currentPost?: string;
    formattedConversation?: string;
    conversationId?: string;
    tweetId?: string;
}

export interface WhitelistedUser {
    username: string;
    wallet_address: string;
    token_symbol: string;
    contract_address: string;
    tier: number;
}

export interface CounterpartyTier {
    tier: number;
    max_offer_amount: number;
    refractory_period_days: number;
    min_offer_percentage: number;
    max_offer_percentage: number;
    max_negotiations: number;
}

export interface NegotiationSettings {
    whitelisted_users: WhitelistedUser[];
    counterparty_tiers: CounterpartyTier[];
    our_token: {
        symbol: string;
        contract_address: string;
        minimum_balance: number;
    };
}

export interface NegotiationState {
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

export type TwitterStateWithBase = State & TwitterState;