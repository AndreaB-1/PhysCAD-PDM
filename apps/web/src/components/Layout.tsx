import { Link, Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Box, ChevronDown, Clock, FileLock2, Link2, LogOut, Moon, Search, Settings, ShieldCheck, Sun, Users, Database, ScrollText, Star, User, Monitor, Library, FolderKanban, Menu, X } from "lucide-react";
import { get, post } from "../api";
import { useMe, useVaults } from "../session";
import { cx, Spinner } from "./ui";
import { useTheme } from "../theme";

function NavItem({ to, params, search, icon, children, active }: { to: string; params?: object; search?: object; icon: ReactNode; children: ReactNode; active?: boolean }) {
  return (
    <Link to={to as never} params={params as never} search={search as never}
      className={cx("flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm", active ? "bg-accent/12 font-medium text-accent" : "text-muted hover:bg-panel2 hover:text-fg")}>
      <span className="[&>svg]:size-4">{icon}</span>{children}
    </Link>
  );
}

function GlobalSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const ref = useRef<HTMLInputElement>(null);
  const { data } = useQuery({ queryKey: ["search", q], queryFn: () => get<{ id: string; number: string; description: string; vaultName: string }[]>(`search?q=${encodeURIComponent(q)}`), enabled: q.trim().length > 0 });
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === "k") { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  return (
    <div className="relative w-full max-w-md">
      <Search className="absolute top-2.5 left-2.5 size-4 text-muted" />
      <input ref={ref} value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => { if (e.key === "Enter" && data?.[0]) { nav({ to: "/items/$itemId", params: { itemId: data[0].id } }); setOpen(false); setQ(""); } }}
        placeholder="Search…" className="h-9 w-full rounded-md border border-line bg-panel2 pr-3 pl-8 text-sm outline-none focus:border-accent" />
      {open && q && data && (
        <div className="absolute top-10 z-30 w-[min(28rem,calc(100vw-1.5rem))] overflow-hidden rounded-md border border-line bg-panel shadow-xl">
          {data.length === 0 && <p className="px-3 py-2 text-sm text-muted">No matches</p>}
          {data.map((r) => (
            <button key={r.id} onMouseDown={() => { nav({ to: "/items/$itemId", params: { itemId: r.id } }); setQ(""); }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-panel2">
              <span className="mono font-medium">{r.number}</span><span className="truncate">{r.description}</span><span className="ml-auto text-xs text-muted">{r.vaultName}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function AppLayout() {
  const me = useMe();
  const nav = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const search = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });
  const vaults = useVaults(!!me.data?.user && me.data.mfaOk === true);
  const params = useParams({ strict: false }) as { vaultId?: string };
  const [theme, setTheme] = useTheme();
  const [menu, setMenu] = useState(false);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => setDrawer(false), [path, search]);

  useEffect(() => {
    if (!me.data) return;
    if (me.data.needsSetup) nav({ to: "/setup" });
    else if (!me.data.user) nav({ to: "/login", search: { next: path } as never });
    else if (me.data.next === "mfa") nav({ to: "/login" });
    else if (me.data.next === "enroll") nav({ to: "/enroll" });
  }, [me.data, nav, path]);

  if (!me.data?.user || me.data.next !== "done") return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  const user = me.data.user;
  const stored = (() => { try { return localStorage.getItem("vault"); } catch { return null; } })();
  const currentVault = vaults.data?.find((v) => v.id === params.vaultId) ?? vaults.data?.find((v) => v.id === stored) ?? vaults.data?.[0];
  const vaultBase = currentVault ? `/v/${currentVault.id}` : "";

  return (
    <div className="flex h-full">
      {drawer && <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setDrawer(false)} />}
      <aside className={cx("flex w-64 shrink-0 flex-col border-r border-line bg-panel lg:static lg:w-60 lg:translate-x-0",
        "fixed inset-y-0 left-0 z-50 transition-transform", drawer ? "translate-x-0 shadow-2xl" : "-translate-x-full")}>
        <div className="flex h-14 items-center gap-2 border-b border-line px-4">
          <img src="/favicon.svg" className="size-7" alt="" />
          <span className="font-semibold tracking-tight">PLM Lite</span>
          <button onClick={() => setDrawer(false)} className="ml-auto rounded p-1.5 text-muted hover:bg-panel2 lg:hidden" aria-label="Close menu"><X className="size-4" /></button>
        </div>
        <div className="p-3">
          <select value={currentVault?.id ?? ""} onChange={(e) => { try { localStorage.setItem("vault", e.target.value); } catch { /* */ } nav({ to: "/v/$vaultId", params: { vaultId: e.target.value } }); }}
            className="h-9 w-full rounded-md border border-line bg-panel2 px-2 text-sm font-medium">
            {!vaults.data?.length && <option value="">No vaults yet</option>}
            {vaults.data?.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3">
          {currentVault && <>
            <NavItem to="/v/$vaultId" params={{ vaultId: currentVault.id }} icon={<Box />} active={path === vaultBase && !search.filter}>All items</NavItem>
            <NavItem to="/v/$vaultId" params={{ vaultId: currentVault.id }} search={{ filter: "recent" }} icon={<Clock />} active={path === vaultBase && search.filter === "recent"}>Recent</NavItem>
            <NavItem to="/v/$vaultId" params={{ vaultId: currentVault.id }} search={{ filter: "released" }} icon={<Star />} active={path === vaultBase && search.filter === "released"}>Released</NavItem>
            <NavItem to="/v/$vaultId" params={{ vaultId: currentVault.id }} search={{ filter: "locked" }} icon={<FileLock2 />} active={path === vaultBase && search.filter === "locked"}>Checked out</NavItem>
          </>}
          <div className="pt-3 pb-1 pl-2.5 text-[11px] font-semibold tracking-wider text-muted uppercase">Organise</div>
          <NavItem to="/catalogs" icon={<Library />} active={path.startsWith("/catalogs")}>Catalogs</NavItem>
          <NavItem to="/projects" icon={<FolderKanban />} active={path.startsWith("/projects")}>Projects</NavItem>
          <div className="pt-3 pb-1 pl-2.5 text-[11px] font-semibold tracking-wider text-muted uppercase">You</div>
          <NavItem to="/checkouts" icon={<FileLock2 />} active={path === "/checkouts"}>My check-outs</NavItem>
          <NavItem to="/shares" icon={<Link2 />} active={path === "/shares"}>Shared links</NavItem>
          {user.isAdmin && <>
            <div className="pt-3 pb-1 pl-2.5 text-[11px] font-semibold tracking-wider text-muted uppercase">Admin</div>
            <NavItem to="/admin/users" icon={<Users />} active={path.startsWith("/admin/users")}>Users</NavItem>
            <NavItem to="/admin/vaults" icon={<Database />} active={path.startsWith("/admin/vaults")}>Vaults</NavItem>
            <NavItem to="/admin/audit" icon={<ScrollText />} active={path.startsWith("/admin/audit")}>Audit log</NavItem>
            <NavItem to="/admin/settings" icon={<Settings />} active={path.startsWith("/admin/settings")}>Settings</NavItem>
          </>}
        </nav>
        <div className="border-t border-line p-3 text-xs text-muted">v0.1.0</div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 sm:gap-3 sm:px-5">
          <button onClick={() => setDrawer(true)} className="rounded-md p-2 text-muted hover:bg-panel2 lg:hidden" aria-label="Menu"><Menu className="size-5" /></button>
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-1">
            <button title="Theme" onClick={() => setTheme(theme === "dark" ? "light" : theme === "light" ? "system" : "dark")} className="rounded-md p-2 text-muted hover:bg-panel2">
              {theme === "dark" ? <Moon className="size-4" /> : theme === "light" ? <Sun className="size-4" /> : <Monitor className="size-4" />}
            </button>
            <div className="relative">
              <button onClick={() => setMenu(!menu)} onBlur={() => setTimeout(() => setMenu(false), 150)} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-panel2">
                <span className="flex size-7 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-fg">{user.name.slice(0, 1).toUpperCase()}</span>
                <span className="hidden text-sm sm:inline">{user.name}</span><ChevronDown className="size-3.5 text-muted" />
              </button>
              {menu && (
                <div className="absolute right-0 z-30 mt-1 w-52 overflow-hidden rounded-md border border-line bg-panel py-1 shadow-xl">
                  <Link to="/account" className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-panel2"><User className="size-4" />Account &amp; security</Link>
                  <Link to="/account" hash="tokens" className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-panel2"><ShieldCheck className="size-4" />Access tokens</Link>
                  <button onMouseDown={async () => { await post("auth/logout"); location.href = "/login"; }} className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-panel2"><LogOut className="size-4" />Sign out</button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-6"><Outlet /></main>
      </div>
    </div>
  );
}
