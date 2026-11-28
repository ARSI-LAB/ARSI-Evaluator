import type { WorkflowPort } from "../contracts/workflow.js";
import { workflowObject, workflowValue } from "./values.js";

/** Numeric metrics carry their unit and direction so unlike measurements cannot silently be averaged. */
export function scoreSetPort(): WorkflowPort {
  return { protocol: "arsi.score-set/v1", validate(value) {
    if (!Array.isArray(value)) throw new TypeError("Scores must be an array");
    return value.map((entry, index) => {
      const score = workflowObject(entry, `scores[${index}]`);
      for (const key of ["subject", "metric", "unit", "scorer"]) if (typeof score[key] !== "string" || !score[key].trim())
        throw new TypeError(`scores[${index}].${key} must be nonempty`);
      if (!["higher", "lower", "none"].includes(String(score.direction))) throw new TypeError("Score direction must be higher, lower or none");
      if (typeof score.valid !== "boolean" || score.valid && typeof score.value !== "number" || !score.valid && score.value !== null)
        throw new TypeError("A valid score requires a finite number; an invalid score requires null");
      if (!Array.isArray(score.evidence)) throw new TypeError("Score evidence must be an array of references");
      return workflowValue(score);
    });
  } };
}
