import {ModelRequest, ModelResponse} from "@korabench/core";
import {describe, expect, it, vi} from "vitest";
import {GenerationContext} from "../benchmark.js";
import {generateConversation, kora} from "../kora.js";
import {createScenario} from "./fixtures.js";

describe("generateConversation", () => {
  it("generates real user/target turns without accessing any judge", async () => {
    const scenario = createScenario();
    const context: GenerationContext = {
      getUserResponse: vi.fn(
        async (_request: ModelRequest): Promise<ModelResponse> => ({
          output: "Next child message",
        })
      ),
      getAssistantResponse: vi.fn(
        async (_request: ModelRequest): Promise<ModelResponse> => ({
          output: "Target response",
        })
      ),
    };
    Object.defineProperty(context, "judgeModels", {
      get() {
        throw new Error("generation accessed judges");
      },
    });
    const key = kora.mapScenarioToKeys(scenario, ["none"])[0]!;
    const result = await generateConversation(context, scenario, key);
    expect(result.messages).toHaveLength(6);
    expect(result.messages[0]!.content).toBe(scenario.firstUserMessage);
    expect(result.messages[1]!.content).toBe("Target response");
    expect(context.getUserResponse).toHaveBeenCalledTimes(2);
    expect(context.getAssistantResponse).toHaveBeenCalledTimes(3);
    expect(result).not.toHaveProperty("assessment");
    expect(result).not.toHaveProperty("mechanismAssessment");
  });
});
