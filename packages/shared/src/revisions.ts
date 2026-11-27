export type RevScheme = "numeric" | "letters";

/** Revision label for a 0-based index: numeric → "01","02"…; letters → "A".."Z","AA"… */
export function revLabel(index: number, scheme: RevScheme): string {
  if (scheme === "numeric") return String(index + 1).padStart(2, "0");
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Baseline label: numeric → "01.004"; letters → "A.4". */
export function baselineLabel(rev: string, seq: number, scheme: RevScheme): string {
  return scheme === "numeric" ? `${rev}.${String(seq).padStart(3, "0")}` : `${rev}.${seq}`;
}

export function formatNumber(prefix: string, digits: number, n: number): string {
  return `${prefix}${String(n).padStart(digits, "0")}`;
}

/** File base name used on disk and inside .physcad links, e.g. "AB00003_01.004". */
export function baselineFileBase(number: string, rev: string, seq: number, scheme: RevScheme): string {
  return `${number}_${baselineLabel(rev, seq, scheme)}`;
}

/** Parse "AB00003_01.004.physcad" → { number, rev, seq }. */
export function parseBaselineFileName(fileName: string): { number: string; rev: string; seq: number } | null {
  const base = fileName.replace(/^.*[\\/]/, "");
  const m = /^([A-Za-z0-9-]+)_([A-Za-z0-9]+)\.(\d+)\.physcad$/i.exec(base);
  if (!m) return null;
  return { number: m[1]!.toUpperCase(), rev: m[2]!.toUpperCase(), seq: parseInt(m[3]!, 10) };
}

export function documentName(number: string, description: string): string {
  return `${number} - ${description}`;
}
