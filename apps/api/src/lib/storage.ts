import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { badRequest } from "./errors";

export function vaultRoot(vaultsRoot: string, folder: string) {
  const root = path.resolve(vaultsRoot, folder);
  if (path.dirname(root) !== path.resolve(vaultsRoot)) throw badRequest("Invalid vault folder");
  return root;
}

/** Join a relative path under root, refusing anything that escapes it. */
export function safeJoin(root: string, rel: string) {
  const p = path.resolve(root, rel);
  if (p !== root && !p.startsWith(root + path.sep)) throw badRequest("Invalid path");
  return p;
}

export type Stored = { size: number; sha256: string };

/** Stream into root/rel atomically (temp file + rename), hashing on the way. */
export async function storeStream(root: string, rel: string, src: Readable, maxBytes?: number): Promise<Stored> {
  const dest = safeJoin(root, rel);
  const tmpDir = path.join(root, ".plm-tmp");
  await mkdir(tmpDir, { recursive: true });
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = path.join(tmpDir, randomBytes(8).toString("hex"));
  const hash = createHash("sha256");
  let size = 0;
  try {
    await pipeline(src, async function* (source) {
      for await (const chunk of source) {
        size += chunk.length;
        if (maxBytes && size > maxBytes) throw badRequest("File too large");
        hash.update(chunk);
        yield chunk;
      }
    }, createWriteStream(tmp, { flags: "wx" }));
    if ((src as { truncated?: boolean }).truncated) throw badRequest("File too large");
    await rename(tmp, dest);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return { size, sha256: hash.digest("hex") };
}

export async function storeBuffer(root: string, rel: string, buf: Buffer | string): Promise<Stored> {
  const dest = safeJoin(root, rel);
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + ".tmp-" + randomBytes(4).toString("hex");
  await writeFile(tmp, buf);
  await rename(tmp, dest);
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return { size: b.length, sha256: createHash("sha256").update(b).digest("hex") };
}

export function openRead(root: string, rel: string) {
  return createReadStream(safeJoin(root, rel));
}
export async function fileExists(p: string) {
  try { await stat(p); return true; } catch { return false; }
}

/** Move a file into <root>/.trash instead of deleting it. */
export async function trash(root: string, rel: string) {
  const src = safeJoin(root, rel);
  if (!(await fileExists(src))) return;
  const dest = path.join(root, ".trash", `${Date.now()}-${rel.replace(/[\\/]/g, "__")}`);
  await mkdir(path.dirname(dest), { recursive: true });
  await rename(src, dest);
}
