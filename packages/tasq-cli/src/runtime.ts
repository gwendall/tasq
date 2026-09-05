/**
 * CLI runtime — opens the DB, runs migrations, returns the handle.
 * Shared across all commands.
 */

import {
  openDb,
  committedMutationCount,
  localPrincipalId,
  recordPrincipalDevice,
  inspectStoreFormat,
  type StoreFormatInspection,
  runMigrations,
  renderProjection,
  ensureDeliverySink,
  disableDeliverySink,
  leaseNextDelivery,
  completeDelivery,
  failDelivery,
  getEvent,
  diagnoseStore,
  type OpenedDb,
  type ServiceContext,
} from "@tasq-internal/local-service";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  configUrl,
  ensureDbDir,
  inheritedSpaceOwnedElsewhere,
  loadConfig,
  resolveEffectiveSpace,
  resolveProjectionTarget,
  type EffectiveSpace,
  type TasqConfig,
} from "./config.js";
import { loadOrCreateDeviceIdentity } from "./identity.js";
import {
  appendJournalEvent,
  readLeadingCheckpoint,
  verifyJournalArchiveChain,
} from "./journal.js";
import { systemClock, type Clock } from "@tasq-run/schema";

export interface Runtime extends OpenedDb {
  config: TasqConfig;
  ctx: ServiceContext & { clock: Clock };
  journal: EventJournalBinding | null;
  /** Where the effective space came from. */
  effectiveSpace: EffectiveSpace;
  /** The projection file a mutation in this runtime renders to, if any. */
  projectionTarget: string | null;
}

export interface OpenRuntimeOptions {
  /** Explicit compatibility opt-in for the bundled reference extension. */
  installReferenceExtension?: boolean;
}

export interface EventJournalBinding {
  path: string;
  sinkId: string;
  tenantId: string;
}

export interface EventJournalDrainReport {
  delivered: number;
  alreadyPresent: number;
  coveredByCheckpoint: number;
  failed: number;
  quarantined: number;
}

export interface JournalCheckpointCoverage {
  valid: boolean;
  cursor: number;
  issue: string | null;
}

/**
 * Resolve the DB url: `TASQ_DB_URL` env (when set non-empty) takes
 * precedence over the config file. Lets tests + scripts pick a temp
 * DB without rewriting config.json.
 */
function resolveDbUrl(config: TasqConfig): string {
  const env = process.env.TASQ_DB_URL;
  if (env && env.length > 0) return env;
  return configUrl(config);
}


type StoreClient = Parameters<typeof inspectStoreFormat>[0];

/**
 * Crossing a store format is a decision, not a side effect of asking a question.
 *
 * Every command migrates on open, so on 2026-08-26 running this project's own
 * working tree against its own live ledger moved the store from format 32 to 33,
 * and the installed published binary then refused it. The operator asked for a
 * diagnosis; they got an irreversible format change.
 *
 * Released builds are gated too, and that is the substantive part. Tasq is a
 * SHARED ledger: two machines, or two agents in one fleet, on one store with
 * different Tasq versions means whoever runs first silently locks the others
 * out. The refusal they hit afterwards is clear and non-destructive; the
 * unconsented upgrade that caused it is what needed a gate.
 *
 * `tasq store upgrade` is the consent: typing the verb IS the decision, so
 * there is no prompt to script around and no flag to set blindly.
 */
async function assertMigrationIsIntended(client: StoreClient): Promise<void> {
  if (process.env.TASQ_ALLOW_STORE_UPGRADE === "1") return;
  const inspection = await inspectStoreFormat(client);
  if (!inspection.requiresIrreversibleUpgrade) return;
  throw new Error(
    `This store is format ${inspection.format}; this executable (${EXECUTABLE_VERSION}) writes `
    + `${inspection.current}. Opening it would apply an irreversible upgrade.\n`
    + `Pending: ${inspection.pending.map((entry) => entry.name).join(", ")}\n`
    + "Afterwards, any older Tasq sharing this store - another machine, another agent - could no "
    + "longer read it.\n"
    + "Run `tasq store upgrade` to do it deliberately; a verified snapshot is written first and "
    + "`tasq store restore` can roll it back. Run `tasq store clone --to <dir>` to rehearse instead.",
  );
}

export interface ConfiguredStoreInspection extends StoreFormatInspection {
  /** The store that was inspected, so a report can name it. */
  dbUrl: string;
}

/**
 * Inspect the configured store WITHOUT migrating it.
 *
 * `openRuntime` migrates on open, so a command that needs to know what it is
 * looking at before touching it - a diagnosis above all - has to ask here
 * first. Opening the connection does not modify the store; only `runMigrations`
 * does, and this never calls it.
 */
export async function inspectConfiguredStore(
  tenantOverride?: string,
): Promise<ConfiguredStoreInspection> {
  const loaded = loadConfig();
  const config = {
    ...loaded,
    tenantId: resolveEffectiveSpace({
      config: loaded,
      explicit: tenantOverride,
      environment: process.env.TASQ_TENANT,
    }).space,
  };
  const dbUrl = resolveDbUrl(config);
  const handle = await openDb({ url: dbUrl });
  try {
    return { ...(await inspectStoreFormat(handle.client)), dbUrl };
  } finally {
    await handle.close();
  }
}

declare const TASQ_BUILD_VERSION: string;
const EXECUTABLE_VERSION = typeof TASQ_BUILD_VERSION === "string" ? TASQ_BUILD_VERSION : "source";

export async function openRuntime(
  actorOverride?: string,
  tenantOverride?: string,
  clock: Clock = systemClock,
  options: OpenRuntimeOptions = {},
): Promise<Runtime> {
  const loaded = loadConfig();
  const effectiveSpace = resolveEffectiveSpace({
    config: loaded,
    explicit: tenantOverride,
    environment: process.env.TASQ_TENANT,
  });
  if (effectiveSpace.source === "global_default" && !effectiveSpace.space) {
    throw new Error(
      "No Tasq space is selected here: this directory is not bound and this machine has no global default.\n"
      + "Set the project up with `tasq setup --space <id> --actor <label>`, or create a local default "
      + "space with `tasq init`. Nothing was read or written.",
    );
  }
  if (effectiveSpace.source === "global_default") {
    const owners = inheritedSpaceOwnedElsewhere(loaded, effectiveSpace.space, process.cwd());
    if (owners.length > 0) {
      throw new Error(
        `This directory is not bound to a Tasq space, so the global default `
        + `${effectiveSpace.space} would be used - but that space is bound to `
        + `${owners.join(", ")}.\n`
        + "Refusing, because a command here would read and write another project's ledger while "
        + "appearing to succeed.\n"
        + `Bind this directory with \`tasq use <space>\`, or pass --tenant ${effectiveSpace.space} `
        + "to say you meant that one.",
      );
    }
  }
  const config = {
    ...loaded,
    tenantId: effectiveSpace.space,
  };
  const projectionTarget = resolveProjectionTarget(loaded, effectiveSpace);
  const dbUrl = resolveDbUrl(config);
  if (process.env.TASQ_DB_URL) {
    if (dbUrl.startsWith("file:") && !dbUrl.startsWith("file::memory:")) {
      mkdirSync(dirname(dbUrl.slice(5)), { recursive: true, mode: 0o700 });
    }
  } else {
    ensureDbDir(config);
  }
  const dbPath = dbUrl.startsWith("file:") && !dbUrl.startsWith("file::memory:")
    ? dbUrl.slice(5)
    : null;
  const createdDatabase = dbPath !== null && !existsSync(dbPath);
  const handle = await openDb({ url: dbUrl });
  await assertMigrationIsIntended(handle.client);
  await runMigrations(handle.client, {
    clock,
    // The CLI is the universal agent surface. Merely opening a space must
    // never provision Gmail, GitHub, Mercury or any other domain vocabulary.
    // Historical embedders may still opt into the bundled compatibility
    // extension through runMigrations(..., { installReferenceExtension: true }).
    installReferenceExtension: options.installReferenceExtension ?? false,
    postMigrationCheck: async () => {
      const report = await diagnoseStore(handle.db, handle.client, config.tenantId);
      return {
        ok: report.ok,
        issues: report.issues.map((issue) => `${issue.code}: ${issue.message}`),
      };
    },
  });
  // Creation must be private even under a permissive process umask. Existing
  // mode drift is intentionally left untouched for report-only `doctor` and
  // explicit `doctor --fix-permissions`.
  if (createdDatabase && dbPath && existsSync(dbPath)) chmodSync(dbPath, 0o600);

  const journal = await configureEventJournal(
    handle.db,
    config,
    Boolean(process.env.TASQ_DB_URL),
    clock,
  );
  const drainOwner = `tasq-cli:${process.pid}:${randomUUID()}`;
  if (journal) await drainEventJournal(handle.db, journal, clock, { leaseOwner: drainOwner });

  const ctx: ServiceContext & { clock: Clock } = {
    tenantId: config.tenantId,
    actor: actorOverride ?? process.env.TASQ_ACTOR ?? config.defaultActor,
    clock,
  };

  // The device is recorded once, at close, and only if this process actually
  // committed something. Recording it per attribution call would have covered
  // some writes and not others with no way to tell which, and a read must
  // never leave a mark.
  const mutationsAtOpen = committedMutationCount();

  let closed = false;
  return {
    ...handle,
    config,
    ctx,
    journal,
    effectiveSpace,
    projectionTarget,
    async close() {
      if (closed) return;
      closed = true;
      if (committedMutationCount() > mutationsAtOpen) {
        // Best effort by design: attribution detail must never turn a
        // committed mutation into a failed command.
        try {
          const device = loadOrCreateDeviceIdentity(clock.now());
          if (device) {
            await recordPrincipalDevice(
              handle.db,
              config.tenantId,
              localPrincipalId(config.tenantId, ctx.actor ?? "system"),
              device,
              clock.now(),
            );
          }
        } catch {
          // A device we could not record is the state the ledger was in before
          // this table existed. It is not a reason to fail the user's command.
        }
      }
      try {
        if (journal) {
          try {
            await drainEventJournal(handle.db, journal, clock, { leaseOwner: drainOwner });
          } catch (error) {
            // The command's authoritative mutation may already be committed.
            // A transient/structural drain failure must therefore leave its
            // durable outbox row for the next startup, never turn success into
            // a false command failure that an agent might retry.
            console.error(
              "tasq: event-journal drain deferred — " +
              (error instanceof Error ? error.message : String(error)),
            );
          }
        }
      } finally {
        await handle.close();
      }
    },
  };
}

/**
 * Mirror committed events to append-only JSONL. The DB remains authoritative;
 * this best-effort mirror provides off-DB audit evidence and gap detection.
 * Point-in-time recovery uses verified SQLite snapshots, not event replay.
 */
function eventJournalSinkId(tenantId: string): string {
  const tenantDigest = createHash("sha256").update(tenantId).digest("hex");
  return `tasq.event-journal.v1:${tenantDigest}`;
}

function eventJournalConfigurationDigest(): string {
  const digest = createHash("sha256")
    // Bind to portable format semantics, not an absolute device path. A
    // verified DB+journal restore into another HOME is the same logical sink.
    .update("tasq.event-journal.v1\0jsonl\0event-sequence")
    .digest("hex");
  return `sha256:${digest}`;
}

async function configureEventJournal(
  db: OpenedDb["db"],
  config: TasqConfig,
  isolatedDb: boolean,
  clock: Clock,
): Promise<EventJournalBinding | null> {
  const configuredPath = process.env.TASQ_EVENT_JOURNAL_PATH ?? config.eventJournalPath;
  const sinkId = eventJournalSinkId(config.tenantId);
  // An alternate DB is an isolation boundary. Never leak its events into the
  // real journal unless the caller explicitly supplies a matching target.
  if (!configuredPath || (isolatedDb && process.env.TASQ_EVENT_JOURNAL_PATH === undefined)) {
    await disableDeliverySink(db, sinkId, { tenantId: config.tenantId, clock });
    return null;
  }
  const path = configuredPath;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  await ensureDeliverySink(db, {
    id: sinkId,
    kind: "urn:tasq:sink:event-journal:v1",
    configurationDigest: eventJournalConfigurationDigest(),
  }, { tenantId: config.tenantId, clock });
  return { path, sinkId, tenantId: config.tenantId };
}

/**
 * Drain one JSONL sink in strict event order. Append is idempotent, so a crash
 * after fsync/append but before DB acknowledgement is safely recognized on the
 * next lease. Handler failures become deterministic backoff/quarantine state;
 * they never roll back the already-authoritative domain mutation. A caller
 * closing after a committed command also treats database drain failure as
 * deferred work, because reporting the command as failed would invite an
 * unsafe whole-command retry.
 */
export async function drainEventJournal(
  db: OpenedDb["db"],
  journal: EventJournalBinding,
  clock: Clock,
  options: {
    leaseOwner?: string;
    leaseMs?: number;
    maxRecords?: number;
    maxAttempts?: number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
  } = {},
): Promise<EventJournalDrainReport> {
  const leaseOwner = options.leaseOwner ?? `tasq-cli:${process.pid}:${randomUUID()}`;
  const report: EventJournalDrainReport = {
    delivered: 0,
    alreadyPresent: 0,
    coveredByCheckpoint: 0,
    failed: 0,
    quarantined: 0,
  };
  for (let index = 0; index < (options.maxRecords ?? 10_000); index++) {
    const leased = await leaseNextDelivery(db, journal.sinkId, {
      tenantId: journal.tenantId,
      leaseOwner,
      leaseMs: options.leaseMs ?? 30_000,
      clock,
    });
    if (!leased) break;
    try {
      const result = appendJournalEvent(journal.path, leased.event, clock);
      if (result === "covered_by_checkpoint") {
        const coverage = await verifyJournalCheckpointCoverage(db, journal);
        if (!coverage.valid || leased.event.sequence > coverage.cursor) {
          throw new Error(
            coverage.issue ??
            `Journal checkpoint does not cover event sequence ${leased.event.sequence}`,
          );
        }
      }
      await completeDelivery(db, leased.delivery.id, {
        tenantId: leased.delivery.tenantId,
        leaseOwner,
        clock,
      });
      if (result === "appended") report.delivered++;
      else if (result === "already_present") report.alreadyPresent++;
      else report.coveredByCheckpoint++;
    } catch (error) {
      const failed = await failDelivery(db, leased.delivery.id, {
        tenantId: leased.delivery.tenantId,
        leaseOwner,
        error: error instanceof Error ? error.message : String(error),
        maxAttempts: options.maxAttempts,
        baseBackoffMs: options.baseBackoffMs,
        maxBackoffMs: options.maxBackoffMs,
        clock,
      });
      report.failed++;
      if (failed.status === "quarantined") report.quarantined++;
      break;
    }
  }
  return report;
}

/**
 * Prove that the active checkpoint is a valid coverage boundary for this
 * exact tenant and database. Syntax alone is insufficient: a forged cursor
 * must never turn a missing external record into a successful delivery.
 */
export async function verifyJournalCheckpointCoverage(
  db: OpenedDb["db"],
  journal: EventJournalBinding,
): Promise<JournalCheckpointCoverage> {
  const checkpoint = readLeadingCheckpoint(journal.path);
  if (!checkpoint) return { valid: false, cursor: 0, issue: "Journal has no valid checkpoint" };
  if (checkpoint.tenantId !== journal.tenantId) {
    return {
      valid: false,
      cursor: checkpoint.databaseCursor,
      issue: `Journal checkpoint tenant ${checkpoint.tenantId} differs from ${journal.tenantId}`,
    };
  }
  if (checkpoint.databaseCursor === 0) {
    if (checkpoint.databaseEventId !== null) {
      return {
        valid: false,
        cursor: 0,
        issue: "Journal checkpoint at cursor 0 must have a null databaseEventId",
      };
    }
  } else {
    if (!checkpoint.databaseEventId) {
      return {
        valid: false,
        cursor: checkpoint.databaseCursor,
        issue: "Journal checkpoint cursor requires a databaseEventId",
      };
    }
    const boundary = await getEvent(db, checkpoint.databaseEventId, journal.tenantId);
    if (!boundary || boundary.sequence !== checkpoint.databaseCursor) {
      return {
        valid: false,
        cursor: checkpoint.databaseCursor,
        issue: `Journal checkpoint identity does not match database cursor ${checkpoint.databaseCursor}`,
      };
    }
  }
  const archive = verifyJournalArchiveChain(journal.path, checkpoint);
  if (!archive.ok) {
    return {
      valid: false,
      cursor: checkpoint.databaseCursor,
      issue: archive.issues[0] ?? "Journal checkpoint archive chain is invalid",
    };
  }
  return { valid: true, cursor: checkpoint.databaseCursor, issue: null };
}

/**
 * Regenerate the markdown projection after a mutation.
 * No-op when nothing is configured for the space this runtime opened: a
 * directory binding renders only its own projection, and the global target
 * renders only the global default space (see `resolveProjectionTarget`).
 */
export async function regenerateProjection(rt: Runtime): Promise<void> {
  const isolatedDb = Boolean(process.env.TASQ_DB_URL);
  const target = process.env.TASQ_PROJECTION_TARGET ?? rt.projectionTarget;
  if (!target || (isolatedDb && process.env.TASQ_PROJECTION_TARGET === undefined)) return;
  const md = await renderProjection(rt.db, { tenantId: rt.config.tenantId, clock: rt.ctx.clock });
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, md, "utf-8");
  renameSync(temporary, target);
}
