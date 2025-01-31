export * from "./providers/token.ts";
export * from "./providers/wallet.ts";
export * from "./providers/trustScoreProvider.ts";
export * from "./evaluators/trust.ts";

import { Plugin, IAgentRuntime, Memory, State, settings } from "@elizaos/core";
import { executeSwap } from "./actions/swap.ts";
import take_order from "./actions/takeOrder";
import pumpfun from "./actions/pumpfun.ts";
import fomo from "./actions/fomo.ts";
import { executeSwapForDAO } from "./actions/swapDao";
import transferToken from "./actions/transfer.ts";
import { walletProvider } from "./providers/wallet.ts";
import { trustScoreProvider } from "./providers/trustScoreProvider.ts";
import { trustEvaluator } from "./evaluators/trust.ts";
import { TokenProvider } from "./providers/token.ts";
import { WalletProvider } from "./providers/wallet.ts";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";

export { TokenProvider, WalletProvider };

const connection = new Connection(settings.RPC_URL, "confirmed");

let walletProviderInstance: WalletProvider | null = null;

export const solanaPlugin: Plugin = {
    name: "solana",
    description: "Solana Plugin for Eliza",
    actions: [
        //executeSwap,
        //pumpfun,
        //fomo,
        //transferToken,
        //executeSwapForDAO,
        //take_order,
    ],
    evaluators: [],
    providers: [{
        get: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<string> => {
            if (!walletProviderInstance) {
                const publicKey = new PublicKey(runtime.getSetting("WALLET_PUBLIC_KEY"));
                walletProviderInstance = WalletProvider.getInstance(connection, publicKey);
            }
            return walletProviderInstance.getFormattedPortfolio(runtime);
        }},
        trustScoreProvider
    ],
};
export { fetchTokenData, getAveragedPrice } from './providers/tokenUtils';
export { getSplTokenHoldings } from './providers/walletUtils';

export default solanaPlugin;

export { TokenPollingService } from './services/tokenPollingService';
export type { PollingTask } from './services/tokenPollingService';
