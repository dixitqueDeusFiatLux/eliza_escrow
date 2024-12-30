import { IAgentRuntime, Memory, Provider, State, settings, elizaLogger } from "@ai16z/eliza";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import BigNumber from "bignumber.js";
import NodeCache from "node-cache";
import { getSolBalance, getSplTokenHoldings } from './walletUtils';
import { fetchTokenData, getAveragedPrice, getSolanaPrice } from './tokenUtils';
import { TokenPollingService } from '../services/tokenPollingService';

export interface Item {
  name: string;
  address: string;
  symbol: string;
  decimals: number;
  balance: string;
  uiAmount: string;
  priceUsd: string;
  valueUsd: string;
  valueSol?: string;
}

interface WalletPortfolio {
  totalUsd: string;
  totalSol?: string;
  items: Array<Item>;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class WalletProvider {
  private static instance: WalletProvider;
  private cache: NodeCache;
  private pollingService: TokenPollingService;

  constructor(
    private connection: Connection,
    private walletPublicKey: PublicKey
  ) {
    this.cache = new NodeCache({ stdTTL: 300 });
    this.pollingService = TokenPollingService.getInstance(this.connection);
    this.pollingService.startPolling();
  }

  public static getInstance(connection: Connection, walletPublicKey: PublicKey): WalletProvider {
    if (!WalletProvider.instance) {
      WalletProvider.instance = new WalletProvider(connection, walletPublicKey);
    }
    return WalletProvider.instance;
  }

  async fetchPortfolioValue(runtime: IAgentRuntime): Promise<WalletPortfolio> {
    try {
      const cacheKey = `portfolio-${this.walletPublicKey}`;
      const cachedValue = this.cache.get<WalletPortfolio>(cacheKey);

      if (cachedValue) {
        return cachedValue;
      }

      const solBalance = await getSolBalance(
        this.connection,
        this.walletPublicKey
      );

      const splTokens = await getSplTokenHoldings(
        this.connection,
        this.walletPublicKey
      );

      const holdings = [
        {
          mintAddress: settings.SOL_ADDRESS,
          amount: solBalance,
          decimals: 9,
        },
        ...splTokens,
      ];

      const prices: { [key: string]: { usd: string; sol: string } } = {};
      const tokenMetadata: { [key: string]: { name: string; symbol: string } } = {};

      const solPrice = await getSolanaPrice(runtime);
      prices[settings.SOL_ADDRESS] = {
        usd: solPrice.toString(),
        sol: "1",
      };
      tokenMetadata[settings.SOL_ADDRESS] = {
        name: "Solana",
        symbol: "SOL",
      };

      for (const token of holdings) {
        // Skip SOL as we already handled it
        if (token.mintAddress === settings.SOL_ADDRESS) continue;

        const tokenData = await fetchTokenData(token.mintAddress, runtime);
        if (tokenData) {
          const averagedPrice = getAveragedPrice(tokenData);
          prices[token.mintAddress] = {
            usd: averagedPrice.averagePriceUsd,
            sol: averagedPrice.averagePriceSol,
          };
          tokenMetadata[token.mintAddress] = {
            name: averagedPrice.tokenName,
            symbol: averagedPrice.tokenSymbol,
          };
        } else {
          elizaLogger.error(
            `No price data found for token ${token.mintAddress}`
          );
          prices[token.mintAddress] = {
            usd: "0",
            sol: "0",
          };
          tokenMetadata[token.mintAddress] = {
            name: "Unknown",
            symbol: "Unknown",
          };
        }

        await sleep(2000); // DexScreener rate limit is 60 requests per minute
      }

      const items: Item[] = [];
      let totalUsd = new BigNumber(0);

      for (const token of holdings) {
        const priceInfo = prices[token.mintAddress];
        const amount = new BigNumber(token.amount.toString());
        const priceUsd = new BigNumber(priceInfo.usd);
        const valueUsd = amount.multipliedBy(priceUsd);
        totalUsd = totalUsd.plus(valueUsd);

        let valueSol = new BigNumber(0);
        if (new BigNumber(solPrice).gt(0)) {
          valueSol = valueUsd.dividedBy(solPrice);
        }

        const metadata = tokenMetadata[token.mintAddress] || {
          name: "Unknown",
          symbol: "Unknown",
        };

        items.push({
          name: metadata.name,
          address: token.mintAddress,
          symbol: metadata.symbol,
          decimals: token.decimals,
          balance: amount.toFixed(token.decimals),
          uiAmount: amount.toFixed(token.decimals),
          priceUsd: priceUsd.toFixed(2),
          valueUsd: valueUsd.toFixed(2),
          valueSol: valueSol.toFixed(6),
        });
      }

      const totalSol = totalUsd.dividedBy(solPrice);

      const portfolio = {
        totalUsd: totalUsd.toFixed(2),
        totalSol: totalSol.toFixed(6),
        items: items.sort((a, b) =>
          new BigNumber(b.valueUsd)
            .minus(new BigNumber(a.valueUsd))
            .toNumber()
        ),
      };

      this.cache.set(cacheKey, portfolio);
      return portfolio;
    } catch (error) {
      elizaLogger.error("Error fetching portfolio:", {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
      });
      throw error;
    }
  }

  async getFormattedPortfolio(runtime): Promise<string> {
    try {
      const walletAddress = this.walletPublicKey.toBase58();
      
      const formattedCacheKey = `formatted-portfolio-${walletAddress}`;
      const cachedFormatted = this.cache.get<string>(formattedCacheKey);
      
      if (cachedFormatted) {
        return cachedFormatted;
      }

      const portfolio = await this.fetchPortfolioValue(runtime);

      if (!portfolio) {
        elizaLogger.error("Missing data after fetch:", {
          message: "Failed to fetch required portfolio data",
          portfolio,
          error: JSON.stringify({ portfolio }, null, 2)
        });
        throw new Error("Failed to fetch required portfolio data");
      }

      const formattedPortfolio = this.formatPortfolio(runtime, portfolio);
      
      this.cache.set(formattedCacheKey, formattedPortfolio);
      return formattedPortfolio;
    } catch (error) {
      elizaLogger.error("Error generating portfolio report:", {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
      });
      return "Unable to fetch wallet information. Please try again later.";
    }
  }

  formatPortfolio(
    runtime,
    portfolio: WalletPortfolio,
  ): string {
    let output = "";
    output += `Wallet Address: ${this.walletPublicKey.toBase58()}\n\n`;

    const totalUsdFormatted = new BigNumber(portfolio.totalUsd).toFixed(2);
    const totalSolFormatted = portfolio.totalSol;

    output += `Total Value: $${totalUsdFormatted} (${totalSolFormatted} SOL)\n\n`;
    output += "Token Balances:\n";

    const filteredItems = portfolio.items.filter((item) =>
      new BigNumber(item.uiAmount).isGreaterThan(0)
    );

    if (filteredItems.length === 0) {
      output += "No tokens found with non-zero balance\n";
    } else {
      for (const item of filteredItems) {
        const valueUsd = new BigNumber(item.valueUsd).toFixed(2);
        output += `${item.name || "Unknown"} (${item.symbol || "Unknown"}): ${new BigNumber(
          item.uiAmount
        ).toFixed(6)} ($${valueUsd} | ${item.valueSol} SOL)\n`;
      }
    }

    output += "\nMarket Prices:\n";
    for (const item of portfolio.items) {
      output += `${item.symbol}: $${new BigNumber(item.priceUsd).toFixed(8)}\n`;
    }
    return output;
  }

  async startTokenPolling(
    mintAddress: string,
    expectedAmount: string,
    accounts: {
      escrow: string;
      initializer: string;
      taker: string;
      mintA: string;
      initializerAtaA: string;
      initializerAtaB: string;
      takerAtaA: string;
      takerAtaB: string;
      vaultA: string;
      initializerSecretKey: number[];
      tweet: {
        id: string;
        text: string;
        username: string;
        timestamp: number;
        conversationId: string;
      };
    },
    threshold: number = 0.95
  ): Promise<void> {
    const associatedTokenAccount = await getAssociatedTokenAddress(
      new PublicKey(mintAddress),
      this.walletPublicKey
    );

    const pollingService = TokenPollingService.getInstance(this.connection);
    pollingService.addPollingTask(
      associatedTokenAccount.toString(),
      mintAddress,
      expectedAmount,
      accounts,
      threshold
    );
  }

  async stopTokenPolling(tweetId: string): Promise<void> {
    const pollingService = TokenPollingService.getInstance(this.connection);
    pollingService.removePollingTask(tweetId);
  }

  async fetchPrices(runtime): Promise<{ [key: string]: { usd: string } }> {
    try {
      const cacheKey = "prices";
      const cachedValue = this.cache.get<{ [key: string]: { usd: string } }>(cacheKey);

      if (cachedValue) {
        return cachedValue;
      }

      const portfolio = await this.fetchPortfolioValue(runtime);
      const prices: { [key: string]: { usd: string } } = {};
      
      // Convert portfolio items to price format
      for (const item of portfolio.items) {
        prices[item.symbol.toLowerCase()] = {
          usd: item.priceUsd
        };
      }

      // Ensure we have solana price
      if (!prices.solana && portfolio.items.find(item => item.address === settings.SOL_ADDRESS)) {
        const solItem = portfolio.items.find(item => item.address === settings.SOL_ADDRESS);
        prices.solana = {
          usd: solItem!.priceUsd
        };
      }

      this.cache.set(cacheKey, prices);
      return prices;
    } catch (error) {
      elizaLogger.error("Error fetching prices:", {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
      });
      throw error;
    }
  }
}

const walletProvider: Provider = {
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<string> => {
    try {
      console.log("HELLO");
      const walletPublicKeySetting = runtime.getSetting("WALLET_PUBLIC_KEY");
      if (!walletPublicKeySetting) {
        elizaLogger.error(
          "Wallet public key is not configured in settings"
        );
        return "";
      }

      if (
        typeof walletPublicKeySetting !== "string" ||
        walletPublicKeySetting.trim() === ""
      ) {
        elizaLogger.error("Invalid wallet public key format");
        return "";
      }

      let publicKey: PublicKey;
      try {
        publicKey = new PublicKey(walletPublicKeySetting);
      } catch (error) {
        elizaLogger.error("Error creating PublicKey:", {
          message: error instanceof Error ? error.message : 'Unknown error',
          stack: error instanceof Error ? error.stack : undefined,
          error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
        });
        return "";
      }

      const connection = new Connection(settings.RPC_URL, "confirmed");
      const provider = new WalletProvider(connection, publicKey);

      const portfolio = await provider.getFormattedPortfolio(runtime);
      console.log("portfolio", portfolio);
      return portfolio;
    } catch (error) {
      elizaLogger.error("Error in wallet provider:", {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
      });
      return `Failed to fetch wallet information: ${
        error instanceof Error ? error.message : "Unknown error"
      }`;
    }
  },
};

export { walletProvider };