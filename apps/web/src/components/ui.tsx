import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Loader2, X } from "lucide-react";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

type Variant = "primary" | "secondary" | "ghost" | "danger";
const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:brightness-110 border-transparent",
  secondary: "bg-panel border-line hover:bg-panel2 text-fg",
  ghost: "bg-transparent border-transparent hover:bg-panel2 text-fg",
  danger: "bg-danger text-white border-transparent hover:brightness-110",
};
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean; size?: "sm" | "md" }>(
  ({ variant = "secondary", busy, size = "md", className, children, disabled, ...p }, ref) => (
    <button ref={ref} disabled={disabled || busy}
      className={cx("inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap",
        size === "sm" ? "h-7 px-2 text-xs" : "h-9 px-3 text-sm", variants[variant], className)} {...p}>
      {busy && <Loader2 className="size-4 animate-spin" />}{children}
    </button>
  ));

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => (
  <input ref={ref} className={cx("h-9 w-full rounded-md border border-line bg-panel px-3 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20", className)} {...p} />
));
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => (
  <textarea ref={ref} className={cx("w-full rounded-md border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20", className)} {...p} />
));
export const Select = ({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select className={cx("h-9 rounded-md border border-line bg-panel px-2 text-sm outline-none focus:border-accent", className)} {...p} />
);

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("rounded-lg border border-line bg-panel", className)}>{children}</div>;
}

export function Chip({ color, children, title }: { color?: string; children: ReactNode; title?: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap"
      style={color ? { borderColor: color + "66", background: color + "1f", color } : undefined}>
      {children}
    </span>
  );
}

export function StateChip({ state }: { state: { name: string; color: string } | null | undefined }) {
  if (!state) return null;
  return <Chip color={state.color}><span className="size-1.5 rounded-full" style={{ background: state.color }} />{state.name}</Chip>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("size-5 animate-spin text-muted", className)} />;
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{(error as Error).message}</p>;
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      {icon && <div className="text-muted">{icon}</div>}
      <p className="font-medium">{title}</p>
      {children && <div className="max-w-md text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onCancel={onClose}
      className={cx("m-auto max-h-[92dvh] overflow-y-auto rounded-xl border border-line bg-panel p-0 text-fg shadow-2xl", wide ? "w-[min(760px,94vw)]" : "w-[min(480px,94vw)]")}>
      {open && (
        <div>
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <h2 className="font-semibold">{title}</h2>
            <button onClick={onClose} className="rounded p-1 text-muted hover:bg-panel2"><X className="size-4" /></button>
          </div>
          <div className="space-y-4 p-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button key={t.id} onClick={() => onChange(t.id)}
          className={cx("-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap", value === t.id ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg")}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Thumb({ fileId, className, alt }: { fileId?: string | null; className?: string; alt?: string }) {
  return (
    <div className={cx("checker flex items-center justify-center overflow-hidden", className)}>
      {fileId ? <img src={`/api/files/${fileId}`} alt={alt ?? ""} className="h-full w-full object-contain" loading="lazy" />
        : <svg viewBox="0 0 24 24" className="size-10 text-muted/50" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M12 2 3 7v10l9 5 9-5V7z" /><path d="m3 7 9 5 9-5M12 12v10" /></svg>}
    </div>
  );
}
