/**
 * Room to room: announcements and calls between the phones and tablets of one home.
 *
 * The hub only introduces the two ends and passes notes between them. An announcement's
 * recording is held here for a few minutes so the other screens can fetch it; a call's
 * picture and sound go straight from one screen to the other and never pass through the hub.
 *
 * A screen can be reached while the Vincent app is open on it. Each open screen keeps one
 * line to the hub (`listen`) and says which room it lives in.
 */
import { randomBytes } from "node:crypto";

/** One open screen. `id` names the phone or tablet (stable across restarts); `room` is "" when it has no room of its own. */
interface Screen { line: string; id: string; name: string; room: string; send: (event: string, data: unknown) => void }
interface Clip { data: Buffer; type: string; at: number }
interface Call { id: string; from: Screen; rung: Screen[]; to?: Screen; at: number; timer?: NodeJS.Timeout }

/** Someone who can be called or announced to: a room with a screen in it, or a screen with no room. */
export interface Place { id: string; name: string; kind: "room" | "screen"; screens: number }

const CLIP_KEEP_MS = 5 * 60_000;
const RING_MS = 30_000;

export class Intercom {
  private screens = new Map<string, Screen>();
  private clips = new Map<string, Clip>();
  private calls = new Map<string, Call>();
  private roomName: (id: string) => string;

  constructor(roomName: (id: string) => string) { this.roomName = roomName; }

  /** An app came to the front. Returns how to hang up the line. */
  listen(device: { id: string; name: string }, room: string, send: Screen["send"]): () => void {
    const line = randomBytes(8).toString("hex");
    const screen: Screen = { line, ...device, room: this.roomName(room) ? room : "", send };
    this.screens.set(line, screen);
    send("hello", { line });
    this.tellPlaces();
    return () => {
      this.screens.delete(line);
      for (const c of [...this.calls.values()]) if (c.from.line === line || c.to?.line === line) this.end(c.id, line);
      this.tellPlaces();
    };
  }

  private tellPlaces(): void { for (const s of this.screens.values()) s.send("places", this.places(s.id)); }

  /** Where `device` can reach right now. Its own screen is left out; its own room stays if another screen is in it. */
  places(device: string): Place[] {
    const others = [...this.screens.values()].filter((s) => s.id !== device);
    const rooms = new Map<string, Set<string>>();
    const loose = new Map<string, string>();
    for (const s of others) {
      if (s.room) (rooms.get(s.room) ?? rooms.set(s.room, new Set()).get(s.room)!).add(s.id);
      else loose.set(s.id, s.name);
    }
    return [
      ...[...rooms].map(([id, set]): Place => ({ id: `room:${id}`, name: this.roomName(id), kind: "room", screens: set.size })),
      ...[...loose].map(([id, name]): Place => ({ id: `screen:${id}`, name, kind: "screen", screens: 1 })),
    ].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The open screens a place id means, never the asker's own phone or tablet. */
  private at(place: string, asker: string): Screen[] {
    const others = [...this.screens.values()].filter((s) => s.id !== asker);
    if (place === "all") return others;
    if (place.startsWith("room:")) return others.filter((s) => s.room === place.slice(5));
    if (place.startsWith("screen:")) return others.filter((s) => s.id === place.slice(7));
    return [];
  }
  private whoIs(line: string): Screen {
    const s = this.screens.get(line);
    if (!s) throw new Error("This screen's line to the hub dropped. Try again in a moment.");
    return s;
  }
  private label(s: Screen): string { return s.room ? this.roomName(s.room) : s.name; }

  /** Plays a recording on every screen in the places given. Returns how many screens it reached. */
  announce(line: string, places: string[], data: Buffer, type: string, seconds: number): { reached: number } {
    const from = this.whoIs(line);
    for (const [id, c] of this.clips) if (Date.now() - c.at > CLIP_KEEP_MS) this.clips.delete(id);
    const reach = new Map<string, Screen>();
    for (const p of places) for (const s of this.at(p, from.id)) reach.set(s.line, s);
    if (!reach.size) return { reached: 0 };
    const id = randomBytes(10).toString("hex");
    this.clips.set(id, { data, type, at: Date.now() });
    for (const s of reach.values()) s.send("announce", { clip: id, from: this.label(from), seconds: Math.min(60, Math.max(1, Math.round(seconds) || 1)) });
    console.log(`[intercom] announcement from ${this.label(from)} to ${reach.size} screen(s), ${Math.round(data.length / 1000)} kB`);
    return { reached: reach.size };
  }
  clip(id: string): Clip | undefined { return this.clips.get(id); }

  /** Rings every screen in a place. The first to answer takes the call; the rest stop ringing. */
  call(line: string, place: string): { call: string; ringing: number; name: string } {
    const from = this.whoIs(line);
    const rung = this.at(place, from.id);
    if (!rung.length) throw new Error("Nobody has Vincent open there right now.");
    for (const c of this.calls.values()) if (c.from.id === from.id || rung.some((s) => s.id === c.to?.id)) throw new Error(c.from.id === from.id ? "You are already on a call." : "That room is on another call.");
    const c: Call = { id: randomBytes(8).toString("hex"), from, rung, at: Date.now() };
    c.timer = setTimeout(() => { if (!c.to) this.end(c.id, "", "Nobody answered."); }, RING_MS);
    this.calls.set(c.id, c);
    for (const s of rung) s.send("ring", { call: c.id, from: this.label(from) });
    console.log(`[intercom] ${this.label(from)} is calling ${place} (${rung.length} screen(s))`);
    return { call: c.id, ringing: rung.length, name: this.label(rung[0]) };
  }

  answer(line: string, id: string): void {
    const c = this.calls.get(id), me = this.whoIs(line);
    if (!c || c.to || !c.rung.some((s) => s.line === line)) throw new Error("That call is over.");
    c.to = me;
    clearTimeout(c.timer);
    for (const s of c.rung) if (s.line !== line) s.send("end", { call: id, why: "Answered on another screen." });
    c.from.send("answered", { call: id, by: this.label(me) });
  }

  /** Passes a note of the handshake (an offer, an answer, a route) to the other end. */
  signal(line: string, id: string, data: unknown): void {
    const c = this.calls.get(id);
    if (!c?.to) return;
    const other = c.from.line === line ? c.to : c.to.line === line ? c.from : undefined;
    other?.send("signal", { call: id, data });
  }

  end(id: string, line: string, why = ""): void {
    const c = this.calls.get(id);
    if (!c) return;
    clearTimeout(c.timer);
    this.calls.delete(id);
    for (const s of new Set([c.from, ...(c.to ? [c.to] : c.rung)])) if (s.line !== line) s.send("end", { call: id, why: why || (c.to ? "" : s === c.from ? "They are busy right now." : "") });
  }
}
