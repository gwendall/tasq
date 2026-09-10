/**
 * `dispatch` is a switch, and the flag table beside it is the only place the
 * commands are enumerated. A command added to one and not the other rejects
 * every flag it defines - or, since the table is also what a typo is measured
 * against, is never suggested to someone who nearly typed it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_FLAGS, nearestCommand } from "../src/index.js";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"), "utf8");

/** The commands `dispatch` actually routes, read from the switch itself. */
function dispatchedCommands(): string[] {
  const body = source.slice(source.indexOf("async function dispatch("));
  return [...new Set([...body.matchAll(/^      case "([a-z-]+)":/gm)].map((match) => match[1]!))];
}

describe("the command table", () => {
  test("names every command the CLI routes", () => {
    const routed = dispatchedCommands();
    expect(routed.length).toBeGreaterThan(50);
    expect(routed.filter((command) => !(command in COMMAND_FLAGS))).toEqual([]);
  });

  test("declares no command the CLI does not route", () => {
    const routed = new Set(dispatchedCommands());
    expect(Object.keys(COMMAND_FLAGS).filter((command) => !routed.has(command))).toEqual([]);
  });
});

describe("what an unknown command is answered with", () => {
  test("corrects a typo and stays quiet about an unrelated word", () => {
    // "unknown command: tasks" told a first-time user nothing they could act
    // on, and these are exactly what someone types before reading the help.
    expect(nearestCommand("tasks")).toBe("task");
    expect(nearestCommand("claime")).toBe("claim");
    expect(nearestCommand("evidenc")).toBe("evidence");
    expect(nearestCommand("clam")).toBe("claim");
    // A guess at an unrelated word is worse than saying nothing.
    expect(nearestCommand("xyzzy")).toBeNull();
    expect(nearestCommand("deploy")).toBeNull();
  });
});
