import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  Box, Boxes, ChevronRight, Eye, FileText, Folder, FolderOpen, FolderPlus, Library, Paperclip, Pencil, Plus, Save, Search,
  Trash2, Upload, X, FolderKanban, Download,
} from "lucide-react";
import { api, del, fmtAgo, fmtSize, get, patch, post } from "../api";
import { Button, Card, Chip, Dialog, Empty, ErrorText, Field, Input, Select, Spinner, StateChip, Tabs, Textarea, Thumb, cx } from "../components/ui";
import { toast } from "../toast";
import type { ListItem } from "./Items";

type Kind = "catalog" | "project";
type Status = "planning" | "active" | "on_hold" | "done";
type CollectionRow = {
  id: string; kind: Kind; parentId: string | null; name: string; description: string; color: string; status: Status | null;
  updatedAt: string; itemCount: number; docCount: number; fileCount: number;
};
type LinkedItem = ListItem & { vaultName: string; note: string; quantity: number | null; addedAt: string };
type Doc = { id: string; title: string; body?: string; updatedAt: string; updatedBy: string | null };
type PFile = { id: string; name: string; size: number; mime: string; note: string; uploadedBy: string | null; createdAt: string };
type Detail = {
  collection: CollectionRow; path: { id: string; name: string }[];
  children: (Pick<CollectionRow, "id" | "name" | "color" | "status" | "description"> & { itemCount: number })[];
  items: LinkedItem[]; hiddenItems: number; canEdit: boolean; docs?: Doc[]; files?: PFile[];
};

const STATUS: Record<Status, { label: string; color: string }> = {
  planning: { label: "Planning", color: "#8b5cf6" },
  active: { label: "Active", color: "#2563eb" },
  on_hold: { label: "On hold", color: "#f59e0b" },
  done: { label: "Done", color: "#10b981" },
};
const COLORS = ["#64748b", "#2563eb", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];
const words = (k: Kind) => k === "catalog"
  ? { one: "catalog", One: "Catalog", many: "Catalogs", sub: "sub-catalog", icon: <Library className="size-4" /> }
  : { one: "project", One: "Project", many: "Projects", sub: "sub-project", icon: <FolderKanban className="size-4" /> };

function useCollections(kind: Kind) {
  return useQuery({ queryKey: ["collections", kind], queryFn: () => get<{ collections: CollectionRow[]; canEdit: boolean }>(`collections?kind=${kind}`) });
}

// ------------------------------------------------------------------ page shell

export function CatalogsPage() { return <CollectionsPage kind="catalog" />; }
export function ProjectsPage() { return <CollectionsPage kind="project" />; }

function CollectionsPage({ kind }: { kind: Kind }) {
  const params = useParams({ strict: false }) as { collectionId?: string };
  const list = useCollections(kind);
  const [creating, setCreating] = useState<null | { parentId: string | null }>(null);
  const w = words(kind);
  if (list.error) return <ErrorText error={list.error} />;
  if (!list.data) return <div className="flex justify-center py-20"><Spinner /></div>;
  const { collections: all, canEdit } = list.data;

  return (
    <div className="mx-auto flex max-w-7xl gap-6">
      <aside className="hidden w-60 shrink-0 md:block">
        <div className="mb-2 flex items-center justify-between">
          <Link to={kind === "catalog" ? "/catalogs" : "/projects"} className="flex items-center gap-2 text-sm font-semibold hover:text-accent">{w.icon}{w.many}</Link>
          {canEdit && <button title={`New ${w.one}`} onClick={() => setCreating({ parentId: null })} className="rounded p-1 text-muted hover:bg-panel2 hover:text-fg"><Plus className="size-4" /></button>}
        </div>
        <Tree all={all} parentId={null} kind={kind} activeId={params.collectionId} depth={0} />
        {all.length === 0 && <p className="px-2 text-xs text-muted">None yet.</p>}
      </aside>
      <div className="min-w-0 flex-1">
        {params.collectionId
          ? <CollectionView id={params.collectionId} kind={kind} onNewChild={(parentId) => setCreating({ parentId })} />
          : <Overview kind={kind} all={all} canEdit={canEdit} onNew={() => setCreating({ parentId: null })} />}
      </div>
      {creating && <EditDialog kind={kind} parentId={creating.parentId} onClose={() => setCreating(null)} />}
    </div>
  );
}

function Tree({ all, parentId, kind, activeId, depth }: { all: CollectionRow[]; parentId: string | null; kind: Kind; activeId?: string; depth: number }) {
  const nodes = all.filter((c) => c.parentId === parentId);
  if (!nodes.length) return null;
  return (
    <ul className="space-y-0.5">
      {nodes.map((c) => {
        const active = c.id === activeId;
        const hasKids = all.some((x) => x.parentId === c.id);
        return (
          <li key={c.id}>
            <Link to={kind === "catalog" ? "/catalogs/$collectionId" : "/projects/$collectionId"} params={{ collectionId: c.id }}
              className={cx("flex items-center gap-2 rounded-md py-1.5 pr-2 text-sm", active ? "bg-accent/12 font-medium text-accent" : "text-muted hover:bg-panel2 hover:text-fg")}
              style={{ paddingLeft: 8 + depth * 14 }}>
              {active || hasKids ? <FolderOpen className="size-4 shrink-0" style={{ color: c.color }} /> : <Folder className="size-4 shrink-0" style={{ color: c.color }} />}
              <span className="truncate">{c.name}</span>
              <span className="ml-auto text-xs tabular-nums opacity-70">{c.itemCount || ""}</span>
            </Link>
            <Tree all={all} parentId={c.id} kind={kind} activeId={activeId} depth={depth + 1} />
          </li>
        );
      })}
    </ul>
  );
}

function Overview({ kind, all, canEdit, onNew }: { kind: Kind; all: CollectionRow[]; canEdit: boolean; onNew: () => void }) {
  const w = words(kind);
  const top = all.filter((c) => !c.parentId);
  const [statusFilter, setStatusFilter] = useState<"" | Status>("");
  const shown = kind === "project" && statusFilter ? top.filter((c) => c.status === statusFilter) : top;
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{w.many}</h1>
          <p className="text-sm text-muted">{kind === "catalog"
            ? "Folders of parts you reuse: screws, washers, bought-in parts… A part can be in any number of catalogs; it's always a link, never a copy."
            : "Your projects: the parts they use, plus notes and any other files (manuals, receipts, photos)."}</p>
        </div>
        <div className="flex gap-2">
          {kind === "project" && (
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as Status | "")}>
              <option value="">All statuses</option>
              {Object.entries(STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
            </Select>
          )}
          {canEdit && <Button variant="primary" onClick={onNew}><Plus className="size-4" />New {w.one}</Button>}
        </div>
      </div>
      {shown.length === 0
        ? <Empty icon={kind === "catalog" ? <Library className="size-10" /> : <FolderKanban className="size-10" />} title={`No ${w.many.toLowerCase()} yet`}>
            {canEdit ? `Create one, then add parts to it from here or from a part's page.` : "Nobody has created one yet."}
          </Empty>
        : <FolderCards kind={kind} folders={shown.map((c) => ({ ...c, extra: kind === "project" ? `${c.docCount} notes · ${c.fileCount} files` : undefined }))} />}
    </div>
  );
}

function FolderCards({ kind, folders }: { kind: Kind; folders: { id: string; name: string; color: string; description: string; itemCount: number; status?: Status | null; extra?: string }[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
      {folders.map((c) => (
        <Link key={c.id} to={kind === "catalog" ? "/catalogs/$collectionId" : "/projects/$collectionId"} params={{ collectionId: c.id }}
          className="group rounded-lg border border-line bg-panel p-4 transition hover:border-accent/60 hover:shadow-md">
          <div className="flex items-center gap-2">
            <Folder className="size-5 shrink-0" style={{ color: c.color }} fill={c.color + "33"} />
            <span className="truncate font-medium group-hover:text-accent">{c.name}</span>
            {c.status && <span className="ml-auto"><StateChip state={{ name: STATUS[c.status].label, color: STATUS[c.status].color }} /></span>}
          </div>
          {c.description && <p className="mt-1.5 line-clamp-2 text-sm text-muted">{c.description}</p>}
          <p className="mt-2 text-xs text-muted">{c.itemCount} part{c.itemCount === 1 ? "" : "s"}{c.extra ? ` · ${c.extra}` : ""}</p>
        </Link>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ one catalog / project

function CollectionView({ id, kind, onNewChild }: { id: string; kind: Kind; onNewChild: (parentId: string) => void }) {
  const q = useQuery({ queryKey: ["collection", id], queryFn: () => get<Detail>(`collections/${id}`) });
  const [tab, setTab] = useState<"parts" | "notes" | "files">("parts");
  const [dialog, setDialog] = useState<null | "edit" | "delete" | "add">(null);
  const qc = useQueryClient();
  const nav = useNavigate();
  const w = words(kind);
  useEffect(() => setTab("parts"), [id]);
  if (q.error) return <ErrorText error={q.error} />;
  if (!q.data) return <div className="flex justify-center py-20"><Spinner /></div>;
  const d = q.data;
  const c = d.collection;
  const refresh = () => { qc.invalidateQueries({ queryKey: ["collection", id] }); qc.invalidateQueries({ queryKey: ["collections", kind] }); };
  const base = kind === "catalog" ? "/catalogs" : "/projects";

  return (
    <div>
      <nav className="mb-1 flex flex-wrap items-center gap-1 text-xs text-muted">
        <Link to={base as never} className="hover:text-fg">{w.many}</Link>
        {d.path.map((p) => <span key={p.id} className="flex items-center gap-1"><ChevronRight className="size-3" />
          <Link to={`${base}/$collectionId` as never} params={{ collectionId: p.id } as never} className="hover:text-fg">{p.name}</Link></span>)}
      </nav>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <FolderOpen className="size-6" style={{ color: c.color }} />
            <h1 className="text-2xl font-semibold">{c.name}</h1>
            {c.status && <StateChip state={{ name: STATUS[c.status].label, color: STATUS[c.status].color }} />}
          </div>
          {c.description && <p className="mt-1 max-w-2xl text-sm whitespace-pre-line text-muted">{c.description}</p>}
        </div>
        {d.canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => setDialog("add")}><Plus className="size-4" />Add parts</Button>
            <Button onClick={() => onNewChild(c.id)}><FolderPlus className="size-4" />New {w.sub}</Button>
            <Button onClick={() => setDialog("edit")}><Pencil className="size-4" />Edit</Button>
            <Button onClick={() => setDialog("delete")}><Trash2 className="size-4" /></Button>
          </div>
        )}
      </div>

      {d.children.length > 0 && <div className="mb-6"><FolderCards kind={kind} folders={d.children} /></div>}

      {kind === "project" && (
        <div className="mb-4">
          <Tabs value={tab} onChange={setTab} tabs={[
            { id: "parts", label: <span className="flex items-center gap-1.5"><Boxes className="size-4" />Parts ({d.items.length})</span> },
            { id: "notes", label: <span className="flex items-center gap-1.5"><FileText className="size-4" />Notes ({d.docs?.length ?? 0})</span> },
            { id: "files", label: <span className="flex items-center gap-1.5"><Paperclip className="size-4" />Files ({d.files?.length ?? 0})</span> },
          ]} />
        </div>
      )}

      {tab === "parts" && <LinkedItems d={d} onChanged={refresh} onAdd={() => setDialog("add")} />}
      {tab === "notes" && kind === "project" && <Notes project={d} onChanged={refresh} />}
      {tab === "files" && kind === "project" && <Files project={d} onChanged={refresh} />}

      {dialog === "edit" && <EditDialog kind={kind} existing={c} onClose={() => setDialog(null)} />}
      {dialog === "add" && <AddItemsDialog collection={c} onClose={() => setDialog(null)} onDone={refresh} />}
      <Dialog open={dialog === "delete"} onClose={() => setDialog(null)} title={`Delete ${c.name}?`}>
        <p className="text-sm">This deletes the {w.one}{d.children.length ? ` and its ${d.children.length} ${w.sub}${d.children.length === 1 ? "" : "s"}` : ""}
          {kind === "project" ? ", with its notes and attached files" : ""}. <b>The parts themselves are not touched</b>: they stay in their vaults and in any other {w.many.toLowerCase()}.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setDialog(null)}>Keep</Button>
          <Button variant="danger" onClick={async () => {
            try { await del(`collections/${c.id}`); toast(`${c.name} deleted`); qc.invalidateQueries({ queryKey: ["collections", kind] }); nav({ to: (c.parentId ? `${base}/$collectionId` : base) as never, params: (c.parentId ? { collectionId: c.parentId } : {}) as never }); }
            catch (e) { toast((e as Error).message, "error"); }
          }}>Delete</Button>
        </div>
      </Dialog>
    </div>
  );
}

function LinkedItems({ d, onChanged, onAdd }: { d: Detail; onChanged: () => void; onAdd: () => void }) {
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<LinkedItem | null>(null);
  const items = d.items.filter((i) => !filter || `${i.number} ${i.description} ${i.note}`.toLowerCase().includes(filter.toLowerCase()));
  if (!d.items.length) return (
    <Empty icon={<Box className="size-10" />} title="No parts here yet">
      {d.canEdit ? <div className="space-y-3"><p>Parts are linked, never copied: the same part can be in many {d.collection.kind === "catalog" ? "catalogs" : "projects"}.</p><Button variant="primary" onClick={onAdd}><Plus className="size-4" />Add parts</Button></div> : null}
      {d.hiddenItems > 0 && <p className="mt-2 text-xs">{d.hiddenItems} part(s) are in vaults you can't see.</p>}
    </Empty>
  );
  const remove = async (i: LinkedItem) => {
    try { await del(`collections/${d.collection.id}/items/${i.id}`); toast(`${i.number} removed (the part itself is kept)`); onChanged(); }
    catch (e) { toast((e as Error).message, "error"); }
  };
  return (
    <div>
      {d.items.length > 8 && <div className="relative mb-3 max-w-xs"><Search className="absolute top-2.5 left-2.5 size-4 text-muted" /><Input className="pl-8" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(210px,1fr))] sm:gap-4">
        {items.map((i) => (
          <div key={i.id} className="group relative overflow-hidden rounded-lg border border-line bg-panel transition hover:border-accent/60 hover:shadow-md">
            <Link to="/items/$itemId" params={{ itemId: i.id }}>
              <div className="relative">
                <Thumb fileId={i.thumbId} className="aspect-[4/3] w-full" />
                <div className="absolute top-2 left-2 rounded-full bg-panel"><StateChip state={{ name: i.stateName, color: i.stateColor }} /></div>
                {i.quantity != null && <div className="absolute right-2 bottom-2 rounded-full bg-panel px-2 py-0.5 text-xs font-semibold">× {i.quantity}</div>}
              </div>
              <div className="space-y-0.5 border-t border-line p-3">
                <div className="flex items-center gap-1.5">
                  <span className="mono font-semibold group-hover:text-accent">{i.number}</span>
                  <TypeChip type={i.type} />
                </div>
                <p className="truncate text-sm">{i.description}</p>
                <p className="truncate text-xs text-muted">{i.note || i.vaultName}</p>
              </div>
            </Link>
            {d.canEdit && (
              <div className="absolute top-2 right-2 flex gap-1 md:hidden md:group-hover:flex">
                <button title="Note and quantity" onClick={() => setEditing(i)} className="rounded-full bg-panel p-1.5 shadow hover:text-accent"><Pencil className="size-3.5" /></button>
                <button title="Remove from here (keeps the part)" onClick={() => remove(i)} className="rounded-full bg-panel p-1.5 shadow hover:text-danger"><X className="size-3.5" /></button>
              </div>
            )}
          </div>
        ))}
      </div>
      {d.hiddenItems > 0 && <p className="mt-3 text-xs text-muted">{d.hiddenItems} more part(s) are in vaults you can't see.</p>}
      {editing && <LinkEditDialog collectionId={d.collection.id} item={editing} onClose={() => setEditing(null)} onDone={onChanged} />}
    </div>
  );
}

export function TypeChip({ type }: { type: "part" | "assembly" }) {
  return type === "assembly"
    ? <span title="Assembly: it contains other parts" className="ml-auto flex items-center gap-1 rounded bg-accent/12 px-1.5 py-0.5 text-[11px] font-medium text-accent"><Boxes className="size-3" />Assembly</span>
    : <span title="Part" className="ml-auto flex items-center gap-1 rounded bg-panel2 px-1.5 py-0.5 text-[11px] text-muted"><Box className="size-3" />Part</span>;
}

function LinkEditDialog({ collectionId, item, onClose, onDone }: { collectionId: string; item: LinkedItem; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState(item.note);
  const [qty, setQty] = useState(item.quantity?.toString() ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onClose={onClose} title={`${item.number} - ${item.description}`}>
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true);
        try { await patch(`collections/${collectionId}/items/${item.id}`, { note, quantity: qty.trim() === "" ? null : Number(qty) }); onDone(); onClose(); }
        catch (err) { toast((err as Error).message, "error"); } finally { setBusy(false); }
      }}>
        <Field label="Note" hint="Only here: e.g. “stainless”, “order from Würth”."><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
        <Field label="Quantity" hint="Optional: how many this project needs, or how many you have."><Input type="number" min={0} value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy}>Save</Button></div>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ dialogs

function EditDialog({ kind, parentId, existing, onClose }: { kind: Kind; parentId?: string | null; existing?: CollectionRow; onClose: () => void }) {
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [color, setColor] = useState(existing?.color ?? COLORS[kind === "catalog" ? 0 : 1]!);
  const [status, setStatus] = useState<Status>(existing?.status ?? "active");
  const [parent, setParent] = useState<string>(existing ? existing.parentId ?? "" : parentId ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const list = useCollections(kind);
  const qc = useQueryClient();
  const nav = useNavigate();
  const w = words(kind);
  // can't move a folder into itself or below it
  const blocked = useMemo(() => {
    const out = new Set<string>();
    if (!existing || !list.data) return out;
    const walk = (id: string) => { out.add(id); for (const c of list.data.collections) if (c.parentId === id) walk(c.id); };
    walk(existing.id);
    return out;
  }, [existing, list.data]);

  return (
    <Dialog open onClose={onClose} title={existing ? `Edit ${existing.name}` : parentId ? `New ${w.sub}` : `New ${w.one}`}>
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        const body = { name, description, color, parentId: parent || null, ...(kind === "project" ? { status } : {}) };
        try {
          const r = existing ? await patch(`collections/${existing.id}`, body) : await post<CollectionRow>("collections", { kind, ...body });
          qc.invalidateQueries({ queryKey: ["collections", kind] });
          qc.invalidateQueries({ queryKey: ["collection", r.id] });
          if (!existing) nav({ to: (kind === "catalog" ? "/catalogs/$collectionId" : "/projects/$collectionId") as never, params: { collectionId: r.id } as never });
          onClose();
        } catch (x) { setErr(x); } finally { setBusy(false); }
      }}>
        <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "catalog" ? "e.g. Screws" : "e.g. Garden shed"} required maxLength={80} /></Field>
        <Field label="Description"><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} /></Field>
        {kind === "project" && (
          <Field label="Status"><Select className="w-full" value={status} onChange={(e) => setStatus(e.target.value as Status)}>
            {Object.entries(STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
          </Select></Field>
        )}
        <Field label={`Inside`}><Select className="w-full" value={parent} onChange={(e) => setParent(e.target.value)}>
          <option value="">— top level —</option>
          {list.data?.collections.filter((c) => !blocked.has(c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select></Field>
        <Field label="Colour"><div className="flex gap-2">{COLORS.map((c) => (
          <button type="button" key={c} onClick={() => setColor(c)} className={cx("size-7 rounded-full border-2", color === c ? "border-fg" : "border-transparent")} style={{ background: c }} aria-label={c} />
        ))}</div></Field>
        {err != null && <ErrorText error={err} />}
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy}>{existing ? "Save" : "Create"}</Button></div>
      </form>
    </Dialog>
  );
}

type SearchHit = { id: string; number: string; description: string; vaultName: string };

function AddItemsDialog({ collection, onClose, onDone }: { collection: CollectionRow; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Map<string, SearchHit>>(new Map());
  const [busy, setBusy] = useState(false);
  const hits = useQuery({ queryKey: ["search", q], queryFn: () => get<SearchHit[]>(`search?q=${encodeURIComponent(q)}`), enabled: q.trim().length > 0 });
  const toggle = (h: SearchHit) => { const m = new Map(picked); if (m.has(h.id)) m.delete(h.id); else m.set(h.id, h); setPicked(m); };
  return (
    <Dialog open onClose={onClose} title={`Add parts to ${collection.name}`} wide>
      <div className="space-y-3">
        <div className="relative"><Search className="absolute top-2.5 left-2.5 size-4 text-muted" />
          <Input autoFocus className="pl-8" placeholder="Search by number or description, in all your vaults…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="max-h-80 overflow-y-auto rounded-md border border-line">
          {!q && <p className="p-3 text-sm text-muted">Type to search. Tick as many parts as you like.</p>}
          {q && hits.data?.length === 0 && <p className="p-3 text-sm text-muted">No matches.</p>}
          {hits.data?.map((h) => (
            <label key={h.id} className="flex cursor-pointer items-center gap-3 border-b border-line px-3 py-2 text-sm last:border-0 hover:bg-panel2">
              <input type="checkbox" checked={picked.has(h.id)} onChange={() => toggle(h)} />
              <span className="mono font-medium">{h.number}</span><span className="truncate">{h.description}</span><span className="ml-auto text-xs text-muted">{h.vaultName}</span>
            </label>
          ))}
        </div>
        {picked.size > 0 && <div className="flex flex-wrap gap-1">{[...picked.values()].map((h) => <Chip key={h.id}>{h.number}<button onClick={() => toggle(h)}><X className="size-3" /></button></Chip>)}</div>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!picked.size} onClick={async () => {
            setBusy(true);
            try {
              const r = await post<{ added: number; alreadyThere: number }>(`collections/${collection.id}/items`, { itemIds: [...picked.keys()] });
              toast(`${r.added} added${r.alreadyThere ? `, ${r.alreadyThere} already there` : ""}`);
              onDone(); onClose();
            } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
          }}>Add {picked.size || ""}</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** On an item's page: which catalogs and projects it's in, and a button to add it to more. */
export function ItemCollections({ itemId }: { itemId: string }) {
  const q = useQuery({ queryKey: ["item-collections", itemId], queryFn: () => get<{ id: string; kind: Kind; name: string; color: string }[]>(`items/${itemId}/collections`) });
  const [open, setOpen] = useState(false);
  const list = q.data ?? [];
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {list.map((c) => (
          <Link key={c.id} to={(c.kind === "catalog" ? "/catalogs/$collectionId" : "/projects/$collectionId") as never} params={{ collectionId: c.id } as never}
            className="flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs hover:border-accent hover:text-accent">
            {c.kind === "catalog" ? <Library className="size-3" style={{ color: c.color }} /> : <FolderKanban className="size-3" style={{ color: c.color }} />}{c.name}
          </Link>
        ))}
        <button onClick={() => setOpen(true)} className="flex items-center gap-1 rounded-full border border-dashed border-line px-2 py-0.5 text-xs text-muted hover:border-accent hover:text-accent"><Plus className="size-3" />Add to…</button>
      </div>
      {open && <AddToDialog itemId={itemId} current={new Set(list.map((c) => c.id))} onClose={() => setOpen(false)} onDone={() => q.refetch()} />}
    </div>
  );
}

function AddToDialog({ itemId, current, onClose, onDone }: { itemId: string; current: Set<string>; onClose: () => void; onDone: () => void }) {
  const cats = useCollections("catalog");
  const projs = useCollections("project");
  const [busy, setBusy] = useState<string | null>(null);
  const qc = useQueryClient();
  const add = async (c: CollectionRow) => {
    setBusy(c.id);
    try { await post(`collections/${c.id}/items`, { itemIds: [itemId] }); toast(`Added to ${c.name}`); onDone(); qc.invalidateQueries({ queryKey: ["collection", c.id] }); qc.invalidateQueries({ queryKey: ["collections"] }); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); }
  };
  const section = (title: string, data: { collections: CollectionRow[] } | undefined, icon: ReactNode) => (
    <div>
      <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">{icon}{title}</h3>
      {!data ? <Spinner /> : data.collections.length === 0 ? <p className="text-xs text-muted">None yet.</p> : (
        <div className="max-h-56 overflow-y-auto rounded-md border border-line">
          {pathSorted(data.collections).map(({ c, depth }) => (
            <div key={c.id} className="flex items-center gap-2 border-b border-line px-2 py-1.5 text-sm last:border-0" style={{ paddingLeft: 8 + depth * 14 }}>
              <Folder className="size-4" style={{ color: c.color }} /><span className="truncate">{c.name}</span>
              {current.has(c.id) ? <span className="ml-auto text-xs text-muted">already in</span>
                : <Button size="sm" className="ml-auto" busy={busy === c.id} onClick={() => add(c)}>Add</Button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
  return (
    <Dialog open onClose={onClose} title="Add to a catalog or project">
      <div className="space-y-4">
        {section("Catalogs", cats.data, <Library className="size-4" />)}
        {section("Projects", projs.data, <FolderKanban className="size-4" />)}
        <div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>
      </div>
    </Dialog>
  );
}

function pathSorted(all: CollectionRow[]) {
  const out: { c: CollectionRow; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const c of all.filter((x) => x.parentId === parent).sort((a, b) => a.name.localeCompare(b.name))) { out.push({ c, depth }); walk(c.id, depth + 1); }
  };
  walk(null, 0);
  return out;
}

// ------------------------------------------------------------------ project notes

marked.setOptions({ gfm: true, breaks: true });
const renderMd = (md: string) => DOMPurify.sanitize(marked.parse(md, { async: false }) as string);

function Notes({ project, onChanged }: { project: Detail; onChanged: () => void }) {
  const docs = project.docs ?? [];
  const [activeId, setActiveId] = useState<string | null>(docs[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!activeId && docs[0]) setActiveId(docs[0].id); }, [docs, activeId]);
  const create = async () => {
    setBusy(true);
    try { const d = await post<Doc>(`collections/${project.collection.id}/docs`, { title: "Untitled note", body: "" }); onChanged(); setActiveId(d.id); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  };
  if (!docs.length) return (
    <Empty icon={<FileText className="size-10" />} title="No notes yet">
      {project.canEdit ? <div className="space-y-3"><p>Plans, measurements, shopping lists, instructions… written in Markdown.</p><Button variant="primary" busy={busy} onClick={create}><Plus className="size-4" />New note</Button></div> : null}
    </Empty>
  );
  return (
    <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
      <div className="space-y-1">
        {docs.map((d) => (
          <button key={d.id} onClick={() => setActiveId(d.id)} className={cx("block w-full rounded-md px-3 py-2 text-left text-sm", d.id === activeId ? "bg-accent/12 font-medium text-accent" : "hover:bg-panel2")}>
            <span className="block truncate">{d.title}</span><span className="text-xs text-muted">{fmtAgo(d.updatedAt)}{d.updatedBy ? ` · ${d.updatedBy}` : ""}</span>
          </button>
        ))}
        {project.canEdit && <Button className="w-full" busy={busy} onClick={create}><Plus className="size-4" />New note</Button>}
      </div>
      {activeId && <NoteEditor key={activeId} id={activeId} canEdit={project.canEdit} onChanged={onChanged} onDeleted={() => { setActiveId(null); onChanged(); }} />}
    </div>
  );
}

function NoteEditor({ id, canEdit, onChanged, onDeleted }: { id: string; canEdit: boolean; onChanged: () => void; onDeleted: () => void }) {
  const q = useQuery({ queryKey: ["doc", id], queryFn: () => get<Doc>(`docs/${id}`) });
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [busy, setBusy] = useState(false);
  const loaded = useRef(false);
  useEffect(() => {
    if (q.data && !loaded.current) { loaded.current = true; setTitle(q.data.title); setBody(q.data.body ?? ""); if (!q.data.body && canEdit) setMode("edit"); }
  }, [q.data, canEdit]);
  const dirty = !!q.data && (title !== q.data.title || body !== (q.data.body ?? ""));
  const save = async () => {
    setBusy(true);
    try { await patch(`docs/${id}`, { title: title.trim() || "Untitled note", body }); await q.refetch(); onChanged(); toast("Note saved"); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === "s" && mode === "edit") { e.preventDefault(); if (dirty) void save(); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });
  if (q.error) return <ErrorText error={q.error} />;
  if (!q.data) return <Spinner />;
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2">
        {mode === "edit" ? <Input value={title} onChange={(e) => setTitle(e.target.value)} className="text-base font-semibold" maxLength={120} />
          : <h2 className="flex-1 truncate text-lg font-semibold">{title}</h2>}
        {canEdit && <>
          <Button size="sm" onClick={() => setMode(mode === "edit" ? "view" : "edit")}>{mode === "edit" ? <><Eye className="size-3.5" />Preview</> : <><Pencil className="size-3.5" />Edit</>}</Button>
          {mode === "edit" && <Button size="sm" variant="primary" busy={busy} disabled={!dirty} onClick={save}><Save className="size-3.5" />Save</Button>}
          <Button size="sm" title="Delete note" onClick={async () => { if (!confirm(`Delete “${title}”?`)) return; await del(`docs/${id}`); onDeleted(); }}><Trash2 className="size-3.5" /></Button>
        </>}
      </div>
      {mode === "edit"
        ? <Textarea rows={18} value={body} onChange={(e) => setBody(e.target.value)} className="mono text-[13px]" placeholder={"# Plan\n\n- [ ] Buy timber\n- **Measurements**: 2400 × 1800 mm\n\nMarkdown works: headings, lists, links, tables."} />
        : body.trim() ? <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMd(body) }} /> : <p className="text-sm text-muted">Empty note.</p>}
      {mode === "edit" && <p className="mt-2 text-xs text-muted">{dirty ? "Unsaved changes · Ctrl+S to save" : "Saved"}</p>}
    </Card>
  );
}

// ------------------------------------------------------------------ project files

function Files({ project, onChanged }: { project: Detail; onChanged: () => void }) {
  const files = project.files ?? [];
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const upload = async (list: FileList | File[]) => {
    const arr = [...list];
    if (!arr.length) return;
    setBusy(true);
    try {
      const fd = new FormData();
      for (const f of arr) fd.append("file", f, f.name);
      await api("POST", `collections/${project.collection.id}/files`, fd);
      toast(`${arr.length} file${arr.length === 1 ? "" : "s"} uploaded`);
      onChanged();
    } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      {project.canEdit && (
        <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); void upload(e.dataTransfer.files); }}
          className={cx("flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-sm text-muted transition", drag ? "border-accent bg-accent/5" : "border-line")}>
          <Upload className="size-6" />
          <p>Drop files here: manuals, receipts, photos, drawings, anything.</p>
          <Button busy={busy} onClick={() => input.current?.click()}>Choose files…</Button>
          <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ""; }} />
        </div>
      )}
      {files.length === 0 ? <p className="text-sm text-muted">No files yet.</p> : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs text-muted"><tr><th className="w-14 p-2"></th><th className="p-2">Name</th><th className="p-2">Note</th><th className="hidden p-2 sm:table-cell">Size</th><th className="hidden p-2 sm:table-cell">Added</th><th className="p-2"></th></tr></thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.id} className="border-b border-line last:border-0 hover:bg-panel2">
                  <td className="p-1.5">{f.mime.startsWith("image/") ? <img src={`/api/project-files/${f.id}`} alt="" className="h-10 w-12 rounded object-cover" loading="lazy" />
                    : <div className="flex h-10 w-12 items-center justify-center rounded bg-panel2"><Paperclip className="size-4 text-muted" /></div>}</td>
                  <td className="p-2"><a href={`/api/project-files/${f.id}`} target="_blank" rel="noreferrer" className="font-medium hover:text-accent">{f.name}</a></td>
                  <td className="p-2 text-muted"><FileNote file={f} canEdit={project.canEdit} onChanged={onChanged} /></td>
                  <td className="hidden p-2 text-xs whitespace-nowrap text-muted sm:table-cell">{fmtSize(f.size)}</td>
                  <td className="hidden p-2 text-xs whitespace-nowrap text-muted sm:table-cell">{fmtAgo(f.createdAt)}{f.uploadedBy ? ` · ${f.uploadedBy}` : ""}</td>
                  <td className="p-2 text-right whitespace-nowrap">
                    <a href={`/api/project-files/${f.id}?download=1`} title="Download" className="inline-flex rounded p-1.5 text-muted hover:bg-panel hover:text-fg"><Download className="size-4" /></a>
                    {project.canEdit && <button title="Delete" onClick={async () => { if (!confirm(`Delete ${f.name}?`)) return; await del(`project-files/${f.id}`); onChanged(); }} className="rounded p-1.5 text-muted hover:bg-panel hover:text-danger"><Trash2 className="size-4" /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function FileNote({ file, canEdit, onChanged }: { file: PFile; canEdit: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(file.note);
  if (!canEdit) return <>{file.note}</>;
  if (!editing) return <button onClick={() => setEditing(true)} className="text-left hover:text-fg">{file.note || <span className="text-xs whitespace-nowrap opacity-60">add a note</span>}</button>;
  return (
    <form onSubmit={async (e) => { e.preventDefault(); await patch(`project-files/${file.id}`, { note }); setEditing(false); onChanged(); }}>
      <Input autoFocus value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => setEditing(false)} className="h-7" maxLength={500} />
    </form>
  );
}
