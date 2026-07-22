/** Historical local composition: neutral schema plus the bundled reference extension. */

import type { Client } from "@libsql/client";
import {
  runMigrations as runKernelMigrations,
  type MigrationOptions as KernelMigrationOptions,
  type MigrationResult,
} from "./index.js";
import { ensureReferenceExtensionRegistry } from "../service/reference-extensions.js";
import { serviceNow } from "../util/clock.js";

export interface MigrationOptions extends KernelMigrationOptions {
  /** Compatibility-only domain install. Strict Core never accepts this option. */
  installReferenceExtension?: boolean;
}

export async function runMigrations(
  client: Client,
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const result = await runKernelMigrations(client, options);
  if (options.installReferenceExtension ?? true) {
    await ensureReferenceExtensionRegistry(client, undefined, {
      now: serviceNow(options, options.now),
    });
  }
  return result;
}

export type { KernelMigrationOptions, MigrationResult };
export {
  STORE_FORMAT_COMPATIBILITY,
  StoreCompatibilityError,
  MigrationSafetyError,
} from "./index.js";
export type {
  MigrationReceiptSummary,
  MigrationPostCheck,
  MigrationSafetyBoundary,
} from "./index.js";
