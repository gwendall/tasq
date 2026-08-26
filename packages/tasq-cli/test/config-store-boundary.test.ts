/**
 * A Tasq home you copy must not drive the home you copied it from.
 *
 * config.json stores dbPath and eventJournalPath as absolute paths, so a copied
 * home still names the original store. `TASQ_HOME=<copy> tasq <anything>` then
 * reads the copy's config and writes the ORIGINAL - which is how rehearsing a
 * migration on a copy destroys the thing it was rehearsing for. That happened
 * to this project's own ledger on 2026-08-26.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

const dirs: string[] = [];
const saved = { home: process.env.TASQ_HOME, escape: process.env.TASQ_ALLOW_EXTERNAL_STORE };

afterEach(() => {
  process.env.TASQ_HOME = saved.home;
  process.env.TASQ_ALLOW_EXTERNAL_STORE = saved.escape;
  if (saved.home === undefined) delete process.env.TASQ_HOME;
  if (saved.escape === undefined) delete process.env.TASQ_ALLOW_EXTERNAL_STORE;
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function home(config: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "tasq-boundary-"));
  dirs.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "config.json"), JSON.stringify(config, null, 2), "utf8");
  return root;
}

const base = {
  tenantId: "gwendall",
  defaultActor: "gwendall",
};

describe("store boundary of an explicit TASQ_HOME", () => {
  test("refuses a config whose store lives outside the home it was loaded from", () => {
    const other = mkdtempSync(join(tmpdir(), "tasq-original-"));
    dirs.push(other);
    const copy = home({
      ...base,
      dbPath: join(other, "db.sqlite"),
      eventJournalPath: join(other, "events.jsonl"),
    });
    process.env.TASQ_HOME = copy;
    delete process.env.TASQ_ALLOW_EXTERNAL_STORE;

    // The message must name both paths: the operator's mental model is wrong,
    // and only seeing the two side by side corrects it.
    expect(() => loadConfig()).toThrow(new RegExp(other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(() => loadConfig()).toThrow(/TASQ_ALLOW_EXTERNAL_STORE/);
  });

  test("accepts a home whose store lives inside it", () => {
    const root = mkdtempSync(join(tmpdir(), "tasq-inside-"));
    dirs.push(root);
    writeFileSync(join(root, "config.json"), JSON.stringify({
      ...base,
      dbPath: join(root, "db.sqlite"),
      eventJournalPath: join(root, "events.jsonl"),
    }, null, 2), "utf8");
    process.env.TASQ_HOME = root;
    delete process.env.TASQ_ALLOW_EXTERNAL_STORE;

    expect(loadConfig().dbPath).toBe(join(root, "db.sqlite"));
  });

  test("lets a deliberate split layout through the explicit escape", () => {
    const other = mkdtempSync(join(tmpdir(), "tasq-external-"));
    dirs.push(other);
    const root = home({
      ...base,
      dbPath: join(other, "db.sqlite"),
      eventJournalPath: join(other, "events.jsonl"),
    });
    process.env.TASQ_HOME = root;
    process.env.TASQ_ALLOW_EXTERNAL_STORE = "1";

    expect(loadConfig().dbPath).toBe(join(other, "db.sqlite"));
  });

  test("leaves an unset TASQ_HOME alone, so the default install is untouched", () => {
    const other = mkdtempSync(join(tmpdir(), "tasq-default-"));
    dirs.push(other);
    home({ ...base, dbPath: join(other, "db.sqlite"), eventJournalPath: join(other, "events.jsonl") });
    delete process.env.TASQ_HOME;
    delete process.env.TASQ_ALLOW_EXTERNAL_STORE;

    // No throw: the guard only applies when the operator named a home explicitly.
    expect(() => loadConfig()).not.toThrow();
  });
});
