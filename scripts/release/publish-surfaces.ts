#!/usr/bin/env bun
/**
 * `release:publish-surfaces --version <x.y.z> [--surfaces all|server,python] [--fly] [--fly-mode local|managed] [--fly-initialize] [--workflow-ref <ref>]`
 *
 * After the protected release workflow has published npm and the GitHub
 * release for a tag, publish and certify the candidate surfaces that run as
 * separate protected workflows, then deploy the Fly private beta. Every step
 * is a workflow dispatch on the tagged commit with the confirmation phrase the
 * workflow demands, followed by a wait for its conclusion. The output is the
 * JSON `release:record` consumes.
 *
 * Standing decision (2026-09-06): every surface ships with every release. The
 * two cases that still stop for a human are a store-format change and a Fly
 * deployment in `managed` control-database mode; both are refused here unless
 * named explicitly.
 *
 * `--workflow-ref` names the ref whose workflow *definitions* run; the code
 * they publish is always the tagged commit. It exists for one situation: a
 * workflow file was fixed after the tag, and the fix is on main. The
 * protected workflows accept main or the release tag as their own ref and
 * still bind the published bytes to the tagged commit.
 */
import {
  FLY_CONFIRMATION, STABLE_VERSION, SURFACES, dispatch, fail, findRun, ghcrDigestForVersion, parseFlags, parseSurfaces, pypiWheelSha256,
  tagCommit, waitForRun,
} from "./release-pipeline";

const flags = parseFlags(process.argv.slice(2), ["--version", "--surfaces", "--fly-mode", "--workflow-ref"], ["--fly", "--fly-initialize", "--allow-managed"]);
const version = flags.require("--version");
if (!STABLE_VERSION.test(version)) fail(`--version must be a stable SemVer, got ${version}`);
const tag = `v${version}`;
const workflowRef = flags.get("--workflow-ref") ?? tag;
const surfaces = parseSurfaces(flags.get("--surfaces")).filter((surface) => surface !== "client");
const flyMode = flags.get("--fly-mode") ?? "local";
if (!["local", "managed"].includes(flyMode)) fail(`--fly-mode must be local or managed, got ${flyMode}`);
if (flyMode === "managed" && !flags.has("--allow-managed")) {
  fail("a managed control database is one of the two decisions that stay human: pass --allow-managed only after that decision");
}

const commit = tagCommit(tag);
const release = findRun("release.yml", commit);
if (!release || release.conclusion !== "success") {
  fail(`the protected release workflow for ${tag} has not succeeded yet (${release?.conclusion ?? "no run"}); publish surfaces after it`);
}

const result: Record<string, unknown> = { contractVersion: "tasq.release-surfaces.v1", version, tag, sourceCommit: commit, releaseRun: release.url };

async function publishAndCertify(surface: "server" | "python", extra: Record<string, string>, certifyExtra: () => Promise<Record<string, string>>) {
  const spec = SURFACES[surface];
  const publish = await dispatch(spec.publishWorkflow, workflowRef, { version, source_commit: commit, confirmation: spec.publishConfirmation!, ...extra });
  process.stderr.write(`${surface}: publishing, ${publish.url}\n`);
  const published = await waitForRun(publish.databaseId);
  if (published.conclusion !== "success") fail(`${spec.publishWorkflow} concluded ${published.conclusion}: ${published.url}`);
  const certifyInputs = await certifyExtra();
  const certify = await dispatch(spec.certifyWorkflow, workflowRef, { version, source_commit: commit, confirmation: spec.certifyConfirmation!, ...certifyInputs });
  process.stderr.write(`${surface}: certifying, ${certify.url}\n`);
  const certified = await waitForRun(certify.databaseId);
  if (certified.conclusion !== "success") fail(`${spec.certifyWorkflow} concluded ${certified.conclusion}: ${certified.url}`);
  return { publicationWorkflowRun: published.url, certificationWorkflowRun: certified.url };
}

let serverDigest: string | null = null;
if (surfaces.includes("server")) {
  const runs = await publishAndCertify("server", {}, async () => {
    serverDigest = ghcrDigestForVersion(version);
    return { digest: serverDigest };
  });
  result.server = { digest: serverDigest, ...runs };
}
if (surfaces.includes("python")) {
  if (!serverDigest) serverDigest = ghcrDigestForVersion(version);
  // The certification workflow binds the published wheel by its exact digest,
  // so the wheel must already be on PyPI when it is dispatched: read it after
  // the publication run, not before.
  let wheelSha256: string | null = null;
  const runs = await publishAndCertify("python", {}, async () => {
    wheelSha256 = await pypiWheelSha256(version);
    return { server_digest: serverDigest!, wheel_sha256: wheelSha256 };
  });
  result.python = { wheelSha256, ...runs };
}
if (flags.has("--fly")) {
  if (!serverDigest) serverDigest = ghcrDigestForVersion(version);
  const deploy = await dispatch("deploy-fly-private-beta.yml", workflowRef, {
    image_digest: serverDigest,
    source_commit: commit,
    initialize: flags.has("--fly-initialize") ? "true" : "false",
    control_database_mode: flyMode,
    confirmation: FLY_CONFIRMATION,
  });
  process.stderr.write(`fly: deploying, ${deploy.url}\n`);
  const deployed = await waitForRun(deploy.databaseId);
  if (deployed.conclusion !== "success") fail(`deploy-fly-private-beta.yml concluded ${deployed.conclusion}: ${deployed.url}`);
  result.fly = { digest: serverDigest, mode: flyMode, deploymentWorkflowRun: deployed.url };
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
