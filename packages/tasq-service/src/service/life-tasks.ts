/** Historical task API composed with the bundled life-planning hierarchy policy. */

import type { TasqDb } from "../db.js";
import {
  blockTask as blockFlatTask,
  cancelTask as cancelFlatTask,
  createTask as createFlatTask,
  reopenTask as reopenFlatTask,
  restoreTask as restoreFlatTask,
  startTask as startFlatTask,
  unblockTask as unblockFlatTask,
  updateTask as updateFlatTask,
  type StatusChangeOptions,
  type TaskServiceContext,
} from "./tasks.js";
import { lifeTaskHierarchyPolicy } from "./life-task-policy.js";

const withPolicy = <T extends TaskServiceContext>(context?: T): T & TaskServiceContext => ({
  ...(context ?? {} as T),
  hierarchyPolicy: lifeTaskHierarchyPolicy,
});

export const createTask = (db: TasqDb, input: unknown, context?: TaskServiceContext) =>
  createFlatTask(db, input, withPolicy(context));

export const updateTask = (
  db: TasqDb,
  id: string,
  update: unknown,
  context?: TaskServiceContext,
) => updateFlatTask(db, id, update, withPolicy(context));

export const startTask = (db: TasqDb, id: string, options?: StatusChangeOptions) =>
  startFlatTask(db, id, withPolicy(options));
export const blockTask = (db: TasqDb, id: string, options?: StatusChangeOptions) =>
  blockFlatTask(db, id, withPolicy(options));
export const unblockTask = (db: TasqDb, id: string, options?: StatusChangeOptions) =>
  unblockFlatTask(db, id, withPolicy(options));
export const cancelTask = (db: TasqDb, id: string, options?: StatusChangeOptions) =>
  cancelFlatTask(db, id, withPolicy(options));
export const reopenTask = (db: TasqDb, id: string, options?: StatusChangeOptions) =>
  reopenFlatTask(db, id, withPolicy(options));
export const restoreTask = (db: TasqDb, id: string, context?: TaskServiceContext) =>
  restoreFlatTask(db, id, withPolicy(context));
