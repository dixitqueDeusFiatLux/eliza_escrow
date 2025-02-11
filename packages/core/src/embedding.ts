import path from "node:path";

import { trimTokens } from "./generation.ts";
import elizaLogger from "./logger.ts";
import { models } from "./models.ts";
import settings from "./settings.ts";
import { IAgentRuntime, ModelClass, ModelProviderName } from "./types.ts";

interface EmbeddingOptions {
    model: string;
    endpoint: string;
    apiKey?: string;
    length?: number;
    isOllama?: boolean;
}

async function getRemoteEmbedding(
    input: string,
    options: EmbeddingOptions
): Promise<number[]> {
    // Ensure endpoint ends with /v1 for OpenAI
    const baseEndpoint = options.endpoint.endsWith("/v1")
        ? options.endpoint
        : `${options.endpoint}${options.isOllama ? "/v1" : ""}`;

    // Construct full URL
    const fullUrl = `${baseEndpoint}/embeddings`;

    // Remove length from request body for OpenAI models
    const isOpenAI = options.model.startsWith("text-embedding-");
    const requestBody = {
        input,
        model: options.model,
        // Only include length for non-OpenAI models
        ...(isOpenAI ? {} : { length: options.length || 1536 }),
    };

    const requestOptions = {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(options.apiKey
                ? {
                      Authorization: `Bearer ${options.apiKey}`,
                  }
                : {}),
        },
        body: JSON.stringify(requestBody),
    };

    try {
        const response = await fetch(fullUrl, requestOptions);

        if (!response.ok) {
            elizaLogger.error("API Response:", await response.text());
            throw new Error(
                `Embedding API Error: ${response.status} ${response.statusText}`
            );
        }

        interface EmbeddingResponse {
            data: Array<{ embedding: number[] }>;
        }

        const data: EmbeddingResponse = await response.json();
        const embedding = data?.data?.[0].embedding;

        // Validate embedding dimension
        if (embedding && embedding.length !== 1536) {
            elizaLogger.warn(`Unexpected embedding dimension: ${embedding.length}. Expected 1536.`);
        }

        return embedding;
    } catch (e) {
        elizaLogger.error("Full error details:", e);
        throw e;
    }
}

/**
 * Send a message to the OpenAI API for embedding.
 * @param input The input to be embedded.
 * @returns The embedding of the input.
 */
export async function embed(runtime: IAgentRuntime, input: string) {
    const modelProvider = models[runtime.character.modelProvider];
    //need to have env override for this to select what to use for embedding if provider doesnt provide or using openai
    const embeddingModel = settings.USE_OPENAI_EMBEDDING
        ? "text-embedding-3-small" // Use OpenAI if specified
        : modelProvider.model?.[ModelClass.EMBEDDING] || // Use provider's embedding model if available
          models[ModelProviderName.OPENAI].model[ModelClass.EMBEDDING]; // Fallback to OpenAI

    if (!embeddingModel) {
        throw new Error("No embedding model configured");
    }

    // // Try local embedding first
    // Check if we're in Node.js environment
    const isNode =
        typeof process !== "undefined" &&
        process.versions != null &&
        process.versions.node != null;

    if (
        isNode &&
        runtime.character.modelProvider !== ModelProviderName.OPENAI &&
        !settings.USE_OPENAI_EMBEDDING
    ) {
        return await getLocalEmbedding(input);
    }

    // Check cache
    const cachedEmbedding = await retrieveCachedEmbedding(runtime, input);
    if (cachedEmbedding) {
        return cachedEmbedding;
    }

    // Get remote embedding
    return await getRemoteEmbedding(input, {
        model: embeddingModel,
        endpoint: settings.USE_OPENAI_EMBEDDING
            ? "https://api.openai.com/v1" // Always use OpenAI endpoint when USE_OPENAI_EMBEDDING is true
            : runtime.character.modelEndpointOverride || modelProvider.endpoint,
        apiKey: settings.USE_OPENAI_EMBEDDING
            ? settings.OPENAI_API_KEY // Use OpenAI key from settings when USE_OPENAI_EMBEDDING is true
            : runtime.token, // Use runtime token for other providers
        isOllama:
            runtime.character.modelProvider === ModelProviderName.OLLAMA &&
            !settings.USE_OPENAI_EMBEDDING,
    });
}

//  TODO: Add back in when it can work in browser and locally
async function getLocalEmbedding(input: string): Promise<number[]> {
    // Check if we're in Node.js environment
    const isNode =
        typeof process !== "undefined" &&
        process.versions != null &&
        process.versions.node != null;

    if (isNode) {
        const fs = await import("fs");
        const { FlagEmbedding } = await import("fastembed");
        const { fileURLToPath } = await import("url");

        function getRootPath() {
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = path.dirname(__filename);

            const rootPath = path.resolve(__dirname, "..");
            if (rootPath.includes("/eliza/")) {
                return rootPath.split("/eliza/")[0] + "/eliza/";
            }

            return path.resolve(__dirname, "..");
        }

        const cacheDir = getRootPath() + "/cache/";

        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }

        const embeddingModel = await FlagEmbedding.init({
            cacheDir: cacheDir,
        });

        const trimmedInput = trimTokens(input, 8000, "gpt-4o-mini");
        const embedding = await embeddingModel.queryEmbed(trimmedInput);
        return embedding;
    } else {
        // Browser implementation - fallback to remote embedding
        elizaLogger.warn(
            "Local embedding not supported in browser, falling back to remote embedding"
        );
        throw new Error("Local embedding not supported in browser");
    }
}

export async function retrieveCachedEmbedding(
    runtime: IAgentRuntime,
    input: string
) {
    if (!input) {
        elizaLogger.log("No input to retrieve cached embedding for");
        return null;
    }

    const similaritySearchResult =
        await runtime.messageManager.getCachedEmbeddings(input);
    if (similaritySearchResult.length > 0) {
        return similaritySearchResult[0].embedding;
    }
    return null;
}
