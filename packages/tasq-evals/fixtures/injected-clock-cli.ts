/** Eval composition root: production CLI code with a harness-owned clock. */

import { createMutableClock } from "@tasq/schema";
import { runTasqCli } from "../../tasq-cli/src/index.js";

const raw = process.env.TASQ_EVAL_CLOCK_MS;
if (!raw || !/^\d+$/.test(raw)) throw new Error("TASQ_EVAL_CLOCK_MS must be an unsigned integer");
const now = Number(raw);
if (!Number.isSafeInteger(now)) throw new Error("TASQ_EVAL_CLOCK_MS exceeds the safe integer range");

process.exit(await runTasqCli(process.argv.slice(2), createMutableClock(now)));
