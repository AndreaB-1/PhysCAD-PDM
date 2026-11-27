import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LogOut, ShieldCheck } from "lucide-react";
import { del, fmtAgo, fmtDate, get, post } from "../api";
import { Button, Card, Chip, Dialog, ErrorText, Field, Input, PageHeader, Select } from "../components/ui";
import { useMe, useVaults } from "../session";
import { toast, toastError } from "../toast";
import { RecoveryCodes, TotpEnroll } from "./Auth";

export function AccountPage() {
  const me = useMe();
  const qc = useQueryClient();
  const u = me.data?.user;
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => get<any[]>("auth/sessions") });
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: () => get<any[]>("tokens") });
  const vaults = useVaults();
  const [pw, setPw] = useState({ current: "", next: "" });
  const [pwErr, setPwErr] = useState<unknown>(null);
  const [enroll, setEnroll] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [tok, setTok] = useState({ name: "", write: true, vaultId: "" });
  const [newToken, setNewToken] = useState<string | null>(null);
  const [disablePw, setDisablePw] = useState("");
  if (!u) return null;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="Account & security" subtitle={`${u.name} · ${u.email}`} />

      <Card className="p-5">
        <h2 className="mb-1 flex items-center gap-2 font-semibold"><ShieldCheck className="size-4" />Two-factor sign-in</h2>
        {u.totpEnabled ? (
          <div className="space-y-3">
            <p className="text-sm"><Chip color="#10b981">On</Chip> <span className="ml-2 text-muted">{me.data?.recoveryCodesLeft} recovery codes left.</span></p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={async () => { try { setCodes((await post("auth/recovery-codes")).recoveryCodes); } catch (e) { toastError(e); } }}>New recovery codes</Button>
              {!me.data?.mfaMandatory && <>
                <Input type="password" placeholder="Password to turn off" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} className="max-w-52" />
                <Button variant="danger" onClick={async () => { try { await post("auth/totp/disable", { password: disablePw }); toast("Two-factor sign-in is off"); qc.invalidateQueries({ queryKey: ["me"] }); } catch (e) { toastError(e); } }}>Turn off</Button>
              </>}
            </div>
          </div>
        ) : (
          <div className="space-y-3"><p className="text-sm text-muted">Protect your account with an authenticator app.</p><Button variant="primary" onClick={() => setEnroll(true)}>Set up</Button></div>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 font-semibold">Password</h2>
        <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={async (e) => {
          e.preventDefault(); setPwErr(null);
          try { await post("auth/password", pw); toast("Password changed. Other sessions were signed out."); setPw({ current: "", next: "" }); } catch (e) { setPwErr(e); }
        }}>
          <Field label="Current"><Input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
          <Field label="New"><Input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
          <Button>Change</Button>
        </form>
        <div className="mt-2"><ErrorText error={pwErr} /></div>
      </Card>

      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">Sessions</h2>
          <Button size="sm" onClick={async () => { await post("auth/logout-everywhere"); location.href = "/login"; }}><LogOut className="size-3.5" />Sign out everywhere</Button></div>
        <div className="divide-y divide-line text-sm">
          {sessions.data?.map((s, i) => (
            <div key={i} className="flex items-center gap-3 py-2"><span className="flex-1 truncate text-muted" title={s.userAgent}>{s.userAgent || "Unknown browser"}</span><span className="mono text-xs">{s.ip}</span><span className="w-24 text-right text-xs text-muted">{fmtAgo(s.lastSeen)}</span>{s.current && <Chip color="#3b82f6">this one</Chip>}</div>
          ))}
        </div>
      </Card>

      <Card className="p-5" >
        <h2 id="tokens" className="mb-1 flex items-center gap-2 font-semibold"><KeyRound className="size-4" />Access tokens</h2>
        <p className="mb-3 text-sm text-muted">For the desktop agent, scripts and the PhysCAD plugin. The agent normally gets its own through “Connect a device”.</p>
        <form className="mb-4 flex flex-wrap items-end gap-2" onSubmit={async (e) => {
          e.preventDefault();
          try { const r = await post("tokens", { name: tok.name, scopes: tok.write ? ["read", "write"] : ["read"], vaultId: tok.vaultId || null }); setNewToken(r.token); setTok({ name: "", write: true, vaultId: "" }); tokens.refetch(); } catch (e) { toastError(e); }
        }}>
          <Field label="Name"><Input value={tok.name} onChange={(e) => setTok({ ...tok, name: e.target.value })} required placeholder="Workshop PC" /></Field>
          <Field label="Vault"><Select value={tok.vaultId} onChange={(e) => setTok({ ...tok, vaultId: e.target.value })}><option value="">All my vaults</option>{vaults.data?.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></Field>
          <label className="flex h-9 items-center gap-2 text-sm"><input type="checkbox" checked={tok.write} onChange={(e) => setTok({ ...tok, write: e.target.checked })} />Write</label>
          <Button variant="primary">Create token</Button>
        </form>
        <div className="divide-y divide-line text-sm">
          {tokens.data?.map((t) => (
            <div key={t.id} className="flex items-center gap-3 py-2">
              <span className="font-medium">{t.name}</span><span className="mono text-xs text-muted">{t.prefix}…</span>
              <span className="text-xs">{t.scopes.join(", ")}</span>
              <span className="ml-auto text-xs text-muted">{t.lastUsedAt ? `used ${fmtAgo(t.lastUsedAt)}` : `created ${fmtDate(t.createdAt)}`}</span>
              <Button size="sm" variant="ghost" onClick={async () => { await del(`tokens/${t.id}`); tokens.refetch(); toast("Token revoked"); }}>Revoke</Button>
            </div>
          ))}
        </div>
      </Card>

      <Dialog open={enroll} onClose={() => setEnroll(false)} title="Set up two-factor sign-in">
        {enroll && <TotpEnroll onDone={(c) => { setEnroll(false); setCodes(c); qc.invalidateQueries({ queryKey: ["me"] }); }} />}
      </Dialog>
      <Dialog open={!!codes} onClose={() => setCodes(null)} title="Your recovery codes">{codes && <RecoveryCodes codes={codes} />}</Dialog>
      <Dialog open={!!newToken} onClose={() => setNewToken(null)} title="Token created">
        <p className="text-sm text-muted">Copy it now: it won't be shown again.</p>
        <div className="flex gap-2"><Input readOnly value={newToken ?? ""} className="mono text-xs" onFocus={(e) => e.target.select()} /><Button onClick={() => { navigator.clipboard.writeText(newToken!); toast("Copied"); }}>Copy</Button></div>
      </Dialog>
      <ErrorText error={sessions.error} />
    </div>
  );
}
