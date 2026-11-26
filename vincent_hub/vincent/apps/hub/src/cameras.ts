/**
 * Cameras: a picture that is always there, and live view.
 *
 * Pictures. A battery camera (Ring) has no "take a picture now": what Home Assistant holds is a
 * frame from the last recorded event, and its answer comes and goes. So the hub keeps the last
 * good picture and never shows a broken one. When the app opens live view it sends back one
 * frame, which is then the newest picture for every screen in the home.
 *
 * Live view is WebRTC. The video goes straight from the camera's maker to the phone or tablet;
 * the hub only carries the handshake between the app and Home Assistant.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HA } from "./ha.ts";
import type { Devices } from "./devices.ts";

interface Pic { type: string; data: Buffer; at: number }
export type LiveEvent = { type: "answer"; sdp: string } | { type: "candidate"; candidate: string; sdpMLineIndex: number } | { type: "error"; message: string } | { type: "end" };
interface Live { entity: string; unsub?: () => void; session?: string; waiting: object[]; sent: LiveEvent[]; listeners: Set<(e: LiveEvent) => void>; cap: NodeJS.Timeout }

/**
 * Makers whose picture in Home Assistant is a frame from the last recorded event, not one taken now.
 * Every other camera gives a new picture each time it is asked, so its picture is never old.
 */
const EVENT_PICTURES = new Set(["ring"]);

/** No live view runs longer than this: a forgotten one would drain a battery camera. */
const LIVE_CAP_MS = 10 * 60_000;

export class Cameras {
  private ha: HA;
  private devices: Devices;
  /** The last picture Home Assistant gave, and when its picture last changed (0 = not seen changing yet). */
  private last = new Map<string, Pic>();
  private sig = new Map<string, string>();
  /** A frame the app took from live view. */
  private grabbed = new Map<string, Pic>();
  private lives = new Map<string, Live>();

  /** Frames the app took are kept here too, so an update of the hub does not bring back last week's picture. */
  private dir: string;

  constructor(ha: HA, devices: Devices, dataDir: string) {
    this.ha = ha; this.devices = devices; this.dir = join(dataDir, "cameras");
    try {
      mkdirSync(this.dir, { recursive: true });
      for (const f of readdirSync(this.dir)) if (f.endsWith(".jpg")) this.grabbed.set(f.slice(0, -4), { type: "image/jpeg", data: readFileSync(join(this.dir, f)), at: statSync(join(this.dir, f)).mtimeMs });
    } catch { /* no kept pictures: they come back with the first live view */ }
  }

  /** The newest picture of a camera there is: a live frame, Home Assistant's, or the last one that worked. */
  async still(controlId: string): Promise<Pic | undefined> {
    const { entityId, integration } = await this.devices.camera(controlId);
    try {
      const pic = await this.ha.picture(`/api/camera_proxy/${entityId}`);
      if (pic.data.length < 500) throw new Error("empty picture");
      const sig = `${pic.data.length}:${pic.data.subarray(0, 64).toString("hex")}:${pic.data.subarray(-64).toString("hex")}`;
      const before = this.sig.get(entityId);
      // After a restart the picture is of unknown age; only a change seen here has a time.
      const at = !EVENT_PICTURES.has(integration) ? Date.now() : before === undefined ? 0 : before === sig ? this.last.get(entityId)?.at ?? 0 : Date.now();
      this.sig.set(entityId, sig);
      this.last.set(entityId, { ...pic, at });
    } catch { /* the last good one stands in */ }
    const ha = this.last.get(entityId), mine = this.grabbed.get(entityId);
    return mine && (!ha || mine.at >= ha.at) ? mine : ha;
  }

  /** When each camera's picture was taken (0 = unknown), by control id. */
  async ages(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const [id, entityId] of await this.devices.cameras()) {
      const now = !EVENT_PICTURES.has((await this.devices.camera(id)).integration);
      out[id] = now ? Date.now() : Math.max(this.last.get(entityId)?.at ?? 0, this.grabbed.get(entityId)?.at ?? 0);
    }
    return out;
  }

  async frame(controlId: string, data: Buffer): Promise<void> {
    const { entityId } = await this.devices.camera(controlId);
    this.grabbed.set(entityId, { type: "image/jpeg", data, at: Date.now() });
    try { writeFileSync(join(this.dir, `${entityId}.jpg`), data); } catch { /* kept in memory all the same */ }
  }

  /** What the app's player needs before it can offer: the relay servers to use. */
  async config(controlId: string): Promise<{ configuration: object; candidatesUpfront: boolean }> {
    const { entityId } = await this.devices.camera(controlId);
    const c = await this.ha.call({ type: "camera/webrtc/get_client_config", entity_id: entityId }, 15000);
    return { configuration: c?.configuration ?? {}, candidatesUpfront: !!c?.getCandidatesUpfront };
  }

  async start(controlId: string, sdp: string): Promise<string> {
    const { entityId } = await this.devices.camera(controlId);
    const id = randomBytes(9).toString("hex");
    const live: Live = { entity: entityId, waiting: [], sent: [], listeners: new Set(), cap: setTimeout(() => this.stop(id), LIVE_CAP_MS) };
    this.lives.set(id, live);
    const say = (e: LiveEvent) => { live.sent.push(e); for (const l of live.listeners) l(e); };
    try {
      live.unsub = await this.ha.open({ type: "camera/webrtc/offer", entity_id: entityId, offer: sdp }, (ev) => {
        if (ev.type === "session") { live.session = ev.session_id; for (const c of live.waiting.splice(0)) this.pass(live, c); }
        else if (ev.type === "answer") say({ type: "answer", sdp: ev.answer });
        else if (ev.type === "candidate") say({ type: "candidate", candidate: ev.candidate?.candidate ?? "", sdpMLineIndex: ev.candidate?.sdp_m_line_index ?? 0 });
        else if (ev.type === "error") say({ type: "error", message: String(ev.message ?? "The camera did not answer.") });
      });
    } catch (e) { this.stop(id); throw e; }
    return id;
  }

  /** The app's own network candidates, passed on one by one. Ring sends video only once it has them this way. */
  candidate(id: string, c: { candidate?: unknown; sdpMid?: unknown; sdpMLineIndex?: unknown }): void {
    const live = this.lives.get(id);
    if (!live || typeof c.candidate !== "string") return;
    const one = { candidate: c.candidate, sdpMid: typeof c.sdpMid === "string" ? c.sdpMid : "0", sdpMLineIndex: Number(c.sdpMLineIndex ?? 0) || 0 };
    if (live.session) this.pass(live, one); else if (live.waiting.length < 60) live.waiting.push(one);
  }
  private pass(live: Live, candidate: object): void {
    this.ha.call({ type: "camera/webrtc/candidate", entity_id: live.entity, session_id: live.session, candidate }).catch(() => {});
  }

  /** Everything said so far, then everything said from now on. Returns how to stop listening. */
  listen(id: string, fn: (e: LiveEvent) => void): (() => void) | undefined {
    const live = this.lives.get(id);
    if (!live) return undefined;
    for (const e of live.sent) fn(e);
    live.listeners.add(fn);
    return () => live.listeners.delete(fn);
  }

  stop(id: string): void {
    const live = this.lives.get(id);
    if (!live) return;
    this.lives.delete(id);
    clearTimeout(live.cap);
    live.unsub?.();
    for (const l of live.listeners) l({ type: "end" });
  }
}
