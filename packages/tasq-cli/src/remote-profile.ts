import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { configDir } from "./config.js";

const ProfileName = z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

export const RemoteProfile = z.object({
  contractVersion: z.literal("tasq.remote-profile.v1"),
  name: ProfileName,
  endpoint: z.string().url(),
  workspaceId: z.string().min(1).max(200),
  credentialId: z.string().min(1).max(500),
  principalId: z.string().min(1).max(500),
  clientKind: z.enum(["human_device", "workload_agent"]),
  accessToken: z.string().min(32).max(2_000),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  actionUpperBound: z.array(z.object({
    uri: z.string().min(1),
    version: z.number().int().positive(),
    implementationDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }).strict()).min(1),
}).strict();
export type RemoteProfile = z.infer<typeof RemoteProfile>;

function profilesDir(): string {
  return join(configDir(), "remote");
}

export function remoteProfilePath(name: string): string {
  return join(profilesDir(), `${ProfileName.parse(name)}.json`);
}

export function hasRemoteProfile(name: string): boolean {
  return existsSync(remoteProfilePath(name));
}

export function loadRemoteProfile(name: string): RemoteProfile {
  const path = remoteProfilePath(name);
  if (!existsSync(path)) throw new Error(`Remote profile "${name}" does not exist`);
  try {
    return RemoteProfile.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(`Remote profile error in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function saveRemoteProfile(profile: RemoteProfile, replace = false): string {
  const parsed = RemoteProfile.parse(profile);
  const directory = profilesDir();
  const path = remoteProfilePath(parsed.name);
  if (!replace && existsSync(path)) {
    throw new Error(`Remote profile "${parsed.name}" already exists; use --replace to rotate it`);
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return path;
}

export function removeRemoteProfile(name: string): boolean {
  const path = remoteProfilePath(name);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
