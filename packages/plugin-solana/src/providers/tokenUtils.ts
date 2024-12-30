import { elizaLogger, IAgentRuntime, settings } from '@ai16z/eliza';
import { fetchWithRetry } from './fetchUtils'; 

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
    throw new Error("No token pairs found.");
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
      throw new Error("No SOL price data found");
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