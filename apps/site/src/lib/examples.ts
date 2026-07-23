import { productTruth } from "@/lib/product-truth";

const releaseVersion = productTruth.release.version ?? "0.1.0";

export const persistentTasqPath = '"$HOME/.local/share/tasq/node_modules/.bin/tasq"';
const bindTasq = `TASQ=${persistentTasqPath}`;
const tasq = '"$TASQ"';

export const publicCodeExamples = {
  quickTry: {
    kind: "shell",
    title: "try without installing",
    display: `bunx @tasq-run/cli@${releaseVersion} version
npm exec --yes --package=@tasq-run/cli@${releaseVersion} -- tasq version`,
  },
  nativeInstall: {
    kind: "shell",
    title: "verified persistent install",
    display: `curl -fsSLo /tmp/tasq-install.sh https://tasq.run/install-v${releaseVersion}.sh
sh /tmp/tasq-install.sh --dry-run --version ${releaseVersion} --prefix "$HOME/.local"
sh /tmp/tasq-install.sh --version ${releaseVersion} --prefix "$HOME/.local"
"$HOME/.local/bin/tasq" version`,
  },
  install: {
    kind: "shell",
    title: "install",
    display: `mkdir -p "$HOME/.local/share/tasq"
npm install --prefix "$HOME/.local/share/tasq" --ignore-scripts @tasq-run/cli@${releaseVersion}
${persistentTasqPath} version`,
  },
  onboard: {
    kind: "shell",
    title: "agent bootstrap",
    display: `${bindTasq}
${tasq} onboard \\
  --space robotics/team-a \\
  --actor agent:planner \\
  --capabilities read,propose,coordinate \\
  --json`,
  },
  mcp: {
    kind: "shell",
    title: "local stdio",
    display: `${bindTasq}
${tasq} mcp \\
  --tenant robotics/team-a \\
  --actor agent:builder \\
  --capabilities read,propose,coordinate`,
  },
  console: {
    kind: "shell",
    title: "local console",
    display: `${bindTasq}
${tasq} web --tenant robotics/team-a
${tasq} web status --tenant robotics/team-a --json`,
  },
  operations: {
    kind: "shell",
    title: "local operations",
    display: `${bindTasq}
${tasq} doctor
${tasq} backup`,
  },
  sdk: {
    kind: "typescript",
    title: "embedded core",
    display: `import { createLocalTasq, systemClock } from "@tasq-run/core";

const url = process.env.TASQ_DB_URL;
if (!url) throw new Error("Set TASQ_DB_URL=file:/absolute/path/to/db.sqlite");

const tasq = await createLocalTasq({
  url,
  workspaceId: "example/team",
  actor: "app:example",
  clock: systemClock,
});

try {
  let [commitment] = await tasq.commitments.list({ limit: 1 });
  if (!commitment) {
    commitment = await tasq.commitments.create(
      { title: "Ship the embedded Tasq loop" },
      { idempotencyKey: "example:create" },
    );
    commitment = await tasq.commitments.start(commitment.id, {
      expectedRevision: commitment.revision,
      idempotencyKey: "example:start",
    });
    commitment = await tasq.commitments.complete(commitment.id, {
      expectedRevision: commitment.revision,
      idempotencyKey: "example:complete",
    });
  }
  console.log(JSON.stringify({ id: commitment.id, status: commitment.status }));
} finally {
  await tasq.close();
}`,
  },
  lifecycle: {
    kind: "concept",
    title: "coordination model",
    display: "commitment -> claim -> attempt -> evidence -> explicit completion",
  },
} as const;

export type PublicCodeExampleId = keyof typeof publicCodeExamples;
