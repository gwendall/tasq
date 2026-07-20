/**
 * Bundled life-planning profile.
 *
 * This package deliberately has no database, Drizzle, service or kernel-schema
 * dependency. It consumes structural read models and returns deterministic
 * policy output. The reference Tasq service is only an adapter that loads those
 * views and preserves the historical CLI contract.
 */

export {
  LIFE_PRIORITIZER_CONFIG,
  scoreTask,
} from "./prioritizer.js";
export type {
  LifePlanningArea,
  LifePlanningGoal,
  LifePlanningTask,
  ScoreBreakdown,
  ScoreInputs,
} from "./prioritizer.js";
export { renderLifePlanningMarkdown } from "./projection.js";
export type {
  LifePlanningProjectionArea,
  LifePlanningProjectionGoal,
  LifePlanningProjectionInput,
  LifePlanningProjectionProject,
  LifePlanningProjectionTask,
  LifePlanningRankedTask,
} from "./projection.js";
export { nextOccurrence, planNextRecurrence } from "./recurrence.js";
export type {
  CompletedRecurringTask,
  LifeRecurrenceAnchor,
  LifeRecurrenceUnit,
  NextRecurrencePlan,
} from "./recurrence.js";
export { resolveCanonicalLifePlanningScope } from "./hierarchy.js";
export type {
  CanonicalLifePlanningScope,
  LifePlanningHierarchyLookup,
  LifePlanningScopeArea,
  LifePlanningScopeGoal,
  LifePlanningScopeInput,
  LifePlanningScopeProject,
  LifePlanningScopeTask,
} from "./hierarchy.js";
