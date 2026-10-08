import {ModelRequest, TypedModelRequest} from "@korabench/core";
import {publicErrorClassification} from "../retry.js";
import {Model} from "./model.js";
import {UsageLogError} from "./usageLog.js";

interface LabeledModel {
  label: string;
  model: Model;
}

export function createFallbackModel(models: readonly LabeledModel[]): Model {
  if (models.length === 0) {
    throw new Error("createFallbackModel: at least one model required.");
  }

  const head = models[0]!;
  if (models.length === 1) {
    return head.model;
  }

  async function tryChain<T>(
    method: "getTextResponse" | "getStructuredResponse",
    invoke: (m: Model) => Promise<T>
  ): Promise<T> {
    let lastError: unknown;
    for (let i = 0; i < models.length; i++) {
      const current = models[i]!;
      try {
        return await invoke(current.model);
      } catch (error) {
        if (error instanceof UsageLogError) throw error;
        lastError = error;
        const classification = publicErrorClassification(error);
        const next = models[i + 1];
        if (next) {
          console.error(
            `[fallback] ${method} on ${current.label} exhausted retries; failing over to ${next.label}: ${classification}`
          );
        } else {
          console.error(
            `[fallback] ${method} exhausted on final model ${current.label}: ${classification}`
          );
        }
      }
    }
    throw lastError;
  }

  return {
    getTextResponse(request: ModelRequest) {
      return tryChain("getTextResponse", m => m.getTextResponse(request));
    },
    getStructuredResponse<T>(request: TypedModelRequest<T>) {
      return tryChain("getStructuredResponse", m =>
        m.getStructuredResponse(request)
      );
    },
  };
}
