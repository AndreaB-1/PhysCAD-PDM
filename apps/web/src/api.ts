let csrf = "";
export function setCsrf(t: string | null | undefined) { csrf = t ?? ""; }

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(url.startsWith("/") ? url : `/api/${url}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined && !isForm ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" && csrf ? { "x-csrf-token": csrf } : {}),
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data?.code);
  return data as T;
}
export const get = <T = any>(url: string) => api<T>("GET", url);
export const post = <T = any>(url: string, body?: unknown) => api<T>("POST", url, body ?? {});
export const put = <T = any>(url: string, body?: unknown) => api<T>("PUT", url, body);
export const patch = <T = any>(url: string, body?: unknown) => api<T>("PATCH", url, body);
export const del = <T = any>(url: string) => api<T>("DELETE", url);

export const fileUrl = (id: string, download = false) => `/api/files/${id}${download ? "?download=1" : ""}`;

export function fmtDate(d: string | Date | null | undefined) {
  if (!d) return "";
  const x = new Date(d);
  return x.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
export function fmtAgo(d: string | Date) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(d).toLocaleDateString();
}
export function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
