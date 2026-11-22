/**
 * Vincent's own choices for this home, kept on the hub: which devices the household
 * added, which it ignored. Home Assistant is never asked to forget anything.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { ListStatus, Room } from "../../../packages/core/src/index.ts";

interface Saved {
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
  paired?: Record<string, { name: string; since: string }>;
  /** Vincent's own rooms. Home Assistant allows one room per device; Vincent allows several. */
  rooms?: { id: string; name: string; photoAt?: number }[];
  /** device id -> room ids */
  deviceRooms?: Record<string, string[]>;
  /** device id -> the household's own name for it. The device itself keeps its name. */
  deviceNames?: Record<string, string>;
  /** For a device that was waiting for a yes: the rooms chosen for whatever it brings. */
  entryRooms?: Record<string, string[]>;
  theme?: string;
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

// On the hub an add-on's durable folder is /data.
export const dir = process.env.SUPERVISOR_TOKEN ? "/data" : fileURLToPath(new URL("../data", import.meta.url));
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
  pair(name: string): string {
    const key = randomBytes(24).toString("base64url");
    (saved.paired ??= {})[sha(key)] = { name, since: new Date().toISOString() };
    save();
    return key;
  },
  paired(key: string): boolean { return !!key && !!saved.paired?.[sha(key)]; },
  // Rooms
  rooms(): Room[] {
    return (saved.rooms ?? []).map((r) => ({ id: r.id, name: r.name, ...(r.photoAt ? { photo: `/api/rooms/${r.id}/photo?v=${r.photoAt}` } : {}) }));
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
    for (const map of [saved.deviceRooms ?? {}, saved.entryRooms ?? {}])
      for (const k of Object.keys(map)) map[k] = map[k].filter((r) => r !== id);
    rmSync(this.photoFile(id), { force: true });
    save();
  },
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
  get style(): string { return saved.style ?? "traditional"; },
  setStyle(style: string): void { saved.style = style; save(); },
  get custom(): { font: string; shape: string; outfits?: Record<string, string> } { return saved.custom ?? { font: "serif", shape: "traditional" }; },
  setCustom(c: { font: string; shape: string; outfits?: Record<string, string> }): void { saved.custom = c; save(); },
  get character(): string { return saved.character ?? "vincent"; },
  setCharacter(c: string): void { saved.character = c; save(); },
  get rotate(): string { return saved.rotate ?? "off"; },
  setRotate(r: string): void { saved.rotate = r; save(); },
  get voices(): Record<string, { locale: string; voice: string }> { return saved.voices ?? {}; },
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
