/**
 * "Now playing" on the iPhone's Lock Screen (a Live Activity).
 *
 * Each phone follows the speaker IT last played or controlled. When that speaker plays, the hub asks Apple to
 * put the card up on the phone (the app need not be open); it keeps the song, artist and play state current,
 * and takes the card down once the speaker has been quiet for a while. A phone that swipes the card away is
 * left alone until its speaker next goes quiet and starts again. The card's buttons are ordinary
 * POST /api/control calls made by the app.
 *
 * Apple only takes these messages from someone holding the app's push key. For now that key is a setting of
 * the hub service (`push_key`, `push_key_id`), like the picture key; when this is sold it moves to a service
 * of ours, so the key is on no hub. `send()` is the one place that changes. With no key, phones still
 * register and nothing is sent.
 *
 * The names in `Content` are a contract with ios/Shared/NowPlayingActivity.swift: change both together.
 */
import { connect, constants, type ClientHttp2Session } from "node:http2";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Device, Room } from "../../../packages/core/src/index.ts";
import { dir } from "./store.ts";

const TICK_MS = 3000;
const END_AFTER_MS = 15 * 60_000;
const ATTR_TYPE = "VincentNowPlaying";
const TEAM = process.env.VINCENT_PUSH_TEAM || "P3Z4PY2VXA";
const TOPIC = process.env.VINCENT_PUSH_TOPIC || "com.dfcllc.vincent";

interface Content { id: string; room: string; title: string; artist: string; playing: boolean; paper?: string; ink?: string; accent?: string }
/** The colours of the style the phone's owner chose, so the card matches the app. Without them the card is the phone's own plain one. */
interface Look { paper: string; ink: string; accent: string }
interface Reg {
  /** The speaker (control id) this phone last played or controlled. */
  follows?: string;
  look?: Look;
  startToken?: string;
  activities: Record<string, { token: string; at: number }>;
  lastSent?: string;
  /** A stretch of playing, from the first song to fifteen quiet minutes after the last. */
  session?: number; sessionOpen?: boolean; lastPlayingAt?: number;
  /** The session in which the person swiped the card away: no new card until the next one. */
  dismissedSession?: number;
  lastStartAt?: number;
  env?: "sandbox" | "production";
}
type Env = "sandbox" | "production";

export class NowPlaying {
  private file = join(dir, "nowplaying.json");
  private regs: Record<string, Reg> = {};
  private key: { id: string; text: string; key: KeyObject } | null = null;
  private jwt: { token: string; at: number; id: string } | null = null;
  private h2: Partial<Record<Env, ClientHttp2Session>> = {};
  private recent: { at: string; phone: string; event: string; status: number; reason?: string }[] = [];
  private busy = false;

  private house: () => Promise<{ devices: Device[]; rooms: Room[]; phones: string[] }>;

  constructor(house: () => Promise<{ devices: Device[]; rooms: Room[]; phones: string[] }>) {
    this.house = house;
    try { if (existsSync(this.file)) this.regs = JSON.parse(readFileSync(this.file, "utf8")).phones ?? {}; } catch { /* start empty */ }
    setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      void this.tick().catch((e) => console.log(`[nowplaying] tick failed: ${e}`)).finally(() => { this.busy = false; });
    }, TICK_MS);
  }

  private save() { try { writeFileSync(this.file, JSON.stringify({ phones: this.regs })); } catch { /* next time */ } }

  // ---------- Apple's key ----------

  private credentials(): typeof this.key {
    let text = process.env.VINCENT_PUSH_KEY ?? "", id = process.env.VINCENT_PUSH_KEY_ID ?? "";
    if (!text) try { const o = JSON.parse(readFileSync("/data/options.json", "utf8")); text = String(o.push_key ?? ""); id = String(o.push_key_id ?? ""); } catch { /* none */ }
    if (text && existsSync(text)) text = readFileSync(text, "utf8");
    if (!text || !id) return null;
    if (this.key && this.key.id === id && this.key.text === text) return this.key;
    try {
      // The setting is one line: put the key's own lines back.
      const raw = text.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
      const pem = `-----BEGIN PRIVATE KEY-----\n${raw.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
      this.key = { id, text, key: createPrivateKey(pem) };
      this.jwt = null;
      console.log(`[nowplaying] push key ${id} loaded`);
      return this.key;
    } catch (e) { console.log(`[nowplaying] the push key cannot be read: ${e}`); return null; }
  }

  private bearer(k: NonNullable<typeof this.key>): string {
    if (this.jwt && this.jwt.id === k.id && Date.now() - this.jwt.at < 45 * 60_000) return this.jwt.token;
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = `${b64({ alg: "ES256", kid: k.id })}.${b64({ iss: TEAM, iat: Math.floor(Date.now() / 1000) })}`;
    const sig = sign("sha256", Buffer.from(head), { key: k.key, dsaEncoding: "ieee-p1363" }).toString("base64url");
    this.jwt = { token: `${head}.${sig}`, at: Date.now(), id: k.id };
    return this.jwt.token;
  }

  private line(env: Env): ClientHttp2Session {
    const s = this.h2[env];
    if (s && !s.closed && !s.destroyed) return s;
    const ns = connect(env === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com");
    ns.on("error", () => { /* a new line next time */ });
    ns.on("close", () => { if (this.h2[env] === ns) this.h2[env] = undefined; });
    this.h2[env] = ns;
    return ns;
  }

  /** One message to Apple. The one place to change when the key moves off the hub to a service of ours. */
  private send(env: Env, token: string, payload: object, priority: 5 | 10): Promise<{ status: number; reason?: string }> {
    const k = this.credentials();
    if (!k) return Promise.resolve({ status: 0, reason: "no push key" });
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: { status: number; reason?: string }) => { if (!done) { done = true; resolve(r); } };
      try {
        const req = this.line(env).request({
          [constants.HTTP2_HEADER_METHOD]: "POST", [constants.HTTP2_HEADER_PATH]: `/3/device/${token}`,
          authorization: `bearer ${this.bearer(k)}`, "apns-push-type": "liveactivity", "apns-topic": `${TOPIC}.push-type.liveactivity`, "apns-priority": String(priority),
        });
        let status = 0, text = "";
        req.on("response", (h) => { status = Number(h[constants.HTTP2_HEADER_STATUS] ?? 0); });
        req.setEncoding("utf8");
        req.on("data", (c: string) => { text += c; });
        req.on("end", () => { let reason: string | undefined; try { reason = JSON.parse(text).reason; } catch { /* empty = fine */ } finish({ status, reason }); });
        req.on("error", (e) => finish({ status: 0, reason: String(e) }));
        req.setTimeout(10_000, () => { req.close(); finish({ status: 0, reason: "timeout" }); });
        req.end(JSON.stringify(payload));
      } catch (e) { finish({ status: 0, reason: String(e) }); }
    });
  }

  /** A TestFlight or App Store copy is on Apple's production line, one run from Xcode on the sandbox: try the likely one, then the other, and remember. */
  private async push(phone: string, token: string, payload: object, priority: 5 | 10, event: string): Promise<number> {
    const reg = this.regs[phone];
    const order: Env[] = reg?.env === "sandbox" ? ["sandbox", "production"] : ["production", "sandbox"];
    let last: { status: number; reason?: string } = { status: 0 };
    for (const env of order) {
      last = await this.send(env, token, payload, priority);
      if (last.status === 200) { if (reg) reg.env = env; break; }
      if (last.reason !== "BadDeviceToken" && last.reason !== "BadEnvironmentKeyInToken") break;
    }
    this.recent.unshift({ at: new Date().toISOString(), phone: phone.slice(0, 6), event, status: last.status, reason: last.reason });
    this.recent.length = Math.min(this.recent.length, 30);
    if (last.status !== 200 && last.reason !== "no push key") console.log(`[nowplaying] ${event} for ${phone.slice(0, 6)} refused: ${last.status} ${last.reason ?? ""}`);
    else if (last.status === 200 && event !== "update") console.log(`[nowplaying] ${event} sent to ${phone.slice(0, 6)}`);
    return last.status === 200 ? 200 : last.reason === "Unregistered" || last.reason === "ExpiredToken" ? 410 : last.status;
  }

  // ---------- what each phone shows ----------

  /** This phone played or controlled this speaker: it follows it from now on. */
  note(phone: string, control: string) {
    const reg = (this.regs[phone] ??= { activities: {} });
    if (reg.follows === control) return;
    reg.follows = control; reg.lastSent = undefined; reg.dismissedSession = undefined;
    this.save();
  }

  /** What the phone's app reports: its tokens, and a card ended or swiped away. */
  register(phone: string, b: Record<string, unknown>): boolean {
    const token = typeof b.token === "string" && /^[0-9a-f]{32,400}$/i.test(b.token) ? b.token.toLowerCase() : undefined;
    const activity = typeof b.activity === "string" ? b.activity.slice(0, 80) : "";
    const reg = (this.regs[phone] ??= { activities: {} });
    const hex = (v: unknown) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : "");
    if (b.kind === "look") {
      const look = { paper: hex(b.paper), ink: hex(b.ink), accent: hex(b.accent) };
      if (!look.paper || !look.ink || !look.accent) return false;
      if (JSON.stringify(reg.look) !== JSON.stringify(look)) { reg.look = look; reg.lastSent = undefined; this.save(); }
      return true;
    }
    // The cards really showing on the phone. One the hub still remembers but the phone no longer has was taken down by iOS.
    if (Array.isArray(b.cards)) {
      const live = new Set(b.cards.map(String));
      for (const id of Object.keys(reg.activities)) if (!live.has(id) && id !== activity) { delete reg.activities[id]; reg.lastSent = undefined; console.log(`[nowplaying] ${phone.slice(0, 6)} no longer shows a card the hub remembered`); }
    }
    if (b.kind === "start" && token) reg.startToken = token;
    else if (b.kind === "update" && token && activity) { reg.activities[activity] = { token, at: Date.now() }; reg.lastSent = undefined; }
    else if ((b.kind === "ended" || b.kind === "dismissed") && activity) { delete reg.activities[activity]; if (b.kind === "dismissed") reg.dismissedSession = reg.session; }
    else return false;
    this.save();
    console.log(`[nowplaying] ${phone.slice(0, 6)} reported ${b.kind}`);
    return true;
  }

  status() {
    return { key: !!this.credentials(), phones: Object.fromEntries(Object.entries(this.regs).map(([p, r]) => [p.slice(0, 6), { follows: r.follows, startToken: !!r.startToken, cards: Object.keys(r.activities).length, playing: !!r.sessionOpen, env: r.env }])), recent: this.recent };
  }

  private content(devices: Device[], rooms: Room[], id?: string): Content | null {
    if (!id) return null;
    for (const d of devices) for (const c of d.controls) {
      if (c.id !== id || c.kind !== "media" || d.status !== "added") continue;
      const where = rooms.find((r) => r.id === d.rooms[0])?.name ?? d.name;
      const from = (c.app ?? c.source ?? "").trim();
      const title = (c.title ?? "").trim() || from || "Playing";
      const artist = (c.artist ?? "").trim() || ((c.title ?? "").trim() ? from : "");
      return { id, room: where, title: title.slice(0, 120), artist: artist.slice(0, 120), playing: c.state === "playing" };
    }
    return null;
  }

  private async tick() {
    if (!Object.keys(this.regs).length || !this.credentials()) return;
    const { devices, rooms, phones } = await this.house();
    const now = Date.now(), secs = Math.floor(now / 1000);
    let dirty = false;
    for (const [phone, reg] of Object.entries(this.regs)) {
      if (!phones.includes(phone)) { delete this.regs[phone]; dirty = true; continue; } // it left the home
      const plain = this.content(devices, rooms, reg.follows);
      const c = plain && reg.look ? { ...plain, ...reg.look } : plain;
      if (c?.playing) {
        reg.lastPlayingAt = now;
        if (!reg.sessionOpen) { reg.sessionOpen = true; reg.session = (reg.session ?? 0) + 1; dirty = true; }
      }
      if (reg.sessionOpen && !c?.playing && now - (reg.lastPlayingAt ?? 0) > END_AFTER_MS) {
        reg.sessionOpen = false; reg.lastSent = undefined; dirty = true;
        for (const [id, a] of Object.entries(reg.activities)) { await this.push(phone, a.token, { aps: { timestamp: secs, event: "end", "dismissal-date": secs } }, 5, "end"); delete reg.activities[id]; }
        continue;
      }
      if (!c) continue;
      const key = JSON.stringify(c);
      if (key === reg.lastSent) continue;
      const before = reg.lastSent ? (JSON.parse(reg.lastSent) as Content) : null;
      const urgent = !before || before.playing !== c.playing || before.id !== c.id;
      const cards = Object.entries(reg.activities);
      if (cards.length) {
        for (const [id, a] of cards) {
          const st = await this.push(phone, a.token, { aps: { timestamp: secs, event: "update", "content-state": c, "stale-date": secs + 6 * 3600 } }, urgent ? 10 : 5, "update");
          if (st === 410) delete reg.activities[id];
        }
        reg.lastSent = key; dirty = true;
      } else if (c.playing && reg.startToken && reg.dismissedSession !== reg.session && now - (reg.lastStartAt ?? 0) > 60_000) {
        reg.lastStartAt = now; dirty = true;
        const st = await this.push(phone, reg.startToken, { aps: {
          timestamp: secs, event: "start", "content-state": c, "attributes-type": ATTR_TYPE, attributes: { home: "Vincent" },
          alert: { title: c.title, body: c.artist ? `${c.artist} · ${c.room}` : c.room },
        } }, 10, "start");
        if (st === 200) reg.lastSent = key;
      }
    }
    if (dirty) this.save();
  }
}
