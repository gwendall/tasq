import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { systemClock } from "@tasq-run/schema";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Uint8Array | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), "aws4_request");
}

async function signedFetch(method: "PUT" | "GET", key: string, body?: Uint8Array): Promise<Response> {
  const endpoint = new URL(required("AWS_ENDPOINT_URL_S3"));
  const bucket = required("BUCKET_NAME");
  const accessKey = required("AWS_ACCESS_KEY_ID");
  const secretKey = required("AWS_SECRET_ACCESS_KEY");
  const region = required("AWS_REGION");
  const objectPath = `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const target = new URL(objectPath, endpoint);
  const now = new Date(systemClock.now());
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = digest(body ?? new Uint8Array());
  const canonicalHeaders = `host:${target.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [method, target.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${digest(canonicalRequest)}`;
  const signature = createHmac("sha256", signingKey(secretKey, date, region, "s3"))
    .update(stringToSign).digest("hex");
  return fetch(target, {
    method,
    headers: {
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...(body ? { "content-type": "application/octet-stream" } : {}),
    },
    body: body ? Buffer.from(body) : undefined,
  });
}

async function main(): Promise<void> {
  const [command, source, objectKey = source ? basename(source) : undefined] = process.argv.slice(2);
  if (command !== "upload-verify" || !source || !objectKey) {
    throw new Error("usage: offsite-backup.ts upload-verify <source> [object-key]");
  }
  const plaintext = new Uint8Array(await readFile(source));
  const key = Buffer.from(required("TASQ_CLOUD_BACKUP_KEY"), "base64url");
  if (key.byteLength !== 32) throw new Error("TASQ_CLOUD_BACKUP_KEY must be 32 bytes");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const encrypted = Buffer.concat([Buffer.from("TASQBK1"), nonce, cipher.getAuthTag(), ciphertext]);
  const uploaded = await signedFetch("PUT", objectKey, encrypted);
  if (!uploaded.ok) throw new Error(`off-site upload failed: ${uploaded.status} ${await uploaded.text()}`);
  const downloaded = await signedFetch("GET", objectKey);
  if (!downloaded.ok) throw new Error(`off-site download failed: ${downloaded.status} ${await downloaded.text()}`);
  const roundTrip = Buffer.from(await downloaded.arrayBuffer());
  if (roundTrip.subarray(0, 7).toString() !== "TASQBK1") throw new Error("backup envelope mismatch");
  const decipher = createDecipheriv("aes-256-gcm", key, roundTrip.subarray(7, 19));
  decipher.setAuthTag(roundTrip.subarray(19, 35));
  const restored = Buffer.concat([decipher.update(roundTrip.subarray(35)), decipher.final()]);
  if (digest(restored) !== digest(plaintext)) throw new Error("off-site round-trip digest mismatch");
  await writeFile(`${source}.restored`, restored, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    contractVersion: "tasq.cloud-offsite-backup-evidence.v1",
    executedAt: new Date(systemClock.now()).toISOString(),
    status: "passed",
    bucket,
    objectKey,
    plaintextBytes: plaintext.byteLength,
    plaintextSha256: `sha256:${digest(plaintext)}`,
    encryptedBytes: encrypted.byteLength,
    encryptedSha256: `sha256:${digest(encrypted)}`,
    cipher: "AES-256-GCM",
    restoredSha256: `sha256:${digest(restored)}`,
  })}\n`);
}

const bucket = process.env.BUCKET_NAME ?? "";
void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
