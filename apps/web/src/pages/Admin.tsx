import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Database, FolderOpen, Plus, Trash2, UserPlus } from "lucide-react";
import { ROLES } from "@plm/shared";
import { del, fmtDate, get, patch, post, put } from "../api";
import { Button, Card, Chip, Dialog, Empty, ErrorText, Field, Input, PageHeader, Select, Spinner, StateChip } from "../components/ui";
import { useMe, useVaults } from "../session";
import { toast, toastError } from "../toast";

// ------------------------------------------------------------------ users
export function UsersPage() {
  const me = useMe();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["admin-users"], queryFn: () => get<any[]>("admin/users") });
  const vaults = useVaults();
  const [create, setCreate] = useState(false);
  const [edit, setEdit] = useState<any | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: ["admin-users"] });
  const upd = async (id: string, body: object, msg: string) => { try { await patch(`admin/users/${id}`, body); toast(msg); reload(); } catch (e) { toastError(e); } };
  return (
    <div>
      <PageHeader title="Users" subtitle="People who can sign in. Give them a role per vault." actions={<Button variant="primary" onClick={() => setCreate(true)}><UserPlus className="size-4" />Add user</Button>} />
      {!users.data ? <Spinner /> : (
        <Card className="overflow-x-auto">
          <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-sm">
            <thead className="border-b border-line text-left text-xs text-muted"><tr><th className="p-2 pl-4">Name</th><th className="p-2">Email</th><th className="p-2">2FA</th><th className="p-2">Vault roles</th><th className="p-2">Status</th><th></th></tr></thead>
            <tbody>
              {users.data.map((u) => (
                <tr key={u.id} className="border-b border-line last:border-0">
                  <td className="p-2 pl-4 font-medium">{u.name} {u.isAdmin && <Chip color="#8b5cf6">Admin</Chip>}</td>
                  <td className="p-2 text-muted">{u.email}</td>
                  <td className="p-2">{u.totpEnabled ? <Chip color="#10b981">On</Chip> : <Chip color="#f59e0b">Off</Chip>}</td>
                  <td className="p-2 text-xs">{u.isAdmin ? "all (admin)" : u.vaults.map((m: any) => `${vaults.data?.find((v) => v.id === m.vaultId)?.name ?? "?"}: ${m.role}`).join(", ") || "—"}</td>
                  <td className="p-2">{u.disabled ? <Chip color="#ef4444">Disabled</Chip> : <Chip color="#10b981">Active</Chip>}</td>
                  <td className="p-2 pr-4 text-right"><Button size="sm" onClick={() => setEdit(u)}>Edit</Button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Card>
      )}
      <CreateUser open={create} onClose={() => setCreate(false)} onDone={reload} />
      <Dialog open={!!edit} onClose={() => setEdit(null)} title={edit ? `${edit.name}` : ""} wide>
        {edit && <EditUser u={edit} self={edit.id === me.data?.user?.id} upd={(b, m) => upd(edit.id, b, m).then(() => setEdit(null))} vaults={vaults.data ?? []} onRoles={reload} />}
      </Dialog>
    </div>
  );
}

function CreateUser({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: "", email: "", password: "", isAdmin: false });
  const [err, setErr] = useState<unknown>(null);
  return (
    <Dialog open={open} onClose={onClose} title="Add user">
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault(); setErr(null);
        try { await post("admin/users", f); toast("User added"); onDone(); onClose(); setF({ name: "", email: "", password: "", isAdmin: false }); } catch (e) { setErr(e); }
      }}>
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
        <Field label="Temporary password" hint="Send it to them; they can change it under Account."><Input value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={10} /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isAdmin} onChange={(e) => setF({ ...f, isAdmin: e.target.checked })} />Administrator (all vaults, user management)</label>
        <ErrorText error={err} />
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary">Add</Button></div>
      </form>
    </Dialog>
  );
}

function EditUser({ u, self, upd, vaults, onRoles }: { u: any; self: boolean; upd: (b: object, m: string) => void; vaults: { id: string; name: string }[]; onRoles: () => void }) {
  const [pw, setPw] = useState("");
  const [roles, setRoles] = useState<Record<string, string>>(Object.fromEntries(u.vaults.map((m: any) => [m.vaultId, m.role])));
  const setRole = async (vaultId: string, role: string) => {
    try {
      if (role) await put(`vaults/${vaultId}/members/${u.id}`, { role }); else await del(`vaults/${vaultId}/members/${u.id}`);
      setRoles({ ...roles, [vaultId]: role }); onRoles(); toast("Role saved");
    } catch (e) { toastError(e); }
  };
  return (
    <div className="space-y-5">
      {!u.isAdmin && <div>
        <h3 className="mb-2 text-sm font-semibold">Vault roles</h3>
        <div className="space-y-2">
          {vaults.map((v) => (
            <div key={v.id} className="flex items-center gap-3 text-sm"><span className="w-48">{v.name}</span>
              <Select value={roles[v.id] ?? ""} onChange={(e) => setRole(v.id, e.target.value)}><option value="">No access</option>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</Select>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">viewer: browse and download · editor: create, check out/in, change state, share · admin: vault settings, force unlock</p>
      </div>}
      <div className="flex flex-wrap gap-2">
        {!self && <Button onClick={() => upd({ isAdmin: !u.isAdmin }, u.isAdmin ? "Admin rights removed" : "Now an administrator")}>{u.isAdmin ? "Remove admin" : "Make admin"}</Button>}
        {u.totpEnabled && <Button onClick={() => upd({ resetTotp: true }, "2FA reset: they'll set it up again at next sign-in")}>Reset 2FA</Button>}
        <Button onClick={() => upd({ unlock: true }, "Sign-in lockout cleared")}>Clear lockout</Button>
        {!self && <Button variant={u.disabled ? "secondary" : "danger"} onClick={() => upd({ disabled: !u.disabled }, u.disabled ? "Enabled" : "Disabled")}>{u.disabled ? "Enable" : "Disable"}</Button>}
      </div>
      <div className="flex items-end gap-2">
        <Field label="Set a new password"><Input value={pw} onChange={(e) => setPw(e.target.value)} minLength={10} /></Field>
        <Button disabled={pw.length < 10} onClick={() => upd({ password: pw }, "Password set")}>Set</Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ vaults
export function VaultsPage() {
  const vaults = useVaults();
  const [create, setCreate] = useState(false);
  return (
    <div>
      <PageHeader title="Vaults" subtitle="Each vault is a folder under /vaults with its own numbering and lifecycle." actions={<Button variant="primary" onClick={() => setCreate(true)}><Plus className="size-4" />New vault</Button>} />
      {!vaults.data ? <Spinner /> : !vaults.data.length ? <Empty icon={<Database className="size-10" />} title="No vaults yet">Create the first one: pick a folder on the NAS share mounted at /vaults.</Empty> : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {vaults.data.map((v) => (
            <Link key={v.id} to="/admin/vaults/$vaultId" params={{ vaultId: v.id }} className="rounded-lg border border-line bg-panel p-4 hover:border-accent/60">
              <p className="font-semibold">{v.name}</p>
              <p className="mono mt-1 text-xs text-muted">/vaults/{v.folder}</p>
              <p className="mt-3 text-sm">Next number <span className="mono font-medium">{v.prefix}{String(v.nextNumber).padStart(v.digits, "0")}</span></p>
              <p className="text-xs text-muted">Revisions {v.revScheme === "numeric" ? "01.001" : "A.1"}</p>
            </Link>
          ))}
        </div>
      )}
      <CreateVault open={create} onClose={() => setCreate(false)} />
    </div>
  );
}

function CreateVault({ open, onClose }: { open: boolean; onClose: () => void }) {
  const folders = useQuery({ queryKey: ["folders"], queryFn: () => get("admin/folders"), enabled: open });
  const qc = useQueryClient();
  const nav = useNavigate();
  const [f, setF] = useState({ name: "", folder: "", prefix: "AB", digits: 5, nextNumber: 1, revScheme: "numeric", uppercaseDescriptions: true });
  const [err, setErr] = useState<unknown>(null);
  return (
    <Dialog open={open} onClose={onClose} title="New vault">
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault(); setErr(null);
        try { const v = await post("vaults", f); qc.invalidateQueries({ queryKey: ["vaults"] }); toast("Vault created"); onClose(); nav({ to: "/v/$vaultId", params: { vaultId: v.id } }); } catch (e) { setErr(e); }
      }}>
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, folder: f.folder || "" })} required placeholder="Main" /></Field>
        <Field label="Folder under /vaults" hint="Pick an existing folder or type a new name: it's created for you.">
          <Input list="vault-folders" value={f.folder} onChange={(e) => setF({ ...f, folder: e.target.value })} required placeholder="main" />
          <datalist id="vault-folders">{folders.data?.folders.filter((x: any) => !x.used).map((x: any) => <option key={x.name} value={x.name} />)}</datalist>
        </Field>
        {folders.data && <p className="flex items-center gap-1 text-xs text-muted"><FolderOpen className="size-3.5" />{folders.data.folders.length ? `${folders.data.folders.length} folder(s) found in ${folders.data.root}` : `${folders.data.root} is empty or not mounted`}</p>}
        <div className="grid grid-cols-3 gap-3">
          <Field label="Prefix"><Input value={f.prefix} onChange={(e) => setF({ ...f, prefix: e.target.value.toUpperCase() })} /></Field>
          <Field label="Digits"><Input type="number" min={3} max={10} value={f.digits} onChange={(e) => setF({ ...f, digits: Number(e.target.value) })} /></Field>
          <Field label="First number"><Input type="number" min={1} value={f.nextNumber} onChange={(e) => setF({ ...f, nextNumber: Number(e.target.value) })} /></Field>
        </div>
        <p className="text-xs text-muted">First part: <span className="mono font-medium">{f.prefix}{String(f.nextNumber).padStart(f.digits, "0")}</span></p>
        <Field label="Revisions"><Select className="w-full" value={f.revScheme} onChange={(e) => setF({ ...f, revScheme: e.target.value })}><option value="numeric">01, 02… with baselines 01.001</option><option value="letters">A, B… with baselines A.1</option></Select></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.uppercaseDescriptions} onChange={(e) => setF({ ...f, uppercaseDescriptions: e.target.checked })} />Upper-case descriptions</label>
        <ErrorText error={err} />
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary">Create</Button></div>
      </form>
    </Dialog>
  );
}

type St = { id?: string; name: string; color: string; freezes: boolean; isRelease: boolean; isInitial: boolean; allowedRoles: string[]; transitionsTo: string[] };

export function VaultSettingsPage() {
  const { vaultId } = useParams({ from: "/app/admin/vaults/$vaultId" });
  const qc = useQueryClient();
  const v = useQuery({ queryKey: ["vault", vaultId], queryFn: () => get(`vaults/${vaultId}`) });
  const members = useQuery({ queryKey: ["members", vaultId], queryFn: () => get<any[]>(`vaults/${vaultId}/members`) });
  const [f, setF] = useState<any>(null);
  const [states, setStates] = useState<St[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [rebuild, setRebuild] = useState<any>(null);
  useEffect(() => {
    if (!v.data) return;
    setF({ name: v.data.name, prefix: v.data.prefix, digits: v.data.digits, nextNumber: v.data.nextNumber, revScheme: v.data.revScheme, uppercaseDescriptions: v.data.uppercaseDescriptions });
    const byId = new Map(v.data.states.map((s: any) => [s.id, s.name]));
    setStates(v.data.states.map((s: any) => ({ ...s, transitionsTo: s.transitionsTo.map((t: string) => byId.get(t)).filter(Boolean) })));
  }, [v.data]);
  if (!v.data || !f || !states) return <Spinner />;
  const names = states.map((s) => s.name);
  const upd = (i: number, p: Partial<St>) => setStates(states.map((s, j) => (j === i ? { ...s, ...p } : p.isInitial ? { ...s, isInitial: false } : s)));
  const move = (i: number, d: number) => { const a = [...states]; const [x] = a.splice(i, 1); a.splice(i + d, 0, x!); setStates(a); };
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={v.data.name} subtitle={<span className="mono">/vaults/{v.data.folder}</span>} />
      <Card className="p-5">
        <h2 className="mb-3 font-semibold">Numbering and naming</h2>
        <div className="grid gap-3 sm:grid-cols-5">
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Prefix"><Input value={f.prefix} onChange={(e) => setF({ ...f, prefix: e.target.value.toUpperCase() })} /></Field>
          <Field label="Digits"><Input type="number" value={f.digits} onChange={(e) => setF({ ...f, digits: Number(e.target.value) })} /></Field>
          <Field label="Next number"><Input type="number" value={f.nextNumber} onChange={(e) => setF({ ...f, nextNumber: Number(e.target.value) })} /></Field>
          <Field label="Revisions"><Select className="w-full" value={f.revScheme} onChange={(e) => setF({ ...f, revScheme: e.target.value })}><option value="numeric">01.001</option><option value="letters">A.1</option></Select></Field>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.uppercaseDescriptions} onChange={(e) => setF({ ...f, uppercaseDescriptions: e.target.checked })} />Upper-case descriptions</label>
          <Button variant="primary" onClick={async () => { try { await patch(`vaults/${vaultId}`, f); toast("Saved"); qc.invalidateQueries({ queryKey: ["vaults"] }); v.refetch(); } catch (e) { toastError(e); } }}>Save</Button>
        </div>
        <p className="mt-2 text-xs text-muted">Changing the revision scheme affects new revisions only.</p>
      </Card>

      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <div><h2 className="font-semibold">Lifecycle states</h2><p className="text-xs text-muted">Order, colours, which states freeze a revision, who may set them, and the allowed transitions.</p></div>
          <Button size="sm" onClick={() => setStates([...states, { name: `State ${states.length + 1}`, color: "#64748b", freezes: false, isRelease: false, isInitial: false, allowedRoles: ["admin", "editor"], transitionsTo: [] }])}><Plus className="size-3.5" />Add state</Button>
        </div>
        <div className="space-y-3">
          {states.map((s, i) => (
            <div key={s.id ?? i} className="rounded-md border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex flex-col">
                  <button disabled={i === 0} onClick={() => move(i, -1)} className="text-muted disabled:opacity-30"><ArrowUp className="size-3.5" /></button>
                  <button disabled={i === states.length - 1} onClick={() => move(i, 1)} className="text-muted disabled:opacity-30"><ArrowDown className="size-3.5" /></button>
                </div>
                <input type="color" value={s.color} onChange={(e) => upd(i, { color: e.target.value })} className="h-8 w-10 rounded border border-line bg-panel" />
                <div className="w-44"><Input value={s.name} onChange={(e) => {
                  const old = s.name, nn = e.target.value;
                  setStates(states.map((x, j) => ({ ...x, name: j === i ? nn : x.name, transitionsTo: x.transitionsTo.map((t) => (t === old ? nn : t)) })));
                }} /></div>
                <StateChip state={s} />
                <label className="flex items-center gap-1 text-xs"><input type="radio" checked={s.isInitial} onChange={() => upd(i, { isInitial: true })} />Initial</label>
                <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={s.freezes} onChange={(e) => upd(i, { freezes: e.target.checked })} />Freezes revision</label>
                <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={s.isRelease} onChange={(e) => upd(i, { isRelease: e.target.checked })} />Counts as released</label>
                <button className="ml-auto text-muted hover:text-danger" onClick={() => setStates(states.filter((_, j) => j !== i).map((x) => ({ ...x, transitionsTo: x.transitionsTo.filter((t) => t !== s.name) })))}><Trash2 className="size-4" /></button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 pl-6 text-xs">
                <span className="text-muted">Set by:</span>
                {ROLES.map((r) => <label key={r} className="flex items-center gap-1"><input type="checkbox" checked={s.allowedRoles.includes(r)} onChange={(e) => upd(i, { allowedRoles: e.target.checked ? [...s.allowedRoles, r] : s.allowedRoles.filter((x) => x !== r) })} />{r}</label>)}
                <span className="ml-4 text-muted">Can go to:</span>
                {names.filter((n) => n !== s.name).map((n) => <label key={n} className="flex items-center gap-1"><input type="checkbox" checked={s.transitionsTo.includes(n)} onChange={(e) => upd(i, { transitionsTo: e.target.checked ? [...s.transitionsTo, n] : s.transitionsTo.filter((x) => x !== n) })} />{n}</label>)}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3"><ErrorText error={err} /></div>
        <div className="mt-3 flex justify-end">
          <Button variant="primary" onClick={async () => { setErr(null); try { await put(`vaults/${vaultId}/lifecycle`, { states }); toast("Lifecycle saved"); v.refetch(); } catch (e) { setErr(e); } }}>Save lifecycle</Button>
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 font-semibold">Members</h2>
        {members.data?.length ? (
          <div className="divide-y divide-line text-sm">{members.data.map((m) => <div key={m.userId} className="flex items-center gap-3 py-2"><span className="font-medium">{m.name}</span><span className="text-muted">{m.email}</span><Chip>{m.role}</Chip></div>)}</div>
        ) : <p className="text-sm text-muted">No members besides administrators.</p>}
        <p className="mt-2 text-xs text-muted">Set roles from <Link to="/admin/users" className="text-accent">Users</Link>.</p>
      </Card>

      <Card className="p-5">
        <h2 className="mb-1 font-semibold">Rebuild index from disk</h2>
        <p className="mb-3 text-sm text-muted">Re-imports items from their <span className="mono">NUMBER/NUMBER.json</span> records that the database doesn't know (e.g. after restoring files without a database backup). Existing items are left alone.</p>
        <Button onClick={async () => { try { setRebuild(await post(`vaults/${vaultId}/rebuild`)); } catch (e) { toastError(e); } }}>Rebuild</Button>
        {rebuild && <pre className="mono mt-3 rounded-md bg-panel2 p-3 text-xs">{JSON.stringify(rebuild, null, 2)}</pre>}
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ audit
export function AuditPage() {
  const [action, setAction] = useState("");
  const [pages, setPages] = useState<any[][]>([]);
  const first = useQuery({ queryKey: ["audit", action], queryFn: () => get<any[]>(`admin/audit?limit=100${action ? `&action=${encodeURIComponent(action)}` : ""}`) });
  useEffect(() => setPages([]), [action]);
  const rows = [...(first.data ?? []), ...pages.flat()];
  const more = async () => { const last = rows[rows.length - 1]; if (!last) return; setPages([...pages, await get(`admin/audit?limit=100&before=${last.id}${action ? `&action=${encodeURIComponent(action)}` : ""}`)]); };
  return (
    <div>
      <PageHeader title="Audit log" subtitle="Every sign-in, check-out, check-in, state change, download, share and admin action."
        actions={<Select value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">All events</option>{["auth.", "item.", "revision.", "file.", "share.", "admin.", "vault.", "token.", "device.", "worker."].map((a) => <option key={a} value={a}>{a.slice(0, -1)}</option>)}
        </Select>} />
      {!first.data ? <Spinner /> : (
        <Card className="overflow-x-auto">
          <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-sm">
            <thead className="border-b border-line text-left text-xs text-muted"><tr><th className="p-2 pl-4">When</th><th className="p-2">Who</th><th className="p-2">Action</th><th className="p-2">Item</th><th className="p-2">Details</th><th className="p-2">IP</th></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="border-b border-line align-top last:border-0">
                  <td className="p-2 pl-4 text-xs whitespace-nowrap text-muted">{fmtDate(a.at)}</td>
                  <td className="p-2 text-xs">{a.actor}</td>
                  <td className="p-2 mono text-xs">{a.action}</td>
                  <td className="p-2 text-xs">{a.itemId ? <Link to="/items/$itemId" params={{ itemId: a.itemId }} className="mono text-accent">{a.itemNumber ?? "item"}</Link> : ""}</td>
                  <td className="mono max-w-md p-2 text-xs break-all text-muted">{Object.keys(a.details ?? {}).length ? JSON.stringify(a.details) : ""}</td>
                  <td className="mono p-2 text-xs text-muted">{a.ip}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          {rows.length >= 100 && <div className="p-3 text-center"><Button size="sm" onClick={more}>Load more</Button></div>}
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ settings
export function SettingsPage() {
  const s = useQuery({ queryKey: ["settings"], queryFn: () => get("admin/settings") });
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (s.data) setF(s.data); }, [s.data]);
  if (!f) return <Spinner />;
  const sd = f.shareDefaults;
  const fmts = ["native", "step", "stl", "glb", "png", "3mf", "pdf"];
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="Settings" />
      <Card className="space-y-3 p-5">
        <h2 className="font-semibold">Security</h2>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.mfaMandatory} onChange={(e) => setF({ ...f, mfaMandatory: e.target.checked })} />Two-factor sign-in is mandatory for everyone</label>
        <Field label="Minimum password length"><Input type="number" min={8} max={128} value={f.minPasswordLength} onChange={(e) => setF({ ...f, minPasswordLength: Number(e.target.value) })} className="w-28" /></Field>
      </Card>
      <Card className="space-y-3 p-5">
        <h2 className="font-semibold">Share links</h2>
        <Field label="Default formats"><div className="flex flex-wrap gap-3">{fmts.map((k) => <label key={k} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={sd.formats.includes(k)} onChange={(e) => setF({ ...f, shareDefaults: { ...sd, formats: e.target.checked ? [...sd.formats, k] : sd.formats.filter((x: string) => x !== k) } })} />{k}</label>)}</div></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Default expiry (days)"><Input type="number" min={1} value={sd.expiresInDays ?? ""} onChange={(e) => setF({ ...f, shareDefaults: { ...sd, expiresInDays: e.target.value ? Number(e.target.value) : null } })} /></Field>
          <Field label="Longest allowed (days)"><Input type="number" min={1} value={sd.maxExpiryDays} onChange={(e) => setF({ ...f, shareDefaults: { ...sd, maxExpiryDays: Number(e.target.value) } })} /></Field>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sd.requirePassword} onChange={(e) => setF({ ...f, shareDefaults: { ...sd, requirePassword: e.target.checked } })} />Require a password on every link</label>
      </Card>
      <Card className="space-y-3 p-5">
        <h2 className="font-semibold">Backups</h2>
        <p className="text-sm text-muted">The worker runs <span className="mono">pg_dump</span> nightly into <span className="mono">/vaults/.plm-backups</span> (BACKUP_CRON, BACKUP_KEEP).</p>
        <Button onClick={async () => { try { await post("admin/backup"); toast("Backup queued"); } catch (e) { toastError(e); } }}>Back up now</Button>
      </Card>
      <div className="flex justify-end"><Button variant="primary" onClick={async () => { try { await put("admin/settings", f); toast("Settings saved"); s.refetch(); } catch (e) { toastError(e); } }}>Save settings</Button></div>
    </div>
  );
}
