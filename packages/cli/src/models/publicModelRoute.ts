import type {OpenAICompatibleModelConfig} from "./modelConfig.js";
import type {
  OpenAICompatibleProvider,
  ParsedProviderSlug,
} from "./openAICompatibleProviders.js";

export type PublicEnvironment = Readonly<Record<string, string | undefined>>;
export interface PublicCompatibleRoute {
  modelId: string;
  baseURL: string;
  maxTokens: number | undefined;
  temperature: number | undefined;
  providerOptions: OpenAICompatibleModelConfig["providerOptions"];
  supportsStructuredOutputs: boolean;
}

/** Preserve the executed endpoint spelling, removing only normal trailing slashes. */
export function normalizePublicEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Endpoint must be a nonsecret HTTP(S) base URL.");
  }
  if (
    !endpoint ||
    endpoint !== endpoint.trim() ||
    !["http:", "https:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    endpoint.includes("?") ||
    endpoint.includes("#")
  ) {
    throw new Error("Endpoint must be a nonsecret HTTP(S) base URL.");
  }
  let normalized = endpoint;
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

export function resolvePublicProviderEndpoint(
  provider: OpenAICompatibleProvider,
  env: PublicEnvironment = process.env
): string {
  const endpoint = env[provider.baseURLEnv]?.trim() || provider.defaultBaseURL;
  if (!endpoint)
    throw new Error(
      `Provider "${provider.prefix}" requires env var ${provider.baseURLEnv} to be set (no default base URL).`
    );
  return normalizePublicEndpoint(endpoint);
}

export function resolvePublicCompatibleSlug(
  parsed: ParsedProviderSlug,
  env: PublicEnvironment = process.env
): PublicCompatibleRoute {
  const maxTokensEnv = `${parsed.provider.prefix.toUpperCase()}_MAX_TOKENS`;
  const raw = env[maxTokensEnv]?.trim();
  const maxTokens = raw ? Number.parseInt(raw, 10) : undefined;
  if (raw && (!Number.isFinite(maxTokens) || maxTokens! <= 0))
    throw new Error(`${maxTokensEnv} must be a positive integer.`);
  return {
    modelId: parsed.modelId,
    baseURL: resolvePublicProviderEndpoint(parsed.provider, env),
    maxTokens,
    temperature: undefined,
    providerOptions: undefined,
    supportsStructuredOutputs:
      parsed.provider.supportsStructuredOutputs ?? false,
  };
}

export function resolvePublicCompatibleConfig(
  slug: string,
  config: OpenAICompatibleModelConfig,
  env: PublicEnvironment = process.env
): PublicCompatibleRoute {
  const endpoint = config.baseURL ?? env[config.baseURLEnv!]?.trim();
  if (!endpoint)
    throw new Error(
      `Model "${slug}": env var ${config.baseURLEnv} (referenced via baseURLEnv) is not set.`
    );
  return {
    modelId: config.model,
    baseURL: normalizePublicEndpoint(endpoint),
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    providerOptions: config.providerOptions,
    supportsStructuredOutputs: config.supportsStructuredOutputs ?? false,
  };
}
