import { lazy, Suspense, useMemo, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpCircle, Box, Boxes, ChevronDown, ChevronRight, Download, ExternalLink, FileUp, GitBranch, Image as ImageIcon,
  Link2, Lock, LockOpen, Pencil, RotateCcw, Share2, ShieldAlert, Undo2, Rotate3d,
} from "lucide-react";
import { SHAREABLE_KINDS } from "@plm/shared";
import { fileUrl, fmtAgo, fmtDate, fmtSize, get, patch, post } from "../api";
import { Button, Card, Chip, Dialog, Empty, ErrorText, Field, Input, Select, Spinner, StateChip, Tabs, Textarea, Thumb, cx } from "../components/ui";
import { LockChip } from "./Items";
import { useMe } from "../session";
import { toast, toastError } from "../toast";

const Viewer3D = lazy(() => import("../components/Viewer3D"));

type FileRow = { id: string; kind: string; size: number; name: string };
type Uses = { number: string; rev: string | null; baseline: string | null; count: number; itemId: string | null; baselineId: string | null };
type Baseline = { id: string; label: string; seq: number; status: "wip" | "checked_in"; author: string | null; comment: string; createdAt: string; uses: Uses[]; files: FileRow[] };
type State = { id: string; name: string; color: string; freezes: boolean; isRelease: boolean; isInitial: boolean; allowedRoles: string[]; transitionsTo: string[] };
type Revision = { id: string; rev: string; frozen: boolean; createdAt: string; state: State; history: { at: string; by: string | null; note: string; from: string | null; to: string }[]; baselines: Baseline[] };
export type ItemDetail = {
  item: { id: string; number: string; description: string; type: "part" | "assembly"; vaultId: string; createdAt: string };
  vault: { id: string; name: string; revScheme: string };
  lock: { userId: string; user: string; machine: string | null; since: string } | null;
  revisions: Revision[]; current: Baseline | null; released: Baseline | null; latest: Baseline | null; states: State[];
  role: "admin" | "editor" | "viewer";
};

const KIND_LABEL: Record<string, string> = { native: "PhysCAD", step: "STEP", stl: "STL", glb: "GLB (3D)", png: "Picture", "3mf": "3MF", obj: "OBJ", pdf: "PDF" };

export function ItemPage() {
  const { itemId } = useParams({ from: "/app/items/$itemId" });
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["item", itemId], queryFn: () => get<ItemDetail>(`items/${itemId}`) });
  const [tab, setTab] = useState<"history" | "contains" | "whereused" | "files" | "activity">("history");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"picture" | "3d">("picture");
  const [dialog, setDialog] = useState<null | "checkin" | "upload" | "state" | "share" | "rename" | "cancel" | "unlock">(null);
  const [busy, setBusy] = useState(false);
  const [dl, setDl] = useState(false);

  const d = q.data;
  const all = useMemo(() => d?.revisions.flatMap((r) => r.baselines.map((b) => ({ ...b, rev: r }))) ?? [], [d]);
  const selected = all.find((b) => b.id === selectedId) ?? all.find((b) => b.id === d?.current?.id) ?? all[0];
  if (q.error) return <ErrorText error={q.error} />;
  if (!d) return <div className="flex justify-center py-20"><Spinner /></div>;

  const myId = me.data?.user?.id;
  const mine = d.lock?.userId === myId;
  const canEdit = d.role !== "viewer";
  const latestRev = d.revisions[0]!;
  const set = (x: ItemDetail) => { qc.setQueryData(["item", itemId], x); qc.invalidateQueries({ queryKey: ["items"] }); };
  const act = async (fn: () => Promise<ItemDetail | { item: ItemDetail }>, msg: string) => {
    setBusy(true);
    try { const r = await fn(); set("item" in r && (r as { item: ItemDetail }).item.revisions ? (r as { item: ItemDetail }).item : (r as ItemDetail)); toast(msg); }
    catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const png = selected?.files.find((f) => f.kind === "png");
  const glb = selected?.files.find((f) => f.kind === "glb");
  const openLink = `plmlite://open?server=${encodeURIComponent(location.origin)}&item=${d.item.id}${selected ? `&baseline=${selected.id}` : ""}`;

  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-1 text-xs text-muted"><Link to="/v/$vaultId" params={{ vaultId: d.vault.id }} className="hover:text-fg">{d.vault.name}</Link></div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {d.item.type === "assembly" ? <Boxes className="size-5 text-muted" /> : <Box className="size-5 text-muted" />}
            <h1 className="mono text-2xl font-semibold">{d.item.number}</h1>
            <span className="text-2xl font-light text-muted">–</span>
            <h2 className="text-xl font-medium">{d.item.description}</h2>
            {canEdit && <button onClick={() => setDialog("rename")} className="rounded p-1 text-muted hover:bg-panel2" title="Rename"><Pencil className="size-3.5" /></button>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <Chip>rev <span className="mono">{latestRev.rev}</span></Chip>
            <StateChip state={latestRev.state} />
            {latestRev.frozen && <Chip color="#64748b">Frozen</Chip>}
            {d.lock ? <LockChip user={d.lock.user} since={d.lock.since} mine={mine} /> : <Chip color="#10b981"><LockOpen className="size-3" />Available</Chip>}
            {d.lock && <span className="text-xs text-muted">checked out {fmtAgo(d.lock.since)}{d.lock.machine ? ` on ${d.lock.machine}` : ""}</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canEdit && !d.lock && !latestRev.frozen && <Button variant="primary" busy={busy} onClick={() => act(() => post(`items/${itemId}/checkout`, {}), "Checked out")}><Lock className="size-4" />Check out</Button>}
          {canEdit && !d.lock && latestRev.frozen && <Button variant="primary" busy={busy} onClick={() => act(() => post(`items/${itemId}/revise`, {}), `Revision started and checked out`)}><GitBranch className="size-4" />Revise</Button>}
          {mine && <>
            <Button variant="primary" onClick={() => setDialog("checkin")}><ArrowUpCircle className="size-4" />Check in</Button>
            <Button onClick={() => setDialog("upload")}><FileUp className="size-4" />Upload baseline</Button>
            <Button onClick={() => setDialog("cancel")}><Undo2 className="size-4" />Cancel check-out</Button>
          </>}
          {d.lock && !mine && d.role === "admin" && <Button onClick={() => setDialog("unlock")}><ShieldAlert className="size-4" />Force unlock</Button>}
          <a href={openLink}><Button title="Needs the PLM Lite desktop agent"><ExternalLink className="size-4" />Open in PhysCAD</Button></a>
          <div className="relative">
            <Button onClick={() => setDl(!dl)} onBlur={() => setTimeout(() => setDl(false), 200)} disabled={!selected}><Download className="size-4" />Download<ChevronDown className="size-3.5" /></Button>
            {dl && selected && (
              <div className="absolute right-0 z-20 mt-1 w-60 overflow-hidden rounded-md border border-line bg-panel py-1 shadow-xl">
                <p className="px-3 py-1 text-xs text-muted">Baseline {selected.label}</p>
                {selected.files.map((f) => <a key={f.id} href={fileUrl(f.id, true)} className="flex justify-between px-3 py-1.5 text-sm hover:bg-panel2"><span>{KIND_LABEL[f.kind] ?? f.kind}</span><span className="text-xs text-muted">{fmtSize(f.size)}</span></a>)}
                {selected.uses.length > 0 && <a href={`/api/baselines/${selected.id}/pack`} className="block border-t border-line px-3 py-1.5 text-sm hover:bg-panel2">Pack and go (.zip)</a>}
              </div>
            )}
          </div>
          {canEdit && <Button onClick={() => setDialog("share")}><Share2 className="size-4" />Share</Button>}
          {canEdit && <Button onClick={() => setDialog("state")}><RotateCcw className="size-4" />Change state</Button>}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <div className="flex gap-1">
              <button onClick={() => setView("picture")} className={cx("flex items-center gap-1 rounded px-2 py-1 text-xs", view === "picture" ? "bg-panel2 font-medium" : "text-muted")}><ImageIcon className="size-3.5" />Picture</button>
              <button onClick={() => setView("3d")} className={cx("flex items-center gap-1 rounded px-2 py-1 text-xs", view === "3d" ? "bg-panel2 font-medium" : "text-muted")}><Rotate3d className="size-3.5" />3D</button>
            </div>
            {selected && <span className="text-xs text-muted">Baseline <span className="mono">{selected.label}</span>{selected.status === "wip" && <span className="ml-1 text-amber-500">(work in progress)</span>}</span>}
          </div>
          {view === "picture" ? <Thumb fileId={png?.id} className="aspect-[4/3] w-full" alt={d.item.number} />
            : glb ? <Suspense fallback={<div className="flex aspect-[4/3] items-center justify-center"><Spinner /></div>}><Viewer3D url={fileUrl(glb.id)} /></Suspense>
            : <div className="flex aspect-[4/3] items-center justify-center"><Empty icon={<Rotate3d className="size-10" />} title="No 3D model for this baseline">The desktop agent uploads a GLB at check-in. A STEP upload is converted automatically.</Empty></div>}
        </Card>
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold">Summary</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">Checked in</dt><dd className="mono">{d.current?.label ?? "—"}</dd>
            <dt className="text-muted">Latest released</dt><dd className="mono">{d.released?.label ?? "—"}</dd>
            <dt className="text-muted">Latest baseline</dt><dd className="mono">{d.latest ? <>{d.latest.label}{d.latest.status === "wip" && <span className="ml-1 text-amber-500">WIP</span>}</> : "—"}</dd>
            <dt className="text-muted">Type</dt><dd>{d.item.type === "assembly" ? "Assembly" : "Part"}</dd>
            <dt className="text-muted">Created</dt><dd>{fmtDate(d.item.createdAt)}</dd>
            <dt className="text-muted">Document name</dt><dd className="mono text-xs">{d.item.number} - {d.item.description}</dd>
          </dl>
          {selected?.comment && <div className="mt-4 rounded-md bg-panel2 p-3 text-sm"><p className="mb-1 text-xs text-muted">{selected.label} · {selected.author} · {fmtAgo(selected.createdAt)}</p>{selected.comment}</div>}
        </Card>
      </div>

      <div className="mt-6">
        <Tabs value={tab} onChange={setTab} tabs={[
          { id: "history", label: "History" }, { id: "contains", label: `Contains${selected?.uses.length ? ` (${selected.uses.length})` : ""}` },
          { id: "whereused", label: "Where used" }, { id: "files", label: "Files" }, { id: "activity", label: "Activity" },
        ]} />
        <div className="pt-4">
          {tab === "history" && <History d={d} selectedId={selected?.id} onSelect={setSelectedId} />}
          {tab === "contains" && <Contains itemId={itemId} baselineId={selected?.id} />}
          {tab === "whereused" && <WhereUsed itemId={itemId} />}
          {tab === "files" && <FilesTab d={d} />}
          {tab === "activity" && <Activity itemId={itemId} />}
        </div>
      </div>

      <CheckinDialog open={dialog === "checkin"} onClose={() => setDialog(null)} itemId={itemId} onDone={set} />
      <UploadDialog open={dialog === "upload"} onClose={() => setDialog(null)} itemId={itemId} onDone={() => q.refetch()} />
      <StateDialog open={dialog === "state"} onClose={() => setDialog(null)} d={d} onDone={set} />
      <ShareDialog open={dialog === "share"} onClose={() => setDialog(null)} d={d} selected={selected} />
      <RenameDialog open={dialog === "rename"} onClose={() => setDialog(null)} d={d} onDone={() => q.refetch()} />
      <Dialog open={dialog === "cancel"} onClose={() => setDialog(null)} title="Cancel check-out?">
        <p className="text-sm text-muted">The lock is released and the baselines saved during this check-out are discarded (moved to the vault's .trash folder).</p>
        <div className="flex justify-end gap-2"><Button onClick={() => setDialog(null)}>Keep working</Button><Button variant="danger" onClick={() => { setDialog(null); act(() => post(`items/${itemId}/cancel-checkout`), "Check-out cancelled"); }}>Cancel check-out</Button></div>
      </Dialog>
      <Dialog open={dialog === "unlock"} onClose={() => setDialog(null)} title="Force unlock">
        <p className="text-sm text-muted">{d.lock?.user} has this item checked out. Force unlock is recorded in the audit log.</p>
        <div className="flex justify-end gap-2">
          <Button onClick={() => { setDialog(null); act(() => post(`items/${itemId}/force-unlock`, { discard: false }), "Unlocked (work kept)"); }}>Unlock, keep their baselines</Button>
          <Button variant="danger" onClick={() => { setDialog(null); act(() => post(`items/${itemId}/force-unlock`, { discard: true }), "Unlocked, work discarded"); }}>Unlock and discard</Button>
        </div>
      </Dialog>
    </div>
  );
}

function History({ d, selectedId, onSelect }: { d: ItemDetail; selectedId?: string; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!d.revisions.some((r) => r.baselines.length)) return <Empty title="No baselines yet">Check the item out, open it in PhysCAD and save: every save records a baseline. You can also upload a .physcad file here.</Empty>;
  return (
    <div className="space-y-4">
      {d.revisions.map((r) => (
        <Card key={r.id}>
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
            <span className="font-semibold">Revision <span className="mono">{r.rev}</span></span>
            <StateChip state={r.state} />{r.frozen && <Chip color="#64748b">Frozen</Chip>}
            <button onClick={() => setOpen({ ...open, [r.id]: !open[r.id] })} className="ml-auto text-xs text-muted hover:text-fg">{open[r.id] ? "Hide" : "Show"} state history ({r.history.length})</button>
          </div>
          {open[r.id] && (
            <ul className="space-y-1 border-b border-line bg-panel2/50 px-4 py-2 text-xs">
              {r.history.map((h, i) => <li key={i}><span className="text-muted">{fmtDate(h.at)}</span> · {h.by ?? "system"}: {h.from ? `${h.from} → ` : ""}<b>{h.to}</b> — {h.note}</li>)}
            </ul>
          )}
          <table className="w-full text-sm">
            <tbody>
              {r.baselines.map((b) => (
                <tr key={b.id} onClick={() => onSelect(b.id)} className={cx("cursor-pointer border-b border-line last:border-0", b.id === selectedId ? "bg-accent/8" : "hover:bg-panel2")}>
                  <td className="w-24 px-4 py-2 mono font-medium">{b.label}</td>
                  <td className="w-28 py-2">{b.status === "wip" ? <Chip color="#f59e0b">WIP</Chip> : <Chip color="#10b981">Checked in</Chip>}</td>
                  <td className="py-2">{b.comment || <span className="text-muted">—</span>}{b.uses.length > 0 && <span className="ml-2 text-xs text-muted">uses {b.uses.length}</span>}</td>
                  <td className="py-2 text-muted">{b.author}</td>
                  <td className="px-4 py-2 text-right text-xs text-muted" title={fmtDate(b.createdAt)}>{fmtAgo(b.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  );
}

function Contains({ itemId, baselineId }: { itemId: string; baselineId?: string }) {
  const { data } = useQuery({ queryKey: ["contains", itemId, baselineId], queryFn: () => get(`items/${itemId}/contains${baselineId ? `?baselineId=${baselineId}` : ""}`) });
  if (!data) return <Spinner />;
  if (!data.children.length) return <Empty title="Uses no other parts">An assembly lists here the exact part baselines it links to (PhysCAD's Add to File, linked).</Empty>;
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-line text-left text-xs text-muted"><tr><th className="w-14 p-2"></th><th className="p-2">Part</th><th className="p-2">Pinned</th><th className="p-2">State</th><th className="p-2">Qty</th><th className="p-2">Newer</th></tr></thead>
        <tbody>
          {data.children.map((c: any) => (
            <tr key={`${c.number}-${c.baseline}`} className="border-b border-line last:border-0">
              <td className="p-1.5"><Thumb fileId={c.thumbFileId} className="h-10 w-12 rounded" /></td>
              <td className="p-2">{c.itemId ? <Link to="/items/$itemId" params={{ itemId: c.itemId }} className="mono font-medium hover:text-accent">{c.number}</Link> : <span className="mono text-danger" title="Not in this vault">{c.number}</span>} <span className="text-muted">{c.description}</span></td>
              <td className="p-2 mono">{c.baseline ?? `${c.rev}.${String(c.seq).padStart(3, "0")}`}{!c.baselineId && <span className="ml-1 text-xs text-danger">missing</span>}</td>
              <td className="p-2"><StateChip state={c.pinnedState} /></td>
              <td className="p-2">{c.count}</td>
              <td className="p-2 text-xs">
                {c.releasedAvailable && <Chip color="#22c55e">Released {c.latestReleased}</Chip>}
                {!c.releasedAvailable && c.newerAvailable && <Chip color="#3b82f6">{c.latestCheckedIn}</Chip>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

type WuNode = { itemId: string; number: string; description: string; usages: { parentBaseline: string; status: string; rev: string; state: { name: string; color: string; freezes: boolean }; childBaseline: string | null; count: number }[]; parents: WuNode[] };
function WhereUsed({ itemId }: { itemId: string }) {
  const { data } = useQuery({ queryKey: ["whereused", itemId], queryFn: () => get<WuNode[]>(`items/${itemId}/where-used`) });
  const [stateFilter, setStateFilter] = useState("");
  if (!data) return <Spinner />;
  if (!data.length) return <Empty title="Not used in any assembly" />;
  const names = [...new Set(data.flatMap(function walk(n: WuNode): string[] { return [...n.usages.map((u) => u.state.name), ...n.parents.flatMap(walk)]; }))];
  const Node = ({ n, depth }: { n: WuNode; depth: number }) => {
    const [open, setOpen] = useState(depth < 1);
    const usages = n.usages.filter((u) => !stateFilter || u.state.name === stateFilter);
    if (!usages.length) return null;
    return (
      <div style={{ marginLeft: depth * 20 }}>
        <div className="flex items-center gap-2 py-1.5">
          <button onClick={() => setOpen(!open)} className="text-muted">{n.parents.length ? (open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />) : <span className="inline-block size-4" />}</button>
          <Link to="/items/$itemId" params={{ itemId: n.itemId }} className="mono font-medium hover:text-accent">{n.number}</Link><span className="text-muted">{n.description}</span>
          <div className="flex flex-wrap gap-1">
            {usages.slice(0, 6).map((u) => <Chip key={u.parentBaseline} color={u.state.color} title={`${u.parentBaseline} (${u.state.name}) uses ${u.childBaseline} ×${u.count}`}><span className="mono">{u.parentBaseline}</span>→<span className="mono">{u.childBaseline}</span></Chip>)}
            {usages.length > 6 && <span className="text-xs text-muted">+{usages.length - 6}</span>}
          </div>
        </div>
        {open && n.parents.map((p) => <Node key={p.itemId} n={p} depth={depth + 1} />)}
      </div>
    );
  };
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2 text-sm"><span className="text-muted">Parent state</span>
        <Select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}><option value="">Any</option>{names.map((n) => <option key={n}>{n}</option>)}</Select>
      </div>
      {data.map((n) => <Node key={n.itemId} n={n} depth={0} />)}
    </Card>
  );
}

function FilesTab({ d }: { d: ItemDetail }) {
  const rows = d.revisions.flatMap((r) => r.baselines.flatMap((b) => b.files.map((f) => ({ ...f, label: b.label, status: b.status }))));
  if (!rows.length) return <Empty title="No files yet" />;
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-line text-left text-xs text-muted"><tr><th className="p-2 pl-4">File</th><th className="p-2">Kind</th><th className="p-2">Baseline</th><th className="p-2">Size</th><th></th></tr></thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.id} className="border-b border-line last:border-0">
              <td className="p-2 pl-4 mono text-xs">{f.name}</td><td className="p-2">{KIND_LABEL[f.kind] ?? f.kind}</td>
              <td className="p-2 mono">{f.label}{f.status === "wip" && <span className="ml-1 text-amber-500">WIP</span>}</td><td className="p-2 text-muted">{fmtSize(f.size)}</td>
              <td className="p-2 pr-4 text-right"><a href={fileUrl(f.id, true)} className="text-accent hover:underline">Download</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Activity({ itemId }: { itemId: string }) {
  const { data } = useQuery({ queryKey: ["activity", itemId], queryFn: () => get<any[]>(`items/${itemId}/activity`) });
  if (!data) return <Spinner />;
  return (
    <Card className="divide-y divide-line">
      {data.map((a) => (
        <div key={a.id} className="flex gap-3 px-4 py-2 text-sm">
          <span className="w-36 shrink-0 text-xs text-muted">{fmtDate(a.at)}</span>
          <span className="w-44 shrink-0 truncate">{a.actor}</span>
          <span className="mono w-44 shrink-0 text-xs">{a.action}</span>
          <span className="truncate text-xs text-muted">{Object.entries(a.details ?? {}).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ")}</span>
        </div>
      ))}
    </Card>
  );
}

function FilePicker({ files, setFiles }: { files: Record<string, File | null>; setFiles: (f: Record<string, File | null>) => void }) {
  const kinds: [string, string, string][] = [["native", "PhysCAD file (.physcad)", ".physcad,.json"], ["step", "STEP (optional)", ".step,.stp"], ["glb", "GLB 3D model (optional)", ".glb"], ["png", "Picture (optional)", ".png"], ["stl", "STL (optional)", ".stl"]];
  return (
    <div className="space-y-2">
      {kinds.map(([k, label, accept]) => (
        <Field key={k} label={label}><input type="file" accept={accept} onChange={(e) => setFiles({ ...files, [k]: e.target.files?.[0] ?? null })} className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-line file:bg-panel2 file:px-3 file:py-1.5 file:text-sm" /></Field>
      ))}
    </div>
  );
}

function CheckinDialog({ open, onClose, itemId, onDone }: { open: boolean; onClose: () => void; itemId: string; onDone: (d: ItemDetail) => void }) {
  const [comment, setComment] = useState("");
  const [withFile, setWithFile] = useState(false);
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} title="Check in">
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try {
          let d: ItemDetail;
          if (withFile) {
            if (!files.native) throw new Error("Pick the .physcad file");
            const fd = new FormData(); fd.append("comment", comment);
            for (const [k, f] of Object.entries(files)) if (f) fd.append(k, f, f.name);
            d = await post(`items/${itemId}/checkin`, fd);
          } else d = await post(`items/${itemId}/checkin`, { comment });
          onDone(d); toast(`Checked in${d.current ? ` as ${d.current.label}` : ""}`); onClose(); setComment(""); setFiles({});
        } catch (e) { setErr(e); } finally { setBusy(false); }
      }}>
        <p className="text-sm text-muted">The last baseline saved during this check-out becomes the checked-in baseline, and the lock is released.</p>
        <Field label="Comment (required)"><Textarea autoFocus rows={3} value={comment} onChange={(e) => setComment(e.target.value)} required /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={withFile} onChange={(e) => setWithFile(e.target.checked)} />Upload a final file with the check-in</label>
        {withFile && <FilePicker files={files} setFiles={setFiles} />}
        <ErrorText error={err} />
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy}>Check in</Button></div>
      </form>
    </Dialog>
  );
}

function UploadDialog({ open, onClose, itemId, onDone }: { open: boolean; onClose: () => void; itemId: string; onDone: () => void }) {
  const [comment, setComment] = useState("");
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} title="Upload a baseline">
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try {
          if (!files.native) throw new Error("Pick the .physcad file");
          const fd = new FormData(); fd.append("comment", comment);
          for (const [k, f] of Object.entries(files)) if (f) fd.append(k, f, f.name);
          const r = await post(`items/${itemId}/baselines`, fd);
          toast(r.unchanged ? "No changes since the last baseline" : `Baseline ${r.baseline.label} recorded`);
          onDone(); onClose(); setFiles({}); setComment("");
        } catch (e) { setErr(e); } finally { setBusy(false); }
      }}>
        <p className="text-sm text-muted">Normally the desktop agent does this on every save in PhysCAD. Baselines stay marked work in progress until check-in.</p>
        <FilePicker files={files} setFiles={setFiles} />
        <Field label="Comment (optional)"><Input value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        <ErrorText error={err} />
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy}>Upload</Button></div>
      </form>
    </Dialog>
  );
}

function StateDialog({ open, onClose, d, onDone }: { open: boolean; onClose: () => void; d: ItemDetail; onDone: (d: ItemDetail) => void }) {
  const [revId, setRevId] = useState(d.revisions[0]!.id);
  const rev = d.revisions.find((r) => r.id === revId) ?? d.revisions[0]!;
  const targets = d.states.filter((s) => rev.state.transitionsTo.includes(s.id) && (d.role === "admin" || s.allowedRoles.includes(d.role)));
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const target = targets.find((t) => t.id === to);
  return (
    <Dialog open={open} onClose={onClose} title="Change state">
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try { const r = await post(`revisions/${rev.id}/state`, { stateId: to, note }); onDone(r); toast(`Revision ${rev.rev} is now ${target?.name}`); onClose(); setNote(""); setTo(""); }
        catch (e) { setErr(e); } finally { setBusy(false); }
      }}>
        <Field label="Revision"><Select value={revId} onChange={(e) => { setRevId(e.target.value); setTo(""); }} className="w-full">{d.revisions.map((r) => <option key={r.id} value={r.id}>{r.rev} — {r.state.name}</option>)}</Select></Field>
        {targets.length === 0 ? <p className="text-sm text-muted">No transitions from <b>{rev.state.name}</b> are open to you.</p> : (
          <div className="flex flex-wrap gap-2">
            {targets.map((t) => (
              <button type="button" key={t.id} onClick={() => setTo(t.id)} className={cx("rounded-md border px-3 py-2 text-sm", to === t.id ? "border-accent ring-2 ring-accent/30" : "border-line hover:bg-panel2")}>
                <StateChip state={t} />{t.freezes && <span className="ml-2 text-xs text-muted">freezes</span>}
              </button>
            ))}
          </div>
        )}
        {target?.freezes && <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">Revision {rev.rev} will be frozen: further changes need a new revision (Revise).</p>}
        <Field label="Note (required)"><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} required /></Field>
        <ErrorText error={err} />
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!to}>Change state</Button></div>
      </form>
    </Dialog>
  );
}

function ShareDialog({ open, onClose, d, selected }: { open: boolean; onClose: () => void; d: ItemDetail; selected?: Baseline & { rev: Revision } }) {
  const settings = useQuery({ queryKey: ["share-defaults"], queryFn: () => get("shares/defaults"), enabled: open });
  const [target, setTarget] = useState<"baseline" | "revision" | "latest_released">(d.released ? "latest_released" : "baseline");
  const [formats, setFormats] = useState<string[] | null>(null);
  const [days, setDays] = useState<string>("");
  const [password, setPassword] = useState("");
  const [max, setMax] = useState("");
  const [note, setNote] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const fm: string[] = formats ?? settings.data?.formats ?? ["step", "png"];
  const dd = days || String(settings.data?.expiresInDays ?? 14);
  const close = () => { setUrl(null); onClose(); };
  return (
    <Dialog open={open} onClose={close} title={`Share ${d.item.number}`}>
      {url ? (
        <div className="space-y-3">
          <p className="text-sm">Anyone with this link can see the picture and 3D view, and download the chosen formats. Nothing else in the vault is visible.</p>
          <div className="flex gap-2"><Input readOnly value={url} className="mono text-xs" onFocus={(e) => e.target.select()} /><Button onClick={() => { navigator.clipboard.writeText(url); toast("Link copied"); }}><Link2 className="size-4" />Copy</Button></div>
          <div className="flex justify-end"><Button variant="primary" onClick={close}>Done</Button></div>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={async (e) => {
          e.preventDefault(); setBusy(true); setErr(null);
          try {
            const r = await post("shares", {
              target, itemId: d.item.id, formats: fm, expiresInDays: dd === "never" ? null : Number(dd),
              baselineId: target === "baseline" ? selected?.id : undefined, revisionId: target === "revision" ? selected?.rev.id : undefined,
              password: password || undefined, maxDownloads: max ? Number(max) : null, note: note || undefined,
            });
            setUrl(r.url);
          } catch (e) { setErr(e); } finally { setBusy(false); }
        }}>
          <Field label="What">
            <Select className="w-full" value={target} onChange={(e) => setTarget(e.target.value as never)}>
              <option value="baseline">This exact baseline ({selected?.label})</option>
              <option value="revision">Latest checked-in baseline of revision {selected?.rev.rev}</option>
              <option value="latest_released" disabled={!d.released}>Always the latest released{d.released ? ` (now ${d.released.label})` : " (none yet)"}</option>
            </Select>
          </Field>
          <Field label="Formats" hint="The native PhysCAD file is off by default: it contains the full design history.">
            <div className="flex flex-wrap gap-3">
              {SHAREABLE_KINDS.map((k) => (
                <label key={k} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={fm.includes(k)} onChange={(e) => setFormats(e.target.checked ? [...fm, k] : fm.filter((x: string) => x !== k))} />{KIND_LABEL[k]}</label>
              ))}
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Expires"><Select className="w-full" value={dd} onChange={(e) => setDays(e.target.value)}>
              {[1, 3, 7, 14, 30, 60, 90].map((n) => <option key={n} value={n}>in {n} day{n > 1 ? "s" : ""}</option>)}<option value="never">never (admins)</option>
            </Select></Field>
            <Field label="Download limit"><Input type="number" min={1} value={max} onChange={(e) => setMax(e.target.value)} placeholder="unlimited" /></Field>
          </div>
          <Field label={settings.data?.requirePassword ? "Password (required)" : "Password (optional)"}><Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" /></Field>
          <Field label="Note for yourself (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. quote for Acme" /></Field>
          <ErrorText error={err} />
          <div className="flex justify-end gap-2"><Button type="button" onClick={close}>Cancel</Button><Button variant="primary" busy={busy}><Share2 className="size-4" />Create link</Button></div>
        </form>
      )}
    </Dialog>
  );
}

function RenameDialog({ open, onClose, d, onDone }: { open: boolean; onClose: () => void; d: ItemDetail; onDone: () => void }) {
  const [v, setV] = useState(d.item.description);
  const [err, setErr] = useState<unknown>(null);
  return (
    <Dialog open={open} onClose={onClose} title={`Rename ${d.item.number}`}>
      <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); try { await patch(`items/${d.item.id}`, { description: v }); toast("Renamed"); onDone(); onClose(); } catch (e) { setErr(e); } }}>
        <Field label="Description" hint="Rename the PhysCAD document to match the next time you open it."><Input value={v} onChange={(e) => setV(e.target.value)} /></Field>
        <ErrorText error={err} />
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary">Save</Button></div>
      </form>
    </Dialog>
  );
}
