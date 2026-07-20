/** Compatibility composition for the bundled life-planning recurrence policy. */

import type { TasqDb } from "../db.js";
import { materializeNextInstance } from "./recurrence.js";
import { lifeTaskHierarchyPolicy } from "./life-task-policy.js";
import {
  transitionTaskStatus,
  type StatusChangeOptions,
} from "./tasks.js";

export const completeTask = (
  db: TasqDb,
  id: string,
  options?: StatusChangeOptions,
) => transitionTaskStatus(
  db,
  id,
  "done",
  { ...options, hierarchyPolicy: lifeTaskHierarchyPolicy },
  materializeNextInstance,
);
