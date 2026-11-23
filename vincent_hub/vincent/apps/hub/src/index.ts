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
 *   POST /api/pin                    {pin, newPin} change the admin PIN
 *   POST /api/unlock | /api/lock     {pin} opens settings on this device for ten minutes
 *   POST /api/devices/:id/add|rooms  {rooms, newRooms} choose it / say which rooms it is in (several allowed)
 *   POST /api/home                   {name, theme, style, character, voice, newRooms, zip, timeZone, contact} the home's name, look, first rooms, where it is, how to reach the owner
 *   POST /api/rooms, /api/rooms/order, /api/rooms/:id/rename|delete|photo      rooms and their photos (photo = a JPEG body)
 *   GET  /api/rooms/:id/photo
 *   GET  /api/media/:id/sources      a player's favourites, playlists and inputs
 *   POST /api/media/:id/play         {kind, id} play one of them
 *   POST /api/media/:id/group        {members} the players that play together with this one
 *   GET  /api/media/:id/siriusxm     the SiriusXM channel guide
 *   GET  /api/spotify                is Spotify connected; POST /api/spotify/link starts the one-time sign-in
 *   GET  /api/spotify/browse?id=     Spotify's own lists; /api/spotify/search?q=
 *   GET  /api/radio?q=|tag=          internet radio stations
 *   GET  /api/thumb/:token           the picture of something to play (only ones the hub listed)
 *   GET  /api/art/:id                cover art of what a player is playing
 *   GET  /api/software               the hub software's version; POST /api/software/update brings the newest
 *   GET  /api/lists/:id              a list's items; POST {op: add|done|reopen|remove|clear, text, item}; POST /api/lists {name} makes one
 *   GET  /api/brands                 brands that can be added by name
 *   POST /api/adding {brand, rooms}  start adding one -> a Step; POST /api/adding/:flow/answer|poll|cancel
 *   POST /api/matter {code}          add a device by its Matter code
 *   POST /api/place {items}          several devices at once: add each to its rooms, or leave it out
 *   GET  /api/events                 server-sent "changed" whenever the app should re-read
 *
 * Serves the built app too, when apps/app/dist exists.
 */
import "./log.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { extname, join, normalize } from "node:path";
import { HA } from "./ha.ts";
import { Devices } from "./devices.ts";
import { Media, radio, thumb } from "./media.ts";
import { Place } from "./place.ts";
import { Lists } from "./lists.ts";
import { Portraits, pictureType } from "./portraits.ts";
import { dir as dataDir } from "./store.ts";
import { Flows } from "./flows.ts";
import { brandList } from "./brands.ts";
import { erase, erasePreview, report } from "./upkeep.ts";
import { store } from "./store.ts";
import { THEMES, STYLES, HOME_STYLE, FONTS, CHARACTERS, VOICE_LANGUAGES, defaultVoice, outfitOf, type HubStatus, type SetupRequest, type Software } from "../../../packages/core/src/index.ts";

const PORT = Number(process.env.VINCENT_HUB_PORT ?? 8870);
const ha = new HA();
const devices = new Devices(ha);
const media = new Media(ha, devices);
const place = new Place(ha);
const lists = new Lists(ha);
const portraits = new Portraits(dataDir, fileURLToPath(new URL("../../app/dist", import.meta.url)), () => changed());
const flows = new Flows(ha, devices);
// A found device with nothing to ask is answered with a plain yes; anything more goes to the app as a question.
devices.steps = async (flowId, handler, rooms) => {
  const first = await flows.startFound(flowId, handler, rooms);
  return first.kind === "form" && first.flow && !first.fields.some((f) => f.required) && first.fields.length === 0 ? flows.answer(first.flow, {}) : first;
};

/** On the hub, Vincent runs as an add-on and can ask the hub's supervisor about its own software. */
async function supervisor(method: string, path: string, timeout = 20_000): Promise<any> {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) throw new Error("not on a hub");
  const r = await fetch(`http://supervisor${path}`, { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeout) });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok || j.result === "error") throw new Error(j.message ?? `the hub answered ${r.status}`);
  return j.data ?? {};
}
/** How the last "add by Matter code" went. */
let matter: { state: "idle" | "working" | "done" | "failed"; message: string; brought?: string[] } = { state: "idle", message: "" };

/** Why a Matter code did not work, in plain words. */
function matterWhy(m: string): string {
  if (/No commissionable device/i.test(m)) return "No device answered that code. It must be switched on and on your Wi-Fi, and the code freshly made in its maker's app (codes last a few minutes).";
  if (/unknown command|not loaded|not found/i.test(m)) return "Matter is not ready on this hub yet.";
  if (/timeout|did not answer/i.test(m)) return "The device did not answer. It must be switched on, on your Wi-Fi, and its code freshly made in the maker's app.";
  return "That code was not accepted. Codes last only a few minutes: make a new one in the maker's app and try again.";
}
async function software(): Promise<Software> {
  try {
    const info = await supervisor("GET", "/addons/self/info");
    return { version: info.version ?? "", latest: info.version_latest ?? info.version ?? "", canUpdate: !!info.update_available };
  } catch { return { version: "", latest: "", canUpdate: false }; }
}

// Push: one debounced "changed" to every open app.
const streams = new Set<ServerResponse>();
let pending: NodeJS.Timeout | undefined;
const changed = () => {
  if (pending) return;
  pending = setTimeout(() => { pending = undefined; for (const s of streams) s.write("event: changed\ndata: 1\n\n"); }, 150);
};
// Every home starts with three lists. Made once, after setup, when the hub is reachable.
const STARTER_LISTS = ["Shopping", "To Do", "Recipes"];
let seeding = false;
setInterval(() => {
  if (seeding || store.listsSeeded || !store.setUp || !ha.connected) return;
  seeding = true;
  lists.seed(STARTER_LISTS).then(() => { store.setListsSeeded(); devices.invalidate(); }).catch(() => {}).finally(() => { seeding = false; });
}, 5000);

ha.onChange = (entityId) => {
  if (entityId === "") { devices.invalidate(); changed(); }
  else if (devices.shown(entityId) || place.shows(entityId) || lists.shows(entityId)) changed();
};
place.onDays = () => changed();
ha.start();

// The app is not always served from here (the iPhone app carries its own copy), so any origin may ask,
// but only a paired phone or tablet gets an answer.
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };

/** Settings (adding, ignoring, removing, rooms) need the admin PIN. A correct PIN opens them on that device for a while. */
const UNLOCK_MS = 10 * 60_000;
/**
 * Which devices have settings open, and until when. Kept on disk as well, so an update or a
 * restart of the hub service does not ask for the PIN again; using settings keeps them open.
 */
const unlockFile = join(dataDir, "unlocked.json");
const unlockId = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 24);
const unlockTimes = new Map<string, number>();
try { for (const [k, t] of Object.entries(JSON.parse(readFileSync(unlockFile, "utf8")) as Record<string, number>)) if (t > Date.now()) unlockTimes.set(k, t); } catch { /* none kept */ }
const keepUnlocks = () => { try { writeFileSync(unlockFile, JSON.stringify(Object.fromEntries([...unlockTimes].filter(([, t]) => t > Date.now())))); } catch { /* next time */ } };
const unlocked = {
  get: (key: string) => unlockTimes.get(unlockId(key)),
  set: (key: string, until: number) => { unlockTimes.set(unlockId(key), until); keepUnlocks(); },
  delete: (key: string) => { unlockTimes.delete(unlockId(key)); keepUnlocks(); },
};
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
  // A new PIN needs the current one, even on a device whose settings are open.
  if (m === "POST" && path === "/api/pin") {
    const b = await body(req);
    const r = pinOk(b.pin);
    if (r !== "ok") return pinRefusal(res, r);
    if (!/^\d{4,8}$/.test(String(b.newPin ?? ""))) return json(res, 400, { error: "A PIN is 4 to 8 digits." });
    store.setPin(String(b.newPin));
    return json(res, 200, { ok: true });
  }
  if (m === "POST" && path === "/api/lock") { unlocked.delete(key); return json(res, 200, { ok: true }); }
  // A report is most needed when something is broken, so it does not wait for the hub to be well.
  if (m === "POST" && path === "/api/report") {
    const b = await body(req);
    const text = await report({ ha, devices, media, lists, supervisor, picture: () => portraits.status(), matter, note: String(b.note ?? ""), app: b.app ?? null });
    console.log("[hub] a report was made");
    return json(res, 200, { text });
  }
  if (!ha.connected) return json(res, 503, { error: "The hub is starting. Try again in a moment." });

  // Erasing the home always asks for the PIN itself, even on a device whose settings are open.
  if (m === "POST" && path === "/api/erase") {
    const r = pinOk((await body(req)).pin);
    if (r !== "ok") return pinRefusal(res, r);
    const left = await erase(ha, media);
    unlockTimes.clear();
    json(res, 200, { ok: true, left });
    changed();
    // Start again with nothing remembered: on a hub its supervisor restarts this service; a development copy just stops.
    setTimeout(() => { supervisor("POST", "/addons/self/restart").catch(() => process.exit(0)); }, 800);
    return;
  }

  // Everyday use: no PIN.
  if (m === "GET" && path === "/api/devices")
    return json(res, 200, {
      devices: await devices.all(), rooms: store.rooms(), theme: store.theme, style: store.style, custom: store.custom, rotate: store.rotate, character: store.character, voices: Object.fromEntries(CHARACTERS.map((c) => { const v = store.voices[c.id]; return [c.id, v && c.voices.some((x) => x.id === v.voice) ? v : defaultVoice(c.id)]; })), unlocked: isUnlocked(key),
      weather: place.weather(), lists: lists.all(), place: { zip: store.place?.zip ?? "", place: store.place?.place ?? "", timeZone: store.place?.timeZone ?? "", contact: isUnlocked(key) ? store.contact : "" },
    });
  if (m === "POST" && path === "/api/control") { await devices.control(await body(req)); return json(res, 200, { ok: true }); }
  const med = /^\/api\/media\/([^/]+)\/(sources|play|siriusxm|group)$/.exec(path);
  if (med && m === "POST" && med[2] === "group") { await media.group(med[1], (await body(req)).members); return json(res, 200, { ok: true }); }
  if (med && m === "GET" && med[2] === "siriusxm") return json(res, 200, { groups: await media.siriusxm(med[1]) });
  if (med && m === "GET" && med[2] === "sources") return json(res, 200, await media.sources(med[1]));
  if (med && m === "POST" && med[2] === "play") { await media.play(med[1], await body(req)); return json(res, 200, { ok: true }); }
  const li = /^\/api\/lists\/([a-f0-9]+)$/.exec(path);
  if (li && m === "GET") return json(res, 200, await lists.items(li[1]));
  if (li && m === "POST") { await lists.change(li[1], await body(req)); changed(); return json(res, 200, { ok: true }); }
  if (m === "POST" && path === "/api/lists") { await lists.create(String((await body(req)).name ?? "")); devices.invalidate(); changed(); return json(res, 200, { ok: true }); }
  if (m === "GET" && path === "/api/spotify") return json(res, 200, await media.spotifyStatus());
  if (m === "GET" && path === "/api/spotify/browse") return json(res, 200, { items: await media.spotifyBrowse((new URL(req.url ?? "/", "http://hub").searchParams.get("id") ?? "").slice(0, 300)) });
  if (m === "GET" && path === "/api/spotify/search") {
    const q = (new URL(req.url ?? "/", "http://hub").searchParams.get("q") ?? "").trim().slice(0, 80);
    return json(res, 200, { groups: q.length < 2 ? [] : await media.spotifySearch(q) });
  }
  if (m === "GET" && path === "/api/radio") {
    const q = new URL(req.url ?? "/", "http://hub").searchParams;
    return json(res, 200, { stations: await radio((q.get("q") ?? "").trim().slice(0, 60), (q.get("tag") ?? "").trim().slice(0, 40)) });
  }
  const art = /^\/api\/art\/([^/]+)$/.exec(path);
  if (m === "GET" && art) {
    const pic = await media.art(art[1]).catch(() => null);
    if (!pic) return json(res, 404, { error: "no picture" });
    res.writeHead(200, { ...CORS, "Content-Type": pic.type, "Cache-Control": "private, max-age=86400" });
    res.end(pic.data);
    return;
  }
  const th = /^\/api\/thumb\/([a-f0-9]+)$/.exec(path);
  if (m === "GET" && th) {
    const pic = await thumb(th[1]);
    if (!pic) return json(res, 404, { error: "no picture" });
    res.writeHead(200, { ...CORS, "Content-Type": pic.type, "Cache-Control": "private, max-age=604800" });
    res.end(pic.data);
    return;
  }
  if (m === "GET" && path === "/api/matter") return json(res, 200, matter);
  if (m === "GET" && path === "/api/portraits") return json(res, 200, portraits.status());
  const pic = /^\/api\/portraits\/(photo\/)?([a-z0-9]+)$/.exec(path);
  if (m === "GET" && pic) {
    const file = pic[1] ? portraits.photoFile(pic[2]) : portraits.file(pic[2]);
    if (!existsSync(file)) return json(res, 404, { error: "no picture" });
    const data = await readFile(file);
    res.writeHead(200, { ...CORS, "Content-Type": pictureType(data), "Cache-Control": "private, max-age=31536000, immutable" });
    res.end(data);
    return;
  }
  if (m === "GET" && path === "/api/brands") return json(res, 200, { brands: brandList() });
  if (m === "GET" && path === "/api/software") return json(res, 200, await software());
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
  // Still working in settings: the ten minutes start again, at most once a minute on disk.
  if ((unlocked.get(key) ?? 0) - Date.now() < UNLOCK_MS - 60_000) unlocked.set(key, Date.now() + UNLOCK_MS);
  const done = () => { changed(); return json(res, 200, { ok: true }); };
  /** Room ids for a list of room ids and/or new room names. */
  const roomIds = (b: any): string[] => [
    ...(Array.isArray(b.rooms) ? b.rooms.map(String) : []),
    ...(Array.isArray(b.newRooms) ? b.newRooms.map(String).filter((n: string) => n.trim()).map((n: string) => store.room(n)) : []),
  ];

  if (path === "/api/erase/preview") return json(res, 200, await erasePreview(ha, devices, lists));
  if (path === "/api/software/update") {
    await supervisor("POST", "/store/reload", 60_000).catch(() => {});
    const info = await supervisor("GET", "/addons/self/info");
    if (!info.update_available) return json(res, 200, { ok: false, message: "Your hub already has the newest Vincent." });
    // The hub does not let its own software replace itself, so Home Assistant is asked to do it.
    const entity = [...ha.states.values()].find((x) => x.entity_id.startsWith("update.") && x.attributes?.title === info.name)?.entity_id;
    if (!entity) return json(res, 200, { ok: false, message: "The hub could not find Vincent's update. Try again in a few minutes." });
    await ha.service("homeassistant", "update_entity", entity).catch(() => {});
    json(res, 200, { ok: true, message: "Updating. Vincent will be back in a minute or two." });
    // The update stops this service and starts the new one; nothing after this line is certain to run.
    ha.service("update", "install", entity).catch((e: Error) => console.log(`[hub] update failed: ${e.message}`));
    return;
  }
  // Adding by brand, and answering what a maker asks.
  if (path === "/api/adding") { const b = await body(req); const step = await flows.startBrand(String(b.brand ?? ""), roomIds(b)); changed(); return json(res, 200, step); }
  const adding = /^\/api\/adding\/([A-Za-z0-9]+)\/(answer|poll|cancel)$/.exec(path);
  if (adding) {
    if (adding[2] === "cancel") { await flows.cancel(adding[1]); return done(); }
    const step = adding[2] === "poll" ? await flows.poll(adding[1]) : await flows.answer(adding[1], (await body(req)).values ?? {});
    if (step.kind === "done") changed();
    return json(res, 200, step);
  }
  if (path === "/api/matter") {
    const code = String((await body(req)).code ?? "").replace(/[\s-]/g, "");
    if (!/^(\d{11}|\d{21}|MT:[A-Z0-9.\-]+)$/i.test(code)) return json(res, 200, { state: "failed", message: "A Matter code is 11 or 21 digits, or the text of its QR code starting with MT:." });
    if (matter.state === "working") return json(res, 200, matter);
    // Looking for the device can take a few minutes, so the app is answered at once and asks how it went.
    matter = { state: "working", message: "Looking for the device. This can take a couple of minutes." };
    const before = new Set(await devices.ids());
    ha.call({ type: "matter/commission", code, network_only: true }, 240_000)
      .then(async () => {
        // What the code brought: whatever is on the hub now that was not there before.
        const brought = await devices.settle(async () => (await devices.ids()).filter((id) => !before.has(id)), 20_000);
        matter = { state: "done", message: brought.length ? "Your hub has it." : "Your hub has it. It appears under Add a device in a moment.", brought };
      })
      .catch((e: Error) => { matter = { state: "failed", message: matterWhy(e.message) }; })
      .finally(changed);
    return json(res, 200, matter);
  }
  if (path === "/api/portraits/photos") {
    const jpeg = await raw(req, 4_000_000);
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return json(res, 400, { error: "That is not a photo." });
    portraits.addPhoto(jpeg);
    return done();
  }
  const pdel = /^\/api\/portraits\/photo\/([a-z0-9]+)\/delete$/.exec(path);
  if (pdel) { portraits.removePhoto(pdel[1]); return done(); }
  if (path === "/api/portraits/generate") {
    const b = await body(req);
    const ids = Array.isArray(b.characters) && b.characters.length ? b.characters.map(String) : CHARACTERS.map((c) => c.id);
    portraits.start(ids, (id) => outfitOf(store.custom, id));
    return done();
  }
  const preset = /^\/api\/portraits\/([a-z]+)\/reset$/.exec(path);
  if (preset) { portraits.reset(preset[1]); return done(); }
  if (path === "/api/spotify/link") return json(res, 200, await media.spotifyLink(changed));
  if (path === "/api/spotify/forget") { await media.spotifyForget(); return done(); }
  if (path === "/api/reviewed") { store.setReviewed(); return done(); }
  if (path === "/api/home") {
    const b = await body(req);
    if (typeof b.name === "string" && b.name.trim()) store.setHomeName(b.name);
    if (typeof b.theme === "string" && THEMES.some((t) => t.id === b.theme)) store.setTheme(b.theme);
    if (typeof b.style === "string" && (STYLES.some((t) => t.id === b.style) || b.style === HOME_STYLE.id)) store.setStyle(b.style);
    if (b.custom && typeof b.custom === "object") {
      const font = FONTS.some((f) => f.id === b.custom.font) ? String(b.custom.font) : store.custom.font;
      const shape = STYLES.some((t) => t.id === b.custom.shape) ? String(b.custom.shape) : store.custom.shape;
      const outfits: Record<string, string> = { ...store.custom.outfits };
      if (b.custom.outfits && typeof b.custom.outfits === "object")
        for (const [who, look] of Object.entries(b.custom.outfits))
          if (CHARACTERS.some((c) => c.id === who) && STYLES.some((t) => t.id === look)) outfits[who] = String(look);
      store.setCustom({ font, shape, outfits });
    }
    if (typeof b.character === "string" && CHARACTERS.some((c) => c.id === b.character)) store.setCharacter(b.character);
    if (["off", "daily", "hourly"].includes(b.rotate)) store.setRotate(b.rotate);
    if (b.voice && typeof b.voice === "object") {
      const who = CHARACTERS.find((c) => c.id === b.voice.character);
      const locale = String(b.voice.locale ?? ""), voice = String(b.voice.voice ?? "");
      if (who && VOICE_LANGUAGES.some((l) => l.accents.some((a) => a.id === locale)) && who.voices.some((v) => v.id === voice)) store.setVoice(who.id, { locale, voice });
    }
    roomIds(b); // rooms named during home setup
    if (typeof b.contact === "string" && b.contact.trim()) store.setContact(b.contact);
    // The ZIP code last: it is the one part that can be refused, and the rest should stand either way.
    if (typeof b.zip === "string" && b.zip.trim()) {
      try { await place.set(b.zip, typeof b.timeZone === "string" ? b.timeZone : undefined); }
      catch (e) { changed(); return json(res, 200, { ok: false, message: (e as Error).message }); }
    }
    return done();
  }
  if (path === "/api/rooms") { const b = await body(req); const id = store.room(String(b.name ?? "")); changed(); return json(res, 200, { ok: true, id }); }
  if (path === "/api/rooms/order") { const b = await body(req); store.orderRooms(Array.isArray(b.ids) ? b.ids.map(String) : []); changed(); return json(res, 200, { ok: true }); }
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
  if (path === "/api/place") {
    const b = await body(req);
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 200).map((it: any) => ({ id: String(it.id ?? ""), add: !!it.add, rooms: it.add ? roomIds(it) : [] }));
    await devices.place(items);
    return done();
  }
  const act = /^\/api\/devices\/([^/]+)\/(add|ignore|restore|rooms|rename)$/.exec(path);
  if (act) {
    const id = decodeURIComponent(act[1]);
    if (act[2] === "add") { const r = await devices.add(id, roomIds(await body(req))); changed(); return json(res, 200, r); }
    if (act[2] === "rename") { await devices.rename(id, String((await body(req)).name ?? "")); return done(); }
    if (act[2] === "rooms") { await devices.setRooms(id, roomIds(await body(req))); return done(); }
    await devices.setStatus(id, act[2] === "ignore" ? "ignored" : "found");
    return done();
  }
  json(res, 404, { error: "not found" });
}

const dist = fileURLToPath(new URL("../../app/dist", import.meta.url));
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".json": "application/json", ".mp3": "audio/mpeg" };

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
