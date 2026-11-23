/**
 * Runs scenes. A scene is a list of the same requests a tap on a control sends, so running
 * one is sending them all at once, and "put it back" is sending what was there before.
 */
import { randomBytes } from "node:crypto";
import type { ControlRequest, Device } from "../../../packages/core/src/index.ts";
import { ROOM_KINDS, SCENE_ICONS, sceneCan, stepNow } from "../../../packages/core/src/index.ts";
import type { Devices } from "./devices.ts";

/** What a scene may ask of a control. No "unlock": a scene never opens a door. No thermostats yet. */
const ALLOWED = new Set(["on", "off", "brightness", "open", "close", "lock"]);
const UNDO_FOR = 5 * 60_000;

export const isRoomKind = (k: unknown): boolean => ROOM_KINDS.some((x) => x.id === k);
export const sceneIcon = (i: unknown): string => (typeof i === "string" && i in SCENE_ICONS ? i : "spark");

/** Keeps only steps a scene is allowed to hold, one per control. */
export function cleanSteps(raw: unknown): ControlRequest[] {
  const seen = new Set<string>(), out: ControlRequest[] = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    const id = String(s?.id ?? ""), action = String(s?.action ?? "");
    if (!id || seen.has(id) || !ALLOWED.has(action)) continue;
    seen.add(id);
    out.push(action === "brightness" ? { id, action, value: Math.min(100, Math.max(1, Math.round(Number(s.value) || 1))) } : { id, action: action as ControlRequest["action"] });
    if (out.length >= 200) break;
  }
  return out;
}

export class Scenes {
  private devices: Devices;
  private undo = new Map<string, { steps: ControlRequest[]; until: number }>();
  constructor(devices: Devices) { this.devices = devices; }

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
        if (c && c.available && sceneCan(c)) out.push({ step, c });
      }
    }
    return out;
  }

  private async send(steps: ControlRequest[]): Promise<number> {
    const results = await Promise.allSettled(steps.map((s) => this.devices.control(s)));
    const bad = results.filter((r) => r.status === "rejected");
    if (bad.length) console.log(`[scenes] ${bad.length} of ${steps.length} did not take: ${(bad[0] as PromiseRejectedResult).reason?.message ?? "?"}`);
    return bad.length;
  }
}
