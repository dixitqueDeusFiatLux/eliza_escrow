import { IAgentRuntime, Plugin, State, Memory } from "@elizaos/core";
import { allianceAction } from "./actions/alliance";
import { hasOfferedTokensAction } from "./actions/hasOfferedTokens";
import { hasAcceptedOfferAction } from "./actions/hasAcceptedOffer";
import { NegotiationService } from "./services/NegotiationService";

import { WalletProvider } from "@elizaos/plugin-solana";
console.log("NEGOTIATIONS PLUGIN")
let negotiationService: NegotiationService | null = null;

export const negotiationsPlugin: Plugin = {
    name: "negotiations",
    description: "Plugin for handling negotiations",
    actions: [
        allianceAction,
        hasOfferedTokensAction,
        hasAcceptedOfferAction
    ],
    providers: [
        {
        get: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<NegotiationService> => {
            if (!negotiationService) {
                negotiationService = NegotiationService.getInstance(runtime);
            }
            return negotiationService;
        }},
    ],
    services: [],
    evaluators: []
};

export default negotiationsPlugin;

export * from "./actions/alliance";
export * from "./actions/hasOfferedTokens";
export * from "./actions/hasAcceptedOffer";