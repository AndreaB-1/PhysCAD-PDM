/**
 * Integration harness for the desktop agent's tests (apps/agent/tests).
 * Starts the real API on PORT with a fresh database, an admin signed in with 2FA and one vault,
 * then prints one JSON line: {"server", "vaultId", "control"}.
 * The control port has GET /approve?url=<verificationUriComplete>, which approves a device sign-in
 * as the admin — standing in for the person clicking "Approve" in the browser.
 *
 *   DATABASE_URL=postgres://…/plm_agent_it PORT=18090 npx tsx test/agent-it-server.ts
 */
import http from "node:http";
import { makeApp, signInAdmin } from "./helpers";

const port = Number(process.env.PORT ?? 18090);
const controlPort = Number(process.env.CONTROL_PORT ?? port + 1);

const { app } = await makeApp();
const { a } = await signInAdmin(app);
const vault = await a.json("POST", "/api/vaults", { name: "Agent IT", folder: "agent-it", prefix: "IT", digits: 4 });
await app.listen({ host: "127.0.0.1", port });

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/approve") {
      const code = new URL(u.searchParams.get("url") ?? "").searchParams.get("code") ?? "";
      await a.json("POST", "/api/device/approve", { code, approve: true });
      res.writeHead(200).end("ok");
      return;
    }
    res.writeHead(404).end();
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
}).listen(controlPort, "127.0.0.1");

console.log(JSON.stringify({ server: `http://127.0.0.1:${port}`, vaultId: vault.id, control: `http://127.0.0.1:${controlPort}` }));
