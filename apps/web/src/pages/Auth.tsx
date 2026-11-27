import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, ShieldCheck } from "lucide-react";
import { get, post, setCsrf } from "../api";
import { Button, Card, ErrorText, Field, Input } from "../components/ui";
import { useMe } from "../session";
import { toast } from "../toast";

export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2">
          <img src="/favicon.svg" className="size-9" alt="" />
          <span className="text-lg font-semibold tracking-tight">PLM Lite</span>
        </div>
        <Card className="p-6 shadow-sm">
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          <div className="mt-5 space-y-4">{children}</div>
        </Card>
      </div>
    </div>
  );
}

async function refreshCsrf(qc: ReturnType<typeof useQueryClient>) {
  const me = await get("auth/me");
  setCsrf(me.csrf);
  qc.setQueryData(["me"], me);
  return me;
}

export function LoginPage() {
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const search = useSearch({ strict: false }) as { next?: string };
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const step = me.data?.user ? me.data.next : "password";

  useEffect(() => {
    if (me.data?.needsSetup) nav({ to: "/setup" });
    if (me.data?.user && me.data.next === "done") nav({ to: (search.next as "/") ?? "/" });
    if (me.data?.user && me.data.next === "enroll") nav({ to: "/enroll" });
  }, [me.data, nav, search.next]);

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      if (step === "mfa") await post("auth/mfa", { code: code.replace(/\s/g, "") });
      else await post("auth/login", { email, password });
      await refreshCsrf(qc);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  if (step === "mfa") return (
    <AuthShell title="Two-factor sign-in" subtitle="Enter the 6-digit code from your authenticator app, or one of your recovery codes.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Code"><Input autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} className="mono text-center text-lg tracking-widest" /></Field>
        <ErrorText error={err} />
        <Button variant="primary" className="w-full" busy={busy}>Verify</Button>
        <button type="button" className="w-full text-center text-xs text-muted hover:text-fg" onClick={async () => { await post("auth/logout"); await refreshCsrf(qc); }}>Use another account</button>
      </form>
    </AuthShell>
  );
  return (
    <AuthShell title="Sign in">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email"><Input autoFocus type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <Field label="Password"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <ErrorText error={err} />
        <Button variant="primary" className="w-full" busy={busy}>Sign in</Button>
      </form>
    </AuthShell>
  );
}

export function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 rounded-md border border-line bg-panel2 p-3 mono text-sm">
        {codes.map((c) => <span key={c}>{c}</span>)}
      </div>
      <div className="flex gap-2">
        <Button size="sm" type="button" onClick={() => { navigator.clipboard.writeText(codes.join("\n")); toast("Copied"); }}><Copy className="size-3.5" />Copy</Button>
        <Button size="sm" type="button" onClick={() => {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(new Blob([`PLM Lite recovery codes\n\n${codes.join("\n")}\n`], { type: "text/plain" }));
          a.download = "plm-lite-recovery-codes.txt"; a.click();
        }}>Download</Button>
      </div>
      <p className="text-xs text-muted">Each code works once. Keep them somewhere safe: they're the only way in if you lose your phone.</p>
    </div>
  );
}

export function TotpEnroll({ onDone }: { onDone: (codes: string[]) => void }) {
  const { data, error } = useQuery({ queryKey: ["totp-setup"], queryFn: () => post<{ secret: string; uri: string; qr: string }>("auth/totp/setup"), staleTime: Infinity, gcTime: 0 });
  const [code, setCode] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorText error={error} />;
  if (!data) return null;
  return (
    <form className="space-y-4" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(null);
      try { const r = await post<{ recoveryCodes: string[] }>("auth/totp/confirm", { code: code.trim() }); onDone(r.recoveryCodes); }
      catch (e) { setErr(e); } finally { setBusy(false); }
    }}>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
        <li>Open an authenticator app (Google Authenticator, 1Password, Aegis, Authy…).</li>
        <li>Scan this QR code, or type the key.</li>
        <li>Enter the 6-digit code it shows.</li>
      </ol>
      <div className="flex items-center gap-4">
        <img src={data.qr} alt="QR code" className="size-40 rounded-md bg-white p-1" />
        <div className="min-w-0 text-xs"><p className="text-muted">Key</p><p className="mono break-all">{data.secret.match(/.{1,4}/g)?.join(" ")}</p></div>
      </div>
      <Field label="Code"><Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} className="mono tracking-widest" /></Field>
      <ErrorText error={err} />
      <Button variant="primary" className="w-full" busy={busy}><ShieldCheck className="size-4" />Turn on two-factor sign-in</Button>
    </form>
  );
}

export function EnrollPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [codes, setCodes] = useState<string[] | null>(null);
  return (
    <AuthShell title="Set up two-factor sign-in" subtitle="This server requires a second step when you sign in.">
      {codes ? <>
        <RecoveryCodes codes={codes} />
        <Button variant="primary" className="w-full" onClick={async () => { await refreshCsrf(qc); nav({ to: "/" }); }}>I saved them: continue</Button>
      </> : <TotpEnroll onDone={setCodes} />}
    </AuthShell>
  );
}

export function SetupPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const status = useQuery({ queryKey: ["setup"], queryFn: () => get<{ needsSetup: boolean; adminEmail: string | null }>("setup/status") });
  const [f, setF] = useState({ setupToken: "", email: "", name: "", password: "", confirm: "" });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (status.data?.adminEmail) setF((x) => ({ ...x, email: status.data!.adminEmail! })); }, [status.data]);
  if (status.data && !status.data.needsSetup) return (
    <AuthShell title="Already set up"><Button variant="primary" className="w-full" onClick={() => nav({ to: "/login" })}>Go to sign-in</Button></AuthShell>
  );
  return (
    <AuthShell title="Welcome to PLM Lite" subtitle={<>First run: create the administrator account. The <b>setup token</b> is printed in the server log (Portainer → container → Logs).</>}>
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault(); setErr(null);
        if (f.password !== f.confirm) return setErr(new Error("The passwords don't match"));
        setBusy(true);
        try {
          const r = await post("setup", { setupToken: f.setupToken, email: f.email, name: f.name, password: f.password });
          await refreshCsrf(qc);
          nav({ to: r.next === "enroll" ? "/enroll" : "/" });
        } catch (e) { setErr(e); } finally { setBusy(false); }
      }}>
        <Field label="Setup token"><Input className="mono" value={f.setupToken} onChange={(e) => setF({ ...f, setupToken: e.target.value })} required /></Field>
        <Field label="Your name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
        <Field label="Email"><Input type="email" value={f.email} readOnly={!!status.data?.adminEmail} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
        <Field label="Password" hint="At least 10 characters."><Input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={10} /></Field>
        <Field label="Confirm password"><Input type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} required /></Field>
        <ErrorText error={err} />
        <Button variant="primary" className="w-full" busy={busy}>Create administrator</Button>
      </form>
    </AuthShell>
  );
}

export function DevicePage() {
  const me = useMe();
  const nav = useNavigate();
  const search = useSearch({ strict: false }) as { code?: string };
  const [code, setCode] = useState(search.code ?? "");
  const [looked, setLooked] = useState<{ clientName: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => { if (me.data && (!me.data.user || me.data.next !== "done")) nav({ to: "/login", search: { next: `/device?code=${code}` } as never }); }, [me.data]); // eslint-disable-line
  if (done) return <AuthShell title={done}><p className="text-sm text-muted">You can close this tab and go back to the desktop agent.</p></AuthShell>;
  return (
    <AuthShell title="Connect a device" subtitle="Enter the code the PLM Lite desktop agent shows.">
      {!looked ? (
        <form className="space-y-4" onSubmit={async (e) => {
          e.preventDefault(); setErr(null);
          try { setLooked(await get(`device/lookup?code=${encodeURIComponent(code)}`)); } catch (e) { setErr(e); }
        }}>
          <Input autoFocus value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCD-EFGH" className="mono text-center text-lg tracking-widest" />
          <ErrorText error={err} />
          <Button variant="primary" className="w-full">Continue</Button>
        </form>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-md border border-line bg-panel2 p-3"><KeyRound className="size-5 text-accent" /><div><p className="font-medium">{looked.clientName}</p><p className="text-xs text-muted">will be able to read and write in your vaults as {me.data?.user?.name}.</p></div></div>
          <ErrorText error={err} />
          <div className="flex gap-2">
            <Button className="flex-1" onClick={async () => { await post("device/approve", { code, approve: false }); setDone("Request denied"); }}>Deny</Button>
            <Button variant="primary" className="flex-1" onClick={async () => { try { await post("device/approve", { code, approve: true }); setDone("Device connected"); } catch (e) { setErr(e); } }}>Allow</Button>
          </div>
        </div>
      )}
    </AuthShell>
  );
}
