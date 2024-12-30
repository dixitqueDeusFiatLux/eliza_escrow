import { elizaLogger, IAgentRuntime } from "@ai16z/eliza";

export async function fetchWithRetry(
  url: string,
  runtime: IAgentRuntime,
  options?: RequestInit,
): Promise<any> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < runtime?.character?.settings?.wallet?.max_retries; attempt++) {
    try {
      const response = await fetch(url, options);
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      return await response.json();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (attempt < runtime?.character?.settings?.wallet?.max_retries - 1) {
        elizaLogger.warn(`Attempt ${attempt + 1} failed, retrying in ${runtime?.character?.settings?.wallet?.retry_delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, runtime?.character?.settings?.wallet?.retry_delay));
      }
    }
  }

  throw lastError || new Error('Failed to fetch after multiple attempts');
}