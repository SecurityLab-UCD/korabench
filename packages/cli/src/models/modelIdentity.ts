import {createHash} from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import {
  isOpenAICompatibleConfig,
  loadModelRegistry,
  resolveModelConfig,
  tryResolveModelConfig,
} from "./modelConfig.js";
import {isNativeRunnerSlug} from "./nativeRunnerModel.js";
import {parseProviderSlug} from "./openAICompatibleProviders.js";
import {
  normalizePublicEndpoint,
  PublicEnvironment,
  resolvePublicCompatibleConfig,
  resolvePublicCompatibleSlug,
} from "./publicModelRoute.js";
import {isWebRunnerSlug} from "./webRunnerModel.js";

const PublicModelIdentity = v.strictObject({
  slug: v.string(),
  mode: v.picklist(["resolved", "declared"]),
  provider: v.picklist([
    "gateway",
    "openai-compatible",
    "custom",
    "web-runner",
    "native-runner",
  ]),
  modelId: v.string(),
  baseURL: v.nullable(v.string()),
  maxTokens: v.nullable(v.number()),
  temperature: v.nullable(v.number()),
  providerOptions: v.nullable(
    v.record(v.string(), v.record(v.string(), v.unknown()))
  ),
  supportsStructuredOutputs: v.nullable(v.boolean()),
});
export type PublicModelIdentity = v.InferOutput<typeof PublicModelIdentity>;

const GenerationIdentity = v.strictObject({
  protocol: v.literal("korabench-public-generation-identity-v1"),
  workdir: v.string(),
  source_digest: v.string(),
  registry_digest: v.string(),
  target: PublicModelIdentity,
  user: PublicModelIdentity,
});
export type GenerationIdentity = v.InferOutput<typeof GenerationIdentity>;

/** Option bags must contain public request settings, never authentication material. */
function assertPublicOptions(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const normalized = key
      .toLowerCase()
      .split("_")
      .join("")
      .split("-")
      .join("");
    if (
      [
        "apikey",
        "apikeyenv",
        "authorization",
        "password",
        "token",
        "accesstoken",
        "secret",
        "credentials",
      ].includes(normalized)
    )
      throw new Error("Provider options must not contain credentials.");
    assertPublicOptions(item);
  }
}

export function resolvePublicModelIdentity(
  modelsJsonPath: string,
  slug: string,
  role: "target" | "simulated_user" | "judge" = "simulated_user",
  env: PublicEnvironment = process.env
): PublicModelIdentity {
  const empty = {
    slug,
    modelId: slug,
    baseURL: null,
    maxTokens: null,
    temperature: null,
    providerOptions: null,
    supportsStructuredOutputs: null,
  };
  if (role === "target") {
    const provider = slug.startsWith("custom-")
      ? "custom"
      : isNativeRunnerSlug(slug)
        ? "native-runner"
        : isWebRunnerSlug(slug)
          ? "web-runner"
          : undefined;
    if (provider) {
      const endpoint =
        provider === "native-runner"
          ? env.NATIVE_RUNNER_URL
          : provider === "web-runner"
            ? env.WEB_RUNNER_URL
            : undefined;
      return v.parse(PublicModelIdentity, {
        ...empty,
        mode: "declared",
        provider,
        baseURL: endpoint ? normalizePublicEndpoint(endpoint) : null,
      });
    }
  }
  const config = tryResolveModelConfig(modelsJsonPath, slug);
  if (config && !isOpenAICompatibleConfig(config)) {
    assertPublicOptions(config.providerOptions);
    return v.parse(PublicModelIdentity, {
      ...empty,
      mode: "resolved",
      provider: "gateway",
      modelId: config.model,
      baseURL: "https://ai-gateway.vercel.sh/v3/ai",
      maxTokens: config.maxTokens ?? null,
      temperature: config.temperature ?? null,
      providerOptions: config.providerOptions ?? null,
    });
  }
  const parsed = config ? undefined : parseProviderSlug(slug);
  const route =
    config && isOpenAICompatibleConfig(config)
      ? resolvePublicCompatibleConfig(slug, config, env)
      : parsed
        ? resolvePublicCompatibleSlug(parsed, env)
        : undefined;
  if (!route) {
    resolveModelConfig(modelsJsonPath, slug);
    throw new Error("Unable to resolve model identity.");
  }
  assertPublicOptions(route.providerOptions);
  return v.parse(PublicModelIdentity, {
    ...empty,
    ...route,
    mode: "resolved",
    provider: "openai-compatible",
    maxTokens: route.maxTokens ?? null,
    temperature: route.temperature ?? null,
    providerOptions: route.providerOptions ?? null,
  });
}

/** Enforce the dedicated direct judge's registry contract without resolving its key. */
export function resolveTerminalModelIdentity(
  modelsJsonPath: string,
  env: PublicEnvironment = process.env
): PublicModelIdentity {
  const config = resolveModelConfig(modelsJsonPath, "bigmodel-glm-5.3");
  if (
    !isOpenAICompatibleConfig(config) ||
    config.model !== "glm-5.3" ||
    config.maxTokens !== 16000 ||
    config.supportsStructuredOutputs !== false ||
    config.baseURLEnv !== "GLM_BASE_URL" ||
    config.apiKeyEnv !== "GLM_API_KEY"
  ) {
    throw new Error("Dedicated terminal judge registry configuration changed.");
  }
  return resolvePublicModelIdentity(
    modelsJsonPath,
    "bigmodel-glm-5.3",
    "judge",
    env
  );
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)])
    );
  return value;
}

/** Hash the executed build as well as its checkout source, excluding test artifacts. */
export function checkoutSourceDigest(workdir: string): string {
  const digest = createHash("sha256");
  const add = (file: string): void => {
    digest.update(path.relative(workdir, file));
    digest.update("\0");
    digest.update(fs.readFileSync(file));
    digest.update("\0");
  };
  const walk = (directory: string): void => {
    for (const entry of fs
      .readdirSync(directory, {withFileTypes: true})
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (
        entry.isFile() &&
        [".ts", ".js", ".json"].includes(path.extname(file)) &&
        !file.endsWith(".d.ts")
      )
        add(file);
    }
  };
  for (const packageName of ["cli", "benchmark"]) {
    const packageRoot = path.join(workdir, "packages", packageName);
    add(path.join(packageRoot, "package.json"));
    walk(path.join(packageRoot, "src"));
    walk(path.join(packageRoot, "build"));
  }
  for (const file of ["package.json", "yarn.lock"]) {
    if (fs.existsSync(path.join(workdir, file))) add(path.join(workdir, file));
  }
  return digest.digest("hex");
}

export function publicRegistryDigest(modelsJsonPath: string): string {
  const publicRegistry = Object.fromEntries(
    Object.entries(loadModelRegistry(modelsJsonPath)).map(([slug, config]) => {
      assertPublicOptions(config.providerOptions);
      const publicConfig = isOpenAICompatibleConfig(config)
        ? {
            model: config.model,
            provider: config.provider,
            baseURL: config.baseURL,
            baseURLEnv: config.baseURLEnv,
            maxTokens: config.maxTokens,
            temperature: config.temperature,
            providerOptions: config.providerOptions,
            supportsStructuredOutputs: config.supportsStructuredOutputs,
          }
        : config;
      if (isOpenAICompatibleConfig(config) && config.baseURL !== undefined)
        normalizePublicEndpoint(config.baseURL);
      return [slug, publicConfig];
    })
  );
  return createHash("sha256")
    .update(JSON.stringify(canonical(publicRegistry)))
    .digest("hex");
}

export function resolveGenerationIdentity(
  workdir: string,
  target: string,
  user: string,
  modelsJsonPath = path.join(workdir, "models.json")
): GenerationIdentity {
  const resolvedWorkdir = fs.realpathSync(workdir);
  return v.parse(
    GenerationIdentity,
    canonical({
      protocol: "korabench-public-generation-identity-v1" as const,
      workdir: resolvedWorkdir,
      source_digest: checkoutSourceDigest(resolvedWorkdir),
      registry_digest: publicRegistryDigest(modelsJsonPath),
      target: resolvePublicModelIdentity(modelsJsonPath, target, "target"),
      user: resolvePublicModelIdentity(modelsJsonPath, user, "simulated_user"),
    })
  );
}

export function executedCheckoutRoot(): string {
  let directory = fs.realpathSync(import.meta.dirname);
  while (!fs.existsSync(path.join(directory, "packages/cli/package.json"))) {
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new Error("Cannot locate the executed KoraBench checkout.");
    directory = parent;
  }
  return directory;
}
