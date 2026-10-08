import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import * as path from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {resolvePublicModelIdentity} from "../models/modelIdentity.js";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, {recursive: true, force: true});
  root = undefined;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function registry(config: unknown): string {
  root ??= mkdtempSync(path.join(tmpdir(), "public-model-identity-"));
  const file = path.join(root, "models.json");
  writeFileSync(file, JSON.stringify(config));
  return file;
}

describe("provider-free public model identity", () => {
  it("captures direct endpoints and caps without reading credentials or probing models", () => {
    const file = registry({});
    vi.stubGlobal("fetch", () => {
      throw new Error("provider probe forbidden");
    });
    vi.stubEnv("OPENAI_API_KEY", "do-not-serialize");
    vi.stubEnv("OPENAI_BASE_URL", "https://first.example/v1/");
    const first = resolvePublicModelIdentity(file, "openai/gpt-4o-mini");
    expect(first.baseURL).toBe("https://first.example/v1");
    expect(JSON.stringify(first)).not.toContain("do-not-serialize");
    vi.stubEnv("OPENAI_BASE_URL", "https://first.example/v1");
    expect(resolvePublicModelIdentity(file, "openai/gpt-4o-mini")).toEqual(
      first
    );
    vi.stubEnv("OPENAI_BASE_URL", "https://second.example/v1");
    expect(resolvePublicModelIdentity(file, "openai/gpt-4o-mini")).not.toEqual(
      first
    );
    vi.stubEnv("OPENAI_MAX_TOKENS", "123");
    expect(
      resolvePublicModelIdentity(file, "openai/gpt-4o-mini").maxTokens
    ).toBe(123);
  });

  it("does not access API-key environment properties", () => {
    const file = registry({});
    const env = {
      OPENAI_BASE_URL: "https://offline.example/v1",
      get OPENAI_API_KEY(): string {
        throw new Error("credentials must not be read");
      },
    };
    expect(
      resolvePublicModelIdentity(file, "openai/gpt-4o-mini", "target", env)
        .provider
    ).toBe("openai-compatible");
  });

  it("re-reads effective registry options and keeps named gateway routing", () => {
    const file = registry({
      named: {model: "openai/gpt-4o-mini", maxTokens: 100},
    });
    const first = resolvePublicModelIdentity(file, "named");
    expect(first.provider).toBe("gateway");
    registry({
      named: {
        model: "openai/gpt-4o-mini",
        maxTokens: 200,
        providerOptions: {openai: {reasoningEffort: "high"}},
      },
    });
    expect(resolvePublicModelIdentity(file, "named")).not.toEqual(first);
  });

  it.each([
    "https://user:secret@example.com/v1",
    "https://example.com/v1?token=secret",
    "https://example.com/v1#secret",
  ])("rejects secret endpoint components", endpoint => {
    const file = registry({
      direct: {
        provider: "openai-compatible",
        model: "glm-5",
        baseURL: endpoint,
        apiKeyEnv: "UNSET_KEY",
      },
    });
    expect(() => resolvePublicModelIdentity(file, "direct")).toThrow(
      "nonsecret HTTP(S)"
    );
  });

  it.each([
    "custom-existing",
    "kora-app-existing",
    "kora-app-existing-android",
  ])("preserves declared target mode without provider lookup: %s", slug => {
    const file = registry({});
    const identity = resolvePublicModelIdentity(file, slug, "target");
    expect(identity.mode).toBe("declared");
    expect(identity.slug).toBe(slug);
  });
});
