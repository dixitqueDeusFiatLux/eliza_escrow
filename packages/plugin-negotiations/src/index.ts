import { Plugin } from "@elizaos/core";
import { allianceAction } from "./actions/alliance";
import { hasOfferedTokensAction } from "./actions/hasOfferedTokens";
import { hasAcceptedOfferAction } from "./actions/hasAcceptedOffer";

export const negotiationsPlugin: Plugin = {
    name: "negotiations",
    description: "Plugin for handling negotiations",
    actions: [
        allianceAction,
        hasOfferedTokensAction,
        hasAcceptedOfferAction
    ],
    providers: [],
    services: [],
    evaluators: []
};

export default negotiationsPlugin;

export * from "./actions/alliance";
export * from "./actions/hasOfferedTokens";
export * from "./actions/hasAcceptedOffer";

export { NegotiationService } from "./services/NegotiationService";