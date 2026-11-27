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
 *   POST /api/scenes                 {id?, name, room, icon, steps} make or change a scene · /api/scenes/:id/delete
 *   POST /api/scenes/run             {id} or {steps} -> {done, failed, undo} · /api/scenes/undo {undo} puts it back
 *   POST /api/scenes/refuse          {key} a suggested scene the household does not want · /api/rooms/:id/kind {kind}
 *   POST /api/setup                  first-time only: owner name + admin PIN -> this device's key
 *   POST /api/pair                   {pin, name, person} -> a key for another phone or tablet
 *   GET  /api/changes                who changed what, newest first · GET /api/phones who has joined
 *   POST /api/phones/me              {name, person} what this device is called and who uses it · /api/phones/:id/remove (PIN)
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
 *   GET  /api/cameras/:id/still      a camera's newest picture; POST .../frame (a JPEG) gives it a newer one; GET /api/cameras/ages
 *   GET  /api/cameras/:id/live       what the player needs; POST {sdp} starts live view -> {session}
 *   GET  /api/cameras/live/:s/events the handshake's answers; POST .../candidate, .../stop
 *   GET  /api/software               the hub software's version; POST /api/software/update brings the newest
 *   GET  /api/lists/:id              a list's items; POST {op: add|done|reopen|remove|clear, text, item}; POST /api/lists {name} makes one
 *   GET  /api/brands                 brands that can be added by name
 *   GET  /api/seen                   makers with devices on the network that are not added yet
 *   POST /api/adding {brand, rooms}  start adding one -> a Step; POST /api/adding/:flow/answer|poll|cancel
 *   POST /api/matter {code}          add a device by its Matter code
 *   POST /api/place {items}          several devices at once: add each to its rooms, or leave it out
 *   POST /api/nowplaying             {kind, token, activity} an iPhone's Lock Screen card; GET how it is going
 *   GET  /api/events                 server-sent "changed" whenever the app should re-read
 *   GET  /api/intercom/listen?room=  this screen's line for announcements and calls; POST /api/intercom/announce, /call, /call/:id/answer|signal|end; GET /api/intercom/clip/:id
 *
 * Serves the built app too, when apps/app/dist exists.
 */
import "./log.ts";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { extname, join, normalize } from "node:path";
import { HA } from "./ha.ts";
import { Devices } from "./devices.ts";
import { Media, radio, thumb } from "./media.ts";
import { Cameras } from "./cameras.ts";
import { Intercom } from "./intercom.ts";
import { HouseLine } from "./houseline.ts";
import { Talk, TalkRefusal, type TalkDeps } from "./talk.ts";
import { Place } from "./place.ts";
import { Lists } from "./lists.ts";
import { Apple } from "./apple.ts";
import { Portraits, pictureType } from "./portraits.ts";
import { dir as dataDir } from "./store.ts";
import { Flows } from "./flows.ts";
import { Echo, ECHO_DRIVER } from "./echo.ts";
import { brandList } from "./brands.ts";
import { Network } from "./network.ts";
import { erase, erasePreview, report } from "./upkeep.ts";
import { MatterKeeper } from "./matter.ts";
import { changes } from "./changes.ts";
import { Scenes, cleanSteps, cleanWhen, isRoomKind, sceneIcon } from "./scenes.ts";
import { store } from "./store.ts";
import { NowPlaying } from "./nowplaying.ts";
import { Backup } from "./backup.ts";
import type { Device, Repeat, Scene } from "../../../packages/core/src/index.ts";
import { dayKey, whenDue, whenWords, everythingOff, cleanSays, RULES, ruleFor, controlWords, CLIMATE_MODES, type SunTimes } from "../../../packages/core/src/index.ts";
import { THEMES, CUSTOM_THEME, cleanPalette, STYLES, HOME_STYLE, FONTS, CHARACTERS, VOICE_LANGUAGES, defaultVoice, outfitOf, type HubStatus, type SetupRequest, type Software } from "../../../packages/core/src/index.ts";

const PORT = Number(process.env.VINCENT_HUB_PORT ?? 8870);
const ha = new HA();
const devices = new Devices(ha);
const media = new Media(ha, devices);
const cameras = new Cameras(ha, devices, dataDir);
const scenes = new Scenes(devices, media);
/** The home's scenes as they stand now: Everything off is worked out from the devices in the home this minute. */
/** The home's own Everything off: changing it used to freeze it, so things added afterwards were left on. It is the home's own again. */
const isOffScene = (x: Scene) => x.auto === "off" || (x.id === "everything-off" && !x.room);
/** Its steps this minute: every light, speaker and TV in the home, less what the household took out, plus anything they set differently or added. */
const offSteps = (x: Scene, all: Device[]) => { const out = new Set(x.except ?? []), own = x.auto === "off" ? x.steps : []; return [...everythingOff(all).filter((a) => !out.has(a.id) && !own.some((o) => o.id === a.id)), ...own]; };
const scenesNow = async (): Promise<Scene[]> => { const list = store.scenes(); if (!list.some(isOffScene)) return list; const all = await devices.all(); return list.map((x) => (isOffScene(x) ? { ...x, auto: "off" as const, steps: offSteps(x, all) } : x)); };
const intercom = new Intercom((id) => store.rooms().find((r) => r.id === id)?.name ?? "");
new HouseLine(intercom, () => store.rooms()); // one home only; off unless given that house's address
const place = new Place(ha);
const lists = new Lists(ha);
// "Now playing" on each iPhone's Lock Screen.
const nowPlaying = new NowPlaying(async () => ({ devices: await devices.all(), rooms: store.rooms(), phones: store.phones().map((p) => p.id) }));
const apple = new Apple(lists);
const repeatOf = (v: unknown): Repeat => (["day", "weekdays", "week", "month", "year"].includes(String(v)) ? (String(v) as Repeat) : "");
const portraits = new Portraits(dataDir, fileURLToPath(new URL("../../app/dist", import.meta.url)), () => changed());
const flows = new Flows(ha, devices);
const network = new Network(ha);
devices.makerAt = (ip) => network.makerAt(ip);
// Echo speakers need a part the hub fetches once; and Amazon's sign-in page is shown from Home Assistant's own address.
const echo = new Echo(ha, (method, path, data, timeout) => supervisor(method, path, timeout ?? 60_000, data));
flows.preparers[ECHO_DRIVER] = echo;
// Amazon's sign-in page is asked for at the hub's own address (see `amazon` below), the one this phone already reaches it by.
flows.haUrl = async (host) => `http://${host}`;
flows.hostsFor = async (driver) => (driver === "webostv" ? network.lgTvs() : []);
flows.hostAnswers = async (driver, host) => (driver === "webostv" ? network.lgAt(host) : true);
// A found device with nothing to ask is answered with a plain yes; anything more goes to the app as a question.
devices.steps = async (flowId, handler, rooms) => {
  const first = await flows.startFound(flowId, handler, rooms);
  return first.kind === "form" && first.flow && !first.fields.some((f) => f.required) && first.fields.length === 0 ? flows.answer(first.flow, {}) : first;
};

/** On the hub, Vincent runs as an add-on and can ask the hub's supervisor about its own software. */
async function supervisor(method: string, path: string, timeout = 20_000, data?: unknown): Promise<any> {
  const token = process.env.SUPERVISOR_TOKEN;
  // A developer's copy can borrow the test hub's supervisor through Home Assistant, to try the Matter keeper.
  if (!token && process.env.VINCENT_DEV_SUPERVISOR === "1")
    return ha.call({ type: "supervisor/api", endpoint: path, method: method.toLowerCase(), timeout: Math.round(timeout / 1000), ...(data === undefined ? {} : { data }) }, timeout + 5000);
  if (!token) throw new Error("not on a hub");
  const r = await fetch(`http://supervisor${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { "Content-Type": "application/json" }) }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(timeout) });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok || j.result === "error") throw new Error(j.message ?? `the hub answered ${r.status}`);
  return j.data ?? {};
}
/** Looks after Matter on a real hub. A development copy has no supervisor to ask, so it has no keeper. */
const keeper = process.env.SUPERVISOR_TOKEN || process.env.VINCENT_DEV_SUPERVISOR === "1"
  ? new MatterKeeper(ha, (method, path, data, timeout) => supervisor(method, path, timeout ?? 60_000, data), { changed: () => changed(), lostFile: join(dataDir, "matter-afresh") })
  : undefined;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
/** Which maker each sign-in under way is for, so the change log can name it when it finishes. */
const addingWhat = new Map<string, string>();
/** How the last "add by Matter code" went. */
let matter: { state: "idle" | "working" | "done" | "failed"; message: string; brought?: string[] } = { state: "idle", message: "" };

/** Why a Matter code did not work, in plain words. */
function matterWhy(m: string): string {
  if (/No commissionable device/i.test(m)) return "No device on your Wi-Fi is waiting to be added. If it is already in another smart home (Apple Home, Google Home, Alexa, another hub), that app has to make a fresh code for it: its own printed code no longer works. If it is new, switch it off and on, then try again within 15 minutes.";
  if (/unknown command|not loaded|not found/i.test(m)) return keeper ? "Matter on this hub had stopped. Vincent is putting it right: try your code again in a few minutes." : "Matter is not ready on this hub yet.";
  if (/timeout|did not answer/i.test(m)) return "The device did not answer. It must be switched on, on your Wi-Fi, and its code freshly made in the maker's app.";
  return "That code was not accepted. Codes last only a few minutes: make a new one in the maker's app and try again.";
}
let storeLooked = 0;
async function software(): Promise<Software> {
  try {
    // The hub is asked to look for a newer Vincent now and then, so an update is offered the day it is out.
    if (Date.now() - storeLooked > 30 * 60_000) { storeLooked = Date.now(); await supervisor("POST", "/store/reload", 60_000).catch(() => {}); }
    const info = await supervisor("GET", "/addons/self/info");
    return { version: info.version ?? "", latest: info.version_latest ?? info.version ?? "", canUpdate: !!info.update_available };
  } catch { return { version: "", latest: "", canUpdate: false }; }
}

let myVersion = "";
software().then((s) => { myVersion = s.version; });
/** Copies of the home, and bringing a home over from another hub. Only on a real hub. */
const backup = process.env.SUPERVISOR_TOKEN ? new Backup(supervisor, () => myVersion) : null;
// A move that was cut short after the hub's own records arrived is finished at the next start.
if (backup?.unfinished) setTimeout(() => backup.finish().catch((e) => console.log(`[backup] could not finish the move: ${(e as Error).message}`)), 5000);

// Push: one debounced "changed" to every open app.
const streams = new Set<ServerResponse>();
let pending: NodeJS.Timeout | undefined;
const changed = () => {
  if (pending) return;
  pending = setTimeout(() => { pending = undefined; for (const s of streams) s.write("event: changed\ndata: 1\n\n"); }, 150);
};
// An Echo tells Home Assistant about a new song only now and then (a radio station's next song can go unreported for minutes).
// While somebody has the app open and an Echo is playing, it is asked every 20 seconds, so the song shown is the song heard.
setInterval(async () => {
  if (!streams.size || !ha.connected) return;
  try {
    const playing = (await devices.playersOf("alexa_media")).filter((e) => ha.states.get(e)?.state === "playing");
    if (playing.length) await ha.call({ type: "call_service", domain: "homeassistant", service: "update_entity", service_data: { entity_id: playing } });
    // Home Assistant's line to Amazon can go quiet without saying so, and then an Echo stopped by voice shows as playing for good
    // (asking again does not help; only connecting afresh does). An Echo "playing" the very same thing for half an hour gets that
    // fresh connection, at most once each half hour. One really playing reads as playing again a few seconds later.
    const now = Date.now();
    for (const e of [...echoSame.keys()]) if (!playing.includes(e)) echoSame.delete(e);
    let stuck: string | undefined;
    for (const e of playing) {
      const sig = String(ha.states.get(e)?.attributes?.media_title ?? "");
      const was = echoSame.get(e);
      if (!was || was.sig !== sig) echoSame.set(e, { sig, since: now });
      else if (now - was.since > 30 * 60_000) stuck = e;
    }
    if (stuck && now - echoFresh > 30 * 60_000) {
      echoFresh = now; echoSame.clear();
      console.log(`[echo] ${stuck} has played the same thing for half an hour: connecting to Amazon afresh`);
      await ha.call({ type: "call_service", domain: "homeassistant", service: "reload_config_entry", service_data: { entity_id: stuck } });
    }
  } catch { /* next time */ }
}, 20_000);
// A TV box whose link to the hub has gone quiet shows what it did hours ago. Checked each minute: sooner while somebody has the app open.
setInterval(() => { if (ha.connected) devices.all().then(() => devices.refreshBoxes((streams.size ? 30 : 120) * 60_000)).catch(() => {}); }, 60_000);
const echoSame = new Map<string, { sig: string; since: number }>();
let echoFresh = 0;
/** Somebody's starred music changed (or whose device it is): every open app checks its own list at once. */
const starsChanged = () => { for (const s of streams) s.write("event: stars\ndata: 1\n\n"); };
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
/** The next sunrise and sunset, as Home Assistant works them out from where the home is. */
function sunTimes(): SunTimes | undefined {
  const a = ha.states.get("sun.sun")?.attributes;
  return a?.next_rising && a?.next_setting ? { rise: String(a.next_rising), set: String(a.next_setting) } : undefined;
}
// Scenes on a schedule. Looked at twice a minute; each runs once on the home's day it falls due.
setInterval(async () => {
  if (!ha.connected || !store.setUp) return;
  const now = Date.now(), zone = store.place?.timeZone || ha.timeZone, today = dayKey(now, zone);
  for (const s of await scenesNow()) {
    if (!whenDue(s.when, now, zone, sunTimes()) || store.sceneRan(s.id) === today) continue;
    store.setSceneRan(s.id, today);
    changes.add("Vincent", `Ran "${s.name}" on its schedule`, "scenes");
    scenes.run(s.steps)
      .then((r) => console.log(`[scenes] "${s.name}" ran on its schedule (${whenWords(s.when!)}): ${r.done} set${r.failed ? `, ${r.failed} did not answer` : ""}`))
      .catch((e: Error) => console.log(`[scenes] "${s.name}" did not run on its schedule: ${e.message}`));
  }
}, 30_000);

ha.start();
// A first look at the home network soon after starting, so the answer is ready when someone opens Add a device.
setTimeout(() => { network.seen().catch(() => undefined); }, 20_000);
keeper?.start();

// The app is not always served from here (the iPhone app carries its own copy), so any origin may ask,
// but only a paired phone or tablet gets an answer.
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };

/** Settings (adding, ignoring, removing, rooms) need the admin PIN. A correct PIN opens them on that device for a while. */
const UNLOCK_MS = 10 * 60_000;
/**
 * Which devices have settings open, and until when. Kept on disk as well, so an update or a
 * restart of the hub service does not ask for the PIN again; using settings keeps them open.
 */
const isTheme = (id: string) => id === CUSTOM_THEME || THEMES.some((t) => t.id === id);
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
    const s: HubStatus = { connected: ha.connected, version: ha.version, homeName: store.homeName || ha.homeName, reviewed: store.reviewed, setUp: store.setUp, owner: store.owner, vincent: myVersion };
    return json(res, 200, s);
  }
  if (m === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }

  // First-time setup: the owner, the PIN, and the first paired device (the one doing the setup).
  if (m === "POST" && path === "/api/setup") {
    if (store.setUp) return json(res, 409, { error: "This hub is already set up." });
    const b = (await body(req)) as SetupRequest;
    if (!b.owner?.trim() || !/^\d{4,8}$/.test(b.pin ?? "")) return json(res, 400, { error: "A name and a PIN of 4 to 8 digits are needed." });
    store.setup(b.owner.trim(), b.pin, b.ha);
    const key = store.pair(`${b.owner.trim()}'s device`, b.owner.trim(), [], true);
    changes.add(b.owner.trim(), "Set up this home");
    unlocked.set(key, Date.now() + UNLOCK_MS); // the first device review follows at once
    return json(res, 200, { ok: true, key });
  }
  // Another phone or tablet joins the home with the PIN.
  if (m === "POST" && path === "/api/pair") {
    const b = await body(req);
    // The join PIN lets a device in and nothing more; the admin PIN works too (the owner's own second device).
    const byJoinPin = !!store.joinPin && Date.now() >= lockedUntil && String(b.pin ?? "") === store.joinPin;
    if (!byJoinPin) {
      const r = pinOk(b.pin);
      if (r !== "ok") return pinRefusal(res, r);
    }
    const name = String(b.name ?? "").trim().slice(0, 40) || "A device", person = String(b.person ?? "").trim().slice(0, 30);
    changes.add(person ? `${person}, on ${name}` : name, "Joined this home");
    changed();
    // A device let in with the join PIN starts with the rules the owner set for newcomers; one let in with the admin PIN is the owner's own.
    return json(res, 200, { ok: true, key: store.pair(name, person, byJoinPin ? store.joinDeny : []) });
  }

  // Another hub asking for this home, to carry it over: it must show this home's PIN, and gets a fresh copy to fetch.
  if (m === "POST" && path === "/api/backup/hand") {
    if (!backup) return json(res, 404, { error: "not on a hub" });
    const r = pinOk((await body(req)).pin);
    if (r !== "ok") return pinRefusal(res, r);
    try { const h = await backup.hand(); changes.add("Another hub", "Took a copy of this home, to move it"); return json(res, 200, h); }
    catch (e) { return json(res, 500, { error: `The other hub could not make a copy of its home: ${(e as Error).message}` }); }
  }
  if (m === "GET" && path === "/api/backup/file") { if (!backup) return json(res, 404, { error: "not on a hub" }); return backup.send(new URL(req.url ?? "/", "http://hub").searchParams.get("pass") ?? "", res); }

  // Everything below is for paired devices only. (An event stream cannot send a header, so the key may ride in the address.)
  const key = (req.headers.authorization ?? "").replace(/^Bearer /, "") || new URL(req.url ?? "/", "http://hub").searchParams.get("k") || "";
  if (!store.paired(key)) return json(res, 401, { code: "pair", error: "This device has not joined this home." });
  /** Writes one line in the home's change log, against this phone or tablet (and its person, when it has said who). */
  const me = store.device(key)!;
  const say = (what: string, kind = "settings") => { if (what) changes.add(me.person && !me.name.startsWith(me.person) ? `${me.person}, on ${me.name}` : me.name, what, kind); };
  /** The control a request is about, with its device. */
  const controlOf = async (id: string) => { for (const d of await devices.all()) { const c = d.controls.find((x) => x.id === id); if (c) return { c, d }; } return undefined; };
  /** The owner's rules for this phone or tablet: the reason it may not do this, or "" when it may. */
  const barred = (kind: string): string => { const rule = ruleFor(kind); return rule && me.deny.includes(rule) ? `This device is not allowed to control ${RULES.find((r) => r.id === rule)!.name.toLowerCase()}. The home's owner can change that in Settings.` : ""; };
  const roomWord = (id: string) => (id ? store.rooms().find((r) => r.id === id)?.name ?? "a room" : "the whole home");
  const deviceWord = async (id: string) => (await devices.all()).find((d) => d.id === id)?.name ?? "a device";
  if (m === "GET" && path === "/api/changes") return json(res, 200, { changes: changes.recent() });
  if (m === "GET" && path === "/api/phones") return json(res, 200, { phones: store.phones().map((p) => ({ ...p, me: p.id === me.id })), joinPinSet: !!store.joinPin, joinPin: isUnlocked(key) ? store.joinPin : "", joinDeny: store.joinDeny });
  if (m === "POST" && path === "/api/phones/me") {
    const b = await body(req);
    store.nameDevice(key, String(b.name ?? ""), String(b.person ?? ""));
    starsChanged();
    const now = store.device(key)!;
    changes.add(now.person ? `${now.person}, on ${now.name}` : now.name, me.name !== now.name ? `Renamed this device from ${me.name}` : "Said who uses this device");
    changed();
    return json(res, 200, { ok: true });
  }

  if (m === "GET" && path === "/api/events") {
    res.writeHead(200, { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write("event: hello\ndata: 1\n\n");
    streams.add(res);
    const beat = setInterval(() => res.write(": beat\n\n"), 20000);
    req.on("close", () => { clearInterval(beat); streams.delete(res); });
    return;
  }
  // Room to room: announcements and calls between this home's screens. See intercom.ts.
  if (path.startsWith("/api/intercom/")) {
    const q = new URL(req.url ?? "/", "http://hub").searchParams;
    if (m === "GET" && path === "/api/intercom/listen") {
      res.writeHead(200, { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      const off = intercom.listen(store.device(key)!, q.get("room") ?? "", (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const beat = setInterval(() => res.write(": beat\n\n"), 20000);
      req.on("close", () => { clearInterval(beat); off(); });
      return;
    }
    const clip = /^\/api\/intercom\/clip\/([a-f0-9]+)$/.exec(path);
    if (m === "GET" && clip) {
      const c = intercom.clip(clip[1]);
      if (!c) return json(res, 404, { error: "That announcement is gone." });
      res.writeHead(200, { ...CORS, "Content-Type": c.type, "Cache-Control": "private, max-age=300" });
      res.end(c.data);
      return;
    }
    if (m !== "POST") return json(res, 404, { error: "not found" });
    try {
      // The owner's rules: this device may be stopped from announcing, or from starting a call. Answering one is always allowed.
      const stopped = (rule: string, what: string): boolean => { if (!store.device(key)!.deny.includes(rule)) return false; json(res, 403, { code: "rule", error: `This device is not allowed to ${what}. The home's owner can change that in Settings.` }); return true; };
      if (path === "/api/intercom/announce" && stopped("announce", "make announcements")) return;
      if (path === "/api/intercom/call" && stopped("call", "start a call")) return;
      if (path === "/api/intercom/announce") {
        const sound = await raw(req, 3_000_000);
        if (sound.length < 800) return json(res, 400, { error: "Nothing was recorded." });
        return json(res, 200, { ok: true, ...intercom.announce(q.get("line") ?? "", (q.get("places") ?? "").split(",").filter(Boolean), sound, String(req.headers["content-type"] ?? "audio/mp4").slice(0, 60), Number(q.get("seconds"))) });
      }
      const b = await body(req);
      if (path === "/api/intercom/call") return json(res, 200, { ok: true, ...intercom.call(String(b.line ?? ""), String(b.place ?? "")) });
      const on = /^\/api\/intercom\/call\/([a-f0-9]+)\/(answer|signal|end)$/.exec(path);
      if (on?.[2] === "answer") intercom.answer(String(b.line ?? ""), on[1]);
      else if (on?.[2] === "signal") intercom.signal(String(b.line ?? ""), on[1], b.data);
      else if (on?.[2] === "end") intercom.end(on[1], String(b.line ?? ""));
      else return json(res, 404, { error: "not found" });
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 409, { error: (e as Error).message }); }
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
    say("Changed the admin PIN");
    return json(res, 200, { ok: true });
  }
  if (m === "POST" && path === "/api/lock") { unlocked.delete(key); return json(res, 200, { ok: true }); }
  // A report is most needed when something is broken, so it does not wait for the hub to be well.
  if (m === "POST" && path === "/api/report") {
    const b = await body(req);
    const text = await report({ ha, devices, media, lists, supervisor, picture: () => portraits.status(), matter, matterCare: keeper ? { ...keeper.health(), history: keeper.history() } : null, note: String(b.note ?? ""), app: b.app ?? null });
    console.log("[hub] a report was made");
    return json(res, 200, { text });
  }
  // Copies of the home. Asked for while the hub's own software restarts in the middle of a move, so it does not wait for it.
  if (path.startsWith("/api/backup")) {
    if (!backup) return json(res, 200, { ok: false, copies: [], hubs: [], move: { step: "" }, message: "This only works on a real hub." });
    if (m === "GET" && path === "/api/backup/move") return json(res, 200, { move: backup.state });
    try {
      if (m === "GET" && path === "/api/backup") return json(res, 200, { copies: await backup.list(), move: backup.state });
      if (!isUnlocked(key)) return json(res, 403, { code: "pin", error: "Enter the PIN first." });
      if (m === "GET" && path === "/api/backup/hubs") return json(res, 200, { hubs: await backup.others() });
      if (m === "POST" && path === "/api/backup/make") { const c = await backup.make(); say("Made a copy of this home"); return json(res, 200, { ok: true, copy: c }); }
      if (m === "POST" && path === "/api/backup/bring") {
        const b = await body(req);
        await backup.bring(String(b.url ?? ""), String(b.pin ?? ""));
        say("Started bringing a home over from another hub");
        return json(res, 200, { ok: true });
      }
    } catch (e) { return json(res, 409, { error: (e as Error).message }); }
    return json(res, 404, { error: "not found" });
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
    // The hub only notices a device on the network once: with every discovery forgotten, it has to start again to find them all afresh.
    supervisor("POST", "/core/restart", 5 * 60_000).catch(() => {});
    // Start again with nothing remembered: on a hub its supervisor restarts this service; a development copy just stops.
    setTimeout(() => { supervisor("POST", "/addons/self/restart").catch(() => process.exit(0)); }, 800);
    return;
  }

  // Everyday use: no PIN.
  // The look this device shows: the home's, with whatever this device chose for itself laid over it.
  // The owner's device has no look of its own: the home's look IS its look. One left over from earlier would hide every change it makes.
  const mine = store.isOwner(key) ? {} : store.lookOf(key);
  if (m === "GET" && path === "/api/devices")
    return json(res, 200, {
      // A player showing no picture of its own (a radio station) wears the picture of what was started on it.
      devices: (await devices.all()).map((d) => (d.controls.some((c) => c.kind === "media" && !c.art && c.state === "playing" && media.artFor(c.id)) ? { ...d, controls: d.controls.map((c) => (c.kind === "media" && !c.art && c.state === "playing" && media.artFor(c.id) ? { ...c, art: media.artFor(c.id) } : c)) } : d)), rooms: store.rooms(), theme: mine.theme ?? store.theme, palette: mine.palette ?? store.palette, style: mine.style ?? store.style, custom: mine.custom ?? store.custom, rotate: mine.rotate ?? store.rotate, character: mine.character ?? store.character, look: { owner: store.isOwner(key), own: Object.keys(mine).length > 0 }, voices: Object.fromEntries(CHARACTERS.map((c) => { const v = mine.voices?.[c.id] ?? store.voices[c.id]; return [c.id, v && c.voices.some((x) => x.id === v.voice) ? v : defaultVoice(c.id)]; })), unlocked: isUnlocked(key), scenes: await scenesNow(), scenesRefused: store.scenesRefused, colors: store.colors, sun: sunTimes(),
      weather: place.weather(), lists: lists.all(), timers: store.timers(me.id), reminders: store.reminders(me.id), apple: { can: true, ...apple.chosen(me.id) }, wake: store.wakeTaught(), place: { zip: store.place?.zip ?? "", place: store.place?.place ?? "", timeZone: store.place?.timeZone ?? "", contact: isUnlocked(key) ? store.contact : "" },
    });
  // A device's own look. The home's look belongs to the owner's device (set in /api/home, with the PIN); every other
  // phone or tablet starts on it, and may change its own without a PIN. What it never changed keeps following the home.
  // A wake word was heard on a phone or tablet. Kept in the hub's log only, to see how well it is working.
  // What a device learned of how its people say the hosts' names: kept for the whole home, so every phone and tablet hears them the same.
  if (m === "POST" && path === "/api/wake/taught") {
    const b = await body(req), add: Record<string, string[]> = {};
    for (const c of CHARACTERS) {
      const list = (Array.isArray(b.add?.[c.id]) ? b.add[c.id] : []).map((x: unknown) => String(x).toLowerCase().replace(/[^a-z ]+/g, " ").split(" ").filter(Boolean).join(" ")).filter((x: string) => x.length >= 6 && x.length <= 40 && x.split(" ").length >= 2 && x.split(" ").length <= 4);
      if (list.length) add[c.id] = list.slice(0, 12);
    }
    if (store.addWake(add)) { console.log(`[wake] ${me.name} taught ${Object.values(add).reduce((n, l) => n + l.length, 0)} ways of saying the names`); devices.invalidate(); changed(); }
    return json(res, 200, { ok: true, wake: store.wakeTaught() });
  }
  if (m === "POST" && path === "/api/wake/forget") { store.clearWake(); console.log(`[wake] ${me.name} cleared what the home had learned`); devices.invalidate(); changed(); return json(res, 200, { ok: true }); }
  if (m === "POST" && path === "/api/wake") { const b = await body(req); console.log(`[wake] ${me.name}: "hey ${String(b.who ?? "").slice(0, 20)}"${b.said ? ` then "${String(b.said).slice(0, 80)}"` : ""}`); return json(res, 200, { ok: true }); }
  // Starred music: kept on the hub so a person's phone and tablet show the same list.
  // The Lock Screen card: the phone hands over what Apple needs to reach it; GET says how it is going.
  if (path === "/api/nowplaying") return m === "POST" ? json(res, 200, { ok: nowPlaying.register(me.id, await body(req)) }) : json(res, 200, nowPlaying.status());
  if (path === "/api/stars") {
    if (m === "POST") {
      const b = await body(req);
      const list = (Array.isArray(b.stars) ? b.stars : []).filter((x: any) => x && typeof x.kind === "string" && typeof x.id === "string" && typeof x.title === "string")
        .map((x: any) => ({ kind: x.kind, id: String(x.id).slice(0, 300), title: String(x.title).slice(0, 200), ...(typeof x.subtitle === "string" ? { subtitle: x.subtitle.slice(0, 200) } : {}), ...(typeof x.art === "string" ? { art: x.art.slice(0, 500) } : {}), ...(typeof x.src === "string" && /^https?:\/\//.test(x.src) ? { src: x.src.slice(0, 600) } : {}), ...(x.opens ? { opens: true } : {}), ...(x.plays === false ? { plays: false } : {}) }));
      store.setStars(key, await media.mendStars(list).catch(() => list));
      starsChanged();
      return json(res, 200, { ok: true });
    }
    const kept = store.starsOf(key);
    return json(res, 200, { stars: kept ? await media.mendStars(kept as any[]).catch(() => kept) : null, person: store.device(key)?.person ?? "" });
  }
  if (m === "POST" && path === "/api/look") {
    const b = await body(req);
    if (b.reset === true) { store.setLook(key, null); changed(); return json(res, 200, { ok: true }); }
    const look = { ...mine };
    if (typeof b.theme === "string" && isTheme(b.theme)) look.theme = b.theme;
    if (cleanPalette(b.palette)) look.palette = cleanPalette(b.palette);
    if (typeof b.style === "string" && (STYLES.some((t) => t.id === b.style) || b.style === HOME_STYLE.id)) look.style = b.style;
    if (b.custom && typeof b.custom === "object") {
      const base = look.custom ?? store.custom;
      const outfits: Record<string, string> = { ...base.outfits };
      if (b.custom.outfits && typeof b.custom.outfits === "object")
        for (const [who, wear] of Object.entries(b.custom.outfits)) if (CHARACTERS.some((c) => c.id === who) && STYLES.some((t) => t.id === wear)) outfits[who] = String(wear);
      look.custom = { font: FONTS.some((f) => f.id === b.custom.font) ? String(b.custom.font) : base.font, shape: STYLES.some((t) => t.id === b.custom.shape) ? String(b.custom.shape) : base.shape, outfits };
    }
    if (typeof b.character === "string" && CHARACTERS.some((c) => c.id === b.character)) look.character = b.character;
    if (["off", "daily", "hourly"].includes(b.rotate)) look.rotate = b.rotate;
    if (b.voicesReset === true) delete look.voices;
    if (b.voice && typeof b.voice === "object") {
      const who = CHARACTERS.find((c) => c.id === b.voice.character), locale = String(b.voice.locale ?? ""), voice = String(b.voice.voice ?? "");
      if (who && VOICE_LANGUAGES.some((l) => l.accents.some((a) => a.id === locale)) && who.voices.some((v) => v.id === voice)) look.voices = { ...look.voices, [who.id]: { locale, voice } };
    }
    store.setLook(key, look);
    changed();
    return json(res, 200, { ok: true });
  }
  // Talking to the host. See talk.ts.
  if (m === "POST" && (path === "/api/talk" || path === "/api/talk/live" || path === "/api/talk/act")) {
    const b = await body(req);
    const deps: TalkDeps = {
      house: async () => ({ devices: await devices.all(), rooms: store.rooms(), scenes: await scenesNow(), weather: place.weather(), lists: lists.all(), timers: store.timers(me.id), homeName: store.homeName, timeZone: store.place?.timeZone ?? ha.timeZone ?? "" }),
      control: (r) => devices.control(r),
      runScene: async (scene, allowed) => { const all = await devices.all(), kind = (id: string) => all.flatMap((d) => d.controls).find((c) => c.id === id)?.kind ?? ""; return scenes.run(scene.steps.filter((st) => allowed(kind(st.id)))); },
      music: (speaker, query, from) => { nowPlaying.note(me.id, speaker); return media.playByName(speaker, query, { from, stars: (store.starsOf(key) ?? []) as any }); },
      setTimer: (seconds, name) => store.addTimer({ seconds, name, by: me.person || me.name, made: me.id }),
      stopTimer: (id) => { store.removeTimer(id); },
      remind: (text, at, repeat) => { store.addReminder({ text, at: at.toISOString(), repeat: repeatOf(repeat), for: "", by: me.person || me.name, made: me.id }); say(`Set the reminder "${text.slice(0, 60)}" by asking the host`); },
      listAdd: (id, text) => lists.change(id, { op: "add", text }),
      say,
    };
    const asker = { ...me, room: store.rooms().find((r) => r.id === String(b.room ?? ""))?.name };
    const talk = new Talk(deps), who = String(b.character ?? mine.character ?? store.character);
    const earlier = (Array.isArray(b.turns) ? b.turns : []).filter((t: any) => t && (t.role === "you" || t.role === "host") && typeof t.text === "string" && t.text.trim());
    try {
      // Speaking: a short pass for the live service, opened by the app itself.
      if (path === "/api/talk/live") {
        const c = CHARACTERS.find((x) => x.id === who) ?? CHARACTERS[0], v = mine.voices?.[c.id] ?? store.voices[c.id];
        return json(res, 200, { ok: true, ...(await talk.live(c.id, v && c.voices.some((x) => x.id === v.voice) ? v : defaultVoice(c.id), earlier, asker)) });
      }
      if (path === "/api/talk/act") { const out = await talk.actFor(String(b.name ?? ""), b.args, asker); if (out.did) changed(); return json(res, 200, out); }
    } catch (e) {
      if (e instanceof TalkRefusal) return json(res, e.code === "rule" ? 403 : 503, { code: e.code, error: e.message });
      throw e;
    }
    const turns = earlier;
    if (!turns.length || turns[turns.length - 1].role !== "you") return json(res, 400, { error: "Nothing was asked." });
    try {
      const out = await talk.reply(who, turns, asker);
      if (out.did.length) changed();
      return json(res, 200, { ok: true, ...out });
    } catch (e) {
      if (e instanceof TalkRefusal) return json(res, e.code === "rule" ? 403 : 503, { code: e.code, error: e.message });
      throw e;
    }
  }
  // Colours mixed on the wheel and kept: everyday use, so no PIN.
  if (m === "POST" && path === "/api/colors") {
    const b = await body(req);
    if (Number.isInteger(b.keep) && b.keep >= 0 && b.keep <= 0xffffff) { store.keepColor(b.keep); say("Kept a new colour for the lights"); }
    if (Number.isInteger(b.drop)) store.dropColor(b.drop);
    changed();
    return json(res, 200, { ok: true });
  }
  // Scenes are everyday use: anyone in the house runs, makes and changes them.
  if (m === "POST" && path === "/api/scenes/run") {
    const b = await body(req);
    const steps = b.id ? (await scenesNow()).find((x) => x.id === b.id)?.steps : cleanSteps(b.steps);
    if (!steps) return json(res, 404, { error: "That scene is gone." });
    // The owner's rules hold inside a scene too: the parts this device may not control are left out.
    const all = await devices.all(), kindOfStep = (id: string) => all.flatMap((d) => d.controls).find((c) => c.id === id)?.kind ?? "";
    const allowed = steps.filter((st) => !barred(kindOfStep(st.id)));
    if (!allowed.length && steps.length) return json(res, 403, { code: "rule", error: "This device is not allowed to control anything in that scene." });
    const r = await scenes.run(allowed);
    if (b.id) say(`Ran the scene "${store.scenes().find((x) => x.id === b.id)?.name ?? ""}"`, "scenes");
    return json(res, 200, { ok: true, ...r, ...(allowed.length < steps.length ? { message: `${steps.length - allowed.length} part${steps.length - allowed.length === 1 ? "" : "s"} left out: this device is not allowed to control them.` } : {}) });
  }
  if (m === "POST" && path === "/api/scenes/undo") return json(res, 200, { ok: await scenes.back(String((await body(req)).undo ?? "")) });
  if (m === "POST" && path === "/api/scenes/refuse") { store.refuseScene(String((await body(req)).key ?? "")); changed(); return json(res, 200, { ok: true }); }
  if (m === "POST" && path === "/api/scenes") {
    const b = await body(req);
    const room = String(b.room ?? "");
    if (room && !store.rooms().some((r) => r.id === room)) return json(res, 404, { error: "That room is gone." });
    const steps = cleanSteps(b.steps);
    if (!steps.length) return json(res, 400, { error: "A scene needs at least one thing to set." });
    // Everything off stays the home's own when it is changed: only what was taken out, set differently or added is kept, so later devices still join it.
    const was = b.id ? store.scenes().find((x) => x.id === String(b.id)) : undefined;
    let keep = steps, off: { auto?: "off"; except?: string[] } = {};
    if (was && isOffScene(was) && !room) {
      const auto = everythingOff(await devices.all());
      keep = steps.filter((st) => !auto.some((a) => a.id === st.id && a.action === st.action));
      off = { auto: "off", except: auto.filter((a) => !steps.some((st) => st.id === a.id)).map((a) => a.id) };
    }
    const id = store.saveScene({ id: b.id ? String(b.id) : undefined, name: String(b.name ?? ""), room, icon: sceneIcon(b.icon), steps: keep, when: cleanWhen(b.when), says: cleanSays(b.says), ...off });
    if (!id) return json(res, 404, { error: "That scene is gone." });
    { const sc = store.scenes().find((x) => x.id === id)!; say(`${b.id ? "Changed" : "Made"} the scene "${sc.name}" for ${roomWord(sc.room)}${sc.when?.on ? `. It runs by itself: ${whenWords(sc.when)}` : ""}`); }
    // A schedule set for a moment that has only just passed starts tomorrow; it does not fire the instant it is saved.
    const zone = store.place?.timeZone || ha.timeZone;
    if (whenDue(cleanWhen(b.when), Date.now(), zone, sunTimes())) store.setSceneRan(id, dayKey(Date.now(), zone));
    changed();
    return json(res, 200, { ok: true, id });
  }
  const sceneGone = /^\/api\/scenes\/([a-f0-9]+)\/delete$/.exec(path);
  if (m === "POST" && sceneGone) {
    const sc = store.scenes().find((x) => x.id === sceneGone[1]);
    store.deleteScene(sceneGone[1]);
    if (sc) say(`Deleted the scene "${sc.name}" from ${roomWord(sc.room)}`);
    changed();
    return json(res, 200, { ok: true });
  }
  const kindOf = /^\/api\/rooms\/([a-f0-9]+)\/kind$/.exec(path);
  if (m === "POST" && kindOf) { const k = (await body(req)).kind; store.setRoomKind(kindOf[1], isRoomKind(k) ? k : undefined); say(`Changed what kind of room ${roomWord(kindOf[1])} is`); changed(); return json(res, 200, { ok: true }); }
  if (m === "POST" && path === "/api/control") {
    const b = await body(req), at = await controlOf(String(b.id ?? ""));
    const no = at ? barred(at.c.kind) : "";
    if (no) return json(res, 403, { code: "rule", error: no });
    await devices.control(b);
    if (at?.c.kind === "media" && b.action !== "key") nowPlaying.note(me.id, at.c.id);
    // A press on the remote is not written down: a film takes a hundred of them.
    if (at && b.action !== "key") say(controlWords(at.c.name === at.d.name || at.d.controls.length === 1 ? at.d.name : `${at.d.name} ${at.c.name}`, at.c.kind, String(b.action), b.value, CLIMATE_MODES.find((x) => x.id === b.mode)?.name ?? b.mode), ruleFor(at.c.kind) ?? "settings");
    return json(res, 200, { ok: true });
  }
  const med = /^\/api\/media\/([^/]+)\/(sources|play|siriusxm|group)$/.exec(path);
  if (med && m === "POST" && barred("media")) return json(res, 403, { code: "rule", error: barred("media") });
  if (med && m === "POST" && med[2] === "group") { await media.group(med[1], (await body(req)).members); return json(res, 200, { ok: true }); }
  if (med && m === "GET" && med[2] === "siriusxm") return json(res, 200, { groups: await media.siriusxm(med[1]) });
  if (med && m === "GET" && med[2] === "sources") return json(res, 200, await media.sources(med[1]));
  if (med && m === "POST" && med[2] === "play") { const b = await body(req); await media.play(med[1], b); nowPlaying.note(me.id, med[1]); const at = await controlOf(med[1]); say(`Played ${String(b.title ?? "something").slice(0, 60)} on ${at?.d.name ?? "a speaker"}`, "media"); return json(res, 200, { ok: true }); }
  // Timers: set by asking the host, or here; stopped from any screen.
  if (m === "POST" && path === "/api/timers") {
    const b = await body(req);
    if (b.op === "stop") { store.removeTimer(String(b.id ?? "")); changed(); return json(res, 200, { ok: true }); }
    const seconds = Math.round(Number(b.seconds));
    if (!(seconds >= 1 && seconds <= 24 * 3600)) return json(res, 400, { error: "A timer needs a length, up to a day." });
    const t = store.addTimer({ seconds, name: String(b.name ?? "").trim().slice(0, 30), by: me.person || me.name, made: me.id });
    changed();
    return json(res, 200, { ok: true, id: t.id });
  }
  // Reminders: something to remember at a date and time. Each phone schedules its own notifications from these.
  if (m === "POST" && path === "/api/reminders") {
    const b = await body(req), text = String(b.text ?? "").trim().slice(0, 200), at = new Date(String(b.at ?? ""));
    if (b.op === "clear") { store.clearReminders(me.id); changed(); return json(res, 200, { ok: true }); }
    if (!text || Number.isNaN(at.getTime())) return json(res, 400, { error: "A reminder needs something to remember, and a time." });
    store.addReminder({ text, at: at.toISOString(), repeat: repeatOf(b.repeat), for: b.mine ? me.id : "", by: me.person || me.name, made: me.id });
    if (!b.mine) say(`Set the reminder "${text.slice(0, 60)}"`);
    changed(); return json(res, 200, { ok: true });
  }
  const rem = /^\/api\/reminders\/([a-f0-9]+)$/.exec(path);
  if (rem && m === "POST") {
    const b = await body(req), time = (v: unknown) => { const d = new Date(String(v ?? "")); return Number.isNaN(d.getTime()) ? "" : d.toISOString(); };
    const was = store.changeReminder(me.id, rem[1], (r) => {
      if (b.op === "remove") return null;
      // Ticked off: one that repeats moves on to its next time (worked out by the phone, which knows the home's clock); the rest are finished.
      if (b.op === "done") return r.repeat && time(b.next) ? { ...r, at: time(b.next) } : { ...r, done: new Date().toISOString() };
      if (b.op === "reopen") { const { done: _d, ...open } = r; return open; }
      if (b.op === "later" && time(b.at)) { const { done: _d, ...open } = r; return { ...open, at: time(b.at) }; }
      if (b.op === "edit") { const text = String(b.text ?? "").trim().slice(0, 200); const { done: _d, ...open } = r; return { ...open, text: text || r.text, at: time(b.at) || r.at, repeat: repeatOf(b.repeat), for: b.mine ? me.id : "" }; }
      return r;
    });
    if (!was) return json(res, 404, { error: "That reminder is no longer there." });
    if (b.op === "remove" && !was.for) say(`Removed the reminder "${was.text.slice(0, 60)}"`);
    changed(); return json(res, 200, { ok: true });
  }
  // Apple Reminders, set up on each phone by itself. The phone hands over its chosen lists; the hub answers with what to change on Apple's side.
  if (m === "POST" && path === "/api/apple") { const b = await body(req); apple.choose(me.id, b.lists ?? {}, String(b.into ?? "")); changed(); return json(res, 200, { ok: true }); }
  if (m === "POST" && path === "/api/apple/sync") { const r = await apple.sync(me.id, me.person || me.name, JSON.parse((await raw(req, 2_000_000)).toString("utf8") || "{}").lists); if (r.changed) { devices.invalidate(); changed(); } return json(res, 200, { ops: r.ops }); }
  if (m === "POST" && path === "/api/apple/made") { apple.made(me.id, (await body(req)).made ?? {}); return json(res, 200, { ok: true }); }
  const li = /^\/api\/lists\/([a-f0-9]+)$/.exec(path);
  if (li && m === "GET") return json(res, 200, await lists.items(li[1]));
  if (li && m === "POST") { await lists.change(li[1], await body(req)); changed(); return json(res, 200, { ok: true }); }
  if (m === "POST" && path === "/api/lists") { const name = String((await body(req)).name ?? ""); await lists.create(name); say(`Made the list "${name.trim().slice(0, 40)}"`); devices.invalidate(); changed(); return json(res, 200, { ok: true }); }
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
  // Cameras: the picture, and live view (the hub carries the handshake; the video goes straight to the app).
  if (m === "GET" && path === "/api/cameras/ages") return json(res, 200, await cameras.ages());
  const cam = /^\/api\/cameras\/([^/]+)\/(still|frame|live)$/.exec(path);
  if (cam && m === "GET" && cam[2] === "still") {
    const pic = await cameras.still(cam[1]);
    if (!pic) return json(res, 404, { error: "no picture yet" });
    res.writeHead(200, { ...CORS, "Content-Type": pic.type, "Cache-Control": "private, max-age=5" });
    res.end(pic.data);
    return;
  }
  if (cam && m === "POST" && cam[2] === "frame") {
    const jpeg = await raw(req, 5_000_000);
    if (jpeg.length < 2000 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return json(res, 400, { error: "That is not a picture." });
    await cameras.frame(cam[1], jpeg);
    changed();
    return json(res, 200, { ok: true });
  }
  if (cam && m === "GET" && cam[2] === "live") return json(res, 200, await cameras.config(cam[1]));
  if (cam && m === "POST" && cam[2] === "live") return json(res, 200, { session: await cameras.start(cam[1], String((await body(req)).sdp ?? "")) });
  const live = /^\/api\/cameras\/live\/([a-f0-9]+)\/(events|candidate|stop)$/.exec(path);
  if (live && m === "GET" && live[2] === "events") {
    res.writeHead(200, { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    const off = cameras.listen(live[1], (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    if (!off) { res.end(`data: ${JSON.stringify({ type: "end" })}\n\n`); return; }
    const beat = setInterval(() => res.write(": beat\n\n"), 20000);
    // The app went away: the camera can go back to sleep.
    req.on("close", () => { clearInterval(beat); off(); cameras.stop(live[1]); });
    return;
  }
  if (live && m === "POST" && live[2] === "candidate") { cameras.candidate(live[1], await body(req)); return json(res, 200, { ok: true }); }
  if (live && m === "POST" && live[2] === "stop") { cameras.stop(live[1]); return json(res, 200, { ok: true }); }
  if (m === "GET" && path === "/api/matter") return json(res, 200, { ...matter, hub: keeper?.health() });
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
  if (m === "GET" && path === "/api/seen") return json(res, 200, { seen: await network.seen(new URL(req.url ?? "/", "http://hub").searchParams.get("fresh") === "1").catch(() => []) });
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
    say(`Updated Vincent to ${info.version_latest ?? "the newest version"}`);
    json(res, 200, { ok: true, message: "Updating. Vincent will be back in a minute or two." });
    // The update stops this service and starts the new one; nothing after this line is certain to run.
    ha.service("update", "install", entity).catch((e: Error) => console.log(`[hub] update failed: ${e.message}`));
    return;
  }
  // Adding by brand, and answering what a maker asks.
  // The join PIN: what a new phone or tablet types to come in. The owner chooses it and can look it up here.
  if (path === "/api/join-pin") {
    const b = await body(req);
    if (b.pin !== undefined) {
      const pin = String(b.pin).trim();
      if (pin && !/^\d{4,8}$/.test(pin)) return json(res, 400, { error: "A join PIN is 4 to 8 digits." });
      if (pin && store.checkPin(pin)) return json(res, 400, { error: "That is the admin PIN. The join PIN must be a different one, or joining would hand over the settings too." });
      store.setJoinPin(pin);
      say(pin ? "Changed the join PIN" : "Removed the join PIN");
      changed();
    }
    return json(res, 200, { ok: true, joinPin: store.joinPin });
  }
  // This device's look becomes the home's: what every device that has not chosen its own will show.
  if (path === "/api/look/home") {
    const b = await body(req);
    if (mine.theme) store.setTheme(mine.theme);
    if (mine.palette) store.setPalette(mine.palette);
    if (mine.style) store.setStyle(mine.style);
    if (mine.custom) store.setCustom(mine.custom);
    if (mine.character) store.setCharacter(mine.character);
    if (mine.rotate) store.setRotate(mine.rotate);
    for (const [who, v] of Object.entries(mine.voices ?? {})) store.setVoice(who, v);
    store.setLook(key, null);
    if (b.everyone === true) store.clearLooks();
    say(b.everyone === true ? "Made this device's look the home's look, for every device" : "Made this device's look the home's look");
    return done();
  }
  if (path === "/api/look/send") {
    const ids = ((await body(req)).devices ?? []) as unknown[];
    const names = store.clearLookOf((Array.isArray(ids) ? ids : []).map(String));
    if (names.length) say(`Sent the home's look to ${names.join(", ")}`.slice(0, 200));
    return done();
  }
  if (path === "/api/join-rules") {
    const asked = (await body(req)).deny;
    const deny = (Array.isArray(asked) ? asked : []).map(String).filter((d: string) => RULES.some((r) => r.id === d));
    store.setJoinDeny(deny);
    say(deny.length ? `Set the rules for new joiners: no ${deny.map((d: string) => RULES.find((r) => r.id === d)!.name.toLowerCase()).join(", ")}` : "Set the rules for new joiners: everything allowed");
    return done();
  }
  const phoneRules = /^\/api\/phones\/([a-f0-9]+)\/rules$/.exec(path);
  if (phoneRules) {
    const asked = (await body(req)).deny;
    const deny = (Array.isArray(asked) ? asked : []).map(String).filter((d: string) => RULES.some((r) => r.id === d));
    const name = store.setDeny(phoneRules[1], deny);
    if (!name) return json(res, 404, { error: "That device is no longer in this home." });
    say(deny.length ? `Stopped ${name} from controlling ${deny.map((d: string) => RULES.find((r) => r.id === d)!.name.toLowerCase()).join(", ")}` : `Let ${name} control everything again`);
    return done();
  }
  const phoneGone = /^\/api\/phones\/([a-f0-9]+)\/remove$/.exec(path);
  if (phoneGone) {
    if (phoneGone[1] === me.id) return json(res, 400, { error: "This is the device you are holding. Use \"Connect to a different hub\" to leave." });
    const name = store.unpair(phoneGone[1]);
    if (!name) return json(res, 404, { error: "That device has already left." });
    say(`Removed ${name} from this home`);
    return done();
  }
  if (path === "/api/adding") {
    const b = await body(req);
    const step = await flows.startBrand(String(b.brand ?? ""), roomIds(b), String(req.headers.host ?? ""));
    const brand = brandList().find((x) => x.id === b.brand)?.name ?? "a maker";
    if (step.kind === "done") say(`Connected ${brand}`); else if (step.flow) addingWhat.set(step.flow, brand);
    changed();
    return json(res, 200, step);
  }
  const adding = /^\/api\/adding\/([A-Za-z0-9]+)\/(answer|poll|cancel)$/.exec(path);
  if (adding) {
    if (adding[2] === "cancel") { await flows.cancel(adding[1]); return done(); }
    const step = adding[2] === "poll" ? await flows.poll(adding[1]) : await flows.answer(adding[1], (await body(req)).values ?? {});
    if (step.kind === "done") { say(`Connected ${addingWhat.get(adding[1]) ?? "a maker's account"}`); addingWhat.delete(adding[1]); changed(); }
    return json(res, 200, step);
  }
  if (path === "/api/matter") {
    const code = String((await body(req)).code ?? "").replace(/[\s-]/g, "");
    if (!/^(\d{11}|\d{21}|MT:[A-Z0-9.\-]+)$/i.test(code)) return json(res, 200, { state: "failed", message: "A Matter code is 11 or 21 digits, or the text of its QR code starting with MT:." });
    if (matter.state === "working") return json(res, 200, matter);
    // Looking for the device can take a few minutes, so the app is answered at once and asks how it went.
    // If Matter itself has stopped on the hub, it is put right first; the household only waits a little longer.
    const LOOKING = "Looking for the device. This can take a couple of minutes.";
    const lostMatter = (e: Error) => /unknown command|not loaded|not found/i.test(e.message);
    const mend = async () => {
      matter = { state: "working", message: "Matter on this hub needs a moment first. Vincent is seeing to it, then looks for your device." };
      changed();
      if (!(await keeper!.ready(8 * 60_000))) throw new Error("matter-down");
      matter = { state: "working", message: LOOKING };
      changed();
    };
    const commission = () => ha.call({ type: "matter/commission", code, network_only: true }, 240_000);
    matter = { state: "working", message: LOOKING };
    const before = new Set(await devices.ids());
    (async () => {
      const health = keeper?.health().state;
      if (keeper && health !== "ok" && health !== "off") await mend();
      // Home Assistant not knowing the word "Matter" means it stopped since the keeper last looked: mend, then try once more.
      return commission().catch(async (e: Error) => { if (!keeper || !lostMatter(e)) throw e; keeper.nudge(); await sleep(3000); await mend(); return commission(); });
    })()
      .then(async () => {
        // What the code brought: whatever is on the hub now that was not there before.
        const brought = await devices.settle(async () => (await devices.ids()).filter((id) => !before.has(id)), 20_000);
        keeper?.added();
        say("Added a device with a Matter code");
        matter = { state: "done", message: brought.length ? "Your hub has it." : "Your hub has it. It appears under Add a device in a moment.", brought };
      })
      .catch((e: Error) => {
        matter = { state: "failed", message: e.message === "matter-down" ? keeper!.health().message || matterWhy("not loaded") : matterWhy(e.message) };
      })
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
  if (path === "/api/spotify/forget") { await media.spotifyForget(); say("Disconnected Spotify"); return done(); }
  if (path === "/api/reviewed") { store.setReviewed(); return done(); }
  if (path === "/api/home") {
    const b = await body(req);
    // Only what actually changes is written down.
    if (typeof b.name === "string" && b.name.trim() && b.name.trim().slice(0, 40) !== store.homeName) say(`Named the home "${b.name.trim().slice(0, 40)}"`);
    if (typeof b.theme === "string" && isTheme(b.theme) && b.theme !== store.theme) say(`Changed the colours to ${THEMES.find((t) => t.id === b.theme)?.name ?? "the home's own"}`);
    if (typeof b.style === "string" && (STYLES.some((t) => t.id === b.style) || b.style === HOME_STYLE.id) && b.style !== store.style) say(`Changed the style to ${STYLES.find((t) => t.id === b.style)?.name ?? "My Home"}`);
    if (typeof b.character === "string" && CHARACTERS.some((c) => c.id === b.character) && b.character !== store.character) say(`Made ${CHARACTERS.find((c) => c.id === b.character)!.name} the host`);
    if (["off", "daily", "hourly"].includes(b.rotate) && b.rotate !== store.rotate) say(b.rotate === "off" ? "Chose one host for always" : `Chose a new host each ${b.rotate === "daily" ? "day" : "hour"}`);
    if (b.voice && typeof b.voice === "object" && CHARACTERS.some((c) => c.id === b.voice.character)) say(`Changed ${CHARACTERS.find((c) => c.id === b.voice.character)!.name}'s voice`);
    if (typeof b.zip === "string" && b.zip.trim() && b.zip.trim() !== (store.place?.zip ?? "")) say("Changed the home's ZIP code");
    if (typeof b.contact === "string" && b.contact.trim() && b.contact.trim() !== store.contact) say("Changed how to reach the owner");
    if (typeof b.name === "string" && b.name.trim()) store.setHomeName(b.name);
    if (typeof b.theme === "string" && isTheme(b.theme)) store.setTheme(b.theme);
    if (cleanPalette(b.palette)) store.setPalette(cleanPalette(b.palette)!);
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
    if (Number.isInteger(b.colorKeep) && b.colorKeep >= 0 && b.colorKeep <= 0xffffff) { store.keepColor(b.colorKeep); say("Kept a new colour for the lights"); }
    if (Number.isInteger(b.colorDrop)) store.dropColor(b.colorDrop);
    if (b.voicesReset === true && Object.keys(store.voices).length) { store.clearVoices(); say("Set every character's voice back to its own"); }
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
  if (path === "/api/rooms") { const b = await body(req); const had = store.rooms().length; const id = store.room(String(b.name ?? "")); if (store.rooms().length > had) say(`Made the room ${roomWord(id)}`); changed(); return json(res, 200, { ok: true, id }); }
  if (path === "/api/rooms/order") { const b = await body(req); store.orderRooms(Array.isArray(b.ids) ? b.ids.map(String) : []); say("Changed the order of the rooms"); changed(); return json(res, 200, { ok: true }); }
  const room = /^\/api\/rooms\/([a-f0-9]+)\/(rename|delete|photo)$/.exec(path);
  if (room) {
    const was = roomWord(room[1]);
    if (room[2] === "delete") { store.deleteRoom(room[1]); say(`Deleted the room ${was}`); }
    else if (room[2] === "rename") { store.renameRoom(room[1], String((await body(req)).name ?? "")); if (roomWord(room[1]) !== was) say(`Renamed the room ${was} to ${roomWord(room[1])}`); }
    else {
      const jpeg = await raw(req, 4_000_000);
      if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return json(res, 400, { error: "That is not a photo." });
      if (!store.setPhoto(room[1], jpeg)) return json(res, 404, { error: "That room is gone." });
      say(`Changed the photo of ${was}`);
    }
    return done();
  }
  if (path === "/api/place") {
    const b = await body(req);
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 200).map((it: any) => ({ id: String(it.id ?? ""), add: !!it.add, rooms: it.add ? roomIds(it) : [] }));
    await devices.place(items);
    const kept = items.filter((it: { add: boolean }) => it.add).length;
    if (kept) say(`Gave ${kept === 1 ? "a room to one device" : `rooms to ${kept} devices`}`);
    return done();
  }
  const act = /^\/api\/devices\/([^/]+)\/(add|ignore|restore|rooms|rename)$/.exec(path);
  if (act) {
    const id = decodeURIComponent(act[1]);
    if (act[2] === "add") { const r = await devices.add(id, roomIds(await body(req))); say(`Added ${await deviceWord(id)}`); changed(); return json(res, 200, r); }
    if (act[2] === "rename") { const was = await deviceWord(id); await devices.rename(id, String((await body(req)).name ?? "")); const now = await deviceWord(id); if (now !== was) say(`Renamed ${was} to ${now}`); return done(); }
    if (act[2] === "rooms") { const ids = roomIds(await body(req)); await devices.setRooms(id, ids); say(`Put ${await deviceWord(id)} in ${ids.length ? ids.map(roomWord).join(" and ") : "no room"}`); return done(); }
    await devices.setStatus(id, act[2] === "ignore" ? "ignored" : "found");
    say(`${act[2] === "ignore" ? "Hid" : "Brought back"} ${await deviceWord(id)}`);
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

/** Home Assistant's own web address as this service reaches it (for its pages, which are not under its API). */
let haWeb = "";
async function haAddress(): Promise<string> {
  if (haWeb) return haWeb;
  if (process.env.SUPERVISOR_TOKEN) { const info = await supervisor("GET", "/core/info"); haWeb = `${info.ssl ? "https" : "http"}://homeassistant:${info.port ?? 8123}`; }
  else haWeb = String(JSON.parse(readFileSync(new URL("../dev-hub.json", import.meta.url), "utf8")).url).replace(/\/$/, "");
  return haWeb;
}
const SIGNED_IN = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signed in</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4efe6;color:#2a2622;font-family:-apple-system,system-ui,sans-serif;text-align:center}
main{padding:32px}.m{width:72px;height:72px;margin:0 auto 20px;border-radius:50%;background:#2a2622;color:#f4efe6;display:grid;place-items:center;font:600 34px Georgia,serif}
h1{font:500 28px Georgia,serif;margin:0 0 10px}p{margin:0;color:#6f675d;font-size:17px;line-height:1.4}</style></head>
<body><main><div class="m">V</div><h1>You are signed in</h1><p>Vincent is collecting your Echo speakers.<br>You can go back to the Vincent app.</p></main>
<script>setTimeout(function(){location.href="vincentdone://signed-in"},400)</script></body></html>`;

/**
 * Amazon's sign-in for Echo speakers. Home Assistant shows Amazon's page from its own address; the hub passes it through
 * from the hub's address instead, so it sees the moment the sign-in finishes and can show its own closing page.
 */
async function amazon(req: IncomingMessage, res: ServerResponse, under = ""): Promise<void> {
  const url = new URL(req.url ?? "/", "http://hub");
  // A bare path asked for by Amazon's page ("/ax/claim") belongs on Amazon's site: it goes through the same sign-in.
  if (under) url.pathname = `/auth/alexamedia/proxy/${under}${url.pathname}`;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const sent = Buffer.concat(chunks);
  // Passed on as it came, the hub's own address included: Home Assistant works out which Amazon page is meant by
  // comparing the address asked for with the hub address it was given at the start. (fetch would rewrite that address.)
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !["connection", "content-length", "accept-encoding", "transfer-encoding"].includes(k)) headers[k] = v;
  if (sent.length) headers["content-length"] = String(sent.length);
  const to = new URL((await haAddress()) + url.pathname + url.search);
  const r = await new Promise<{ status: number; headers: IncomingMessage["headers"]; body: Buffer }>((ok, fail) => {
    const out = (to.protocol === "https:" ? httpsRequest : httpRequest)(to, { method: req.method, headers, timeout: 150_000 }, (back) => {
      const got: Buffer[] = [];
      back.on("data", (c: Buffer) => got.push(c));
      back.on("end", () => ok({ status: back.statusCode ?? 502, headers: back.headers, body: Buffer.concat(got) }));
      back.on("error", fail);
    });
    out.on("timeout", () => out.destroy(new Error("Amazon's page took too long to answer.")));
    out.on("error", fail);
    out.end(sent.length ? sent : undefined);
  });
  const done = url.pathname === "/auth/alexamedia/callback" && r.status === 200;
  for (const [k, v] of Object.entries(r.headers)) if (v !== undefined && !["content-length", "transfer-encoding", "connection", "set-cookie"].includes(k)) res.setHeader(k, v);
  const cookies = [...(r.headers["set-cookie"] ?? [])];
  // Remember, for this browser only and only for a while, which sign-in it is in the middle of.
  const visit = /^\/auth\/alexamedia\/proxy\/([A-Za-z0-9]+)/.exec(url.pathname)?.[1];
  if (done) cookies.push("vincent_amazon=; Path=/; Max-Age=0");
  else if (visit) cookies.push(`vincent_amazon=${visit}; Path=/; Max-Age=1200; HttpOnly; SameSite=Lax`);
  if (cookies.length) res.setHeader("set-cookie", cookies);
  if (done) { res.removeHeader("content-encoding"); res.setHeader("content-type", "text/html; charset=utf-8"); const id = url.searchParams.get("flow_id"); if (id) flows.linkDone(id); console.log("[echo] Amazon sign-in finished"); }
  res.writeHead(r.status);
  res.end(done ? Buffer.from(SIGNED_IN) : r.body);
}

createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://hub").pathname;
  // Amazon's page also asks for things by bare paths. While a browser is in the middle of that sign-in, anything it asks
  // for that is not Vincent's own goes to Amazon the same way.
  const visit = /(?:^|;\s*)vincent_amazon=([A-Za-z0-9]+)/.exec(String(req.headers.cookie ?? ""))?.[1]
    ?? /\/auth\/alexamedia\/proxy\/([A-Za-z0-9]+)/.exec(String(req.headers.referer ?? ""))?.[1];
  const own = path === "/" || path.startsWith("/api/") || (!!extname(path) && existsSync(normalize(join(dist, path))));
  const run = path.startsWith("/auth/alexamedia/") ? amazon(req, res) : visit && !own ? amazon(req, res, visit) : path.startsWith("/api/") ? api(req, res, path) : page(res, path);
  run.catch((e: Error) => {
    console.log(`[api] ${req.method} ${path} failed: ${e.message}`);
    if (!res.headersSent) json(res, 400, { error: e.message });
  });
}).listen(PORT, () => console.log(`[hub] Vincent hub service on :${PORT}`));

// On the hub this process is stopped with a plain signal; leave at once.
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(0));
