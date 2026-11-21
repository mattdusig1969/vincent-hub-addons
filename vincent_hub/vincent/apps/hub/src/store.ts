/**
 * Vincent's own choices for this home, kept on the hub: which devices the household
 * added, which it ignored. Home Assistant is never asked to forget anything.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { ListStatus } from "../../../packages/core/src/index.ts";

interface Saved {
  /** device id -> added | ignored. Absent = found. */
  devices: Record<string, "added" | "ignored">;
  /** Integrations the household said yes to: every device they bring is added. */
  addedEntries: string[];
  reviewed: boolean;
  owner?: string;
  /** The admin PIN, salted and hashed. Never stored in the clear. */
  pin?: { salt: string; hash: string };
  /** The hub's own Home Assistant login, so the household is never locked out of it. */
  ha?: { username: string; password: string };
  /** Phones and tablets allowed to talk to this home: sha-256 of each one's key -> its name. */
  paired?: Record<string, { name: string; since: string }>;
}

// On the hub an add-on's durable folder is /data.
const dir = process.env.SUPERVISOR_TOKEN ? "/data" : fileURLToPath(new URL("../data", import.meta.url));
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
  get reviewed(): boolean { return saved.reviewed; },
  setReviewed(): void { if (!saved.reviewed) { saved.reviewed = true; save(); } },
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
