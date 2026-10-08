import {
  generateConversation,
  Scenario,
  ScenarioPrompt,
} from "@korabench/benchmark";
import {Hash, Script} from "@korabench/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {flatTransform} from "streaming-iterables";
import * as v from "valibot";
import {createModel} from "../models/createModel.js";
import {
  executedCheckoutRoot,
  resolveGenerationIdentity,
} from "../models/modelIdentity.js";
import {UsageLogError} from "../models/usageLog.js";
import {publicErrorClassification} from "../retry.js";
import {countTestTasks, scenariosToTestTasks} from "./runCommand.js";
import {
  buildGenerationContext,
  resolveTargetGatewayModel,
} from "./shared/buildContext.js";

const Conversation = v.strictObject({
  scenario: Scenario.io,
  prompt: ScenarioPrompt.io,
  messages: v.pipe(
    v.array(
      v.strictObject({
        role: v.picklist(["user", "assistant"]),
        content: v.string(),
      })
    ),
    v.minLength(1)
  ),
});
const GenerationOutput = v.strictObject({
  protocol: v.literal("korabench-generation-v1"),
  generation_key: v.string(),
  target: v.string(),
  user: v.string(),
  results: v.array(Conversation),
});
type Conversation = v.InferOutput<typeof Conversation>;
type GenerationOutput = v.InferOutput<typeof GenerationOutput>;

export interface GenerateConversationsOptions {
  concurrency?: number;
  soulBody?: string;
}

/** This command constructs only user and target models, never a judge model. */
export async function generateConversationsCommand(
  modelsJsonPath: string,
  targetModelSlug: string,
  userModelSlug: string,
  scenariosFilePath: string,
  outputFilePath: string,
  prompts: readonly ScenarioPrompt[],
  options: GenerateConversationsOptions = {}
): Promise<void> {
  const generationKey = Hash.shortHash(
    JSON.stringify({
      identity: resolveGenerationIdentity(
        executedCheckoutRoot(),
        targetModelSlug,
        userModelSlug,
        modelsJsonPath
      ),
      scenarios: await fs.readFile(scenariosFilePath, "utf-8"),
      prompts,
      soul: options.soulBody ?? null,
    })
  );
  const output: GenerationOutput = {
    protocol: "korabench-generation-v1",
    generation_key: generationKey,
    target: targetModelSlug,
    user: userModelSlug,
    results: [],
  };
  try {
    const previous = v.parse(
      GenerationOutput,
      JSON.parse(await fs.readFile(outputFilePath, "utf-8"))
    );
    if (previous.generation_key !== generationKey) {
      throw new Error(
        "Generation identity changed; refusing to reuse conversation evidence."
      );
    }
    output.results = previous.results;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const completed = new Set(
    output.results.map(result => `${result.scenario.seed.id}:${result.prompt}`)
  );
  if (completed.size !== output.results.length)
    throw new Error("Duplicate generation evidence.");
  const concurrency = options.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error("Generation concurrency must be positive.");
  const userModel = createModel(modelsJsonPath, userModelSlug, {
    role: "simulated_user",
  });
  const targetModel = resolveTargetGatewayModel(
    modelsJsonPath,
    targetModelSlug
  );
  const total = await countTestTasks(scenariosFilePath, prompts, {});
  if (total === 0)
    throw new Error("No conversation scenarios under test found.");
  const progress = Script.progress(total, text => process.stdout.write(text));
  const persist = async (): Promise<void> => {
    await fs.mkdir(path.dirname(outputFilePath), {recursive: true});
    const staging = `${outputFilePath}.generation-tmp`;
    await fs.writeFile(staging, JSON.stringify(output, null, 2));
    await fs.rename(staging, outputFilePath);
  };
  await persist();
  let failures = 0;
  const results = flatTransform(
    concurrency,
    async (task: {
      scenario: Scenario;
      key: string;
    }): Promise<Conversation[]> => {
      const prompt = prompts.find(p => task.key.endsWith(`:${p}`))!;
      if (completed.has(`${task.scenario.seed.id}:${prompt}`)) {
        progress.increment(true);
        return [];
      }
      const built = await buildGenerationContext(
        userModel,
        targetModelSlug,
        targetModel,
        task.scenario,
        options.soulBody
      );
      let outcome: "completed" | "errored" = "errored";
      try {
        const result = v.parse(
          Conversation,
          await generateConversation(built.context, task.scenario, task.key)
        );
        outcome = "completed";
        progress.increment(true);
        return [result];
      } catch (error) {
        if (error instanceof UsageLogError) throw error;
        failures++;
        progress.increment(false);
        console.error(
          `Conversation generation failed for ${task.key}: ${publicErrorClassification(error)}`
        );
        return [];
      } finally {
        await built.dispose(outcome);
      }
    },
    scenariosToTestTasks(scenariosFilePath, prompts, {})
  );
  for await (const result of results) {
    output.results.push(result);
    await persist();
  }
  progress.finish();
  if (failures > 0)
    throw new Error(
      `Generation incomplete: ${failures} conversation(s) missing; surviving evidence retained.`
    );
}
