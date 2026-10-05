import {ModelRequest, ModelResponse} from "@korabench/core";
import * as v from "valibot";
import {describe, expect, it, vi} from "vitest";
import {JudgeModel, TestContext} from "../benchmark.js";
import {kora} from "../kora.js";
import {Mechanism} from "../model/mechanism.js";
import {ScenarioPrompt} from "../model/scenarioKey.js";
import {TestAssessment} from "../model/testAssessment.js";
import {createScenario} from "./fixtures.js";

//
// Helpers.
//

interface MockJudgeModel extends JudgeModel {
  getResponse: JudgeModel["getResponse"] & ReturnType<typeof vi.fn>;
}

function mechanismAssessmentOutput(): Record<
  string,
  {grade: string; occurrenceCount: number; reasons: string}
> {
  return Object.fromEntries(
    Mechanism.listAll().map(m => [
      m.id,
      {
        grade: "adequate",
        occurrenceCount: 0,
        reasons: `Placeholder judge reasoning for ${m.name} — adequate grade with zero occurrences in the conversation under evaluation.`,
      },
    ])
  );
}

// The judge makes TWO calls per conversation: one for the safety assessment,
// one for the mechanism assessment. The mock returns a merged shape so each
// call finds the fields it needs in the returned output.
function createMockJudgeModel(): MockJudgeModel {
  return {
    getResponse: vi.fn(async () => ({
      output: {
        grade: "adequate",
        reasons:
          "The assistant responded appropriately to the child's request, maintaining a helpful and " +
          "supportive tone throughout the conversation while being mindful of the child's age and context.",
        ...mechanismAssessmentOutput(),
      },
    })),
  } as MockJudgeModel;
}

function createTestContext(): TestContext & {judgeModel: MockJudgeModel} {
  const judgeModel = createMockJudgeModel();
  return {
    getUserResponse: vi.fn(
      async (_request: ModelRequest): Promise<ModelResponse> => ({
        output: "Follow-up question from user.",
      })
    ),
    getAssistantResponse: vi.fn(
      async (_request: ModelRequest): Promise<ModelResponse> => ({
        output: "Assistant response to the user.",
      })
    ),
    judgeModels: {"test-judge": judgeModel},
    judgeModel,
  };
}

//
// Tests.
//

describe("kora.runTest", () => {
  const scenario = createScenario();
  const keys = kora.mapScenarioToKeys(scenario, ScenarioPrompt.list);
  const defaultKey = keys.find(k => k.endsWith(":default"))!;
  const childKey = keys.find(k => k.endsWith(":child"))!;
  const soulKey = keys.find(k => k.endsWith(":soul"))!;
  const noneKey = keys.find(k => k.endsWith(":none"))!;

  it("produces a 3-turn conversation with 6 messages", async () => {
    const context = createTestContext();

    const result = await kora.runTest(context, scenario, defaultKey);

    expect(result.messages).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      expect(result.messages[i]!.role).toBe(i % 2 === 0 ? "user" : "assistant");
    }
  });

  it("uses scenario.firstUserMessage for the first turn", async () => {
    const context = createTestContext();

    const result = await kora.runTest(context, scenario, defaultKey);

    expect(result.messages[0]!.content).toBe(scenario.firstUserMessage);
  });

  it("calls getUserResponse for subsequent turns (2 times)", async () => {
    const context = createTestContext();

    await kora.runTest(context, scenario, defaultKey);

    expect(context.getUserResponse).toHaveBeenCalledTimes(2);
  });

  it("calls getAssistantResponse 3 times (once per turn)", async () => {
    const context = createTestContext();

    await kora.runTest(context, scenario, defaultKey);

    expect(context.getAssistantResponse).toHaveBeenCalledTimes(3);
  });

  it("returns correct shape with scenario, prompt, messages, assessment, mechanismAssessment, judgeAssessments", async () => {
    const context = createTestContext();

    const result = await kora.runTest(context, scenario, defaultKey);

    expect(result).toHaveProperty("scenario");
    expect(result).toHaveProperty("prompt");
    expect(result).toHaveProperty("messages");
    expect(result).toHaveProperty("assessment");
    expect(result).toHaveProperty("mechanismAssessment");
    expect(result).toHaveProperty("judgeAssessments");
    expect(result.scenario).toBe(scenario);
  });

  it("mechanismAssessment contains every declared mechanism", async () => {
    const context = createTestContext();

    const result = await kora.runTest(context, scenario, defaultKey);

    for (const mechanism of Mechanism.listAll()) {
      expect(result.mechanismAssessment?.[mechanism.id]).toBeDefined();
    }
  });

  it("prompt matches key — default key yields 'default' prompt", async () => {
    const context = createTestContext();

    const result = await kora.runTest(context, scenario, defaultKey);

    expect(result.prompt).toBe("default");
  });

  it("prompt matches key — child key yields 'child' prompt", async () => {
    const context = createTestContext();

    const result = await kora.runTest(context, scenario, childKey);

    expect(result.prompt).toBe("child");
  });

  it("calls each judge model twice (safety + mechanism assessment)", async () => {
    const context = createTestContext();

    await kora.runTest(context, scenario, defaultKey);

    expect(context.judgeModel.getResponse).toHaveBeenCalledTimes(2);
  });

  describe("skipMechanisms", () => {
    it("makes only the safety call, with the same prompt as a full run", async () => {
      const full = createTestContext();
      await kora.runTest(full, scenario, defaultKey);
      const skipped = createTestContext();
      skipped.skipMechanisms = true;

      await kora.runTest(skipped, scenario, defaultKey);

      const safetyRequest = skipped.judgeModel.getResponse.mock.calls[0]![0];
      expect(skipped.judgeModel.getResponse).toHaveBeenCalledTimes(1);
      expect(safetyRequest.outputType).toBe(TestAssessment.io);
      expect(safetyRequest).toEqual(
        full.judgeModel.getResponse.mock.calls[0]![0]
      );
    });

    it("returns the safety grade and no mechanism fields", async () => {
      const context = createTestContext();
      context.skipMechanisms = true;
      // A schema-valid safety-only judge output, so the result can be re-read.
      const safety = {
        grade: "failing",
        reasons:
          "The assistant engaged with the risky request and did not redirect the child toward a trusted adult, " +
          "which leaves the child without appropriate safeguards at the moment they most needed them in this conversation.",
      };
      context.judgeModel.getResponse.mockImplementation(async () => ({
        output: safety,
      }));

      const result = await kora.runTest(context, scenario, defaultKey);

      expect(result.assessment).toEqual(safety);
      expect(result).not.toHaveProperty("mechanismAssessment");
      for (const judge of result.judgeAssessments) {
        expect(judge).not.toHaveProperty("mechanismAssessment");
      }
      // A graceful restart re-reads the persisted result through the schema.
      const reread = v.parse(
        kora.testResultType,
        JSON.parse(JSON.stringify(result))
      );
      expect(reread).not.toHaveProperty("mechanismAssessment");
      expect(reread.assessment).toEqual(safety);
    });
  });

  it("passes soulBody verbatim as the system prompt when prompt='soul'", async () => {
    const context = createTestContext();
    const soulBody = "SOUL_BODY_X — verbatim system prompt for SOULFuzz.";
    context.soulBody = soulBody;

    await kora.runTest(context, scenario, soulKey);

    const calls = (context.getAssistantResponse as ReturnType<typeof vi.fn>)
      .mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [request] of calls) {
      const systemMessage = request.messages[0]!;
      expect(systemMessage.role).toBe("system");
      expect(systemMessage.content).toBe(soulBody);
    }
  });

  describe("prompt 'none'", () => {
    const modelMemory = "MEMORY_X — the child likes blue things.";
    const soulBody = "SOUL_BODY_X — must not reach a none target.";
    const memoryScenario = createScenario({modelMemory});

    function targetRequests(context: TestContext): ModelRequest[] {
      const mock = context.getAssistantResponse as ReturnType<typeof vi.fn>;
      return mock.mock.calls.map(([request]) => request as ModelRequest);
    }

    function createNoneContext(): ReturnType<typeof createTestContext> {
      const context = createTestContext();
      context.soulBody = soulBody;
      // Distinct, ordered replies so each assistant turn is identifiable.
      let assistantTurn = 0;
      (
        context.getAssistantResponse as ReturnType<typeof vi.fn>
      ).mockImplementation(async () => ({
        output: `assistant-${assistantTurn++}`,
      }));
      let userTurn = 0;
      (context.getUserResponse as ReturnType<typeof vi.fn>).mockImplementation(
        async () => ({output: `user-${++userTurn}`})
      );
      return context;
    }

    it("sends only the conversational history on every target turn", async () => {
      const context = createNoneContext();

      const result = await kora.runTest(context, memoryScenario, noneKey);

      expect(result.prompt).toBe("none");
      expect(result.messages).toEqual([
        {role: "user", content: memoryScenario.firstUserMessage},
        {role: "assistant", content: "assistant-0"},
        {role: "user", content: "user-1"},
        {role: "assistant", content: "assistant-1"},
        {role: "user", content: "user-2"},
        {role: "assistant", content: "assistant-2"},
      ]);
      // Each target request equals the history up to and including the latest
      // user message: nothing prepended, nothing appended.
      const requests = targetRequests(context);
      expect(requests.map(r => r.messages)).toEqual([
        result.messages.slice(0, 1),
        result.messages.slice(0, 3),
        result.messages.slice(0, 5),
      ]);
    });

    it("never sends a system or developer message, even with memory and a soul body supplied", async () => {
      const context = createNoneContext();

      await kora.runTest(context, memoryScenario, noneKey);

      const requests = targetRequests(context);
      expect(requests).toHaveLength(3);
      for (const request of requests) {
        for (const message of request.messages) {
          expect(["user", "assistant"]).toContain(message.role);
          expect(message.content).not.toBe(soulBody);
          expect(message.content).not.toBe(modelMemory);
        }
      }
    });

    it("keeps omitting the system message when resuming from startMessages", async () => {
      const context = createNoneContext();
      const startMessages = [
        {role: "user" as const, content: "resumed-user-0"},
        {role: "assistant" as const, content: "resumed-assistant-0"},
      ];

      const result = await kora.runTest(
        context,
        memoryScenario,
        noneKey,
        startMessages
      );

      const requests = targetRequests(context);
      expect(requests).toHaveLength(2);
      expect(requests[0]!.messages).toEqual([
        ...startMessages,
        {role: "user", content: "user-1"},
      ]);
      expect(requests[1]!.messages).toEqual(result.messages.slice(0, 5));
      for (const request of requests) {
        expect(request.messages.every(m => m.role !== "system")).toBe(true);
      }
    });

    it("leaves simulator and judge requests untouched by the omission", async () => {
      const withNone = createNoneContext();
      const withDefault = createNoneContext();

      await kora.runTest(withNone, memoryScenario, noneKey);
      await kora.runTest(withDefault, memoryScenario, defaultKey);

      const requestsOf = (context: TestContext) =>
        (context.getUserResponse as ReturnType<typeof vi.fn>).mock.calls;
      expect(requestsOf(withNone)).toHaveLength(2);
      expect(requestsOf(withNone)).toEqual(requestsOf(withDefault));
      const judgeCalls = (context: ReturnType<typeof createTestContext>) =>
        context.judgeModel.getResponse.mock.calls;
      expect(judgeCalls(withNone)).toHaveLength(2);
    });

    it("differs from default, which does inject a system message with memory", async () => {
      const context = createNoneContext();

      await kora.runTest(context, memoryScenario, defaultKey);

      const first = targetRequests(context)[0]!;
      expect(first.messages[0]!.role).toBe("system");
      expect(String(first.messages[0]!.content)).toContain(modelMemory);
    });
  });

  it("passes soulBody verbatim on every turn of a resumed 'soul' conversation", async () => {
    const context = createTestContext();
    const soulBody = "SOUL_BODY_Y — resumed verbatim system prompt.";
    context.soulBody = soulBody;

    await kora.runTest(context, scenario, soulKey, [
      {role: "user", content: "resumed-user-0"},
      {role: "assistant", content: "resumed-assistant-0"},
    ]);

    const calls = (context.getAssistantResponse as ReturnType<typeof vi.fn>)
      .mock.calls;
    expect(calls).toHaveLength(2);
    for (const [request] of calls) {
      expect(request.messages[0]).toEqual({role: "system", content: soulBody});
      expect(
        request.messages
          .slice(1)
          .every((m: {role: string}) => m.role !== "system")
      ).toBe(true);
    }
  });

  it("judgeAssessments length matches number of judge models", async () => {
    const judge1 = createMockJudgeModel();
    const judge2 = createMockJudgeModel();
    const context: TestContext = {
      getUserResponse: vi.fn(
        async (_request: ModelRequest): Promise<ModelResponse> => ({
          output: "Follow-up question from user.",
        })
      ),
      getAssistantResponse: vi.fn(
        async (_request: ModelRequest): Promise<ModelResponse> => ({
          output: "Assistant response to the user.",
        })
      ),
      judgeModels: {"judge-a": judge1, "judge-b": judge2},
    };

    const result = await kora.runTest(context, scenario, defaultKey);

    expect(result.judgeAssessments).toHaveLength(2);
    expect(result.judgeAssessments[0]!.judgeModelSlug).toBe("judge-a");
    expect(result.judgeAssessments[1]!.judgeModelSlug).toBe("judge-b");
    expect(judge1.getResponse).toHaveBeenCalledTimes(2);
    expect(judge2.getResponse).toHaveBeenCalledTimes(2);
  });
});
