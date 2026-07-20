/** Black-box runtime speaking one execution protocol; no peer or domain knowledge. */

import { onboard, validateEventResume, validatePacket } from "./unfamiliar-runtime-common.js";

const input = JSON.parse(await Bun.stdin.text()) as any;
const hello = onboard(input, "2025-11-25");

if (input.phase === "plan") {
  validatePacket(input);
  process.stdout.write(JSON.stringify({
    hello,
    task: {
      taskId: input.taskId,
      status: "completed",
      createdAt: input.startedAt,
      lastUpdatedAt: input.completedAt,
      result: {
        contractVersion: "work-packet.v1",
        condition: input.packet,
        requestedOutput: input.requestedOutput,
      },
    },
  }));
} else if (input.phase === "review") {
  validateEventResume(input.events, input.afterSequence);
  if (input.evaluation?.decision !== "matched") throw new Error("extension evaluation did not match");
  if (!input.events.some((event: any) => event.eventType === "attempt_succeeded")) {
    throw new Error("resumed event stream has no successful execution");
  }
  process.stdout.write(JSON.stringify({
    hello,
    approveEvidence: true,
    artifactId: input.artifact.id,
    artifactDigest: input.artifact.digest,
    resumeSequence: input.events.at(-1)?.sequence ?? input.afterSequence,
  }));
} else {
  throw new Error("unsupported runtime phase");
}
