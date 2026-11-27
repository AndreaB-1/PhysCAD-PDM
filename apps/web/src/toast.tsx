import { useSyncExternalStore } from "react";
import { CheckCircle2, AlertCircle } from "lucide-react";

type T = { id: number; text: string; kind: "success" | "error" };
let toasts: T[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());
let n = 0;
export function toast(text: string, kind: T["kind"] = "success") {
  const t = { id: ++n, text, kind };
  toasts = [...toasts, t]; emit();
  setTimeout(() => { toasts = toasts.filter((x) => x.id !== t.id); emit(); }, kind === "error" ? 6000 : 3500);
}
export const toastError = (e: unknown) => toast((e as Error).message, "error");

export function Toaster() {
  const list = useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => toasts);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2">
      {list.map((t) => (
        <div key={t.id} className="pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-sm shadow-lg">
          {t.kind === "success" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-500" /> : <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
