/** Historical deadline API composed with the bundled life-planning hierarchy policy. */

import type { TasqDb } from "../db.js";
import {
  evaluateWaitConditionDeadline as evaluateFlatDeadline,
  sweepWaitConditionDeadlines as sweepFlatDeadlines,
  type EvaluateDeadlineOptions,
  type SweepDeadlineOptions,
} from "./deadlines.js";
import { lifeTaskHierarchyPolicy } from "./life-task-policy.js";

export const evaluateWaitConditionDeadline = (
  db: TasqDb,
  conditionId: string,
  options: EvaluateDeadlineOptions = {},
) => evaluateFlatDeadline(db, conditionId, {
  ...options,
  hierarchyPolicy: lifeTaskHierarchyPolicy,
});

export const sweepWaitConditionDeadlines = (
  db: TasqDb,
  options: SweepDeadlineOptions = {},
) => sweepFlatDeadlines(db, {
  ...options,
  hierarchyPolicy: lifeTaskHierarchyPolicy,
});
