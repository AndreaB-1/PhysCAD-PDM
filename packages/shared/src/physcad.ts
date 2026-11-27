import { parseBaselineFileName } from "./revisions";

export type LinkRef = { fileName: string; number: string; rev: string; seq: number };

/**
 * Find linked parts in a .physcad document: features with type "import", format "physcad".
 * Returns one entry per occurrence (callers aggregate counts).
 */
export function findLinkedParts(doc: unknown): { refs: LinkRef[]; unresolved: string[] } {
  const refs: LinkRef[] = [];
  const unresolved: string[] = [];
  const features = (doc as { features?: unknown[] } | null)?.features;
  if (!Array.isArray(features)) return { refs, unresolved };
  for (const f of features as Array<Record<string, unknown>>) {
    if (!f || f.type !== "import" || (f.format && f.format !== "physcad")) continue;
    const link = f.link as { path?: string } | undefined;
    const name = (typeof f.fileName === "string" && f.fileName) || link?.path || "";
    const parsed = parseBaselineFileName(name);
    if (parsed) refs.push({ fileName: name, ...parsed });
    else if (name) unresolved.push(name);
  }
  return { refs, unresolved };
}

/** Rewrite every linked feature's link.path with `rewrite(fileName)`; returns the new JSON text. */
export function rewriteLinkPaths(jsonText: string, rewrite: (fileName: string) => string): string {
  const doc = JSON.parse(jsonText) as { features?: Array<Record<string, any>> };
  for (const f of doc.features ?? []) {
    if (f?.type === "import" && f.link && typeof f.fileName === "string") {
      f.link.path = rewrite(f.fileName);
    }
  }
  return JSON.stringify(doc);
}
