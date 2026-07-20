/** Independent black-box runtime; it learns data meaning only from discovery. */

import { onboard, validateEventResume, validatePacket } from "./unfamiliar-runtime-common.js";

const input = JSON.parse(await Bun.stdin.text()) as any;
const hello = onboard(input, "1.0");
validatePacket(input);

if (input.phase === "start") {
  if (!input.assignment?.id || input.assignment.status !== "proposed") {
    throw new Error("no proposed assignment was supplied");
  }
  process.stdout.write(JSON.stringify({
    hello,
    acceptAssignment: true,
    task: {
      id: input.taskId,
      contextId: input.contextId,
      status: { state: "TASK_STATE_WORKING", timestamp: input.occurredAt },
    },
  }));
} else if (input.phase === "resume") {
  validateEventResume(input.events, input.afterSequence);
  if (!input.events.some((event: any) => event.eventType === "started")) {
    throw new Error("resumed event stream does not contain the required commitment transition");
  }
  process.stdout.write(JSON.stringify({
    hello,
    task: {
      id: input.taskId,
      contextId: input.contextId,
      status: { state: "TASK_STATE_COMPLETED", timestamp: input.occurredAt },
      artifacts: [{
        artifactId: input.artifactId,
        name: "typed-output.json",
        parts: [{ data: input.packet.payload, mediaType: "application/json" }],
        metadata: {
          typeUri: input.packet.typeUri,
          schemaVersion: input.packet.schemaVersion,
        },
      }],
    },
    resumeSequence: input.events.at(-1)?.sequence ?? input.afterSequence,
  }));
} else {
  throw new Error("unsupported runtime phase");
}
