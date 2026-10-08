import {afterEach, describe, expect, it, vi} from "vitest";
import {createFallbackModel} from "../models/fallbackModel.js";
import type {Model} from "../models/model.js";
import {createNativeRunnerModel} from "../models/nativeRunnerModel.js";
import {UsageLogError} from "../models/usageLog.js";
import {createWebRunnerModel} from "../models/webRunnerModel.js";
import {
  createLogRetryHandler,
  publicErrorClassification,
  withRetry,
} from "../retry.js";

const marker = "credential-echo-private-provider-token";
afterEach(() => vi.restoreAllMocks());

describe("public retry diagnostics", () => {
  it("retains attempts, delays and the original final exception without provider content", async () => {
    const error = new Error(`503 ${marker}`, {cause: marker});
    error.name = marker;
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw error;
        },
        {
          maxRetries: 2,
          initialDelayMs: 0,
          jitterFactor: 0,
          onRetry: createLogRetryHandler("target-route"),
        }
      )
    ).rejects.toBe(error);
    expect(attempts).toBe(3);
    expect(stderr).toHaveBeenCalledTimes(2);
    expect(stderr.mock.calls[0]?.[0]).toContain("target-route");
    expect(stderr.mock.calls[0]?.[0]).toContain("Retry 1");
    expect(stderr.mock.calls[1]?.[0]).toContain("Retry 2");
    expect(stderr.mock.calls[0]?.[0]).toContain("0.0s");
    expect(
      JSON.stringify(stderr.mock.calls) + JSON.stringify(stdout.mock.calls)
    ).not.toContain(marker);
  });

  it("does not retry nonretryable failures or expose arbitrary thrown values", async () => {
    const error = new Error(marker);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw error;
        },
        {onRetry: createLogRetryHandler()}
      )
    ).rejects.toBe(error);
    expect(attempts).toBe(1);
    expect(stderr).not.toHaveBeenCalled();
    expect(publicErrorClassification(error)).toBe(
      publicErrorClassification({message: marker})
    );
    expect(publicErrorClassification(marker)).not.toContain(marker);
    expect(publicErrorClassification(new UsageLogError())).not.toContain(
      marker
    );
  });

  it("propagates accounting failures unchanged without retrying", async () => {
    const error = new UsageLogError();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw error;
        },
        {onRetry: createLogRetryHandler()}
      )
    ).rejects.toBe(error);
    expect(attempts).toBe(1);
    expect(stderr).not.toHaveBeenCalled();
    expect(publicErrorClassification(error)).not.toBe(
      publicErrorClassification(new Error(marker))
    );
    expect(publicErrorClassification(new Error(`503 ${marker}`))).not.toBe(
      publicErrorClassification(new Error(marker))
    );
  });
});

describe("public generation wrapper diagnostics", () => {
  const request = {messages: [{role: "user" as const, content: "hello"}]};

  it("keeps failover and the original final error without emitting either provider error", async () => {
    const first = new Error(`503 ${marker}`);
    const last = new Error(marker);
    const failing = (error: Error): Model => ({
      async getTextResponse() {
        throw error;
      },
      async getStructuredResponse() {
        throw error;
      },
    });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const chain = createFallbackModel([
      {label: "first-route", model: failing(first)},
      {label: "last-route", model: failing(last)},
    ]);
    await expect(chain.getTextResponse(request)).rejects.toBe(last);
    expect(stderr).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(marker);
    const survivor = createFallbackModel([
      {label: "first-route", model: failing(first)},
      {
        label: "survivor-route",
        model: {
          async getTextResponse() {
            return "survivor";
          },
          async getStructuredResponse() {
            throw last;
          },
        },
      },
    ]);
    await expect(survivor.getTextResponse(request)).resolves.toBe("survivor");
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(marker);
  });

  it.each(["web", "native"] as const)(
    "keeps %s cleanup best-effort without exposing transport errors",
    async runner => {
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      const transport = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({sessionId: "public-session"}))
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({assistantMessage: "survivor"}))
        )
        .mockRejectedValueOnce(new Error(marker));
      const config = {modelSlug: "kora-app-test", apiKey: marker};
      const model =
        runner === "web"
          ? createWebRunnerModel({...config, webRunnerUrl: "http://localhost"})
          : createNativeRunnerModel({
              ...config,
              nativeRunnerUrl: "http://localhost",
            });
      await expect(model.getTextResponse(request)).resolves.toBe("survivor");
      await expect(model.dispose?.("completed")).resolves.toBeUndefined();
      expect(transport).toHaveBeenCalledTimes(3);
      expect(JSON.parse(String(transport.mock.calls[2]?.[1]?.body))).toEqual({
        outcome: "completed",
      });
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(stderr.mock.calls)).not.toContain(marker);
    }
  );
});
