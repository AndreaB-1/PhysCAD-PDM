import type { FastifyRequest } from "fastify";
import { mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { rm } from "node:fs/promises";
import { badRequest } from "./errors";
import type { IncomingFile } from "./pdm";

/**
 * Read a multipart request: every file part is streamed to a temp file under tmpRoot
 * (same filesystem as the vault, so it can be renamed into place). The field name is the file kind.
 */
export async function readMultipart(req: FastifyRequest, tmpRoot: string) {
  const fields: Record<string, string> = {};
  const incoming: IncomingFile[] = [];
  const dir = path.join(tmpRoot, ".plm-tmp");
  await mkdir(dir, { recursive: true });
  try {
    for await (const part of req.parts()) {
      if (part.type === "field") { fields[part.fieldname] = String(part.value); continue; }
      const tmpPath = path.join(dir, randomBytes(10).toString("hex"));
      const hash = createHash("sha256");
      let size = 0;
      await pipeline(part.file, async function* (src) {
        for await (const chunk of src) { size += chunk.length; hash.update(chunk); yield chunk; }
      }, createWriteStream(tmpPath));
      if (part.file.truncated) { await rm(tmpPath, { force: true }); throw badRequest("File too large"); }
      incoming.push({ kind: part.fieldname, tmpPath, size, sha256: hash.digest("hex"), fileName: part.filename, mime: part.mimetype });
    }
  } catch (e) {
    await cleanup(incoming);
    throw e;
  }
  return { fields, incoming };
}

export async function cleanup(incoming: IncomingFile[]) {
  for (const f of incoming) await rm(f.tmpPath, { force: true });
}
