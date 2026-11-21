/**
 * The Vincent hub service: the app's only door into the home.
 *
 *   GET  /api/status                 is the hub up, has the household reviewed devices
 *   GET  /api/devices                everything found, with Vincent's found/added/ignored status
 *   POST /api/devices/:id/add        the household chose it
 *   POST /api/devices/:id/ignore     hide it from "Add a device"
 *   POST /api/devices/:id/restore    back to found (un-add or un-ignore)
 *   POST /api/reviewed               the first device review is done
 *   POST /api/control                {id, action, value} for an added device
 *   POST /api/setup                  first-time only: owner name + admin PIN
 *   POST /api/pin                    {pin} -> is it the admin PIN
 *   GET  /api/events                 server-sent "changed" whenever the app should re-read
 *
 * Serves the built app too, when apps/app/dist exists.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname, join, normalize } from "node:path";
import { HA } from "./ha.ts";
import { Devices } from "./devices.ts";
import { store } from "./store.ts";
import type { HubStatus, SetupRequest } from "../../../packages/core/src/index.ts";

const PORT = Number(process.env.VINCENT_HUB_PORT ?? 8870);
const ha = new HA();
const devices = new Devices(ha);

// Push: one debounced "changed" to every open app.
const streams = new Set<ServerResponse>();
let pending: NodeJS.Timeout | undefined;
const changed = () => {
  if (pending) return;
  pending = setTimeout(() => { pending = undefined; for (const s of streams) s.write("event: changed\ndata: 1\n\n"); }, 150);
};
ha.onChange = (entityId) => {
  if (entityId === "") { devices.invalidate(); changed(); }
  else if (devices.shown(entityId)) changed();
};
ha.start();

// The app is not always served from here (the iPhone app carries its own copy), so any origin may ask.
// TODO before real homes: a per-device pairing token; today anything on the home Wi-Fi can call this.
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

async function body(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) throw new Error("request too large"); }
  return raw ? JSON.parse(raw) : {};
}

async function api(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const m = req.method ?? "GET";

  if (m === "GET" && path === "/api/status") {
    const s: HubStatus = { connected: ha.connected, version: ha.version, homeName: ha.homeName, reviewed: store.reviewed, setUp: store.setUp, owner: store.owner };
    return json(res, 200, s);
  }
  if (m === "GET" && path === "/api/events") {
    res.writeHead(200, { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write("event: hello\ndata: 1\n\n");
    streams.add(res);
    const beat = setInterval(() => res.write(": beat\n\n"), 20000);
    req.on("close", () => { clearInterval(beat); streams.delete(res); });
    return;
  }
  if (m === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
  if (m === "POST" && path === "/api/setup") {
    if (store.setUp) return json(res, 409, { error: "This hub is already set up." });
    const b = (await body(req)) as SetupRequest;
    if (!b.owner?.trim() || !/^\d{4,8}$/.test(b.pin ?? "")) return json(res, 400, { error: "A name and a PIN of 4 to 8 digits are needed." });
    store.setup(b.owner.trim(), b.pin, b.ha);
    return json(res, 200, { ok: true });
  }
  if (m === "POST" && path === "/api/pin") return json(res, 200, { ok: store.checkPin(String((await body(req)).pin ?? "")) });
  if (!ha.connected) return json(res, 503, { error: "The hub is starting. Try again in a moment." });

  if (m === "GET" && path === "/api/devices") return json(res, 200, { devices: await devices.all() });
  if (m === "POST" && path === "/api/reviewed") { store.setReviewed(); return json(res, 200, { ok: true }); }
  if (m === "POST" && path === "/api/control") { await devices.control(await body(req)); return json(res, 200, { ok: true }); }

  const act = /^\/api\/devices\/([^/]+)\/(add|ignore|restore)$/.exec(path);
  if (m === "POST" && act) {
    const id = decodeURIComponent(act[1]);
    if (act[2] === "add") { const r = await devices.add(id); changed(); return json(res, 200, r); }
    await devices.setStatus(id, act[2] === "ignore" ? "ignored" : "found");
    changed();
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: "not found" });
}

const dist = fileURLToPath(new URL("../../app/dist", import.meta.url));
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".json": "application/json" };

async function page(res: ServerResponse, path: string): Promise<void> {
  if (!existsSync(dist)) { res.writeHead(404); res.end("The app has not been built (npm run build)."); return; }
  const wanted = normalize(join(dist, path));
  const file = wanted.startsWith(dist) && extname(wanted) && existsSync(wanted) ? wanted : join(dist, "index.html");
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(await readFile(file));
}

createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://hub").pathname;
  const run = path.startsWith("/api/") ? api(req, res, path) : page(res, path);
  run.catch((e: Error) => {
    console.log(`[api] ${req.method} ${path} failed: ${e.message}`);
    if (!res.headersSent) json(res, 400, { error: e.message });
  });
}).listen(PORT, () => console.log(`[hub] Vincent hub service on :${PORT}`));
