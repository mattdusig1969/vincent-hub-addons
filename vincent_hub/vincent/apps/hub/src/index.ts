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
 *   POST /api/setup                  first-time only: owner name + admin PIN -> this device's key
 *   POST /api/pair                   {pin, name} -> a key for another phone or tablet
 *   POST /api/unlock | /api/lock     {pin} opens settings on this device for ten minutes
 *   POST /api/devices/:id/add|rooms  {rooms, newRooms} choose it / say which rooms it is in (several allowed)
 *   POST /api/home                   {name, theme, newRooms} the home's name, look and first rooms
 *   POST /api/rooms, /api/rooms/:id/rename|delete|photo      rooms and their photos (photo = a JPEG body)
 *   GET  /api/rooms/:id/photo
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
import { THEMES, type HubStatus, type SetupRequest } from "../../../packages/core/src/index.ts";

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

// The app is not always served from here (the iPhone app carries its own copy), so any origin may ask,
// but only a paired phone or tablet gets an answer.
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };

/** Settings (adding, ignoring, removing, rooms) need the admin PIN. A correct PIN opens them on that device for a while. */
const UNLOCK_MS = 10 * 60_000;
const unlocked = new Map<string, number>();
const isUnlocked = (key: string) => (unlocked.get(key) ?? 0) > Date.now();

/** Wrong PINs: after five in a row, a minute's wait for everyone. */
let misses = 0, lockedUntil = 0;
function pinOk(pin: unknown): "ok" | "wrong" | "wait" {
  if (Date.now() < lockedUntil) return "wait";
  if (store.checkPin(String(pin ?? ""))) { misses = 0; return "ok"; }
  if (++misses >= 5) { misses = 0; lockedUntil = Date.now() + 60_000; }
  return "wrong";
}
const pinRefusal = (res: ServerResponse, r: "wrong" | "wait") =>
  json(res, 403, r === "wait" ? { code: "wait", error: "Too many wrong PINs. Try again in a minute." } : { code: "wrong", error: "That is not the PIN." });

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

async function raw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error("That is too large."); parts.push(chunk as Buffer); }
  return Buffer.concat(parts);
}

async function body(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) throw new Error("request too large"); }
  return raw ? JSON.parse(raw) : {};
}

async function api(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const m = req.method ?? "GET";

  if (m === "GET" && path === "/api/status") {
    const s: HubStatus = { connected: ha.connected, version: ha.version, homeName: store.homeName || ha.homeName, reviewed: store.reviewed, setUp: store.setUp, owner: store.owner };
    return json(res, 200, s);
  }
  if (m === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }

  // First-time setup: the owner, the PIN, and the first paired device (the one doing the setup).
  if (m === "POST" && path === "/api/setup") {
    if (store.setUp) return json(res, 409, { error: "This hub is already set up." });
    const b = (await body(req)) as SetupRequest;
    if (!b.owner?.trim() || !/^\d{4,8}$/.test(b.pin ?? "")) return json(res, 400, { error: "A name and a PIN of 4 to 8 digits are needed." });
    store.setup(b.owner.trim(), b.pin, b.ha);
    const key = store.pair(`${b.owner.trim()}'s device`);
    unlocked.set(key, Date.now() + UNLOCK_MS); // the first device review follows at once
    return json(res, 200, { ok: true, key });
  }
  // Another phone or tablet joins the home with the PIN.
  if (m === "POST" && path === "/api/pair") {
    const b = await body(req);
    const r = pinOk(b.pin);
    if (r !== "ok") return pinRefusal(res, r);
    return json(res, 200, { ok: true, key: store.pair(String(b.name ?? "").trim().slice(0, 40) || "A device") });
  }

  // Everything below is for paired devices only. (An event stream cannot send a header, so the key may ride in the address.)
  const key = (req.headers.authorization ?? "").replace(/^Bearer /, "") || new URL(req.url ?? "/", "http://hub").searchParams.get("k") || "";
  if (!store.paired(key)) return json(res, 401, { code: "pair", error: "This device has not joined this home." });

  if (m === "GET" && path === "/api/events") {
    res.writeHead(200, { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write("event: hello\ndata: 1\n\n");
    streams.add(res);
    const beat = setInterval(() => res.write(": beat\n\n"), 20000);
    req.on("close", () => { clearInterval(beat); streams.delete(res); });
    return;
  }
  if (m === "POST" && path === "/api/unlock") {
    const r = pinOk((await body(req)).pin);
    if (r !== "ok") return pinRefusal(res, r);
    unlocked.set(key, Date.now() + UNLOCK_MS);
    return json(res, 200, { ok: true });
  }
  if (m === "POST" && path === "/api/lock") { unlocked.delete(key); return json(res, 200, { ok: true }); }
  if (!ha.connected) return json(res, 503, { error: "The hub is starting. Try again in a moment." });

  // Everyday use: no PIN.
  if (m === "GET" && path === "/api/devices")
    return json(res, 200, { devices: await devices.all(), rooms: store.rooms(), theme: store.theme, unlocked: isUnlocked(key) });
  if (m === "POST" && path === "/api/control") { await devices.control(await body(req)); return json(res, 200, { ok: true }); }
  const photo = /^\/api\/rooms\/([a-f0-9]+)\/photo$/.exec(path);
  if (m === "GET" && photo) {
    const file = store.photoFile(photo[1]);
    if (!existsSync(file)) return json(res, 404, { error: "no photo" });
    res.writeHead(200, { ...CORS, "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" });
    res.end(await readFile(file));
    return;
  }

  // Settings: the PIN first.
  if (m !== "POST") return json(res, 404, { error: "not found" });
  if (!isUnlocked(key)) return json(res, 403, { code: "pin", error: "The admin PIN is needed for that." });
  const done = () => { changed(); return json(res, 200, { ok: true }); };
  /** Room ids for a list of room ids and/or new room names. */
  const roomIds = (b: any): string[] => [
    ...(Array.isArray(b.rooms) ? b.rooms.map(String) : []),
    ...(Array.isArray(b.newRooms) ? b.newRooms.map(String).filter((n: string) => n.trim()).map((n: string) => store.room(n)) : []),
  ];

  if (path === "/api/reviewed") { store.setReviewed(); return done(); }
  if (path === "/api/home") {
    const b = await body(req);
    if (typeof b.name === "string" && b.name.trim()) store.setHomeName(b.name);
    if (typeof b.theme === "string" && THEMES.some((t) => t.id === b.theme)) store.setTheme(b.theme);
    roomIds(b); // rooms named during home setup
    return done();
  }
  if (path === "/api/rooms") { const b = await body(req); const id = store.room(String(b.name ?? "")); changed(); return json(res, 200, { ok: true, id }); }
  const room = /^\/api\/rooms\/([a-f0-9]+)\/(rename|delete|photo)$/.exec(path);
  if (room) {
    if (room[2] === "delete") store.deleteRoom(room[1]);
    else if (room[2] === "rename") store.renameRoom(room[1], String((await body(req)).name ?? ""));
    else {
      const jpeg = await raw(req, 4_000_000);
      if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return json(res, 400, { error: "That is not a photo." });
      if (!store.setPhoto(room[1], jpeg)) return json(res, 404, { error: "That room is gone." });
    }
    return done();
  }
  const act = /^\/api\/devices\/([^/]+)\/(add|ignore|restore|rooms)$/.exec(path);
  if (act) {
    const id = decodeURIComponent(act[1]);
    if (act[2] === "add") { const r = await devices.add(id, roomIds(await body(req))); changed(); return json(res, 200, r); }
    if (act[2] === "rooms") { await devices.setRooms(id, roomIds(await body(req))); return done(); }
    await devices.setStatus(id, act[2] === "ignore" ? "ignored" : "found");
    return done();
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

// On the hub this process is stopped with a plain signal; leave at once.
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(0));
