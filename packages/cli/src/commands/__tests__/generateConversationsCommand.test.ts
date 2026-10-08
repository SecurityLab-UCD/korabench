import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import * as path from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {generateConversationsCommand} from "../generateConversationsCommand.js";

const calls = vi.hoisted(() => ({roles: [] as string[]}));
vi.mock("../../models/createModel.js", () => ({
  createModel(_registry: string, _slug: string, options: {role: string}) {
    if (options.role === "judge")
      throw new Error("generation constructed a judge");
    calls.roles.push(options.role);
    return {
      async getTextResponse(): Promise<string> {
        return "Offline real conversation response";
      },
      async getStructuredResponse(): Promise<never> {
        throw new Error("generation invoked a judge");
      },
    };
  },
}));

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, {recursive: true, force: true});
  calls.roles.length = 0;
  vi.unstubAllEnvs();
});

describe("generation-only command", () => {
  it("persists real conversation messages without any judge construction or invocation", async () => {
    root = await mkdtemp(path.join(tmpdir(), "generation-command-"));
    const corpus = await readFile(
      path.resolve(import.meta.dirname, "../../../../../data/scenarios.jsonl"),
      "utf-8"
    );
    const first = corpus.split("\n").find(line => line.trim())!;
    const input = path.join(root, "scenarios.jsonl");
    const output = path.join(root, "conversations.json");
    await writeFile(input, `${first}\n`);
    const registry = path.join(root, "models.json");
    await writeFile(
      registry,
      JSON.stringify({
        "offline-target": {model: "openai/offline-target"},
        "changed-target": {model: "openai/changed-target"},
        "offline-user": {model: "openai/offline-user"},
      })
    );
    await generateConversationsCommand(
      registry,
      "offline-target",
      "offline-user",
      input,
      output,
      ["none"]
    );
    const persisted = JSON.parse(await readFile(output, "utf-8"));
    expect(calls.roles).toEqual(["simulated_user", "target"]);
    expect(persisted.results).toHaveLength(1);
    expect(persisted.results[0].messages[1].content).toBe(
      "Offline real conversation response"
    );
    expect(persisted.results[0]).not.toHaveProperty("assessment");
    expect(persisted.results[0]).not.toHaveProperty("mechanismAssessment");
    await generateConversationsCommand(
      registry,
      "offline-target",
      "offline-user",
      input,
      output,
      ["none"]
    );
    expect(JSON.parse(await readFile(output, "utf-8")).results).toEqual(
      persisted.results
    );
    await expect(
      generateConversationsCommand(
        registry,
        "changed-target",
        "offline-user",
        input,
        output,
        ["none"]
      )
    ).rejects.toThrow("Generation identity changed");
  });

  it("rejects changed routes and options before constructing models on restart", async () => {
    root = await mkdtemp(path.join(tmpdir(), "generation-route-restart-"));
    const corpus = await readFile(
      path.resolve(import.meta.dirname, "../../../../../data/scenarios.jsonl"),
      "utf-8"
    );
    const input = path.join(root, "scenarios.jsonl");
    const output = path.join(root, "conversations.json");
    const registry = path.join(root, "models.json");
    await writeFile(
      input,
      `${corpus.split("\n").find(line => line.trim())!}\n`
    );
    await writeFile(
      registry,
      JSON.stringify({"offline-user": {model: "openai/offline-user"}})
    );
    vi.stubEnv("OPENAI_BASE_URL", "https://first.example/v1");
    await generateConversationsCommand(
      registry,
      "openai/offline-target",
      "offline-user",
      input,
      output,
      ["none"]
    );
    calls.roles.length = 0;
    vi.stubEnv("OPENAI_BASE_URL", "https://changed.example/v1");
    await expect(
      generateConversationsCommand(
        registry,
        "openai/offline-target",
        "offline-user",
        input,
        output,
        ["none"]
      )
    ).rejects.toThrow("Generation identity changed");
    expect(calls.roles).toEqual([]);
    vi.stubEnv("OPENAI_BASE_URL", "https://first.example/v1");
    await writeFile(
      registry,
      JSON.stringify({
        "offline-user": {model: "openai/offline-user", temperature: 0.25},
      })
    );
    await expect(
      generateConversationsCommand(
        registry,
        "openai/offline-target",
        "offline-user",
        input,
        output,
        ["none"]
      )
    ).rejects.toThrow("Generation identity changed");
    expect(calls.roles).toEqual([]);
  });
});
