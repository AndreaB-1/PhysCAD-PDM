import { useState } from "react";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, Boxes, LayoutGrid, Lock, Plus, Rows3 } from "lucide-react";
import { fmtAgo, get, post } from "../api";
import { Button, Card, Chip, Dialog, Empty, ErrorText, Field, Input, PageHeader, Select, Spinner, StateChip, Thumb, cx } from "../components/ui";
import { useMe } from "../session";
import { toast } from "../toast";

export type ListItem = {
  id: string; number: string; description: string; type: "part" | "assembly"; updatedAt: string; vaultId: string;
  lockUserId: string | null; lockUser: string | null; lockSince: string | null; rev: string; frozen: boolean;
  stateName: string; stateColor: string; currentLabel: string | null; latestLabel: string | null; latestStatus: string | null; thumbId: string | null;
};

export function LockChip({ user, since, mine }: { user: string; since?: string | null; mine?: boolean }) {
  return <Chip color={mine ? "#8b5cf6" : "#ef4444"} title={since ? `since ${new Date(since).toLocaleString()}` : undefined}><Lock className="size-3" />{mine ? "You" : user}</Chip>;
}

export function ItemsGrid({ items, view, meId }: { items: ListItem[]; view: "grid" | "table"; meId?: string }) {
  if (view === "table") return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-line text-left text-xs text-muted">
          <tr><th className="w-14 p-2"></th><th className="p-2">Number</th><th className="p-2">Description</th><th className="p-2">Rev</th><th className="p-2">State</th><th className="p-2">Latest</th><th className="p-2">Lock</th><th className="p-2">Updated</th></tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id} className="border-b border-line last:border-0 hover:bg-panel2">
              <td className="p-1.5"><Link to="/items/$itemId" params={{ itemId: i.id }}><Thumb fileId={i.thumbId} className="h-10 w-12 rounded" /></Link></td>
              <td className="p-2 mono font-medium"><Link to="/items/$itemId" params={{ itemId: i.id }} className="hover:text-accent">{i.number}</Link></td>
              <td className="p-2"><span className="flex items-center gap-1.5">{i.type === "assembly" ? <Boxes className="size-3.5 text-muted" /> : <Box className="size-3.5 text-muted" />}{i.description}</span></td>
              <td className="p-2 mono">{i.rev}</td>
              <td className="p-2"><StateChip state={{ name: i.stateName, color: i.stateColor }} /></td>
              <td className="p-2 mono text-xs">{i.latestLabel ?? "—"}{i.latestStatus === "wip" && <span className="ml-1 text-amber-500">WIP</span>}</td>
              <td className="p-2">{i.lockUser && <LockChip user={i.lockUser} since={i.lockSince} mine={i.lockUserId === meId} />}</td>
              <td className="p-2 text-xs text-muted">{fmtAgo(i.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-4">
      {items.map((i) => (
        <Link key={i.id} to="/items/$itemId" params={{ itemId: i.id }} className="group overflow-hidden rounded-lg border border-line bg-panel transition hover:border-accent/60 hover:shadow-md">
          <div className="relative">
            <Thumb fileId={i.thumbId} className="aspect-[4/3] w-full" />
            <div className="absolute top-2 left-2 rounded-full bg-panel"><StateChip state={{ name: i.stateName, color: i.stateColor }} /></div>
            {i.lockUser && <div className="absolute top-2 right-2 rounded-full bg-panel"><LockChip user={i.lockUser} mine={i.lockUserId === meId} /></div>}
          </div>
          <div className="space-y-0.5 border-t border-line p-3">
            <div className="flex items-center gap-1.5"><span className="mono font-semibold group-hover:text-accent">{i.number}</span><span className="mono text-xs text-muted">rev {i.rev}</span>{i.type === "assembly" && <Boxes className="ml-auto size-3.5 text-muted" />}</div>
            <p className="truncate text-sm">{i.description}</p>
            <p className="text-xs text-muted">{fmtAgo(i.updatedAt)}</p>
          </div>
        </Link>
      ))}
    </div>
  );
}

export function NewItemDialog({ vaultId, open, onClose }: { vaultId: string; open: boolean; onClose: () => void }) {
  const [description, setDescription] = useState("");
  const [checkout, setCheckout] = useState(true);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const qc = useQueryClient();
  return (
    <Dialog open={open} onClose={onClose} title="New part">
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try {
          const item = await post(`vaults/${vaultId}/items`, { description, checkout });
          toast(`${item.number} created`);
          qc.invalidateQueries({ queryKey: ["items"] });
          onClose(); setDescription("");
          nav({ to: "/items/$itemId", params: { itemId: item.id } });
        } catch (e) { setErr(e); } finally { setBusy(false); }
      }}>
        <Field label="Description" hint="The next free number is assigned automatically. The document name becomes NUMBER - DESCRIPTION.">
          <Input autoFocus value={description} onChange={(e) => setDescription(e.target.value)} placeholder="MOUNTING BRACKET" required />
        </Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={checkout} onChange={(e) => setCheckout(e.target.checked)} />Check it out to me</label>
        <ErrorText error={err} />
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy}>Create</Button></div>
      </form>
    </Dialog>
  );
}

export function ItemsPage() {
  const { vaultId } = useParams({ from: "/app/v/$vaultId" });
  const search = useSearch({ from: "/app/v/$vaultId" }) as { filter?: string };
  const me = useMe();
  const [q, setQ] = useState("");
  const [state, setState] = useState("");
  const [type, setType] = useState("");
  const [sort, setSort] = useState("-updated");
  const [view, setView] = useState<"grid" | "table">(() => { try { return (localStorage.getItem("view") as "grid") || "grid"; } catch { return "grid"; } });
  const [creating, setCreating] = useState(false);
  try { localStorage.setItem("vault", vaultId); } catch { /* */ }
  const vault = useQuery({ queryKey: ["vault", vaultId], queryFn: () => get(`vaults/${vaultId}`) });
  const params = new URLSearchParams({ q, state, type, sort: search.filter === "recent" ? "-updated" : sort, limit: "120" });
  if (search.filter === "released") params.set("released", "1");
  if (search.filter === "locked") params.set("locked", "1");
  const list = useQuery({ queryKey: ["items", vaultId, params.toString()], queryFn: () => get<{ total: number; items: ListItem[] }>(`vaults/${vaultId}/items?${params}`), placeholderData: (p) => p });
  const title = { recent: "Recent", released: "Released", locked: "Checked out" }[search.filter ?? ""] ?? "All items";
  const canEdit = vault.data && vault.data.role !== "viewer";
  const setV = (v: "grid" | "table") => { setView(v); try { localStorage.setItem("view", v); } catch { /* */ } };

  return (
    <div>
      <PageHeader title={title} subtitle={vault.data ? `${vault.data.name} · ${list.data?.total ?? "…"} items` : undefined}
        actions={canEdit && <Button variant="primary" onClick={() => setCreating(true)}><Plus className="size-4" />New part</Button>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter: number, description, comment…" className="max-w-xs" />
        <Select value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">Any state</option>
          {vault.data?.states.map((s: { id: string; name: string }) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <Select value={type} onChange={(e) => setType(e.target.value)}><option value="">Parts &amp; assemblies</option><option value="part">Parts</option><option value="assembly">Assemblies</option></Select>
        {search.filter !== "recent" && <Select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="-updated">Recently changed</option><option value="number">Number ↑</option><option value="-number">Number ↓</option><option value="description">Description</option><option value="state">State</option>
        </Select>}
        <div className="ml-auto flex rounded-md border border-line">
          <button onClick={() => setV("grid")} className={cx("p-2", view === "grid" ? "bg-panel2 text-fg" : "text-muted")}><LayoutGrid className="size-4" /></button>
          <button onClick={() => setV("table")} className={cx("p-2", view === "table" ? "bg-panel2 text-fg" : "text-muted")}><Rows3 className="size-4" /></button>
        </div>
      </div>
      <ErrorText error={list.error} />
      {!list.data ? <div className="flex justify-center py-16"><Spinner /></div>
        : list.data.items.length === 0 ? (
          <Empty icon={<Box className="size-10" />} title={q || state || type || search.filter ? "Nothing matches" : "This vault is empty"}>
            {!q && !search.filter && canEdit && <>Create the first part with <b>New part</b>. It gets the next number; then check it out in PhysCAD and save to record baselines.</>}
          </Empty>
        ) : <ItemsGrid items={list.data.items} view={view} meId={me.data?.user?.id} />}
      {canEdit && <NewItemDialog vaultId={vaultId} open={creating} onClose={() => setCreating(false)} />}
    </div>
  );
}

export function CheckoutsPage() {
  const me = useMe();
  const { data } = useQuery({ queryKey: ["items", "mine"], queryFn: () => get<ListItem[]>("me/checkouts") });
  return (
    <div>
      <PageHeader title="My check-outs" subtitle="Items locked by you. Check them in from PhysCAD or here when you're done." />
      {!data ? <Spinner /> : data.length === 0 ? <Empty icon={<Lock className="size-10" />} title="Nothing checked out" /> : <ItemsGrid items={data} view="table" meId={me.data?.user?.id} />}
    </div>
  );
}
