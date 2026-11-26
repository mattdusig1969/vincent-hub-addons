/**
 * Runs scenes. A scene is a list of the same requests a tap on a control sends, so running
 * one is sending them all at once, and "put it back" is sending what was there before.
 */
import { randomBytes } from "node:crypto";
import type { ControlRequest, Device, SceneWhen } from "../../../packages/core/src/index.ts";
import { ROOM_KINDS, SCENE_ICONS, sceneCan, stepFits, stepNow } from "../../../packages/core/src/index.ts";
import type { Devices } from "./devices.ts";
import type { Media } from "./media.ts";

/** What a scene may ask of a control. No "unlock": a scene never opens a door. No thermostats yet. */
const ALLOWED = new Set(["on", "off", "brightness", "open", "close", "lock", "play", "pause"]);
const KINDS = new Set(["favourite", "playlist", "radio", "input", "sxm", "spotify"]);
const UNDO_FOR = 5 * 60_000;

export const isRoomKind = (k: unknown): boolean => ROOM_KINDS.some((x) => x.id === k);
export const sceneIcon = (i: unknown): string => (typeof i === "string" && i in SCENE_ICONS ? i : "spark");

/** A schedule as the app sent it, kept only if it makes sense. */
export function cleanWhen(raw: any): SceneWhen | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const at = raw.at === "sunrise" || raw.at === "sunset" ? raw.at : "time";
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw.time)) ? String(raw.time) : "19:00";
  const days = [...new Set((Array.isArray(raw.days) ? raw.days : []).map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() as number[];
  const offset = Math.max(-180, Math.min(180, Math.round(Number(raw.offset) || 0)));
  return { on: !!raw.on && days.length > 0, at, time, offset, days };
}

/** Keeps only steps a scene is allowed to hold, one per control. */
export function cleanSteps(raw: unknown): ControlRequest[] {
  const seen = new Set<string>(), out: ControlRequest[] = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    const id = String(s?.id ?? ""), action = String(s?.action ?? "");
    if (!id || seen.has(id) || !ALLOWED.has(action)) continue;
    seen.add(id);
    if (action === "brightness") {
      const kelvin = Number(s.kelvin), rgb = Number(s.rgb);
      out.push({ id, action, value: Math.min(100, Math.max(1, Math.round(Number(s.value) || 1))), ...(kelvin >= 1500 && kelvin <= 9000 ? { kelvin: Math.round(kelvin) } : s.rgb !== undefined && rgb >= 0 && rgb <= 0xffffff ? { rgb: Math.round(rgb) } : {}) });
    } else if (action === "play") {
      // A scene starts something particular; "carry on playing" is only for putting a room back.
      const item = s.item;
      if (!item || !KINDS.has(String(item.kind)) || !String(item.id ?? "")) { seen.delete(id); continue; }
      const volume = Number(s.value);
      out.push({ id, action, item: { kind: String(item.kind), id: String(item.id).slice(0, 400), title: String(item.title ?? "").slice(0, 80) }, ...(s.value !== undefined && volume >= 0 && volume <= 100 ? { value: Math.round(volume) } : {}) });
    } else out.push({ id, action: action as ControlRequest["action"] });
    if (out.length >= 200) break;
  }
  return out;
}

export class Scenes {
  private devices: Devices;
  private media: Media;
  private undo = new Map<string, { steps: ControlRequest[]; until: number }>();
  constructor(devices: Devices, media: Media) { this.devices = devices; this.media = media; }

  /** Sets everything the steps name. Returns how many did not take, and a ticket to put the room back as it was. */
  async run(steps: ControlRequest[]): Promise<{ done: number; failed: number; undo: string }> {
    const all = await this.devices.all();
    const live = this.known(steps, all);
    // How each thing is now, so it can be put back.
    const before = live.map(({ c }) => stepNow(c)).filter((s): s is ControlRequest => !!s);
    const failed = await this.send(live.map((l) => l.step));
    const undo = randomBytes(8).toString("hex");
    for (const [k, v] of this.undo) if (v.until < Date.now()) this.undo.delete(k);
    this.undo.set(undo, { steps: before, until: Date.now() + UNDO_FOR });
    return { done: live.length - failed, failed, undo };
  }

  /** Puts back what a run changed. False when the ticket is too old. */
  async back(ticket: string): Promise<boolean> {
    const kept = this.undo.get(ticket);
    this.undo.delete(ticket);
    if (!kept || kept.until < Date.now()) return false;
    await this.send(this.known(kept.steps, await this.devices.all()).map((l) => l.step));
    return true;
  }

  /** Steps whose control is still there, on a device the household added, and answering. */
  private known(steps: ControlRequest[], all: Device[]) {
    const out: { step: ControlRequest; c: Device["controls"][number] }[] = [];
    for (const step of steps) {
      for (const d of all) {
        if (d.status !== "added") continue;
        const c = d.controls.find((x) => x.id === step.id);
        if (c && c.available && sceneCan(c) && stepFits(step, c)) out.push({ step, c });
      }
    }
    return out;
  }

  /** One step. A speaker told what to play is set to its volume first, so it never starts too loud. */
  private async one(s: ControlRequest): Promise<void> {
    if (s.action !== "play" || !s.item) return this.devices.control(s);
    // A TV asked for an input or an app: it has to be on and awake first, and that takes a while.
    if (s.item.kind === "input") {
      await this.devices.powerOn(s.id);
      await this.media.play(s.id, s.item);
      return;
    }
    if (s.value !== undefined) await this.devices.control({ id: s.id, action: "volume", value: s.value });
    await this.media.play(s.id, s.item);
  }

  private async send(steps: ControlRequest[]): Promise<number> {
    const results = await Promise.allSettled(steps.map((s) => this.one(s)));
    const bad = results.filter((r) => r.status === "rejected");
    if (bad.length) console.log(`[scenes] ${bad.length} of ${steps.length} did not take: ${(bad[0] as PromiseRejectedResult).reason?.message ?? "?"}`);
    return bad.length;
  }
}
