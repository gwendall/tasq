import { describe, expect, test } from "bun:test";
import { errorChainMessages, errorMatches, errorMessage } from "../src/errors.js";

describe("wrapped error classification", () => {
  test("finds a transient SQLite cause behind an ORM query wrapper", () => {
    const driver = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const wrapped = new Error("Failed query: insert into principal ...", { cause: driver });

    expect(errorMatches(wrapped, /SQLITE_BUSY|database is locked/i)).toBe(true);
    expect(errorMessage(wrapped)).toBe("SQLITE_BUSY: database is locked");
    expect(errorChainMessages(wrapped)).toEqual([
      "Failed query: insert into principal ...",
      "SQLITE_BUSY: database is locked",
    ]);
  });

  test("keeps validation errors and primitive rejections usable", () => {
    expect(errorMessage(new Error("Invalid value for --lease"))).toBe("Invalid value for --lease");
    expect(errorMessage("plain failure")).toBe("plain failure");
  });

  test("terminates a cyclic cause chain", () => {
    const cyclic = new Error("outer") as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    expect(errorChainMessages(cyclic)).toEqual(["outer"]);
  });
});
