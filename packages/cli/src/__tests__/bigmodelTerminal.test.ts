import {TestAssessment} from "@korabench/benchmark";
import * as path from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createModel} from "../models/createModel.js";

const backend = vi.hoisted(() => ({
  provider: vi.fn(() => vi.fn((model: string) => ({model}))),
  structured: vi.fn(),
  text: vi.fn(),
}));
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: backend.provider,
}));
vi.mock("ai", () => ({
  generateObject: backend.structured,
  generateText: backend.text,
  jsonSchema: (value: unknown) => value,
}));
vi.mock("../models/usageLog.js", () => ({
  UsageLogError: class UsageLogError extends Error {},
  withUsageLogging: (model: unknown) => model,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const registry = path.resolve(import.meta.dirname, "../../../../models.json");

describe("direct BigModel terminal route", () => {
  it("returns a locally validated safety grade", async () => {
    vi.stubEnv("GLM_API_KEY", "temporary-test-key");
    vi.stubEnv("GLM_BASE_URL", "https://offline-bigmodel.example/api/paas/v4/");
    backend.structured.mockResolvedValue({
      object: {
        grade: "adequate",
        reasons: "Valid offline grading rationale. ".repeat(10),
      },
    });
    const model = createModel(registry, "bigmodel-glm-5.3", {
      role: "judge",
      retry: {maxRetries: 0},
    });
    const grade = await model.getStructuredResponse({
      messages: [{role: "user", content: "Grade the recorded conversation"}],
      outputType: TestAssessment.io,
    });
    expect(grade.grade).toBe("adequate");
  });

  it.each(["GLM_API_KEY", "GLM_BASE_URL"])(
    "fails before grading when %s is missing",
    missing => {
      vi.stubEnv("GLM_API_KEY", "temporary-test-key");
      vi.stubEnv("GLM_BASE_URL", "https://offline-bigmodel.example/v4/");
      vi.stubEnv(missing, undefined);
      expect(() =>
        createModel(registry, "bigmodel-glm-5.3", {role: "judge"})
      ).toThrow(missing);
      expect(backend.structured).not.toHaveBeenCalled();
    }
  );

  it("rejects invalid grades from every existing structured response path", async () => {
    vi.stubEnv("GLM_API_KEY", "temporary-test-key");
    vi.stubEnv("GLM_BASE_URL", "https://offline-bigmodel.example/v4/");
    backend.structured.mockResolvedValue({
      object: {grade: "invented", reasons: "Invalid grade"},
    });
    backend.text.mockResolvedValue({
      text: '{"grade":"invented","reasons":"Invalid grade"}',
    });
    const model = createModel(registry, "bigmodel-glm-5.3", {
      role: "judge",
      retry: {maxRetries: 0},
    });
    await expect(
      model.getStructuredResponse({
        messages: [{role: "user", content: "Grade"}],
        outputType: TestAssessment.io,
      })
    ).rejects.toThrow("Structured output failed");
  });
});
