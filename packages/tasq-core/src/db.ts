/**
 * DB connection — open a LibSQL file in WAL mode, return a Drizzle handle.
 *
 * Single point of access. The service layer holds one handle per process.
 * Concurrent `tasq` invocations across processes are safe because LibSQL
 * (SQLite under the hood) serializes writes via WAL.
 */

import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { createClient, type Client, type ResultSet } from "@libsql/client";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { schema } from "@tasq/schema";

export type TasqDb = LibSQLDatabase<typeof schema>;

/**
 * The structural base shared by the Drizzle db handle and a transaction
 * handle (`db.transaction(async (tx) => ...)`). Both `LibSQLDatabase` and
 * `LibSQLTransaction` extend `BaseSQLiteDatabase<"async", ResultSet, _>`, so
 * a function typed against `TasqDbOrTx` can run with either the top-level
 * handle or a `tx` from inside a transaction.
 *
 * Public service signatures keep the narrow `TasqDb`. Only the *internal*
 * read helpers + `recordEvent` widen to `TasqDbOrTx` so the post-write
 * read-back + event insert can execute inside the surrounding transaction
 * (and thus see the uncommitted write / roll back together).
 */
export type TasqDbOrTx = BaseSQLiteDatabase<"async", ResultSet, typeof schema>;

/**
 * Per-handle in-process serialization for interactive transactions.
 *
 * Drizzle's `db.transaction(fn)` issues `BEGIN IMMEDIATE` (it asks the
 * libsql client for a "write" transaction), which grabs the writer lock up
 * front. We hold exactly ONE connection per process, so two transactions
 * started concurrently (e.g. `Promise.all([startTask(a), startTask(b)])`)
 * would both try to `BEGIN IMMEDIATE` on the same connection — the second
 * one trips `SQLITE_BUSY` *immediately*, and `busy_timeout` cannot resolve
 * it because the lock is held by this very connection's other transaction
 * (a self-deadlock the timer can't break).
 *
 * The fix is to queue transactions per handle so they run one at a time on
 * the shared connection. This is purely in-process: cross-process contention
 * is still handled by SQLite's WAL writer + `busy_timeout` (see `openDb`).
 * The queue is keyed by the db handle so distinct handles never block each
 * other, and a transaction body's own error never poisons the chain.
 */
const txChains = new WeakMap<object, Promise<unknown>>();

/**
 * Process-global count of mutation transactions that have COMMITTED (one per
 * successful `runInTransaction`). It only ever increases. The CLI's retry
 * logic samples this around a command attempt: if a transient SQLITE_BUSY is
 * thrown and the count did NOT advance, then NO domain mutation committed
 * during that attempt (the BUSY hit connection-open / migration, local
 * delivery bookkeeping, or a rolled-back domain transaction), so a
 * whole-command replay is provably safe — it cannot double-apply. If the
 * count advanced, a domain mutation already committed and the command must
 * NOT be replayed.
 */
let committedMutations = 0;

/** Read the process-global committed-mutation count (see `runInTransaction`). */
export function committedMutationCount(): number {
  return committedMutations;
}

/**
 * Run `fn` inside a single `db.transaction(...)` (row write + event commit
 * or roll back together), serialized against any other transaction on the
 * same handle. Domain and local-operational wrappers both use this instead of
 * `db.transaction` directly so concurrent writes queue rather than
 * self-deadlock.
 */
async function runSerializedTransaction<T>(
  db: TasqDb,
  fn: (tx: Parameters<Parameters<TasqDb["transaction"]>[0]>[0]) => Promise<T>,
  countAsDomainMutation: boolean,
): Promise<T> {
  const prior = txChains.get(db) ?? Promise.resolve();
  // Chain onto the prior transaction, swallowing its result/error so our
  // turn always starts cleanly once it has settled.
  const run = prior.catch(() => {}).then(() => db.transaction(fn));
  // Keep the chain alive even if `run` rejects — the next caller must still
  // proceed after this one settles.
  txChains.set(db, run.catch(() => {}));
  // A resolved `run` means the transaction COMMITTED (drizzle resolves only
  // after COMMIT ; a throw inside `fn` rejects after ROLLBACK). Bump the
  // domain-commit count only when replaying the enclosing command could
  // duplicate user-visible state.
  const result = await run;
  if (countAsDomainMutation) committedMutations++;
  return result;
}

export async function runInTransaction<T>(
  db: TasqDb,
  fn: (tx: Parameters<Parameters<TasqDb["transaction"]>[0]>[0]) => Promise<T>,
): Promise<T> {
  return runSerializedTransaction(db, fn, true);
}

/**
 * Serialize local operational state without marking a domain mutation as
 * committed. Outbox lease/ack/retry transactions use this path: if a later
 * domain write rolls back with SQLITE_BUSY, replaying the CLI command remains
 * safe even though delivery bookkeeping advanced earlier in the attempt.
 */
export async function runOperationalTransaction<T>(
  db: TasqDb,
  fn: (tx: Parameters<Parameters<TasqDb["transaction"]>[0]>[0]) => Promise<T>,
): Promise<T> {
  return runSerializedTransaction(db, fn, false);
}

export interface OpenDbOptions {
  /** Path to the LibSQL file. Defaults to `~/.tasq/db.sqlite`. */
  url?: string;
  /** Set to false to skip WAL pragma (useful for in-memory tests). */
  wal?: boolean;
}

export interface OpenedDb {
  db: TasqDb;
  client: Client;
  /** Close both Drizzle + raw client connections. */
  close: () => Promise<void>;
}

export interface DatabaseVerification {
  ok: boolean;
  integrity: string;
  foreignKeyViolations: number;
  /** Highest durable event sequence contained in this exact file. */
  eventCursor: number | null;
}

/** Verify a SQLite snapshot without migrating or otherwise mutating it. */
export async function verifyDatabaseFile(path: string): Promise<DatabaseVerification> {
  const client = createClient({ url: `file:${path}` });
  try {
    await client.execute("PRAGMA foreign_keys = ON");
    const integrity = await client.execute("PRAGMA integrity_check");
    const foreignKeys = await client.execute("PRAGMA foreign_key_check");
    const eventColumns = await client.execute("PRAGMA table_info('event')");
    const hasSequence = eventColumns.rows.some((row) => row["name"] === "sequence");
    const eventCursor = hasSequence
      ? Number((await client.execute("SELECT coalesce(max(sequence), 0) AS cursor FROM event")).rows[0]?.["cursor"] ?? 0)
      : null;
    const result = String(integrity.rows[0]?.["integrity_check"] ?? "unknown");
    return {
      ok: result === "ok" && foreignKeys.rows.length === 0,
      integrity: result,
      foreignKeyViolations: foreignKeys.rows.length,
      eventCursor,
    };
  } finally {
    client.close();
  }
}

/**
 * Open the tasq database. Pragmas applied:
 *   - busy_timeout = 30000 (installed first, before WAL negotiation can lock)
 *   - journal_mode = WAL  (concurrent reads while writing, safe cross-process)
 *   - foreign_keys = ON   (we rely on FK constraints)
 *   - synchronous = NORMAL (good WAL companion; safe + fast)
 * The timeout is generous and covers first-write WAL recovery
 *     contention when several processes spawn against a fresh DB; SQLite's
 *     `SQLITE_BUSY_RECOVERY` is shorter-lived than plain lock contention
 *     but still requires patience under cold-start fan-out.
 */
export async function openDb(opts: OpenDbOptions = {}): Promise<OpenedDb> {
  const url = opts.url ?? defaultDbUrl();
  const wal = opts.wal ?? !url.startsWith(":memory:");

  const client = createClient({ url });

  // Install the busy handler before journal-mode negotiation. WAL negotiation
  // itself can need a write lock while another process is closing a committed
  // transaction; configuring the timeout afterwards leaves that first boundary
  // vulnerable to an immediate SQLITE_BUSY.
  await client.execute("PRAGMA busy_timeout = 30000");
  if (wal) {
    await client.execute("PRAGMA journal_mode = WAL");
  }
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA synchronous = NORMAL");

  const db = drizzle(client, { schema });

  return {
    db,
    client,
    async close() {
      client.close();
    },
  };
}

/**
 * Default DB URL: `file:~/.tasq/db.sqlite`.
 * Respects `TASQ_DB_URL` env override (useful for tests + alt locations).
 */
export function defaultDbUrl(): string {
  const env = process.env.TASQ_DB_URL;
  if (env && env.length > 0) return env;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return `file:${home}/.tasq/db.sqlite`;
}
