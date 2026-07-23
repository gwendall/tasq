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
    display: `import {
  createCommitment,
  createMutableClock,
  openDb,
  runKernelMigrations,
} from "@tasq-run/core";

const clock = createMutableClock(1_900_000_000_000);
const store = await openDb({
  url: process.env.TASQ_DB_URL ?? "file:./tasq.sqlite",
});
await runKernelMigrations(store.client, { clock });

const commitment = await createCommitment(
  store.db,
  { title: "Calibrate arm joint" },
  { workspaceId: "robotics/team-a", actor: "app:server", clock },
);

console.log(commitment.id);
await store.close();`,
  },
  lifecycle: {
    kind: "concept",
    title: "coordination model",
    display: "commitment -> claim -> attempt -> evidence -> explicit completion",
  },
} as const;

export type PublicCodeExampleId = keyof typeof publicCodeExamples;
