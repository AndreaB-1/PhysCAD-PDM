import { lazy, Suspense, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Link2, Lock } from "lucide-react";
import { del, fmtDate, fmtSize, get, post } from "../api";
import { Button, Card, Chip, Empty, ErrorText, Input, PageHeader, Spinner, StateChip } from "../components/ui";
import { useMe } from "../session";
import { toast, toastError } from "../toast";
import { AuthShell } from "./Auth";

const Viewer3D = lazy(() => import("../components/Viewer3D"));
const STATUS_COLOR: Record<string, string> = { active: "#10b981", expired: "#6b7280", revoked: "#ef4444", used_up: "#f59e0b" };

export function SharesPage() {
  const me = useMe();
  const [all, setAll] = useState(false);
  const qc = useQueryClient();
  const { data, error } = useQuery({ queryKey: ["shares", all], queryFn: () => get<any[]>(`shares${all ? "?all=1" : ""}`) });
  return (
    <div>
      <PageHeader title="Shared links" subtitle="Links for people outside the team. They see only what the link points at."
        actions={me.data?.user?.isAdmin && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />Everyone's links</label>} />
      <ErrorText error={error} />
      {!data ? <Spinner /> : !data.length ? <Empty icon={<Link2 className="size-10" />} title="No shared links">Create one with <b>Share</b> on an item's page.</Empty> : (
        <Card className="overflow-x-auto">
          <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-sm">
            <thead className="border-b border-line text-left text-xs text-muted"><tr><th className="p-2 pl-4">Item</th><th className="p-2">Points at</th><th className="p-2">Formats</th><th className="p-2">Downloads</th><th className="p-2">Expires</th><th className="p-2">Status</th>{all && <th className="p-2">By</th>}<th></th></tr></thead>
            <tbody>
              {data.map((s) => (
                <tr key={s.id} className="border-b border-line last:border-0">
                  <td className="p-2 pl-4"><Link to="/items/$itemId" params={{ itemId: s.itemId }} className="mono font-medium hover:text-accent">{s.number}</Link> <span className="text-muted">{s.description}</span>{s.note && <p className="text-xs text-muted">{s.note}</p>}</td>
                  <td className="p-2 text-xs">{s.target === "baseline" ? <span className="mono">{s.label}</span> : s.target === "revision" ? <>rev <span className="mono">{s.rev}</span> latest</> : "latest released"}</td>
                  <td className="p-2 text-xs">{s.formats.join(", ")}{s.password && <Lock className="ml-1 inline size-3" />}</td>
                  <td className="p-2">{s.downloads}{s.maxDownloads != null && ` / ${s.maxDownloads}`}</td>
                  <td className="p-2 text-xs text-muted">{s.expiresAt ? fmtDate(s.expiresAt) : "never"}</td>
                  <td className="p-2"><Chip color={STATUS_COLOR[s.status]}>{s.status.replace("_", " ")}</Chip></td>
                  {all && <td className="p-2 text-xs">{s.by}</td>}
                  <td className="p-2 pr-4 text-right">{s.status === "active" && <Button size="sm" variant="ghost" onClick={async () => { try { await del(`shares/${s.id}`); toast("Link revoked"); qc.invalidateQueries({ queryKey: ["shares"] }); } catch (e) { toastError(e); } }}>Revoke</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Card>
      )}
    </div>
  );
}

const KIND: Record<string, string> = { native: "PhysCAD (.physcad)", step: "STEP (.step)", stl: "STL (.stl)", glb: "glTF (.glb)", png: "Picture (.png)", "3mf": "3MF (.3mf)", pdf: "PDF drawing" };

export function PublicSharePage() {
  const { token } = useParams({ from: "/s/$token" });
  const [grant, setGrant] = useState<string>(() => { try { return sessionStorage.getItem(`g:${token}`) ?? ""; } catch { return ""; } });
  const q = useQuery({ queryKey: ["public", token, grant], queryFn: () => get(`/api/public/shares/${token}${grant ? `?g=${encodeURIComponent(grant)}` : ""}`), retry: false });
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [view, setView] = useState<"3d" | "pic">("3d");
  const g = grant ? `g=${encodeURIComponent(grant)}` : "";
  const f = (id: string, dl = false) => `/api/public/shares/${token}/files/${id}?${[g, dl ? "download=1" : ""].filter(Boolean).join("&")}`;
  if (q.error) return <AuthShell title="Link unavailable"><p className="text-sm text-muted">{(q.error as Error).message}</p></AuthShell>;
  if (!q.data) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  const d = q.data;
  if (d.needsPassword) return (
    <AuthShell title="Password required" subtitle="This shared link is protected.">
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault(); setErr(null);
        try { const r = await post(`/api/public/shares/${token}/unlock`, { password: pw }); try { sessionStorage.setItem(`g:${token}`, r.grant); } catch { /* */ } setGrant(r.grant); }
        catch (e) { setErr(e); }
      }}>
        <Input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
        <ErrorText error={err} />
        <Button variant="primary" className="w-full">Open</Button>
      </form>
    </AuthShell>
  );
  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <img src="/favicon.svg" className="size-8" alt="" />
        <div>
          <h1 className="text-xl font-semibold"><span className="mono">{d.number}</span> – {d.description}</h1>
          {d.baseline && <p className="flex items-center gap-2 text-sm text-muted">Revision <span className="mono">{d.baseline.rev}</span> · baseline <span className="mono">{d.baseline.label}</span> <StateChip state={d.baseline.state} /> · {fmtDate(d.baseline.date)}</p>}
        </div>
      </div>
      {!d.baseline ? <Card className="p-6"><Empty title="Nothing to show yet">The item has no released version.</Empty></Card> : (
        <div className="grid gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card className="overflow-hidden">
            {d.model && d.preview && <div className="flex gap-1 border-b border-line p-2 text-xs">
              <button onClick={() => setView("3d")} className={`rounded px-2 py-1 ${view === "3d" ? "bg-panel2 font-medium" : "text-muted"}`}>3D</button>
              <button onClick={() => setView("pic")} className={`rounded px-2 py-1 ${view === "pic" ? "bg-panel2 font-medium" : "text-muted"}`}>Picture</button>
            </div>}
            {d.model && view === "3d" ? <Suspense fallback={<div className="flex aspect-[4/3] items-center justify-center"><Spinner /></div>}><Viewer3D url={f(d.model)} /></Suspense>
              : null}
            {(!d.model || view === "pic") && (d.preview ? <img src={f(d.preview)} className="checker aspect-[4/3] w-full object-contain" alt="" /> : <div className="flex aspect-[4/3] items-center justify-center text-sm text-muted">No preview</div>)}
          </Card>
          <Card className="h-fit p-4">
            <h2 className="mb-3 font-semibold">Downloads</h2>
            {!d.files.length && <p className="text-sm text-muted">No files in the shared formats.</p>}
            <div className="space-y-2">
              {d.files.map((x: { id: string; kind: string; size: number }) => (
                <a key={x.id} href={f(x.id, true)} className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm hover:bg-panel2">
                  <Download className="size-4 text-accent" />{KIND[x.kind] ?? x.kind}<span className="ml-auto text-xs text-muted">{fmtSize(x.size)}</span>
                </a>
              ))}
            </div>
            <p className="mt-4 text-xs text-muted">{d.expiresAt ? `Link expires ${fmtDate(d.expiresAt)}.` : ""} {d.downloadsLeft != null ? `${d.downloadsLeft} download(s) left.` : ""}</p>
          </Card>
        </div>
      )}
    </div>
  );
}
