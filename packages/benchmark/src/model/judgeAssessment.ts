import * as v from "valibot";

import {MechanismAssessment} from "./mechanismAssessment.js";
import {TestAssessment} from "./testAssessment.js";

//
// Runtime type.
//

const VJudgeAssessment = v.strictObject({
  judgeModelSlug: v.string(),
  assessment: TestAssessment.io,
  /** Absent when the run skipped the mechanism judge call. */
  mechanismAssessment: v.optional(MechanismAssessment.io),
});

//
// Exports.
//

export interface JudgeAssessment extends v.InferOutput<
  typeof VJudgeAssessment
> {}

export const JudgeAssessment = {
  io: VJudgeAssessment,
};
