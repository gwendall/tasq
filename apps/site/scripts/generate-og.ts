#!/usr/bin/env bun

/**
 * Renders the OpenGraph card to `public/og.png` before the build.
 *
 * Next's `opengraph-image` convention writes the file without an extension, so
 * static servers and CDNs serve a valid PNG as application/octet-stream and
 * link unfurlers refuse it. Two attempts at fixing that with host header config
 * never took effect in production. A file called `og.png` needs no
 * configuration to be served correctly, on any host, forever.
 *
 *   bun scripts/generate-og.ts           # write public/og.png
 *   bun scripts/generate-og.ts --check   # exit 1 if it is missing or stale
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ImageResponse } from "next/og";

import { OgCard, size } from "./og-card";

const target = resolve(import.meta.dir, "../public/og.png");

const response = new ImageResponse(OgCard(), size);
const rendered = Buffer.from(await response.arrayBuffer());

const png = [137, 80, 78, 71, 13, 10, 26, 10];
if (!png.every((byte, index) => rendered[index] === byte)) {
  throw new Error("Rendered card is not a PNG");
}

if (process.argv.includes("--check")) {
  if (!existsSync(target)) {
    process.stderr.write("public/og.png is missing; run bun scripts/generate-og.ts\n");
    process.exit(1);
  }
  const digest = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
  if (digest(readFileSync(target)) !== digest(rendered)) {
    process.stderr.write("public/og.png is stale; run bun scripts/generate-og.ts\n");
    process.exit(1);
  }
  process.stdout.write("public/og.png is current\n");
} else {
  writeFileSync(target, rendered);
  process.stdout.write(`Wrote public/og.png (${rendered.length} bytes)\n`);
}
