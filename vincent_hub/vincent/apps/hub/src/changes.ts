/**
 * The home's change log: who changed what, in plain words, newest first.
 * Settings and set-up are recorded (a scene made, a device added, a phone joined), and so is everyday use
 * that somebody may want to look back on: locks, doors, lights switched, thermostats set, music started.
 * Each line has a kind, so the list can be narrowed. Sliders and colours are not written down.
 * "Who" is the phone or tablet the change came from, and the person using it when they said who they are.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dir } from "./store.ts";

export interface Change { at: string; who: string; what: string; /** settings (the default), locks, doors, lights, climate, media or scenes. */ kind?: string }
const file = join(dir, "changes.json");
const KEPT = 3000;

let list: Change[] = [];
try { if (existsSync(file)) list = JSON.parse(readFileSync(file, "utf8")); } catch { list = []; }

export const changes = {
  add(who: string, what: string, kind = "settings"): void {
    const text = what.trim().slice(0, 200);
    if (!text) return;
    // The same thing done twice in a minute (a slider nudged, a double tap) is one change.
    const last = list[list.length - 1];
    if (last && last.who === who && last.what === text && Date.now() - Date.parse(last.at) < 60_000) return;
    list.push({ at: new Date().toISOString(), who: who || "Someone", what: text, ...(kind !== "settings" ? { kind } : {}) });
    if (list.length > KEPT) list = list.slice(-KEPT);
    try { writeFileSync(file + ".tmp", JSON.stringify(list)); renameSync(file + ".tmp", file); } catch { /* kept in memory until the next one */ }
  },
  recent(n = 800): Change[] { return list.slice(-n).reverse(); },
};
