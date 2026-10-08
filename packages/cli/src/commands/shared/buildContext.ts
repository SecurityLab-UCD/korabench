import {
  GenerationContext,
  JudgeModel,
  Scenario,
  TestContext,
} from "@korabench/benchmark";
import * as R from "remeda";
import {createModel} from "../../models/createModel.js";
import {createCustomModel} from "../../models/customModel.js";
import {Model} from "../../models/model.js";
import {isNativeRunnerSlug} from "../../models/nativeRunnerModel.js";
import {isWebRunnerSlug} from "../../models/webRunnerModel.js";

export interface BuiltGenerationContext {
  context: GenerationContext;
  /** Tear down the target model (e.g., release the web-runner browser
   * session). Always safe to call; idempotent. */
  dispose: (outcome: "completed" | "errored") => Promise<void>;
}

export interface BuiltContext extends BuiltGenerationContext {
  context: TestContext;
}

export async function buildContext(
  judgeModels: Record<string, Model>,
  userModel: Model,
  targetModelSlug: string,
  targetGatewayModel: Model | undefined,
  scenario: Scenario,
  soulBody?: string
): Promise<BuiltContext> {
  const built = await buildGenerationContext(
    userModel,
    targetModelSlug,
    targetGatewayModel,
    scenario,
    soulBody
  );
  return {
    ...built,
    context: {
      ...built.context,
      judgeModels: R.mapValues(
        judgeModels,
        (model: Model): JudgeModel => ({
          getResponse: async request => ({
            output: await model.getStructuredResponse(request),
          }),
        })
      ),
    },
  };
}

export async function buildGenerationContext(
  userModel: Model,
  targetModelSlug: string,
  targetGatewayModel: Model | undefined,
  scenario: Scenario,
  soulBody?: string
): Promise<BuiltGenerationContext> {
  const targetModel = await (async () => {
    if (targetGatewayModel) {
      return targetGatewayModel;
    }

    return createCustomModel(targetModelSlug, scenario);
  })();

  const context: GenerationContext = {
    getUserResponse: async request => ({
      output: await userModel.getTextResponse(request),
    }),
    getAssistantResponse: async request => ({
      output: await targetModel.getTextResponse(request),
    }),
    soulBody,
  };

  return {
    context,
    async dispose(outcome) {
      // Only the targetModel is expected to hold disposable resources today
      // (e.g., the WebRunnerModel keeps a browser session). Gateway models
      // are stateless and have no `dispose`.
      if (targetModel.dispose) {
        await targetModel.dispose(outcome);
      }
    },
  };
}

export function resolveTargetGatewayModel(
  modelsJsonPath: string,
  targetModelSlug: string
): Model | undefined {
  if (
    targetModelSlug.startsWith("custom-") ||
    isWebRunnerSlug(targetModelSlug) ||
    isNativeRunnerSlug(targetModelSlug)
  ) {
    return undefined;
  }
  return createModel(modelsJsonPath, targetModelSlug, {role: "target"});
}
