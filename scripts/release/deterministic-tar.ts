import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";

const BLOCK_SIZE = 512;

function writeString(buffer: Buffer, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > length) throw new Error(`Tar field exceeds ${length} bytes: ${value}`);
  encoded.copy(buffer, offset);
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length >= length) throw new Error(`Tar numeric field exceeds ${length} bytes: ${value}`);
  writeString(buffer, offset, length, `${encoded}\0`);
}

function splitTarPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  const parts = path.split("/");
  for (let index = parts.length - 1; index > 0; index -= 1) {
    const prefix = parts.slice(0, index).join("/");
    const name = parts.slice(index).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`Tar path is too long: ${path}`);
}

function header(path: string, size: number, mode: number, type: "0" | "5"): Buffer {
  const buffer = Buffer.alloc(BLOCK_SIZE);
  const split = splitTarPath(path);
  writeString(buffer, 0, 100, split.name);
  writeOctal(buffer, 100, 8, mode);
  writeOctal(buffer, 108, 8, 0);
  writeOctal(buffer, 116, 8, 0);
  writeOctal(buffer, 124, 12, size);
  writeOctal(buffer, 136, 12, 0);
  buffer.fill(0x20, 148, 156);
  writeString(buffer, 156, 1, type);
  writeString(buffer, 257, 6, "ustar\0");
  writeString(buffer, 263, 2, "00");
  writeString(buffer, 345, 155, split.prefix);
  const checksum = buffer.reduce((total, byte) => total + byte, 0);
  writeString(buffer, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return buffer;
}

interface TarEntry {
  absolutePath: string;
  archivePath: string;
  directory: boolean;
  executable: boolean;
}

async function entries(root: string, prefix: string): Promise<TarEntry[]> {
  const output: TarEntry[] = [{
    absolutePath: root,
    archivePath: `${prefix}/`,
    directory: true,
    executable: false,
  }];
  async function visit(directory: string): Promise<void> {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const absolutePath = join(directory, name);
      const info = await stat(absolutePath);
      const archivePath = `${prefix}/${relative(root, absolutePath).split("\\").join("/")}`;
      if (info.isSymbolicLink()) throw new Error(`Release archives cannot contain symlinks: ${absolutePath}`);
      if (info.isDirectory()) {
        output.push({ absolutePath, archivePath: `${archivePath}/`, directory: true, executable: false });
        await visit(absolutePath);
      } else if (info.isFile()) {
        output.push({ absolutePath, archivePath, directory: false, executable: (info.mode & 0o111) !== 0 });
      } else {
        throw new Error(`Unsupported release archive entry: ${absolutePath}`);
      }
    }
  }
  await visit(root);
  return output;
}

export async function deterministicTarGzip(root: string, prefix = basename(root)): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for (const entry of await entries(root, prefix)) {
    if (entry.directory) {
      chunks.push(header(entry.archivePath, 0, 0o755, "5"));
      continue;
    }
    const content = await readFile(entry.absolutePath);
    chunks.push(header(entry.archivePath, content.length, entry.executable ? 0o755 : 0o644, "0"));
    chunks.push(content);
    const padding = (BLOCK_SIZE - (content.length % BLOCK_SIZE)) % BLOCK_SIZE;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Bun.gzipSync(Buffer.concat(chunks), { level: 9 });
}
