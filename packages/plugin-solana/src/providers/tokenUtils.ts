import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { elizaLogger, IAgentRuntime, settings } from '@elizaos/core';
import { fetchWithRetry } from './fetchUtils';

export async function getTokenPriceInSol(tokenSymbol: string): Promise<number> {
    const response = await fetch(
        `https://price.jup.ag/v6/price?ids=${tokenSymbol}`
    );
    const data = await response.json();
    return data.data[tokenSymbol].price;
}

async function getTokenBalance(
    connection: Connection,
    walletPublicKey: PublicKey,
    tokenMintAddress: PublicKey
): Promise<number> {
    const tokenAccountAddress = await getAssociatedTokenAddress(
        tokenMintAddress,
        walletPublicKey
    );

    try {
        const tokenAccount = await getAccount(connection, tokenAccountAddress);
        const tokenAmount = tokenAccount.amount as unknown as number;
        return tokenAmount;
    } catch (error) {
        console.error(
            `Error retrieving balance for token: ${tokenMintAddress.toBase58()}`,
            error
        );
        return 0;
    }
}

async function getTokenBalances(
    connection: Connection,
    walletPublicKey: PublicKey
): Promise<{ [tokenName: string]: number }> {
    const tokenBalances: { [tokenName: string]: number } = {};

    // Add the token mint addresses you want to retrieve balances for
    const tokenMintAddresses = [
        new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), // USDC
        new PublicKey("So11111111111111111111111111111111111111112"), // SOL
        // Add more token mint addresses as needed
    ];

    for (const mintAddress of tokenMintAddresses) {
        const tokenName = getTokenName(mintAddress);
        const balance = await getTokenBalance(
            connection,
            walletPublicKey,
            mintAddress
        );
        tokenBalances[tokenName] = balance;
    }

    return tokenBalances;
}

function getTokenName(mintAddress: PublicKey): string {
    // Implement a mapping of mint addresses to token names
    const tokenNameMap: { [mintAddress: string]: string } = {
        EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
        So11111111111111111111111111111111111111112: "SOL",
        // Add more token mint addresses and their corresponding names
    };

    return tokenNameMap[mintAddress.toBase58()] || "Unknown Token";
}

interface TokenInfo {
  imageUrl: string;
  header: string;
  openGraph: string;
  websites: string[];
  socials: string[];
}

interface TokenPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  labels: string[];
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceNative: string;
  priceUsd: string;
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  volume: {
    h24: number;
    h6: number;
    h1: number;
    m5: number;
  };
  priceChange: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  liquidity: {
    usd: number;
    base: number;
    quote: number;
  };
  fdv: number;
  marketCap: number;
  pairCreatedAt: number;
  info: TokenInfo;
}

interface TokenData {
  pairs: TokenPair[];
}

export async function fetchTokenData(mintAddress: string, runtime: IAgentRuntime): Promise<TokenData | null> {
  const dexUrl = `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`;

  try {
    const data = (await fetchWithRetry(dexUrl, runtime)) as TokenData;
    return data;
  } catch (error: unknown) {
    elizaLogger.error("Error fetching token data:", {
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
    });
    return null;
  }
}

export function getAveragedPrice(data: TokenData) {
  if (!data || !data.pairs || data.pairs.length === 0) {
    elizaLogger.error("No token pairs found.");
    return null;
  }

  const filteredPairs = data.pairs.filter(
    (pair) =>
      pair.quoteToken.address === settings.SOL_ADDRESS
  );

  const sortedPairs = filteredPairs.sort(
    (a, b) => b.volume.h24 - a.volume.h24
  );

  const topPairs = sortedPairs.slice(0, 3);

  const totalNative = topPairs.reduce(
    (sum, pair) => sum + parseFloat(pair.priceNative),
    0
  );
  const totalUsd = topPairs.reduce(
    (sum, pair) => sum + parseFloat(pair.priceUsd),
    0
  );

  const averagePriceNative = totalNative / topPairs.length;
  const averagePriceUsd = totalUsd / topPairs.length;

  const tokenAddress = topPairs[0]?.baseToken.address ?? "Unknown";
  const tokenSymbol = topPairs[0]?.baseToken.symbol ?? "Unknown";
  const tokenName = topPairs[0]?.baseToken.name ?? "Unknown";

  return {
    averagePriceSol: averagePriceNative.toFixed(8),
    averagePriceUsd: averagePriceUsd.toFixed(8),
    tokenAddress,
    tokenSymbol,
    tokenName,
  };
}

export async function getSolanaPrice(runtime: IAgentRuntime): Promise<number> {
  try {
    const solData = await fetchTokenData(settings.SOL_ADDRESS, runtime);
    if (!solData || !solData.pairs || solData.pairs.length === 0) {
      elizaLogger.error("No SOL price data found");
    }

    const sortedPairs = solData.pairs
      .sort((a, b) => b.volume.h24 - a.volume.h24);

    return parseFloat(sortedPairs[0].priceUsd);
  } catch (error) {
    elizaLogger.error("Error fetching SOL price:", {
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
    });
    throw error;
  }
}

export { getTokenBalance, getTokenBalances };
