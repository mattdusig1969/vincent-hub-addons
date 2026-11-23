/**
 * Keeps Matter working on the hub, so nobody has to.
 *
 * Matter on a hub is two parts: the Matter Server (an add-on the hub's supervisor runs) and
 * Home Assistant's link to it. Either can stop: the server can crash, and it has been seen
 * to crash on every start once its saved data was damaged. Nothing tells the household;
 * the only sign is that a Matter code never works.
 *
 * So this looks every few minutes and puts right what it finds, gentlest first:
 *   1. start the server / reconnect Home Assistant to it
 *   2. restart the server
 *   3. after ten minutes of that: put back the last good copy of the server's data
 *   4. after twenty: install the server afresh (Matter devices then need adding again)
 * While all is well it keeps a copy of the server's data (the pairings with the home's
 * Matter devices), so step 3 has something to put back.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import type { HA } from "./ha.ts";

/** The hub's supervisor: method, path, body, how long to wait. */
export type Supervisor = (method: string, path: string, body?: unknown, timeoutMs?: number) => Promise<any>;

const ADDON = "core_matter_server";
/** How the copies this keeps are named in the hub's backups. The number of devices follows in brackets. */
const COPY = "Vincent: Matter devices";
const MIN = 60_000;
const RESTORE_AFTER = 10 * MIN, REINSTALL_AFTER = 20 * MIN, REST_AFTER_FAILING = 6 * 60 * MIN;
const COPY_EVERY = 7 * 24 * 60 * MIN, COPIES_KEPT = 2;

export interface MatterHealth {
  /** ok · repairing = being put right now · down = could not be repaired · off = switched off by hand · unknown = not looked yet */
  state: "ok" | "repairing" | "down" | "off" | "unknown";
  /** For the household, when there is something to say. */
  message: string;
  /** True after the server had to be installed afresh while the home had Matter devices: they need adding again. */
  lost: boolean;
}

interface Addon { state: string; watchdog?: boolean; version?: string }
interface Entry { entry_id: string; state: string; disabled_by: string | null }
interface Copy { slug: string; name: string; date: string }

const SAYS = {
  repairing: "Matter on this hub stopped working. Vincent is putting it right; this takes a few minutes.",
  down: "Matter on this hub is not working and Vincent could not repair it. Unplug the hub for ten seconds and plug it back in. If a Matter code still fails after that, send a report from Settings, Home.",
  lost: "Matter on this hub had to be set up afresh. Anything you added with a Matter code needs adding again: make a new code in its maker's app.",
};

export class MatterKeeper {
  private state: MatterHealth["state"] = "unknown";
  private lost = false;
  private busy = false;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  /** When the present trouble was first seen; 0 when all is well. */
  private since = 0;
  private tries = 0;
  private restored = false;
  /** Devices whose pairings went with the old server, still to be cleared out of Home Assistant. */
  private dead: string[] = [];
  private gaveUp = 0;
  private copyTried = 0;
  /** What was seen and done, newest last, for a report. */
  private notes: string[] = [];

  private ha: Pick<HA, "connected" | "call" | "rest" | "restRaw">;
  private sup: Supervisor;
  private changed: () => void;
  /** Where "set up afresh" is remembered across restarts of this service. */
  private lostFile: string;
  /** 1 in a home. A test runs the same clock a hundred times faster. */
  private pace: number;
  constructor(ha: Pick<HA, "connected" | "call" | "rest" | "restRaw">, sup: Supervisor, o: { changed?: () => void; lostFile?: string; pace?: number } = {}) {
    this.ha = ha; this.sup = sup; this.changed = o.changed ?? (() => {}); this.lostFile = o.lostFile ?? ""; this.pace = o.pace ?? 1;
    this.lost = !!this.lostFile && existsSync(this.lostFile);
  }
  private sleep(ms: number): Promise<void> { return new Promise((ok) => setTimeout(ok, ms * this.pace)); }
  private setLost(lost: boolean): void {
    this.lost = lost;
    if (!this.lostFile) return;
    try { if (lost) writeFileSync(this.lostFile, new Date().toISOString()); else rmSync(this.lostFile, { force: true }); } catch { /* remembered until the next restart at least */ }
  }

  start(): void { this.again(20_000); }

  health(): MatterHealth {
    const message = this.state === "repairing" ? SAYS.repairing : this.state === "down" ? SAYS.down : this.lost ? SAYS.lost : "";
    return { state: this.state, message, lost: this.lost };
  }
  history(): string[] { return this.notes.slice(); }

  stop(): void { clearTimeout(this.timer); this.timer = undefined; this.stopped = true; }

  /** A Matter code just worked: any "add them again" note has done its work, and there is something new to keep a copy of. */
  added(): void { this.setLost(false); this.copyTried = 0; this.again(2 * MIN); }

  /** Look now instead of at the next turn (a Matter code just failed in a way that points here). */
  nudge(): void {
    if (this.gaveUp && (Date.now() - this.gaveUp) / this.pace > 5 * MIN) { this.gaveUp = 0; this.state = "unknown"; }
    this.again(0);
  }

  /** Waits until Matter is working, for as long as given. False if it is still not. */
  async ready(waitMs: number): Promise<boolean> {
    const until = Date.now() + waitMs;
    if (this.state !== "ok") this.nudge();
    while (this.state !== "ok" && this.state !== "off" && this.state !== "down" && Date.now() < until) await this.sleep(2000);
    return this.state === "ok";
  }

  private again(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.turn(), ms * this.pace);
  }

  private async turn(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const before = this.state;
    try { await this.pass(); }
    catch (e) { this.note(`that did not work: ${(e as Error).message}`); }
    this.busy = false;
    if (this.state !== before) this.changed();
    if (this.stopped) return;
    this.again(this.state === "ok" || this.state === "off" || this.state === "unknown" ? 5 * MIN : this.state === "down" ? 30 * MIN : MIN);
  }

  private note(text: string): void {
    console.log(`[matter] ${text}`);
    this.notes.push(`${new Date().toISOString()} ${text}`);
    if (this.notes.length > 40) this.notes.shift();
  }

  // What is there

  private async addon(): Promise<Addon | undefined> {
    const all = (await this.sup("GET", "/addons")).addons as { slug: string }[];
    if (!all.some((a) => a.slug === ADDON)) return undefined;
    return (await this.sup("GET", `/addons/${ADDON}/info`)) as Addon;
  }
  private async entry(): Promise<Entry | undefined> {
    return ((await this.ha.call({ type: "config_entries/get", domain: "matter" })) as Entry[])[0];
  }
  /** The home's Matter devices. */
  private async devices(entryId: string): Promise<string[]> {
    const all = (await this.ha.call({ type: "config/device_registry/list" })) as { id: string; entry_type: string | null; config_entries: string[] }[];
    return all.filter((d) => d.entry_type !== "service" && d.config_entries.includes(entryId)).map((d) => d.id);
  }
  private async copies(): Promise<Copy[]> {
    const all = ((await this.sup("GET", "/backups")).backups ?? []) as Copy[];
    return all.filter((b) => b.name.startsWith(COPY)).sort((a, b) => b.date.localeCompare(a.date));
  }

  // One look, and one step if something is wrong

  private async pass(): Promise<void> {
    if (!this.ha.connected) return; // Home Assistant itself is away: not Matter's trouble, and nothing can be asked.
    if (this.gaveUp && (Date.now() - this.gaveUp) / this.pace < REST_AFTER_FAILING) return;

    let addon = await this.addon();
    let entry = await this.entry();
    if (entry?.disabled_by) { this.state = "off"; return; }
    if (entry?.state === "setup_in_progress") return;

    if (addon?.state === "started" && entry?.state === "loaded") return this.well(addon, entry);

    // Something is wrong.
    if (!this.since) { this.since = Date.now(); this.tries = 0; this.restored = false; }
    this.state = "repairing";
    this.changed();
    const lasted = (Date.now() - this.since) / this.pace;
    this.tries++;
    const seen = `server ${addon ? addon.state : "not installed"}, link ${entry ? entry.state : "not set up"}`;
    // Even installing afresh keeps failing (no internet, a full disk): rest instead of trying every minute for ever.
    if (lasted >= REINSTALL_AFTER + 15 * MIN) return this.giveUp(seen);

    if (!addon) {
      this.note(`${seen}: installing the Matter Server`);
      await this.install();
    } else if (lasted >= REINSTALL_AFTER && (await this.sup("GET", "/network/info").catch(() => ({}))).host_internet === false) {
      // Taking the server out without being able to fetch it again would only make things worse.
      this.note(`${seen} for ${Math.round(lasted / MIN)} min: the hub has no internet, so the Matter Server cannot be installed afresh yet`);
    } else if (lasted >= REINSTALL_AFTER) {
      const dead = entry ? await this.devices(entry.entry_id).catch(() => []) : [];
      this.note(`${seen} for ${Math.round(lasted / MIN)} min: installing the Matter Server afresh (${dead.length} Matter devices will need adding again)`);
      await this.sup("POST", `/addons/${ADDON}/stop`, undefined, 2 * MIN).catch(() => {});
      await this.sup("POST", `/addons/${ADDON}/uninstall`, undefined, 3 * MIN);
      // From here the old pairings are gone, whatever happens next.
      this.dead = dead;
      if (dead.length) this.setLost(true);
      await this.install();
      // The last thing there is to try. If it does not work, rest rather than install over and over.
      if (!(await this.link())) return this.giveUp(seen);
    } else if (lasted >= RESTORE_AFTER && !this.restored) {
      this.restored = true;
      const copy = (await this.copies().catch(() => []))[0];
      if (copy) {
        this.note(`${seen} for ${Math.round(lasted / MIN)} min: putting back the copy "${copy.name}" of ${copy.date.slice(0, 16)}`);
        await this.sup("POST", `/backups/${copy.slug}/restore/partial`, { addons: [ADDON] }, 10 * MIN);
      } else this.note(`${seen} for ${Math.round(lasted / MIN)} min: no copy of the Matter data to put back`);
    } else if (addon.state !== "started") {
      this.note(`${seen}: starting the Matter Server`);
      await this.sup("POST", `/addons/${ADDON}/start`, undefined, 3 * MIN);
    } else if (this.tries % 2 === 0) {
      this.note(`${seen}: restarting the Matter Server`);
      await this.sup("POST", `/addons/${ADDON}/restart`, undefined, 3 * MIN);
    } else this.note(`${seen}: connecting Home Assistant to the Matter Server again`);

    if (await this.link()) {
      addon = await this.addon(); entry = await this.entry();
      if (addon && entry) return this.well(addon, entry);
    }
  }

  private giveUp(seen: string): void {
    this.note(`${seen}: could not be repaired. Looking again in six hours, or when a Matter code is tried.`);
    this.state = "down";
    this.gaveUp = Date.now();
    this.since = 0;
  }

  private async well(addon: Addon, entry: Entry): Promise<void> {
    if (this.since) this.note(`working again after ${Math.max(1, Math.round((Date.now() - this.since) / this.pace / MIN))} min`);
    else if (this.state !== "ok") this.note(`working: Matter Server ${addon.version ?? ""}`);
    this.since = 0; this.tries = 0; this.gaveUp = 0;
    this.state = "ok";
    // A server installed afresh has never met the old devices. Left in place they would sit there "not answering" for ever.
    for (const id of this.dead.splice(0)) await this.ha.call({ type: "config/device_registry/remove_config_entry", device_id: id, config_entry_id: entry.entry_id }, 25_000).catch(() => {});
    // The supervisor restarts the server itself when it stops unasked.
    if (addon.watchdog === false) await this.sup("POST", `/addons/${ADDON}/options`, { watchdog: true }).then(() => this.note("the hub now restarts the Matter Server itself if it stops")).catch(() => {});
    await this.keepCopy(entry).catch((e: Error) => this.note(`copy of the Matter data not made: ${e.message}`));
  }

  private async install(): Promise<void> {
    await this.sup("POST", `/store/addons/${ADDON}/install`, undefined, 20 * MIN);
    await this.sup("POST", `/addons/${ADDON}/options`, { watchdog: true }).catch(() => {});
    await this.sup("POST", `/addons/${ADDON}/start`, undefined, 3 * MIN);
  }

  /** Gets Home Assistant talking to the server, once the server runs. True when it is. */
  private async link(): Promise<boolean> {
    // The server needs a little while after starting before it answers.
    for (let i = 0; i < 20; i++) {
      if ((await this.addon().catch(() => undefined))?.state === "started") break;
      await this.sleep(3000);
    }
    await this.sleep(12_000);
    let entry = await this.entry();
    if (!entry) {
      await this.makeEntry().catch((e: Error) => this.note(`Home Assistant's link to Matter not made: ${e.message}`));
    } else if (entry.state !== "loaded" && entry.state !== "setup_in_progress") {
      await this.ha.rest("POST", `/config/config_entries/entry/${entry.entry_id}/reload`).catch(() => {});
    }
    for (let i = 0; i < 15; i++) {
      entry = await this.entry().catch(() => undefined);
      if (entry?.state === "loaded") return true;
      await this.sleep(3000);
    }
    return false;
  }

  /** Sets up Home Assistant's side of Matter, the way its own "Add Matter" would, answering yes for it. */
  private async makeEntry(): Promise<void> {
    const flows = (await this.ha.call({ type: "config_entries/flow/progress" })) as { flow_id: string; handler: string; step_id?: string }[];
    const waiting = flows.find((f) => f.handler === "matter");
    let r = waiting
      ? { status: 200, body: { type: "form", flow_id: waiting.flow_id, step_id: waiting.step_id } }
      : await this.ha.restRaw("POST", "/config/config_entries/flow", { handler: "matter", show_advanced_options: false });
    for (let i = 0; i < 60 && r.body?.type !== "create_entry" && r.body?.type !== "abort"; i++) {
      const id = r.body?.flow_id;
      if (!id) break;
      if (r.body.type === "form") r = await this.ha.restRaw("POST", `/config/config_entries/flow/${id}`, r.body.step_id === "on_supervisor" ? { use_addon: true } : {});
      else { await this.sleep(3000); r = await this.ha.restRaw("GET", `/config/config_entries/flow/${id}`); }
    }
    if (r.body?.type === "create_entry") this.note("Home Assistant's link to Matter made");
    else if (r.body?.reason !== "already_configured") throw new Error(String(r.body?.reason ?? r.body?.message ?? `answer ${r.status}`));
  }

  /** Keeps a recent copy of the server's data while the home has Matter devices; none when it has none. */
  private async keepCopy(entry: Entry): Promise<void> {
    if ((Date.now() - this.copyTried) / this.pace < 60 * MIN) return;
    const count = (await this.devices(entry.entry_id)).length;
    const have = await this.copies();
    if (!count) {
      // No Matter devices (a new or erased home): old copies would only bring back another home's devices.
      for (const c of have) await this.sup("DELETE", `/backups/${c.slug}`).catch(() => {});
      if (have.length) this.note("no Matter devices: old copies of the Matter data removed");
      this.copyTried = Date.now();
      return;
    }
    const newest = have[0];
    const fresh = newest && newest.name === `${COPY} (${count})` && Date.now() - Date.parse(newest.date) < COPY_EVERY;
    if (fresh) return;
    this.copyTried = Date.now();
    await this.sup("POST", "/backups/new/partial", { name: `${COPY} (${count})`, addons: [ADDON] }, 10 * MIN);
    this.note(`copy of the Matter data kept (${count} device${count === 1 ? "" : "s"})`);
    for (const c of (await this.copies()).slice(COPIES_KEPT)) await this.sup("DELETE", `/backups/${c.slug}`).catch(() => {});
  }
}
