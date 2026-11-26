/**
 * Vincent's own choices for this home, kept on the hub: which devices the household
 * added, which it ignored. Home Assistant is never asked to forget anything.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { ControlRequest, ListStatus, Palette, Reminder, Repeat, Timer, Room, RoomKind, Scene, SceneWhen } from "../../../packages/core/src/index.ts";

/** The parts of the look one phone or tablet may choose for itself. Anything left out follows the home. */
export interface DeviceLook { theme?: string; palette?: Palette; style?: string; custom?: { font: string; shape: string; outfits?: Record<string, string> }; character?: string; rotate?: string; voices?: Record<string, { locale: string; voice: string }> }

/** One thing kept in step with Apple Reminders, as both sides stood when last matched. */
export interface AppleRow { /** Apple's id; "" while the phone has yet to make it there. */ a: string; ref?: string; /** The Apple list. */ l: string; kind: "item" | "rem"; /** The home's id for it: a list item, or a reminder. */ v: string; text: string; done: boolean; at?: string; repeat?: Repeat; /** It repeats on Apple in a way Vincent has no word for; its repeating is left to Apple. */ odd?: boolean }
export interface AppleSaved { lists: Record<string, { name: string; /** Shared with the home, or this device's own reminders only. */ share: boolean; entity?: string }>; /** The Apple list that reminders made on this device are copied to. */ into: string; rows: AppleRow[]; at?: string }

interface Saved {
  /** How to wake each TV that wakes by its hardware address, by the setup that brought it. */
  tvMacs?: Record<string, string>;
  /** Apple Reminders, by the phone or tablet that set it up. */
  apple?: Record<string, AppleSaved>;
  /** How each host's name is written down when the people of this home say it ("hey vinsen"), learned on any device and used by all of them. */
  wake?: Record<string, string[]>;
  /** device id -> added | ignored. Absent = found. */
  devices: Record<string, "added" | "ignored">;
  /** Integrations the household said yes to: every device they bring is added. */
  addedEntries: string[];
  reviewed: boolean;
  /** The starter lists were made once; a list the household deletes stays deleted. */
  listsSeeded?: boolean | number;
  owner?: string;
  /** The admin PIN, salted and hashed. Never stored in the clear. */
  pin?: { salt: string; hash: string };
  /** The hub's own Home Assistant login, so the household is never locked out of it. */
  ha?: { username: string; password: string };
  /** Phones and tablets allowed to talk to this home: sha-256 of each one's key -> its name. */
  /** Starred music, by whose it is ("p:<person>" or "d:<device>"). */
  stars?: Record<string, unknown[]>;
  paired?: Record<string, { name: string; since: string; person?: string; /** What this device may not control (rule ids). */ deny?: string[]; /** Set on the device that set the home up: its look is the home's look. */ owner?: boolean; /** This device's own look, where it differs from the home's. */ look?: DeviceLook }>;
  /** The PIN that lets a new phone or tablet join. Not the admin PIN: it opens no settings. Kept readable so the owner can look it up. */
  joinPin?: string;
  /** The rules a device starts with when it joins with the join PIN. The owner can change any one device afterwards. */
  joinDeny?: string[];
  /** Vincent's own rooms. Home Assistant allows one room per device; Vincent allows several. */
  rooms?: { id: string; name: string; photoAt?: number; kind?: RoomKind }[];
  /** One-tap scenes, in the order they were made. */
  scenes?: Scene[];
  /** Suggested scenes the household said no to ("room:idea"). */
  scenesRefused?: string[];
  /** Colours the household mixed on the wheel and kept, offered on every colour light. */
  colors?: number[];
  /** Things to remember at a date and time. `for` = the one device it belongs to, or "" for everyone. */
  reminders?: Reminder[];
  /** Running timers, and ones that rang in the last few minutes. `made` = the device that set it. */
  timers?: (Timer & { made: string })[];
  /** scene id -> the home's date it last ran by itself, so a schedule fires once a day even across a restart. */
  scenesRan?: Record<string, string>;
  /** True once the home has been given its Everything off scene. */
  everythingOff?: boolean;
  /** device id -> room ids */
  deviceRooms?: Record<string, string[]>;
  /** device id -> the household's own name for it. The device itself keeps its name. */
  deviceNames?: Record<string, string>;
  /** For a device that was waiting for a yes: the rooms chosen for whatever it brings. */
  entryRooms?: Record<string, string[]>;
  theme?: string;
  /** The home's own colours, used when the theme is "custom". */
  palette?: Palette;
  style?: string;
  custom?: { font: string; shape: string; outfits?: Record<string, string> };
  character?: string;
  /** off = always the chosen character; daily / hourly = a different host by turns. */
  rotate?: string;
  /** character id -> the voice the home chose for it */
  voices?: Record<string, { locale: string; voice: string }>;
  homeName?: string;
  /** Where the home is, from the ZIP code given at setup. */
  place?: SavedPlace;
  /** How to reach the owner if the PIN is lost or the home has to be recovered. Kept on the hub only. */
  contact?: string;
}
export interface SavedPlace { zip: string; country: string; place: string; timeZone?: string }

// On the hub an add-on's durable folder is /data. In development, VINCENT_DATA names another
// folder, so a second, empty home can be tried beside the first.
export const dir = process.env.SUPERVISOR_TOKEN ? "/data" : process.env.VINCENT_DATA ?? fileURLToPath(new URL("../data", import.meta.url));
const file = join(dir, "vincent.json");

let saved: Saved = { devices: {}, addedEntries: [], reviewed: false };
if (existsSync(file)) {
  try { saved = { ...saved, ...JSON.parse(readFileSync(file, "utf8")) }; }
  catch (e) { console.log(`[store] ${file} unreadable, starting empty: ${(e as Error).message}`); }
}

function save(): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + ".tmp", JSON.stringify(saved, null, 1));
  renameSync(file + ".tmp", file);
}

export const store = {
  status(id: string, entryIds: string[] = []): ListStatus {
    const own = saved.devices[id];
    if (own) return own;
    return entryIds.some((e) => saved.addedEntries.includes(e)) ? "added" : "found";
  },
  set(id: string, status: ListStatus): void {
    if (status === "found") delete saved.devices[id]; else saved.devices[id] = status;
    save();
  },
  addEntry(entryId: string): void {
    if (!saved.addedEntries.includes(entryId)) { saved.addedEntries.push(entryId); save(); }
  },
  /** True when the household said yes to everything this maker's account brings. */
  hasEntry(entryId: string): boolean { return saved.addedEntries.includes(entryId); },
  dropEntry(entryId: string): void { saved.addedEntries = saved.addedEntries.filter((e) => e !== entryId); if (saved.entryRooms) delete saved.entryRooms[entryId]; save(); },
  /** The household's own word on one device, if it gave one. */
  own(id: string): "added" | "ignored" | undefined { return saved.devices[id]; },
  hasOwnRooms(id: string): boolean { return !!saved.deviceRooms?.[id]; },
  get setUp(): boolean { return !!saved.pin; },
  get owner(): string { return saved.owner ?? ""; },
  setup(owner: string, pin: string, ha?: { username: string; password: string }): void {
    const salt = randomBytes(16).toString("hex");
    saved.owner = owner;
    saved.pin = { salt, hash: scryptSync(pin, salt, 32).toString("hex") };
    if (ha) saved.ha = ha;
    save();
  },
  setPin(pin: string): void {
    const salt = randomBytes(16).toString("hex");
    saved.pin = { salt, hash: scryptSync(pin, salt, 32).toString("hex") };
    save();
  },
  checkPin(pin: string): boolean {
    if (!saved.pin) return false;
    const got = scryptSync(pin, saved.pin.salt, 32);
    return timingSafeEqual(got, Buffer.from(saved.pin.hash, "hex"));
  },
  /** Lets a phone or tablet in, and returns the key it must show from now on. Only the key's hash is kept. */
  pair(name: string, person = "", deny: string[] = [], owner = false): string {
    const key = randomBytes(24).toString("base64url");
    (saved.paired ??= {})[sha(key)] = { name, since: new Date().toISOString(), ...(person ? { person } : {}), ...(deny.length ? { deny: [...deny] } : {}), ...(owner ? { owner: true } : {}) };
    save();
    return key;
  },
  paired(key: string): boolean { return !!key && !!saved.paired?.[sha(key)]; },
  /** The phone or tablet a key belongs to: a short id that never changes, and the name it was given when it joined. */
  device(key: string): { id: string; name: string; person: string; deny: string[] } | undefined { const h = sha(key), d = saved.paired?.[h]; return d ? { id: h.slice(0, 16), name: d.name, person: d.person ?? "", deny: d.deny ?? [] } : undefined; },
  /** Every phone and tablet that has joined, oldest first. */
  phones(): { id: string; name: string; person: string; since: string; deny: string[]; ownLook: boolean }[] {
    return Object.entries(saved.paired ?? {}).map(([h, d]) => ({ id: h.slice(0, 16), name: d.name, person: d.person ?? "", since: d.since, deny: d.deny ?? [], ownLook: !!d.look && Object.keys(d.look).length > 0 })).sort((a, b) => a.since.localeCompare(b.since));
  },
  /** Puts the chosen devices back on the home's look. Returns their names. */
  clearLookOf(ids: string[]): string[] {
    const names: string[] = [];
    for (const [h, d] of Object.entries(saved.paired ?? {})) if (ids.includes(h.slice(0, 16))) { delete d.look; names.push(d.name); }
    if (names.length) save();
    return names;
  },
  /** A phone or tablet says what it is called and who uses it. */
  nameDevice(key: string, name: string, person: string): void {
    const d = saved.paired?.[sha(key)];
    if (!d) return;
    if (name.trim()) d.name = name.trim().slice(0, 40);
    const p = person.trim().slice(0, 30);
    if (p) d.person = p; else delete d.person;
    save();
  },
  /** What one phone or tablet may not control. Returns its name, or "" when there is no such device. */
  setDeny(id: string, deny: string[]): string {
    const h = Object.keys(saved.paired ?? {}).find((k) => k.slice(0, 16) === id);
    if (!h) return "";
    if (deny.length) saved.paired![h].deny = deny; else delete saved.paired![h].deny;
    save();
    return saved.paired![h].name;
  },
  /** Is this the device whose look is the home's look? The one that set the home up; in a home from before that was written down, the first to join. */
  isOwner(key: string): boolean {
    const all = Object.entries(saved.paired ?? {}), h = sha(key);
    if (all.some(([, d]) => d.owner)) return !!saved.paired?.[h]?.owner;
    return all.sort((a, b) => a[1].since.localeCompare(b[1].since))[0]?.[0] === h;
  },
  /** This device's own look: only what it chose differently from the home. */
  /** Starred music belongs to a person: every phone and tablet with the same person's name shares one list. A device with no person keeps its own. */
  starsOwner(key: string): string { const d = saved.paired?.[sha(key)]; return d?.person ? `p:${d.person.trim().toLowerCase()}` : `d:${sha(key).slice(0, 16)}`; },
  starsOf(key: string): unknown[] | undefined { return saved.stars?.[this.starsOwner(key)]; },
  setStars(key: string, list: unknown[]): void { (saved.stars ??= {})[this.starsOwner(key)] = list.slice(0, 200); save(); },
  lookOf(key: string): DeviceLook { return saved.paired?.[sha(key)]?.look ?? {}; },
  setLook(key: string, look: DeviceLook | null): void {
    const d = saved.paired?.[sha(key)];
    if (!d) return;
    if (look && Object.keys(look).length) d.look = look; else delete d.look;
    save();
  },
  /** Every joined device goes back to following the home's look. */
  clearLooks(): void { for (const d of Object.values(saved.paired ?? {})) delete d.look; save(); },
  get joinPin(): string { return saved.joinPin ?? ""; },
  get joinDeny(): string[] { return saved.joinDeny ?? []; },
  setJoinDeny(deny: string[]): void { if (deny.length) saved.joinDeny = deny; else delete saved.joinDeny; save(); },
  setJoinPin(pin: string): void { if (pin) saved.joinPin = pin; else delete saved.joinPin; save(); },
  /** Takes a phone or tablet out of the home: its key stops working at once. Returns its name. */
  unpair(id: string): string {
    const h = Object.keys(saved.paired ?? {}).find((k) => k.slice(0, 16) === id);
    if (!h) return "";
    const name = saved.paired![h].name;
    delete saved.paired![h];
    save();
    return name;
  },
  get pairedCount(): number { return Object.keys(saved.paired ?? {}).length; },
  /** Forgets the home. The hub's own Home Assistant login is kept: that account outlives any one home. */
  erase(): void { saved = { devices: {}, addedEntries: [], reviewed: false, ...(saved.ha ? { ha: saved.ha } : {}) }; save(); },
  // Rooms
  rooms(): Room[] {
    return (saved.rooms ?? []).map((r) => ({ id: r.id, name: r.name, ...(r.kind ? { kind: r.kind } : {}), ...(r.photoAt ? { photo: `/api/rooms/${r.id}/photo?v=${r.photoAt}` } : {}) }));
  },
  /** Finds the room by name (any capitalisation) or makes it. */
  room(name: string): string {
    const clean = name.trim().slice(0, 40);
    const list = (saved.rooms ??= []);
    const same = list.find((r) => r.name.toLowerCase() === clean.toLowerCase());
    if (same) return same.id;
    const id = randomBytes(6).toString("hex");
    list.push({ id, name: clean });
    save();
    return id;
  },
  renameRoom(id: string, name: string): void {
    const r = saved.rooms?.find((x) => x.id === id);
    if (r && name.trim()) { r.name = name.trim().slice(0, 40); save(); }
  },
  /** Puts the rooms in the given order; any left out keep their place at the end. */
  orderRooms(ids: string[]): void {
    const list = saved.rooms ?? [];
    const first = ids.map((id) => list.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => !!r);
    saved.rooms = [...new Set(first), ...list.filter((r) => !first.includes(r))];
    save();
  },
  deleteRoom(id: string): void {
    saved.rooms = (saved.rooms ?? []).filter((r) => r.id !== id);
    saved.scenes = (saved.scenes ?? []).filter((s) => s.room !== id);
    for (const map of [saved.deviceRooms ?? {}, saved.entryRooms ?? {}])
      for (const k of Object.keys(map)) map[k] = map[k].filter((r) => r !== id);
    rmSync(this.photoFile(id), { force: true });
    save();
  },
  setRoomKind(id: string, kind: RoomKind | undefined): void {
    const r = saved.rooms?.find((x) => x.id === id);
    if (!r) return;
    if (kind) r.kind = kind; else delete r.kind;
    save();
  },
  // Scenes
  /** Every home starts with one whole-home scene, Everything off. Made once; if the household removes it, it stays removed. */
  scenes(): Scene[] {
    if (saved.pin && !saved.everythingOff) {
      saved.everythingOff = true;
      const list = (saved.scenes ??= []);
      if (!list.some((s) => !s.room && /^(everything|all) off$/i.test(s.name.trim()))) list.unshift({ id: "everything-off", name: "Everything off", room: "", icon: "off", steps: [], auto: "off" });
      save();
    }
    return saved.scenes ?? [];
  },
  get scenesRefused(): string[] { return saved.scenesRefused ?? []; },
  /** Saves a new scene (no id) or changes one. Returns its id, or "" when the one to change is gone. */
  saveScene(sc: { id?: string; name: string; room: string; icon: string; steps: ControlRequest[]; when?: SceneWhen }): string {
    const list = (saved.scenes ??= []);
    const clean = { name: sc.name.trim().slice(0, 30) || "Scene", room: sc.room, icon: sc.icon, steps: sc.steps, ...(sc.when ? { when: sc.when } : {}) };
    if (sc.id) {
      const at = list.findIndex((x) => x.id === sc.id);
      if (at < 0) return "";
      list[at] = { id: sc.id, ...clean };
      save();
      return sc.id;
    }
    const id = randomBytes(6).toString("hex");
    list.push({ id, ...clean });
    save();
    return id;
  },
  sceneRan(id: string): string { return saved.scenesRan?.[id] ?? ""; },
  setSceneRan(id: string, day: string): void { (saved.scenesRan ??= {})[id] = day; save(); },
  deleteScene(id: string): void { saved.scenes = (saved.scenes ?? []).filter((s) => s.id !== id); save(); },
  refuseScene(key: string): void { const no = (saved.scenesRefused ??= []); if (!no.includes(key)) { no.push(key.slice(0, 60)); save(); } },
  photoFile(id: string): string { return join(dir, "rooms", `${id.replace(/[^a-f0-9]/g, "")}.jpg`); },
  setPhoto(id: string, jpeg: Buffer): boolean {
    const r = saved.rooms?.find((x) => x.id === id);
    if (!r) return false;
    mkdirSync(join(dir, "rooms"), { recursive: true });
    writeFileSync(this.photoFile(id), jpeg);
    r.photoAt = Date.now();
    save();
    return true;
  },
  roomsOf(id: string, entryIds: string[] = []): string[] {
    const known = new Set((saved.rooms ?? []).map((r) => r.id));
    const own = saved.deviceRooms?.[id] ?? entryIds.flatMap((e) => saved.entryRooms?.[e] ?? []);
    return [...new Set(own)].filter((r) => known.has(r));
  },
  nameOf(id: string): string { return saved.deviceNames?.[id] ?? ""; },
  setName(id: string, name: string): void { const n = name.trim().slice(0, 40); saved.deviceNames ??= {}; if (n) saved.deviceNames[id] = n; else delete saved.deviceNames[id]; save(); },
  setRooms(id: string, rooms: string[]): void { (saved.deviceRooms ??= {})[id] = rooms; save(); },
  setEntryRooms(entryId: string, rooms: string[]): void { (saved.entryRooms ??= {})[entryId] = rooms; save(); },
  get homeName(): string { return saved.homeName ?? ""; },
  setHomeName(name: string): void { saved.homeName = name.trim().slice(0, 40); save(); },
  get theme(): string { return saved.theme ?? "ivory"; },
  setTheme(theme: string): void { saved.theme = theme; save(); },
  get palette(): Palette | undefined { return saved.palette; },
  setPalette(p: Palette): void { saved.palette = p; save(); },
  get style(): string { return saved.style ?? "traditional"; },
  setStyle(style: string): void { saved.style = style; save(); },
  get custom(): { font: string; shape: string; outfits?: Record<string, string> } { return saved.custom ?? { font: "serif", shape: "traditional" }; },
  setCustom(c: { font: string; shape: string; outfits?: Record<string, string> }): void { saved.custom = c; save(); },
  get character(): string { return saved.character ?? "vincent"; },
  setCharacter(c: string): void { saved.character = c; save(); },
  get rotate(): string { return saved.rotate ?? "off"; },
  setRotate(r: string): void { saved.rotate = r; save(); },
  get voices(): Record<string, { locale: string; voice: string }> { return saved.voices ?? {}; },
  get colors(): number[] { return saved.colors ?? []; },
  keepColor(rgb: number): void { saved.colors = [...(saved.colors ?? []).filter((c) => c !== rgb), rgb].slice(-12); save(); },
  dropColor(rgb: number): void { saved.colors = (saved.colors ?? []).filter((c) => c !== rgb); save(); },
  clearVoices(): void { saved.voices = {}; save(); },
  /** The reminders one device sees: the home's, and its own. Finished ones are kept a month. */
  reminders(deviceId: string): Reminder[] {
    const old = Date.now() - 30 * 86_400_000;
    // One this device's own Apple Reminders also holds is rung by Apple there; Vincent stays quiet about it on that device.
    const held = new Set((saved.apple?.[deviceId]?.rows ?? []).filter((r) => r.kind === "rem" && r.a).map((r) => r.v));
    return (saved.reminders ?? []).filter((r) => (!r.for || r.for === deviceId) && !(r.done && Date.parse(r.done) < old)).map(({ made: _m, ...r }) => ({ ...r, mine: r.for === deviceId, ...(held.has(r.id) ? { quiet: true } : {}) }));
  },
  /** Timers still counting, and ones that ended in the last ten minutes (still ringing, until stopped). */
  timers(deviceId: string): Timer[] {
    const all = saved.timers ?? [], live = all.filter((t) => Date.parse(t.ends) > Date.now() - 10 * 60_000);
    if (live.length !== all.length) { saved.timers = live; save(); }
    return live.map(({ made, ...t }) => ({ ...t, mine: made === deviceId })).sort((a, b) => a.ends.localeCompare(b.ends));
  },
  addTimer(t: { name: string; seconds: number; by: string; made: string }): Timer {
    const timer = { id: randomBytes(6).toString("hex"), name: t.name, seconds: t.seconds, ends: new Date(Date.now() + t.seconds * 1000).toISOString(), by: t.by, made: t.made };
    saved.timers = [...(saved.timers ?? []), timer].slice(-20); save();
    return timer;
  },
  removeTimer(id: string): boolean { const had = (saved.timers ?? []).length; saved.timers = (saved.timers ?? []).filter((t) => t.id !== id); save(); return saved.timers.length !== had; },
  get allReminders(): Reminder[] { return saved.reminders ?? []; },
  setReminders(all: Reminder[]): void { saved.reminders = all.slice(-600); save(); },
  appleOf(deviceId: string): AppleSaved | undefined { const a = saved.apple?.[deviceId]; return a && { ...a, lists: { ...a.lists }, rows: a.rows.map((r) => ({ ...r })) }; },
  tvMac(entry: string): string | undefined { return saved.tvMacs?.[entry]; },
  setTvMac(entry: string, mac: string): void { saved.tvMacs = { ...saved.tvMacs, [entry]: mac }; save(); },
  wakeTaught(): Record<string, string[]> { return Object.fromEntries(Object.entries(saved.wake ?? {}).map(([k, v]) => [k, [...v]])); },
  /** Adds what a device learned: newest first, twelve ways a host at most (room for several people). True when anything was new. */
  addWake(add: Record<string, string[]>): boolean {
    const all = { ...saved.wake }; let changed = false;
    for (const [id, list] of Object.entries(add)) {
      const had = all[id] ?? [], next = [...new Set([...list, ...had])].slice(0, 12);
      if (next.length !== had.length || next.some((x, i) => x !== had[i])) { all[id] = next; changed = true; }
    }
    if (changed) { saved.wake = all; save(); }
    return changed;
  },
  clearWake(): void { if (saved.wake && Object.keys(saved.wake).length) { saved.wake = {}; save(); } },
  setApple(deviceId: string, a: AppleSaved | null): void { const all = { ...saved.apple }; if (a) all[deviceId] = a; else delete all[deviceId]; saved.apple = all; save(); },
  addReminder(r: { text: string; at: string; repeat: Repeat; for: string; by: string; made?: string }): Reminder {
    const made: Reminder = { id: randomBytes(6).toString("hex"), ...r };
    saved.reminders = [...(saved.reminders ?? []), made].slice(-300); save();
    return made;
  },
  /** Changes one reminder a device may see. Returns it as it was, or undefined when it is not theirs to change. */
  changeReminder(deviceId: string, id: string, change: (r: Reminder) => Reminder | null): Reminder | undefined {
    const was = (saved.reminders ?? []).find((r) => r.id === id && (!r.for || r.for === deviceId));
    if (!was) return undefined;
    const now = change({ ...was });
    saved.reminders = (saved.reminders ?? []).flatMap((r) => (r.id === id ? (now ? [now] : []) : [r])); save();
    return was;
  },
  clearReminders(deviceId: string): void { saved.reminders = (saved.reminders ?? []).filter((r) => !(r.done && (!r.for || r.for === deviceId))); save(); },
  setVoice(character: string, v: { locale: string; voice: string }): void { saved.voices = { ...saved.voices, [character]: v }; save(); },
  get place(): SavedPlace | undefined { return saved.place; },
  setPlace(p: SavedPlace): void { saved.place = { ...saved.place, ...p }; save(); },
  get contact(): string { return saved.contact ?? ""; },
  setContact(c: string): void { saved.contact = c.trim().slice(0, 120); save(); },
  get listsSeeded(): boolean { return Number(saved.listsSeeded) >= 2; },
  setListsSeeded(): void { saved.listsSeeded = 2; save(); },
  get reviewed(): boolean { return saved.reviewed; },
  setReviewed(): void { if (!saved.reviewed) { saved.reviewed = true; save(); } },
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
