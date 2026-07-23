/** Foreground Console registration and proof-of-life discovery. */

import { createHash } from "node:crypto";
import { chmod, link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CONSOLE_DISCOVERY_CONTRACT_VERSION,
  ConsoleDiscovery as ConsoleDiscoverySchema,
  ConsoleListenerDescriptor as ConsoleListenerDescriptorSchema,
  type ConsoleDiscovery,
  type ConsoleListenerDescriptor,
} from "@tasq-run/schema";
import { configDir } from "./config.js";

const DISCOVERY_TIMEOUT_MS = 1_000;

function registrationDirectory(): string {
  return join(configDir(), "run", "console");
}

export function consoleRegistrationPath(workspaceId: string): string {
  const digest = createHash("sha256").update(workspaceId, "utf8").digest("hex");
  return join(registrationDirectory(), `${digest}.json`);
}

function result(
  workspaceId: string,
  state: ConsoleDiscovery["state"],
  descriptor: ConsoleListenerDescriptor | null,
  reason: ConsoleDiscovery["reason"],
): ConsoleDiscovery {
  return ConsoleDiscoverySchema.parse({
    contractVersion: CONSOLE_DISCOVERY_CONTRACT_VERSION,
    workspaceId,
    state,
    descriptor,
    reason,
  });
}

function sameListener(left: ConsoleListenerDescriptor, right: ConsoleListenerDescriptor): boolean {
  return left.instanceId === right.instanceId &&
    left.workspaceId === right.workspaceId &&
    left.productVersion === right.productVersion &&
    left.endpoint.url === right.endpoint.url &&
    left.process.pid === right.process.pid;
}

export async function discoverConsole(workspaceId: string): Promise<ConsoleDiscovery> {
  let raw: string;
  try {
    raw = await readFile(consoleRegistrationPath(workspaceId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return result(workspaceId, "stopped", null, "not_registered");
    }
    throw error;
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return result(workspaceId, "stale", null, "descriptor_invalid");
  }
  const parsed = ConsoleListenerDescriptorSchema.safeParse(candidate);
  if (!parsed.success) return result(workspaceId, "stale", null, "descriptor_invalid");
  const descriptor = parsed.data;
  if (descriptor.workspaceId !== workspaceId) {
    return result(workspaceId, "stale", descriptor, "identity_mismatch");
  }

  try {
    const response = await fetch(`${descriptor.endpoint.url}/api/console/runtime`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) return result(workspaceId, "stale", descriptor, "listener_unreachable");
    const live = ConsoleListenerDescriptorSchema.safeParse(await response.json());
    if (!live.success || !sameListener(descriptor, live.data)) {
      return result(workspaceId, "stale", descriptor, "identity_mismatch");
    }
    return result(workspaceId, "running", descriptor, null);
  } catch {
    return result(workspaceId, "stale", descriptor, "listener_unreachable");
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Refuse live or ambiguous ownership; clean only a descriptor whose owning process is gone. */
export async function prepareConsoleRegistration(workspaceId: string): Promise<void> {
  const discovery = await discoverConsole(workspaceId);
  if (discovery.state === "stopped") return;
  const path = consoleRegistrationPath(workspaceId);
  if (!discovery.descriptor) {
    throw new Error(`Console registration is invalid; inspect or remove ${path}`);
  }
  if (discovery.state === "running" || processIsAlive(discovery.descriptor.process.pid)) {
    throw new Error(`Console is already registered at ${discovery.descriptor.endpoint.url}`);
  }
  await unlink(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

/** Atomically publish one descriptor without ever replacing another owner. */
export async function registerConsole(descriptor: ConsoleListenerDescriptor): Promise<string> {
  const parsed = ConsoleListenerDescriptorSchema.parse(descriptor);
  const directory = registrationDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = consoleRegistrationPath(parsed.workspaceId);
  const temporary = `${path}.${parsed.instanceId}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await link(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return path;
}

/** Remove only the registration still owned by this exact listener instance. */
export async function unregisterConsole(descriptor: ConsoleListenerDescriptor): Promise<void> {
  const path = consoleRegistrationPath(descriptor.workspaceId);
  try {
    const current = ConsoleListenerDescriptorSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (current.success && current.data.instanceId === descriptor.instanceId) await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
