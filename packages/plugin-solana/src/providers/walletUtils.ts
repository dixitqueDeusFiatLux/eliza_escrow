import { elizaLogger } from "@ai16z/eliza";
import { Connection, PublicKey } from "@solana/web3.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export interface SplTokenHolding {
  mintAddress: string;
  amount: number;
  decimals: number;
}

export async function getSplTokenHoldings(
  connection: Connection,
  walletPublicKey: PublicKey
): Promise<SplTokenHolding[]> {
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      walletPublicKey,
      {
        programId: TOKEN_PROGRAM_ID,
      }
    );

    return tokenAccounts.value.map((tokenAccount) => {
      const accountData = tokenAccount.account.data.parsed.info;
      return {
        mintAddress: accountData.mint,
        amount: parseFloat(accountData.tokenAmount.uiAmountString),
        decimals: accountData.tokenAmount.decimals,
      };
    });
  } catch (error) {
    elizaLogger.error("Error fetching SPL token holdings:", {
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
    });
    throw error;
  }
}

export async function getSolBalance(
  connection: Connection,
  walletPublicKey: PublicKey
): Promise<number> {
  try {
    const lamports = await connection.getBalance(walletPublicKey);
    
    const solBalance = lamports / 1e9;
    
    return solBalance;
  } catch (error) {
    elizaLogger.error("Error fetching SOL balance:", {
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      error: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
    });
    throw error;
  }
}
