import type {
  LanguageModelV3,
  LanguageModelV3GenerateResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import {wrapLanguageModel} from "ai";
import {appendFileSync} from "node:fs";
import * as v from "valibot";
import type {UsageRole} from "./_shared.js";

interface UsageContext {
  modelId: string;
  label: string;
  role?: UsageRole;
  callKind: "text" | "structured" | "structured-fallback";
  provider: "openai-compatible" | "gateway";
}

interface LoggedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens?: number;
  inputTokenDetails: {
    noCacheTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
  };
  outputTokenDetails: {
    textTokens: number | null;
    reasoningTokens: number | null;
  };
}

interface UsageRecord {
  modelId: string;
  model: string | null;
  label: string;
  role?: UsageRole;
  callKind: UsageContext["callKind"];
  outcome: "response" | "error";
  usageStatus: "complete" | "partial" | "missing";
  usage: LoggedUsage | null;
  error?: "provider_call_failed";
}

// Only known accounting fields cross the logging boundary. Raw provider usage,
// request/response bodies, headers and exception messages can contain secrets.
const tokenCountSchema = v.nullish(v.number());
const compatibleUsageSchema = v.object({
  prompt_tokens: tokenCountSchema,
  completion_tokens: tokenCountSchema,
  total_tokens: tokenCountSchema,
  prompt_tokens_details: v.nullish(v.object({cached_tokens: tokenCountSchema})),
  completion_tokens_details: v.nullish(
    v.object({reasoning_tokens: tokenCountSchema})
  ),
});
const gatewayResponseSchema = v.object({
  response: v.optional(v.object({modelId: v.optional(v.string())})),
});

export class UsageLogError extends Error {
  constructor() {
    super(
      "Cannot persist KORA usage accounting; refusing further model attempts."
    );
    this.name = "UsageLogError";
  }
}

// A failed ledger cannot safely resume within this process: concurrent scenarios
// may already have escaped their local error boundary.
const failedUsageLogs = new Map<string, UsageLogError>();

function failUsageLog(logPath: string): never {
  const error = new UsageLogError();
  failedUsageLogs.set(logPath, error);
  throw error;
}

function loggedUsage(
  usage: LanguageModelV3Usage | undefined,
  provider: UsageContext["provider"]
): LoggedUsage {
  let inputTokens = usage?.inputTokens?.total;
  let outputTokens = usage?.outputTokens?.total;
  let totalTokens: number | undefined;
  let noCacheTokens = usage?.inputTokens?.noCache;
  let cacheReadTokens = usage?.inputTokens?.cacheRead;
  const cacheWriteTokens = usage?.inputTokens?.cacheWrite;
  let textTokens = usage?.outputTokens?.text;
  let reasoningTokens = usage?.outputTokens?.reasoning;

  if (provider === "openai-compatible") {
    // The compatible SDK replaces absent fields in a partial usage object with
    // zeros. Its validated raw usage preserves the distinction from real zeros.
    const raw = v.parse(compatibleUsageSchema, usage?.raw ?? {});
    inputTokens = raw.prompt_tokens ?? undefined;
    outputTokens = raw.completion_tokens ?? undefined;
    totalTokens = raw.total_tokens ?? undefined;
    cacheReadTokens = raw.prompt_tokens_details?.cached_tokens ?? undefined;
    reasoningTokens =
      raw.completion_tokens_details?.reasoning_tokens ?? undefined;
    noCacheTokens =
      inputTokens !== undefined && cacheReadTokens !== undefined
        ? inputTokens - cacheReadTokens
        : undefined;
    textTokens =
      outputTokens !== undefined && reasoningTokens !== undefined
        ? outputTokens - reasoningTokens
        : undefined;
  }
  if (
    totalTokens === undefined &&
    inputTokens !== undefined &&
    outputTokens !== undefined
  ) {
    totalTokens = inputTokens + outputTokens;
  }
  return {
    inputTokens: inputTokens ?? null,
    outputTokens: outputTokens ?? null,
    ...(totalTokens !== undefined ? {totalTokens} : {}),
    inputTokenDetails: {
      noCacheTokens: noCacheTokens ?? null,
      cacheReadTokens: cacheReadTokens ?? null,
      cacheWriteTokens: cacheWriteTokens ?? null,
    },
    outputTokenDetails: {
      textTokens: textTokens ?? null,
      reasoningTokens: reasoningTokens ?? null,
    },
  };
}

function appendRecord(logPath: string, record: UsageRecord): void {
  try {
    // A synchronous append keeps concurrent calls in this process from
    // interleaving records; flush makes accounting durable before SDK parsing.
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flush: true,
    });
  } catch {
    // Do not propagate OS messages or paths through model retry classifiers.
    failUsageLog(logPath);
  }
}

export function withUsageLogging(
  model: LanguageModelV3,
  context: UsageContext
): LanguageModelV3 {
  const logPath = process.env.KORA_USAGE_LOG_PATH;
  if (!logPath) return model;

  const identity = {
    modelId: context.modelId,
    label: context.label,
    role: context.role,
    callKind: context.callKind,
  };

  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      async wrapGenerate({doGenerate}) {
        const failure = failedUsageLogs.get(logPath);
        if (failure) throw failure;
        let result: LanguageModelV3GenerateResult;
        try {
          result = await doGenerate();
        } catch (error) {
          appendRecord(logPath, {
            ...identity,
            model: null,
            outcome: "error",
            usageStatus: "missing",
            usage: null,
            error: "provider_call_failed",
          });
          throw error;
        }

        let usage: LoggedUsage;
        try {
          usage = loggedUsage(result.usage, context.provider);
        } catch {
          failUsageLog(logPath);
        }
        // The gateway adapter keeps the remote response metadata in body,
        // replacing response itself with its transport headers and body.
        const gatewayResponse =
          context.provider === "gateway"
            ? v.safeParse(gatewayResponseSchema, result.response?.body)
            : undefined;
        const resolvedModel =
          result.response?.modelId ??
          (gatewayResponse?.success
            ? gatewayResponse.output.response?.modelId
            : undefined) ??
          null;
        const usageStatus =
          usage.inputTokens !== null && usage.outputTokens !== null
            ? "complete"
            : usage.inputTokens !== null ||
                usage.outputTokens !== null ||
                usage.totalTokens !== undefined
              ? "partial"
              : "missing";
        appendRecord(logPath, {
          ...identity,
          model: resolvedModel,
          outcome: "response",
          usageStatus,
          usage,
        });
        return result;
      },
    },
  });
}
