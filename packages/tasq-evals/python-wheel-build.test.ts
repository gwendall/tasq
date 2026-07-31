import { expect, test } from "bun:test";
import { copyFile, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const commit = "a".repeat(40);
const version = "0.4.0";

async function run(args: string[], cwd = root): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(args, {
    cwd,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: `${stdout}\n${stderr}` };
}

test("builds one cross-runner deterministic, valid and dependency-free wheel", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "tasq-python-wheel-"));
  try {
    const first = join(scratch, "first");
    const second = join(scratch, "second");
    await mkdir(first);
    await mkdir(second);
    for (const outdir of [first, second]) {
      const built = await run([
        "python3",
        "scripts/release/build-python-wheel.py",
        "--version", version,
        "--source-commit", commit,
        "--outdir", outdir,
      ]);
      expect(built.code, built.output).toBe(0);
    }
    const wheelName = `tasq_remote-${version}-py3-none-any.whl`;
    const wheel = join(first, wheelName);
    expect(await readFile(wheel)).toEqual(await readFile(join(second, wheelName)));

    const sbom = JSON.parse(
      await readFile(join(first, `tasq-python-v${version}.cdx.json`), "utf8"),
    ) as {
      $schema: string;
      bomFormat: string;
      specVersion: string;
      version: number;
      metadata: {
        component: {
          "bom-ref": string;
          type: string;
          name: string;
          version: string;
          purl: string;
          licenses: Array<{ license: { id: string } }>;
        };
      };
      components: unknown[];
      dependencies: Array<{ ref: string; dependsOn: string[] }>;
    };
    const packagePurl = `pkg:pypi/tasq-remote@${version}`;
    expect(sbom).toMatchObject({
      $schema: "http://cyclonedx.org/schema/bom-1.6.schema.json",
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      metadata: {
        component: {
          "bom-ref": packagePurl,
          type: "library",
          name: "tasq-remote",
          version,
          purl: packagePurl,
          licenses: [{ license: { id: "Apache-2.0" } }],
        },
      },
      components: [],
      dependencies: [{ ref: packagePurl, dependsOn: [] }],
    });
    const knownReferences = new Set([
      sbom.metadata.component["bom-ref"],
      ...sbom.components.flatMap((component) => {
        if (
          typeof component === "object" &&
          component !== null &&
          "bom-ref" in component &&
          typeof component["bom-ref"] === "string"
        ) {
          return [component["bom-ref"]];
        }
        return [];
      }),
    ]);
    expect(sbom.dependencies.every((dependency) => knownReferences.has(dependency.ref))).toBe(true);

    const validation = await run(["python3", "-c", `
import base64, csv, hashlib, io, zipfile
wheel = ${JSON.stringify(wheel)}
with zipfile.ZipFile(wheel) as archive:
    assert archive.testzip() is None
    assert all(item.compress_type == zipfile.ZIP_STORED for item in archive.infolist())
    record_name = next(name for name in archive.namelist() if name.endswith(".dist-info/RECORD"))
    rows = list(csv.reader(io.StringIO(archive.read(record_name).decode())))
    for name, encoded, size in rows:
        if name == record_name:
            assert encoded == "" and size == ""
            continue
        data = archive.read(name)
        expected = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        assert encoded == "sha256=" + expected
        assert size == str(len(data))
`]);
    expect(validation.code, validation.output).toBe(0);

    const venv = join(scratch, "venv");
    const created = await run(["python3", "-m", "venv", venv]);
    expect(created.code, created.output).toBe(0);
    const python = join(venv, "bin", "python");
    const installed = await run([
      python, "-m", "pip", "install",
      "--disable-pip-version-check", "--no-index", "--no-deps", wheel,
    ]);
    expect(installed.code, installed.output).toBe(0);
    const imported = await run([
      python,
      "-c",
      `import tasq_remote; assert tasq_remote.__version__ == "${version}"`,
    ]);
    expect(imported.code, imported.output).toBe(0);

    const suite = join(scratch, "suite");
    await mkdir(join(suite, "tests"), { recursive: true });
    const extracted = await run([
      "python3", "-c",
      "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
      wheel, suite,
    ]);
    expect(extracted.code, extracted.output).toBe(0);
    await copyFile(
      join(root, "clients/python/tests/test_client.py"),
      join(suite, "tests/test_client.py"),
    );
    const replay = await run([python, "-m", "unittest", "-v", "test_client.py"], join(suite, "tests"));
    expect(replay.code, replay.output).toBe(0);
    expect(replay.output).toContain("Ran 6 tests");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 30_000);
