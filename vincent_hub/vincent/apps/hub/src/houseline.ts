/**
 * THE HOUSE LINE. One home only (the owner's own): it joins this hub's intercom to the older Vincent that
 * still runs in that house, so the app can call Otto (a machine in the basement with a camera, a microphone
 * and a screen) and Otto can call the app. It is off unless the hub service is given the address of that
 * house's line (`house_line`, or VINCENT_HOUSE_LINE); nothing here is part of what is sold.
 *
 * The older Vincent pairs two screens over one socket per screen: hello {dev, here}, then call.start,
 * call.started, call.incoming, call.signal, call.end, call.failed. The handshake notes (offers, answers,
 * routes) have the same shape as ours, so this only translates who is calling whom and passes notes through;
 * picture and sound still go straight between the two ends.
 *
 *   Here, Otto is one more screen that can be called ("Otto").
 *   There, this hub stands in for a tablet in every room of the house but Otto's own, so Otto can ring a room.
 *   A room with the same name here, with the app open in it, rings; otherwise every open screen rings.
 */
import { readFileSync } from "node:fs";
import type { Intercom } from "./intercom.ts";

interface Room { id: string; name: string }
/** One call across the two systems. `held` keeps Otto's notes until somebody here answers. */
interface Bridged { house: string; ours: string; sock: WebSocket; answered: boolean; held: unknown[] }

const OTTO = "otto";

export class HouseLine {
  private host = "";
  private intercom: Intercom;
  private rooms: () => Room[];
  private socks = new Map<string, WebSocket>();
  private names = new Map<string, string>();
  private line = "";
  private hangUp: (() => void) | undefined;
  private calls: Bridged[] = [];
  private asking = "";
  private ottoRoom = "basement_lounge";

  constructor(intercom: Intercom, rooms: () => Room[]) {
    this.intercom = intercom; this.rooms = rooms;
    let host = process.env.VINCENT_HOUSE_LINE ?? "";
    if (!host) try { host = String(JSON.parse(readFileSync("/data/options.json", "utf8")).house_line ?? ""); } catch { /* none */ }
    this.host = host.trim().replace(/^\w+:\/\//, "").replace(/[:/].*$/, "");
    if (!this.host) return;
    console.log(`[houseline] joining the house at ${this.host}`);
    void this.look();
    setInterval(() => void this.look(), 60_000).unref();
  }

  /** Which rooms the house has, and which one Otto is in; a socket for each of the others. */
  private async look(): Promise<void> {
    try {
      const get = async (p: string) => (await fetch(`http://${this.host}:8812${p}`, { signal: AbortSignal.timeout(6000) })).json() as Promise<any>;
      const home = await get("/vh/home");
      const there = await get("/vh/presence").catch(() => ({}));
      const otto = (there.sockets ?? []).find((s: any) => s.dev === OTTO)?.here;
      if (otto) this.ottoRoom = String(otto);
      for (const r of home.rooms ?? []) {
        this.names.set(String(r.id), String(r.name));
        if (r.id !== this.ottoRoom && !this.socks.has(r.id)) this.open(String(r.id));
      }
    } catch { /* the house is not answering; the next look tries again */ }
  }

  private open(room: string): void {
    const sock = new WebSocket(`ws://${this.host}:8813/ws`);
    this.socks.set(room, sock);
    sock.onopen = () => { sock.send(JSON.stringify({ type: "hello", dev: `vc-${room}`, here: room, touch: false, screen: "hub" })); this.present(); };
    sock.onmessage = (e) => { try { this.heard(room, sock, JSON.parse(String(e.data))); } catch { /* not ours */ } };
    sock.onclose = () => {
      if (this.socks.get(room) === sock) this.socks.delete(room);
      for (const c of this.calls.filter((c) => c.sock === sock)) { this.drop(c); this.endOurs(c.ours, "The line to the house dropped."); }
      this.present();
    };
    sock.onerror = () => { /* close follows */ };
  }
  private up(): WebSocket | undefined { return [...this.socks.values()].find((s) => s.readyState === WebSocket.OPEN); }

  /** Otto is somebody to call here for as long as the house can be reached. */
  private present(): void {
    if (this.up() && !this.hangUp) this.hangUp = this.intercom.listen({ id: OTTO, name: "Otto", person: "house" }, "", (event, data) => this.told(event, data as any));
    else if (!this.up() && this.hangUp) { this.hangUp(); this.hangUp = undefined; this.line = ""; }
  }
  private drop(c: Bridged): void { this.calls = this.calls.filter((x) => x !== c); }
  private endOurs(id: string, why: string): void { try { this.intercom.end(id, this.line, why); } catch { /* already over */ } }

  /** What this hub's intercom tells the screen called Otto. */
  private told(event: string, d: { line?: string; call?: string; data?: unknown }): void {
    if (event === "hello") { this.line = d.line ?? ""; return; }
    if (!d.call) return;
    const c = this.calls.find((x) => x.ours === d.call);
    if (event === "ring") {
      const sock = this.up();
      if (!sock || this.asking) return this.endOurs(d.call, "Otto is not on the line right now.");
      this.asking = d.call;
      sock.send(JSON.stringify({ type: "call.start", room: this.ottoRoom }));
      console.log("[houseline] the app is calling Otto");
    } else if (event === "answered" && c) {
      // Otto offered the moment he rang; the screen that picked up needs a moment before it can take notes.
      setTimeout(() => { c.answered = true; for (const n of c.held.splice(0)) this.intercom.signal(this.line, c.ours, n); }, 1500);
    } else if (event === "signal" && c) {
      c.sock.send(JSON.stringify({ type: "call.signal", call: c.house, data: d.data }));
    } else if (event === "end") {
      if (this.asking === d.call) this.asking = "";
      if (c) { this.drop(c); c.sock.send(JSON.stringify({ type: "call.end", call: c.house })); }
    }
  }

  /** What the house says on the socket that stands in for `room`. */
  private heard(room: string, sock: WebSocket, m: { type?: string; call?: any; from?: string; message?: string; data?: unknown }): void {
    const id = typeof m.call === "string" ? m.call : m.call?.id;
    const c = this.calls.find((x) => x.house === id);
    const over = () => sock.send(JSON.stringify({ type: "call.end", call: id }));
    switch (m.type) {
      case "call.started": {
        const ours = this.asking; this.asking = "";
        if (!ours || !id) { if (id) over(); return; }
        try { this.calls.push({ house: id, ours, sock, answered: true, held: [] }); this.intercom.answer(this.line, ours); }
        catch { this.calls = this.calls.filter((x) => x.house !== id); over(); }
        return;
      }
      case "call.failed": { const ours = this.asking; this.asking = ""; if (ours) this.endOurs(ours, m.message?.replace(/No tablet is free.*/, "Otto is not on the line right now.") ?? ""); return; }
      case "call.incoming": {
        if (!id) return;
        const name = (this.names.get(room) ?? "").toLowerCase();
        const here = this.rooms().find((r) => r.name.toLowerCase() === name);
        const place = here && this.intercom.count(`room:${here.id}`, OTTO) ? `room:${here.id}` : "all";
        try { const r = this.intercom.call(this.line, place); this.calls.push({ house: id, ours: r.call, sock, answered: false, held: [] }); console.log(`[houseline] ${m.from ?? "The house"} is calling ${this.names.get(room) ?? room}`); }
        catch { over(); }
        return;
      }
      case "call.signal": if (c) { if (c.answered) this.intercom.signal(this.line, c.ours, m.data); else c.held.push(m.data); } return;
      case "call.end": if (c) { this.drop(c); this.endOurs(c.ours, m.message ?? ""); } return;
    }
  }
}
