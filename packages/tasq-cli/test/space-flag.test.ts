/**
 * `--space` is the word every document, `tasq setup` and `tasq onboard` teach,
 * and `--tenant` is the name most commands actually read. Until they were made
 * the same flag, a new user who followed the documented loop was answered
 * `Unknown flag: --space` by `claim`, `attempt`, `evidence`, `done` and
 * `whoami` - the whole loop after the one command that had taught them the
 * word.
 */
import { describe, expect, test } from "bun:test";
import { COMMON_FLAGS, parseArgs, requiredFlag } from "../src/args.js";
import { COMMAND_FLAGS } from "../src/index.js";

describe("--space and --tenant", () => {
  test("resolve to each other whichever one a command reads", () => {
    const spaced = parseArgs(["--space", "team/ledger"]);
    expect(spaced.string("space")).toBe("team/ledger");
    expect(spaced.string("tenant")).toBe("team/ledger");

    const tenanted = parseArgs(["--tenant", "team/ledger"]);
    expect(tenanted.string("space")).toBe("team/ledger");
    expect(tenanted.string("tenant")).toBe("team/ledger");
  });

  test("are accepted by every command, not only the ones that name a space", () => {
    // The commands the documented loop runs, none of which declares the flag
    // itself: they all read it through the common set.
    for (const command of ["claim", "attempt", "evidence", "done", "whoami", "add", "list"]) {
      expect(command in COMMAND_FLAGS).toBe(true);
      const args = parseArgs(["--space", "team/ledger"]);
      expect(() => args.assertKnown([...COMMON_FLAGS, ...COMMAND_FLAGS[command]!])).not.toThrow();
    }
  });

  test("refuse a disagreement rather than pick a ledger", () => {
    expect(() => parseArgs(["--space", "a/one", "--tenant", "b/two"]))
      .toThrow(/same flag and were given different values/);
    // The same value twice is not a disagreement.
    expect(parseArgs(["--space", "a/one", "--tenant", "a/one"]).string("space")).toBe("a/one");
  });
});

describe("a required flag that was not passed", () => {
  test("names the flag and the usage instead of dumping a schema error", () => {
    const usage = "agent install <codex|claude|generic> --space <id> --actor <label>";
    expect(() => requiredFlag(parseArgs([]), "space", usage))
      .toThrow(`--space is required: ${usage}`);
    // A flag present but empty is the same mistake.
    expect(() => requiredFlag(parseArgs(["--space", "  "]), "space", usage)).toThrow(/required/);
    expect(requiredFlag(parseArgs(["--space", "team/ledger"]), "space", usage)).toBe("team/ledger");
  });
});

describe("a flag value that begins with a dash", () => {
  test("is a value, not the next flag", () => {
    // Filing evidence about a flag is exactly where this bites: the summary
    // was read as a flag and the flag became a bare boolean.
    const args = parseArgs(["--summary", "--space is refused everywhere", "--json"]);
    expect(args.string("summary")).toBe("--space is refused everywhere");
    expect(args.bool("json")).toBe(true);
  });

  test("does not swallow the flag that follows it", () => {
    const args = parseArgs(["--json", "--actor", "reader"]);
    expect(args.bool("json")).toBe(true);
    expect(args.string("actor")).toBe("reader");
    // A negative number is still a value.
    expect(parseArgs(["--offset", "-5"]).number("offset")).toBe(-5);
    // A lone token that really does look like a flag stays one.
    expect(parseArgs(["--summary", "--json"]).flag("summary")).toBe(true);
  });

  test("says what happened when a value is still read as a flag", () => {
    // The value landed where no flag precedes it, so it is read as one.
    const args = parseArgs(["--summary=filed", "--space is refused"]);
    expect(() => args.assertKnown([...COMMON_FLAGS, "summary"]))
      .toThrow(/A value that begins with "-" has to be attached/);
  });
});
