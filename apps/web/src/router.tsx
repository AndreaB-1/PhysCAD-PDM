import { createRootRoute, createRoute, createRouter, Navigate, Outlet } from "@tanstack/react-router";
import { Database } from "lucide-react";
import { AppLayout } from "./components/Layout";
import { Empty, Spinner, Button } from "./components/ui";
import { DevicePage, EnrollPage, LoginPage, SetupPage } from "./pages/Auth";
import { CheckoutsPage, ItemsPage } from "./pages/Items";
import { ItemPage } from "./pages/Item";
import { PublicSharePage, SharesPage } from "./pages/Shares";
import { AccountPage } from "./pages/Account";
import { AuditPage, SettingsPage, UsersPage, VaultSettingsPage, VaultsPage } from "./pages/Admin";
import { useMe, useVaults } from "./session";
import { Toaster } from "./toast";
import { Link } from "@tanstack/react-router";

const root = createRootRoute({ component: () => <><Outlet /><Toaster /></> });

function Home() {
  const vaults = useVaults();
  const me = useMe();
  if (!vaults.data) return <Spinner />;
  const stored = (() => { try { return localStorage.getItem("vault"); } catch { return null; } })();
  const v = vaults.data.find((x) => x.id === stored) ?? vaults.data[0];
  if (v) return <Navigate to="/v/$vaultId" params={{ vaultId: v.id }} replace />;
  return (
    <Empty icon={<Database className="size-12" />} title="No vaults yet">
      {me.data?.user?.isAdmin ? <div className="space-y-3"><p>A vault is a folder on the NAS where parts and their files live. Create one to start.</p><Link to="/admin/vaults"><Button variant="primary">Create a vault</Button></Link></div>
        : "Ask an administrator to give you access to a vault."}
    </Empty>
  );
}

const app = createRoute({ getParentRoute: () => root, id: "app", component: AppLayout });
const routes = [
  createRoute({ getParentRoute: () => root, path: "/login", component: LoginPage }),
  createRoute({ getParentRoute: () => root, path: "/setup", component: SetupPage }),
  createRoute({ getParentRoute: () => root, path: "/enroll", component: EnrollPage }),
  createRoute({ getParentRoute: () => root, path: "/device", component: DevicePage }),
  createRoute({ getParentRoute: () => root, path: "/s/$token", component: PublicSharePage }),
  app.addChildren([
    createRoute({ getParentRoute: () => app, path: "/", component: Home }),
    createRoute({ getParentRoute: () => app, path: "/v/$vaultId", component: ItemsPage }),
    createRoute({ getParentRoute: () => app, path: "/items/$itemId", component: ItemPage }),
    createRoute({ getParentRoute: () => app, path: "/checkouts", component: CheckoutsPage }),
    createRoute({ getParentRoute: () => app, path: "/shares", component: SharesPage }),
    createRoute({ getParentRoute: () => app, path: "/account", component: AccountPage }),
    createRoute({ getParentRoute: () => app, path: "/admin/users", component: UsersPage }),
    createRoute({ getParentRoute: () => app, path: "/admin/vaults", component: VaultsPage }),
    createRoute({ getParentRoute: () => app, path: "/admin/vaults/$vaultId", component: VaultSettingsPage }),
    createRoute({ getParentRoute: () => app, path: "/admin/audit", component: AuditPage }),
    createRoute({ getParentRoute: () => app, path: "/admin/settings", component: SettingsPage }),
  ]),
];

export const router = createRouter({ routeTree: root.addChildren(routes), defaultPreload: "intent" });
declare module "@tanstack/react-router" { interface Register { router: typeof router } }
