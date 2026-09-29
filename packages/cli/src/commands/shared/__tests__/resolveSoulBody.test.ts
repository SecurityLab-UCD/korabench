import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import * as path from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {
  resolveSoulBody,
  resolveSoulBodyForPrompts,
} from "../resolveSoulBody.js";

describe("resolveSoulBody", () => {
  let tmpDir: string;
  let dataPath: string;
  let envPath: string;
  let seedPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "kora-soul-test-"));
    dataPath = path.join(tmpDir, "data");
    mkdirSync(path.join(dataPath, "souls"), {recursive: true});
    envPath = path.join(tmpDir, "soul-from-env.md");
    seedPath = path.join(dataPath, "souls", "seed.md");
    delete process.env.SOUL_MD_PATH;
  });

  afterEach(() => {
    delete process.env.SOUL_MD_PATH;
    rmSync(tmpDir, {recursive: true, force: true});
  });

  it("returns the SOUL_MD_PATH file contents when set and readable", () => {
    const body = "# Soul from env\nYou are SOULFuzz.";
    writeFileSync(envPath, body);
    process.env.SOUL_MD_PATH = envPath;

    expect(resolveSoulBody(dataPath)).toBe(body);
  });

  it("throws naming SOUL_MD_PATH when env path is unreadable", () => {
    process.env.SOUL_MD_PATH = path.join(tmpDir, "does-not-exist.md");

    expect(() => resolveSoulBody(dataPath)).toThrow(/SOUL_MD_PATH/);
    expect(() => resolveSoulBody(dataPath)).toThrow(/does-not-exist\.md/);
  });

  it("falls back to <dataPath>/souls/seed.md when SOUL_MD_PATH is unset", () => {
    const body = "# Soul from seed\nYou are SOULFuzz.";
    writeFileSync(seedPath, body);

    expect(resolveSoulBody(dataPath)).toBe(body);
  });

  it("throws naming SOUL_MD_PATH when env unset and seed missing", () => {
    expect(() => resolveSoulBody(dataPath)).toThrow(/SOUL_MD_PATH/);
    expect(() => resolveSoulBody(dataPath)).toThrow(/seed\.md/);
  });

  it("throws when env-resolved body is empty; hint suggests populating the env path or unsetting", () => {
    writeFileSync(envPath, "   \n\t  \n");
    process.env.SOUL_MD_PATH = envPath;

    expect(() => resolveSoulBody(dataPath)).toThrow(/empty/);
    expect(() => resolveSoulBody(dataPath)).toThrow(/soul-from-env\.md/);
    // Hint should NOT re-suggest setting SOUL_MD_PATH (already set to envPath).
    expect(() => resolveSoulBody(dataPath)).toThrow(/unset SOUL_MD_PATH/);
    expect(() => resolveSoulBody(dataPath)).toThrow(/seed\.md/);
  });

  it("throws when seed-resolved body is empty; hint suggests populating seed.md or setting SOUL_MD_PATH", () => {
    writeFileSync(seedPath, "");

    expect(() => resolveSoulBody(dataPath)).toThrow(/empty/);
    expect(() => resolveSoulBody(dataPath)).toThrow(/seed\.md/);
    expect(() => resolveSoulBody(dataPath)).toThrow(/set SOUL_MD_PATH/);
  });
});

describe("resolveSoulBodyForPrompts", () => {
  let tmpDir: string;
  let dataPath: string;
  let seedPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "kora-soul-prompts-test-"));
    dataPath = path.join(tmpDir, "data");
    mkdirSync(path.join(dataPath, "souls"), {recursive: true});
    seedPath = path.join(dataPath, "souls", "seed.md");
    delete process.env.SOUL_MD_PATH;
  });

  afterEach(() => {
    delete process.env.SOUL_MD_PATH;
    rmSync(tmpDir, {recursive: true, force: true});
  });

  it.each([
    ["none"],
    ["default"],
    ["child"],
    ["default", "child", "none"],
  ] as const)("does not read SOUL_MD_PATH or the seed for %s", (...prompts) => {
    // Inherited env path is invalid, and the seed is missing: reading either
    // would throw.
    process.env.SOUL_MD_PATH = path.join(tmpDir, "does-not-exist.md");

    expect(resolveSoulBodyForPrompts(prompts, dataPath)).toBeUndefined();
  });

  it("does not read an existing empty seed for none", () => {
    writeFileSync(seedPath, "");

    expect(resolveSoulBodyForPrompts(["none"], dataPath)).toBeUndefined();
  });

  it("still resolves the soul body when soul is requested alongside none", () => {
    writeFileSync(seedPath, "# Soul\nBody.");

    expect(resolveSoulBodyForPrompts(["none", "soul"], dataPath)).toBe(
      "# Soul\nBody."
    );
  });

  it("keeps the missing-file error for soul", () => {
    expect(() => resolveSoulBodyForPrompts(["soul"], dataPath)).toThrow(
      /SOUL_MD_PATH/
    );
  });

  it("keeps the empty-body error for soul", () => {
    writeFileSync(seedPath, "  \n");

    expect(() => resolveSoulBodyForPrompts(["soul"], dataPath)).toThrow(
      /empty/
    );
  });

  it("keeps the unreadable-env-path error for soul", () => {
    process.env.SOUL_MD_PATH = path.join(tmpDir, "does-not-exist.md");

    expect(() => resolveSoulBodyForPrompts(["none", "soul"], dataPath)).toThrow(
      /does-not-exist\.md/
    );
  });
});
