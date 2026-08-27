/**
 * A directory that was never bound must not silently drive another project's
 * ledger.
 *
 * Space resolution ends at `config.tenantId`, which `tasq setup` writes. So
 * until 2026-08-27, opening any unconfigured directory and running a command
 * reached that space. Walking the newcomer journey, a second git repository
 * with no Tasq configuration listed the first project's tasks and would have
 * written to them - every command succeeding, nothing warning.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inheritedSpaceOwnedElsewhere, type TasqConfig } from "../src/config.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/**
 * Canonicalised, because `bindDirectorySpace` canonicalises on write and on
 * macOS /var is a symlink to /private/var - so a raw mkdtemp path never
 * matches a stored binding.
 */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "tasq-space-"));
  dirs.push(dir);
  return realpathSync(dir);
}

function config(directorySpaces?: Record<string, string>): TasqConfig {
  return {
    dbPath: "/tmp/unused/db.sqlite",
    eventJournalPath: "/tmp/unused/events.jsonl",
    tenantId: "acme/app",
    defaultActor: "gwendall",
    directorySpaces,
  };
}

describe("inheriting a space that belongs to another project", () => {
  test("names the owner when the space is bound somewhere else", () => {
    const owner = scratch();
    const elsewhere = scratch();
    const owners = inheritedSpaceOwnedElsewhere(config({ [owner]: "acme/app" }), "acme/app", elsewhere);
    expect(owners).toEqual([owner]);
  });

  test("says nothing inside the bound tree, where the binding would have won anyway", () => {
    const owner = scratch();
    expect(inheritedSpaceOwnedElsewhere(config({ [owner]: "acme/app" }), "acme/app", owner)).toEqual([]);
    const deep = join(owner, "packages", "deep");
    mkdirSync(deep, { recursive: true });
    expect(inheritedSpaceOwnedElsewhere(config({ [owner]: "acme/app" }), "acme/app", deep)).toEqual([]);
  });

  test("says nothing for a user who has never bound anything", () => {
    // The whole point: a single-space user must never meet this refusal.
    expect(inheritedSpaceOwnedElsewhere(config(), "acme/app", scratch())).toEqual([]);
    expect(inheritedSpaceOwnedElsewhere(config({}), "acme/app", scratch())).toEqual([]);
  });

  test("ignores directories bound to a different space", () => {
    const other = scratch();
    expect(inheritedSpaceOwnedElsewhere(
      config({ [other]: "other/space" }), "acme/app", scratch(),
    )).toEqual([]);
  });

  test("names every owner, sorted, when a space is bound in several trees", () => {
    const a = scratch();
    const b = scratch();
    const owners = inheritedSpaceOwnedElsewhere(
      config({ [a]: "acme/app", [b]: "acme/app" }), "acme/app", scratch(),
    );
    expect(owners).toEqual([a, b].sort());
  });

  test("does not treat a sibling with a shared prefix as inside the bound tree", () => {
    // `/tmp/proj` must not swallow `/tmp/proj-two`.
    const owner = scratch();
    const sibling = `${owner}-two`;
    mkdirSync(sibling);
    dirs.push(sibling);
    expect(inheritedSpaceOwnedElsewhere(config({ [owner]: "acme/app" }), "acme/app", sibling))
      .toEqual([owner]);
  });
});
