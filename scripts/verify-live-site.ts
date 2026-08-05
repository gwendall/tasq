#!/usr/bin/env bun

/**
 * Checks the facts about the deployed site that a local build cannot prove.
 *
 * The OpenGraph card is the case that motivated this: a valid PNG served with
 * the wrong content type returns 200, passes every local check, and still stops
 * link unfurlers from rendering anything. That failure only exists in front of
 * the host, so only a request to the host can rule it out.
 *
 * Run after a deploy:  bun scripts/verify-live-site.ts [--base https://tasq.run]
 * Exits non-zero on the first failed expectation.
 */

const baseIndex = process.argv.indexOf("--base");
const base = (baseIndex === -1 ? "https://tasq.run" : process.argv[baseIndex + 1] ?? "").replace(/\/$/, "");
if (!/^https:\/\/[^/]+$/.test(base)) throw new Error(`Invalid --base: ${base || "<missing>"}`);

const failures: string[] = [];
const checks: Array<{ name: string; run: () => Promise<void> }> = [];

function expect(condition: unknown, message: string): void {
  if (!condition) failures.push(message);
}

checks.push({
  name: "home page responds",
  async run() {
    const response = await fetch(base);
    expect(response.ok, `${base} returned ${response.status}`);
    const html = await response.text();
    expect(html.includes("og:image"), "home page declares no og:image");
    expect(!/commitment/i.test(html), "home page still uses 'commitment' in surface copy");
  },
});

checks.push({
  name: "OpenGraph card is served as an image",
  async run() {
    const html = await (await fetch(base)).text();
    const declared = /property="og:image"\s+content="([^"]+)"/.exec(html)?.[1];
    expect(declared, "no og:image content attribute");
    if (!declared) return;

    const image = await fetch(declared);
    expect(image.ok, `og:image returned ${image.status}`);
    const type = image.headers.get("content-type") ?? "";
    expect(
      type.startsWith("image/"),
      `og:image served as "${type}"; unfurlers reject non-image types`,
    );
    expect(
      declared.endsWith(".png"),
      `og:image is ${declared}; serve it with a file extension rather than relying on host header config`,
    );
    const bytes = new Uint8Array(await image.arrayBuffer()).subarray(0, 8);
    const png = [137, 80, 78, 71, 13, 10, 26, 10];
    expect(png.every((byte, index) => bytes[index] === byte), "og:image is not a PNG");
  },
});

checks.push({
  name: "machine entrypoints resolve",
  async run() {
    for (const path of ["/adopt.json", "/SKILL.md", "/integration.json", "/llms.txt", "/sitemap.xml", "/robots.txt"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.ok, `${path} returned ${response.status}`);
    }
  },
});

checks.push({
  name: "published version matches the release manifest",
  async run() {
    const truth = await (await fetch(`${base}/product-truth.json`)).json() as {
      release: { version: string | null; published: boolean };
    };
    const adopt = await (await fetch(`${base}/adopt.json`)).json() as {
      distribution: { version: string | null };
    };
    expect(
      truth.release.version === adopt.distribution.version,
      `product-truth reports ${truth.release.version} but adopt.json reports ${adopt.distribution.version}`,
    );
  },
});

for (const check of checks) {
  const before = failures.length;
  try {
    await check.run();
  } catch (error) {
    failures.push(`${check.name} threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.stdout.write(`${failures.length === before ? "  ok  " : " FAIL "}${check.name}\n`);
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} failed:\n${failures.map((line) => `  - ${line}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`\nAll live checks passed against ${base}\n`);
