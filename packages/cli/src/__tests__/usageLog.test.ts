import {Command} from "@commander-js/extra-typings";
import {RiskCategory, Scenario} from "@korabench/benchmark";
import type * as AI from "ai";
import {spawn} from "node:child_process";
import * as fs from "node:fs";
import type {Server} from "node:http";
import {createServer} from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as v from "valibot";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {runCommand} from "../commands/runCommand.js";
import * as contextBuilder from "../commands/shared/buildContext.js";
import type {UsageRole} from "../models/_shared.js";
import {createModel, createModelChain} from "../models/createModel.js";
import {createFallbackModel} from "../models/fallbackModel.js";
import {createGatewayModel} from "../models/gatewayModel.js";
import type {Model} from "../models/model.js";
import {createOpenAICompatibleModelFromConfig} from "../models/openAICompatibleModel.js";
import {UsageLogError} from "../models/usageLog.js";

const gatewayEndpoint = vi.hoisted(() => ({baseURL: ""}));
vi.mock("ai", async importOriginal => {
  const actual = await importOriginal<typeof AI>();
  return {
    ...actual,
    gateway: (modelId: string) =>
      actual.createGateway({
        baseURL: gatewayEndpoint.baseURL,
        apiKey: "private-api-key",
      })(modelId),
  };
});

const request = {
  messages: [{role: "user" as const, content: "private-prompt"}],
};
const rawUsage = {
  prompt_tokens: 100,
  completion_tokens: 20,
  total_tokens: 120,
  prompt_tokens_details: {cached_tokens: 30},
  completion_tokens_details: {reasoning_tokens: 5},
};
const gatewayUsage = {
  inputTokens: {total: 100, noCache: 70, cacheRead: 30, cacheWrite: 4},
  outputTokens: {total: 20, text: 15, reasoning: 5},
  raw: {private_metadata: "private-usage-content"},
};
const recordSchema = v.object({
  modelId: v.string(),
  model: v.nullable(v.string()),
  label: v.string(),
  role: v.optional(v.picklist(["target", "simulated_user", "judge"])),
  callKind: v.string(),
  outcome: v.string(),
  usageStatus: v.string(),
  error: v.optional(v.string()),
  usage: v.nullable(
    v.object({
      inputTokens: v.nullable(v.number()),
      outputTokens: v.nullable(v.number()),
      totalTokens: v.optional(v.number()),
      inputTokenDetails: v.object({
        noCacheTokens: v.nullable(v.number()),
        cacheReadTokens: v.nullable(v.number()),
        cacheWriteTokens: v.nullable(v.number()),
      }),
      outputTokenDetails: v.object({
        textTokens: v.nullable(v.number()),
        reasoningTokens: v.nullable(v.number()),
      }),
    })
  ),
});

type Reply = {text: string; usage?: unknown; status?: number};
type LoggedRecord = v.InferOutput<typeof recordSchema>;

interface CommandFixture {
  registry: string;
  scenarios: string;
  output: string;
}

describe("provider usage logging", () => {
  let directory: string;
  let logPath: string;
  let server: Server;
  let baseURL: string;
  let calls: number;
  let loggedBeforeCall: number[];
  let replies: Reply[];

  function records(): LoggedRecord[] {
    if (!fs.existsSync(logPath)) return [];
    return fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map(line => v.parse(recordSchema, JSON.parse(line)));
  }

  function compatible(
    label = "target-route",
    maxRetries = 0,
    role?: UsageRole
  ): Model {
    return createOpenAICompatibleModelFromConfig(
      label,
      {
        provider: "openai-compatible",
        model: "requested-model",
        baseURL,
        apiKey: "private-api-key",
        supportsStructuredOutputs: true,
      },
      {role, retry: {maxRetries, initialDelayMs: 1, jitterFactor: 0}}
    );
  }

  function gateway(
    model = "openai/requested-model",
    maxRetries = 0,
    role?: UsageRole
  ): Model {
    const registry = path.join(directory, "models.json");
    fs.writeFileSync(registry, JSON.stringify({"judge-route": {model}}));
    return createGatewayModel(registry, "judge-route", {
      role,
      retry: {maxRetries, initialDelayMs: 1, jitterFactor: 0},
    });
  }

  function commandFixture(): CommandFixture {
    const registry = path.join(directory, "models.json");
    const config = {
      provider: "openai-compatible",
      model: "requested-model",
      baseURL,
      apiKey: "private-api-key",
      supportsStructuredOutputs: true,
    };
    fs.writeFileSync(
      registry,
      JSON.stringify({
        "target-route": config,
        "user-route": config,
        "judge-route": config,
      })
    );
    const scenarios = path.join(directory, "scenarios.jsonl");
    const source = path.resolve(
      import.meta.dirname,
      "../../../../data/scenarios.jsonl"
    );
    const lines = fs
      .readFileSync(source, "utf8")
      .split("\n")
      .filter(line => line.trim());
    fs.writeFileSync(scenarios, lines.slice(0, 2).join("\n") + "\n");
    return {registry, scenarios, output: path.join(directory, "results.json")};
  }

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "kora-usage-"));
    logPath = path.join(directory, "usage.jsonl");
    vi.stubEnv("KORA_USAGE_LOG_PATH", logPath);
    calls = 0;
    loggedBeforeCall = [];
    replies = [{text: "private-completion", usage: rawUsage}];
    server = createServer((incoming, response) => {
      incoming.resume();
      response.setHeader("Content-Type", "application/json");
      response.setHeader("retry-after", "0");
      response.setHeader("x-private-header", "private-header-value");
      if (incoming.url === "/models") {
        response.end(JSON.stringify({data: [{id: "requested-model"}]}));
        return;
      }
      if (!fs.existsSync(logPath) || !fs.statSync(logPath).isFile()) {
        loggedBeforeCall.push(0);
      } else {
        loggedBeforeCall.push(records().length);
      }
      const reply = replies[Math.min(calls++, replies.length - 1)]!;
      response.statusCode = reply.status ?? 200;
      if (reply.status) {
        response.end(JSON.stringify({error: {message: reply.text}}));
      } else if (incoming.url === "/language-model") {
        response.end(
          JSON.stringify({
            content: [{type: "text", text: reply.text}],
            finishReason: {unified: "stop", raw: "stop"},
            usage: reply.usage,
            response: {modelId: "resolved-gateway-model"},
            warnings: [],
          })
        );
      } else {
        response.end(
          JSON.stringify({
            id: `response-${calls}`,
            model: "resolved-compatible-model",
            choices: [
              {
                index: 0,
                message: {role: "assistant", content: reply.text},
                finish_reason: "stop",
              },
            ],
            usage: reply.usage,
          })
        );
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing local server address");
    baseURL = `http://127.0.0.1:${address.port}`;
    gatewayEndpoint.baseURL = baseURL;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
    fs.rmSync(directory, {recursive: true, force: true});
  });

  it("records paid malformed structured responses before their fallback", async () => {
    replies = [
      {text: "not valid JSON", usage: rawUsage},
      {text: '{"answer":"ok"}', usage: rawUsage},
    ];
    await expect(
      compatible("judge-route", 0, "judge").getStructuredResponse({
        ...request,
        outputType: v.object({answer: v.string()}),
      })
    ).resolves.toEqual({answer: "ok"});
    expect(calls).toBe(2);
    expect(loggedBeforeCall).toEqual([0, 1]);
    expect(
      records().map(row => [row.role, row.callKind, row.usage?.totalTokens])
    ).toEqual([
      ["judge", "structured", 120],
      ["judge", "structured-fallback", 120],
    ]);
  });

  it("counts every structured validation retry without duplicate records", async () => {
    replies = [
      {text: '{"answer":3}', usage: rawUsage},
      {text: '{"answer":"ok"}', usage: rawUsage},
    ];
    await expect(
      compatible("judge-route", 1, "judge").getStructuredResponse({
        ...request,
        outputType: v.object({answer: v.string()}),
      })
    ).resolves.toEqual({answer: "ok"});
    expect(calls).toBe(2);
    expect(records().map(row => [row.role, row.callKind])).toEqual([
      ["judge", "structured"],
      ["judge", "structured"],
    ]);
    expect(
      records().reduce((total, row) => total + row.usage!.inputTokens!, 0)
    ).toBe(200);
  });

  it.each(["openai-compatible", "gateway"] as const)(
    "distinguishes concurrent roles sharing the same %s model and route",
    async provider => {
      const registry = path.join(directory, "models.json");
      const modelId =
        provider === "gateway" ? "openai/requested-model" : "requested-model";
      fs.writeFileSync(
        registry,
        JSON.stringify({
          "shared-route":
            provider === "gateway"
              ? {model: modelId}
              : {
                  provider,
                  model: modelId,
                  baseURL,
                  apiKey: "private-api-key",
                  supportsStructuredOutputs: true,
                },
        })
      );
      if (provider === "gateway") {
        replies = [{text: "private-completion", usage: gatewayUsage}];
      }
      const target = contextBuilder.resolveTargetGatewayModel(
        registry,
        "shared-route"
      );
      if (!target) throw new Error("Missing target provider model");
      const user = createModelChain(registry, ["shared-route"], {
        role: "simulated_user",
      });
      const judge = createModel(registry, "shared-route", {role: "judge"});
      await Promise.all(
        [target, user, judge].map(model => model.getTextResponse(request))
      );
      const rows = records();
      expect(rows.map(row => row.role).sort()).toEqual([
        "judge",
        "simulated_user",
        "target",
      ]);
      for (const row of rows) {
        expect(row).toEqual({
          role: row.role,
          modelId,
          model:
            provider === "gateway"
              ? "resolved-gateway-model"
              : "resolved-compatible-model",
          label: "shared-route",
          callKind: "text",
          outcome: "response",
          usageStatus: "complete",
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            inputTokenDetails: {
              noCacheTokens: 70,
              cacheReadTokens: 30,
              cacheWriteTokens: provider === "gateway" ? 4 : null,
            },
            outputTokenDetails: {textTokens: 15, reasoningTokens: 5},
          },
        });
      }
      const serialized = fs.readFileSync(logPath, "utf8");
      for (const secret of [
        "private-prompt",
        "private-completion",
        "private-api-key",
        "private-header-value",
      ])
        expect(serialized).not.toContain(secret);
    }
  );

  it("makes missing usage explicit instead of emitting zero-token calls", async () => {
    replies = [{text: "ok"}];
    await compatible().getTextResponse(request);
    expect(records()[0]).toMatchObject({
      usageStatus: "missing",
      usage: {inputTokens: null, outputTokens: null},
    });
    expect(records()[0]!.usage).not.toHaveProperty("totalTokens");
    expect(records()[0]).not.toHaveProperty("role");
  });

  it("does not accept SDK-invented zeros for partially reported compatible usage", async () => {
    replies = [{text: "ok", usage: {prompt_tokens: 100}}];
    await compatible().getTextResponse(request);
    expect(records()[0]).toMatchObject({
      usageStatus: "partial",
      usage: {inputTokens: 100, outputTokens: null},
    });
    expect(records()[0]!.usage).not.toHaveProperty("totalTokens");
  });

  it("preserves explicitly reported zero usage as complete", async () => {
    replies = [
      {
        text: "ok",
        usage: {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0},
      },
    ];
    await compatible().getTextResponse(request);
    expect(records()[0]).toMatchObject({
      usageStatus: "complete",
      usage: {inputTokens: 0, outputTokens: 0, totalTokens: 0},
    });
  });

  it("does not create logs when logging is disabled", async () => {
    vi.stubEnv("KORA_USAGE_LOG_PATH", undefined);
    await expect(compatible().getTextResponse(request)).resolves.toBe(
      "private-completion"
    );
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("records sanitized failed attempts before a provider retry", async () => {
    replies = [
      {text: "service unavailable: private-error-content", status: 503},
      {text: "ok", usage: rawUsage},
    ];
    await expect(
      compatible("target-route", 1, "target").getTextResponse(request)
    ).resolves.toBe("ok");
    expect(calls).toBe(2);
    expect(records().map(row => row.role)).toEqual(["target", "target"]);
    expect(records()[0]).toMatchObject({
      outcome: "error",
      usageStatus: "missing",
      usage: null,
      error: "provider_call_failed",
    });
    expect(fs.readFileSync(logPath, "utf8")).not.toContain(
      "private-error-content"
    );
  });

  it("does not retry a provider error when its accounting append fails", async () => {
    fs.mkdirSync(logPath);
    replies = [
      {text: "service unavailable: private-error-content", status: 503},
    ];
    await expect(
      compatible("target-route", 3).getTextResponse(request)
    ).rejects.toBeInstanceOf(UsageLogError);
    expect(calls).toBe(1);
  });

  it.each(["text", "structured"] as const)(
    "surfaces %s log failures without retries or model fallbacks",
    async kind => {
      fs.mkdirSync(logPath);
      replies = [{text: '{"answer":"ok"}', usage: rawUsage}];
      const model = createFallbackModel([
        {label: "primary", model: compatible("primary", 3)},
        {label: "backup", model: compatible("backup", 3)},
      ]);
      const result =
        kind === "text"
          ? model.getTextResponse(request)
          : model.getStructuredResponse({
              ...request,
              outputType: v.object({answer: v.string()}),
            });
      await expect(result).rejects.toBeInstanceOf(UsageLogError);
      expect(calls).toBe(1);
    }
  );

  it.each(["openai/requested-model", "anthropic/requested-model"])(
    "captures gateway structured calls for %s",
    async modelId => {
      replies = [{text: '{"answer":"ok"}', usage: gatewayUsage}];
      await expect(
        gateway(modelId, 0, "judge").getStructuredResponse({
          ...request,
          outputType: v.object({answer: v.string()}),
        })
      ).resolves.toEqual({answer: "ok"});
      expect(records()).toEqual([
        expect.objectContaining({
          modelId,
          model: "resolved-gateway-model",
          label: "judge-route",
          role: "judge",
          callKind: "structured",
          usageStatus: "complete",
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            inputTokenDetails: {
              noCacheTokens: 70,
              cacheReadTokens: 30,
              cacheWriteTokens: 4,
            },
            outputTokenDetails: {textTokens: 15, reasoningTokens: 5},
          },
        }),
      ]);
      expect(fs.readFileSync(logPath, "utf8")).not.toContain(
        "private-usage-content"
      );
    }
  );

  it("counts paid gateway parsing failures even when generation rejects", async () => {
    replies = [{text: "not valid JSON", usage: gatewayUsage}];
    await expect(
      gateway().getStructuredResponse({
        ...request,
        outputType: v.object({answer: v.string()}),
      })
    ).rejects.toThrow();
    expect(records()).toEqual([
      expect.objectContaining({
        callKind: "structured",
        usage: expect.objectContaining({totalTokens: 120}),
      }),
    ]);
    expect(calls).toBe(1);
  });

  it("records missing gateway usage before downstream SDK rejection", async () => {
    replies = [{text: "ok"}];
    await expect(gateway().getTextResponse(request)).rejects.toThrow();
    expect(records()[0]).toMatchObject({
      model: "resolved-gateway-model",
      usageStatus: "missing",
      usage: {inputTokens: null, outputTokens: null},
    });
    expect(calls).toBe(1);
  });

  it("does not create gateway usage logs when disabled", async () => {
    vi.stubEnv("KORA_USAGE_LOG_PATH", undefined);
    replies = [{text: "private-completion", usage: gatewayUsage}];
    await expect(gateway().getTextResponse(request)).resolves.toBe(
      "private-completion"
    );
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("captures gateway text usage and propagates log failures without retrying", async () => {
    replies = [{text: "ok", usage: gatewayUsage}];
    await expect(gateway().getTextResponse(request)).resolves.toBe("ok");
    expect(records()[0]).toMatchObject({
      callKind: "text",
      usage: {totalTokens: 120},
    });
    fs.unlinkSync(logPath);
    fs.mkdirSync(logPath);
    await expect(
      gateway("openai/requested-model", 3).getTextResponse(request)
    ).rejects.toBeInstanceOf(UsageLogError);
    expect(calls).toBe(2);
  });

  it("blocks subsequent provider calls once this ledger has failed", async () => {
    fs.mkdirSync(logPath);
    const first = compatible("target-route");
    const later = compatible("user-route");
    await expect(first.getTextResponse(request)).rejects.toBeInstanceOf(
      UsageLogError
    );
    fs.rmdirSync(logPath);
    await expect(later.getTextResponse(request)).rejects.toBeInstanceOf(
      UsageLogError
    );
    replies = [{text: "ok", usage: gatewayUsage}];
    await expect(gateway().getTextResponse(request)).rejects.toBeInstanceOf(
      UsageLogError
    );
    expect(calls).toBe(1);
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("aborts the outer scenario run on accounting failure and disposes its context", async () => {
    const fixture = commandFixture();
    fs.mkdirSync(logPath);
    const disposed: string[] = [];
    const originalBuildContext = contextBuilder.buildContext;
    vi.spyOn(contextBuilder, "buildContext").mockImplementation(
      async (...args) => {
        const built = await originalBuildContext(...args);
        return {
          ...built,
          async dispose(outcome: "completed" | "errored"): Promise<void> {
            await built.dispose(outcome);
            disposed.push(outcome);
          },
        };
      }
    );
    const program = new Command().option("-d, --debug", "print errors");
    await expect(
      runCommand(
        program,
        fixture.registry,
        "target-route",
        ["judge-route"],
        "user-route",
        fixture.scenarios,
        fixture.output,
        ["default"],
        {concurrency: 1}
      )
    ).rejects.toBeInstanceOf(UsageLogError);
    expect(calls).toBe(1);
    expect(disposed).toEqual(["errored"]);
  });

  it.each([400, 503])(
    "keeps generation survivors and accounting without exposing provider errors (%i)",
    async status => {
      const fixture = commandFixture();
      const marker = "credential-echo-private-api-key";
      const first = v.parse(
        Scenario.io,
        JSON.parse(fs.readFileSync(fixture.scenarios, "utf8").split("\n")[0]!)
      );
      const category = RiskCategory.find(first.seed.riskCategoryId);
      const risk = RiskCategory.findRisk(category, first.seed.riskId);
      const flavor = risk.scenarioFlavors?.find(
        item => item.id === first.seed.scenarioFlavorId
      );
      const successfulCalls =
        2 * (flavor?.conversationLength ?? risk.conversationLength) - 1;
      replies = [
        ...Array.from({length: successfulCalls}, () => ({
          text: "surviving response",
          usage: rawUsage,
        })),
        {text: `${status} ${marker}`, status},
      ];
      const cli = path.resolve(import.meta.dirname, "../../build/src/cli.js");
      const result = await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            cli,
            "generate-conversations",
            "target-route",
            "user-route",
            "--input",
            fixture.scenarios,
            "--output",
            fixture.output,
            "--concurrency",
            "1",
          ],
          {
            cwd: directory,
            env: {...process.env},
            stdio: ["ignore", "pipe", "pipe"],
          }
        );
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", code => resolve({code, stdout, stderr}));
      });
      expect(result.code).toBe(1);
      expect(result.stdout + result.stderr).not.toContain(marker);
      expect(result.stdout + result.stderr).not.toContain("private-api-key");
      const evidence = JSON.parse(fs.readFileSync(fixture.output, "utf8"));
      expect(evidence.results).toHaveLength(1);
      expect(evidence.results[0].messages[1].content).toBe(
        "surviving response"
      );
      const rows = records();
      expect(rows).toHaveLength(calls);
      expect(rows[0]).toMatchObject({
        outcome: "response",
        usageStatus: "complete",
        usage: {inputTokens: 100, outputTokens: 20, totalTokens: 120},
      });
      const errors = rows.filter(row => row.outcome === "error");
      expect(errors).toHaveLength(status === 503 ? 6 : 1);
      expect(result.stderr.split("Retry ").length - 1).toBe(
        status === 503 ? 5 : 0
      );
      expect(fs.readFileSync(logPath, "utf8")).not.toContain(marker);
    },
    60000
  );

  it.each(["run", "generate-conversations"])(
    "exits the actual %s CLI with code 73 on accounting failure",
    async command => {
      const fixture = commandFixture();
      fs.mkdirSync(logPath);
      const cli = path.resolve(import.meta.dirname, "../../build/src/cli.js");
      const result = await new Promise<{code: number | null; stderr: string}>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              cli,
              command,
              "target-route",
              "user-route",
              ...(command === "run"
                ? ["--judges", "judge-route"]
                : ["--prompts", "none"]),
              "--input",
              fixture.scenarios,
              "--output",
              fixture.output,
              "--concurrency",
              "1",
            ],
            {
              cwd: directory,
              env: {...process.env},
              stdio: ["ignore", "ignore", "pipe"],
            }
          );
          let stderr = "";
          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
          });
          child.on("error", reject);
          child.on("close", code => resolve({code, stderr}));
        }
      );
      expect(result.code, result.stderr).toBe(73);
      expect(calls).toBe(1);
      expect(result.stderr).not.toContain("private-api-key");
    },
    20000
  );
});
