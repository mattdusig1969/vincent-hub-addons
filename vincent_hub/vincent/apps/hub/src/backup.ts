/**
 * Keeping a copy of the home, and bringing a home onto a new hub.
 *
 * A copy is the hub's own full backup (every maker's setup and sign-ins, Matter, lists) with Vincent's
 * records laid inside it: before the backup is made, Vincent's folder is copied into Home Assistant's
 * own, so it rides along. The copy is locked with a key only this home has.
 *
 * Bringing a home over: the new hub asks the old one (with the old home's PIN) for a fresh copy, takes
 * it, puts everything back except Vincent's own service, then lays Vincent's records over its own and
 * starts again. The phones that had joined the new hub stay joined.
 */
import { cpSync, createWriteStream, existsSync, mkdirSync, openAsBlob, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ServerResponse } from "node:http";
import { dir, freeze, store } from "./store.ts";

const HA_DIR = process.env.VINCENT_HA_CONFIG ?? "/homeassistant";
const RIDE = join(HA_DIR, ".vincent-home");
const PENDING = join(dir, "restore-pending.json");
const KEYFILE = join(dir, "backup.key");
/** Never part of a copy: the hub's own settings file (its supervisor writes it), and what only matters while a move is under way. */
const SKIP = new Set(["options.json", "restore-pending.json", "incoming.tar"]);
const KEEP = 3;
const PORT = 8870;

type Sup = (method: string, path: string, timeout?: number, data?: unknown) => Promise<any>;
export interface Copy { slug: string; made: string; size: number }
export interface OtherHub { url: string; homeName: string; owner: string; version: string }
export interface MoveState { step: "" | "asking" | "taking" | "restoring" | "finishing" | "done" | "failed"; error?: string; from?: string }

export class Backup {
  private sup: Sup;
  private version: () => string;
  private passes = new Map<string, { slug: string; until: number }>();
  private making?: Promise<Copy>;
  state: MoveState = { step: "" };

  constructor(sup: Sup, version: () => string) {
    this.sup = sup;
    this.version = version;
    // A copy every night, a little after three.
    setInterval(() => { const d = new Date(); if (d.getHours() === 3 && d.getMinutes() === 20 && store.setUp && this.state.step === "") this.make().catch((e) => console.log(`[backup] the nightly copy failed: ${(e as Error).message}`)); }, 60_000);
  }

  private key(): string {
    if (!existsSync(KEYFILE)) writeFileSync(KEYFILE, randomBytes(18).toString("hex"), { mode: 0o600 });
    return readFileSync(KEYFILE, "utf8").trim();
  }

  private async mine(): Promise<any[]> {
    const all = (await this.sup("GET", "/backups")).backups ?? [];
    return all.filter((b: any) => String(b.name).startsWith("Vincent home ")).sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)));
  }

  /** The copies this hub holds, newest first. */
  async list(): Promise<Copy[]> {
    return (await this.mine()).map((b: any) => ({ slug: b.slug, made: b.date, size: Math.round((b.size_bytes ?? (b.size ?? 0) * 1048576)) }));
  }

  /** Makes a copy of the home now. One at a time: a second ask waits for the first. */
  make(): Promise<Copy> {
    this.making ??= this.makeNow().finally(() => { this.making = undefined; });
    return this.making;
  }

  private async makeNow(): Promise<Copy> {
    const made = new Date().toISOString();
    rmSync(RIDE, { recursive: true, force: true });
    mkdirSync(join(RIDE, "data"), { recursive: true });
    for (const f of readdirSync(dir)) if (!SKIP.has(f)) cpSync(join(dir, f), join(RIDE, "data", f), { recursive: true });
    let options: Record<string, unknown> = {};
    try { options = JSON.parse(readFileSync(join(dir, "options.json"), "utf8")); } catch { /* none */ }
    const self = await this.sup("GET", "/addons/self/info");
    writeFileSync(join(RIDE, "manifest.json"), JSON.stringify({ made, version: this.version(), homeName: store.homeName, owner: store.owner, options, service: self.slug }));
    const r = await this.sup("POST", "/backups/new/full", 20 * 60_000, { name: `Vincent home ${made.slice(0, 16).replace("T", " ")}`, password: this.key(), homeassistant_exclude_database: true });
    const all = await this.mine();
    for (const old of all.slice(KEEP)) await this.sup("DELETE", `/backups/${old.slug}`).catch(() => {});
    const b = all.find((x: any) => x.slug === r.slug);
    console.log(`[backup] made a copy of the home (${r.slug})`);
    return { slug: r.slug, made, size: Math.round(b?.size_bytes ?? (b?.size ?? 0) * 1048576) };
  }

  /** For another hub that showed this home's PIN: a fresh copy, a pass to fetch it with, and the key that opens it. */
  async hand(): Promise<{ pass: string; key: string; version: string; size: number }> {
    const c = await this.make();
    const pass = randomBytes(24).toString("hex");
    this.passes.set(pass, { slug: c.slug, until: Date.now() + 30 * 60_000 });
    return { pass, key: this.key(), version: this.version(), size: c.size };
  }

  /** Sends the copy a pass is for. */
  async send(pass: string, res: ServerResponse): Promise<void> {
    const p = this.passes.get(pass);
    if (!p || p.until < Date.now()) { res.writeHead(403); res.end(); return; }
    const r = await fetch(`http://supervisor/backups/${p.slug}/download`, { headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` } });
    if (!r.ok || !r.body) { res.writeHead(502); res.end(); return; }
    res.writeHead(200, { "Content-Type": "application/x-tar", ...(r.headers.get("content-length") ? { "Content-Length": r.headers.get("content-length")! } : {}) });
    await pipeline(Readable.fromWeb(r.body as any), res);
  }

  /** Other Vincent hubs on the home network that already hold a home. */
  async others(): Promise<OtherHub[]> {
    const mine = new Set<string>(), hosts: string[] = [];
    for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      mine.add(a.address);
      const ip = a.address.split(".").map(Number), mask = a.netmask.split(".").map(Number);
      const net = ip.map((x, i) => x & mask[i]), size = mask.reduce((n, m) => n * (256 - m), 1);
      if (size > 1024 || size < 4) continue;
      const base = ((net[0] << 24) | (net[1] << 16) | (net[2] << 8) | net[3]) >>> 0;
      for (let i = 1; i < size - 1; i++) { const n = base + i; hosts.push([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".")); }
    }
    const found = await Promise.all([...new Set(hosts)].filter((h) => !mine.has(h)).map(async (h) => {
      try {
        const s = (await (await fetch(`http://${h}:${PORT}/api/status`, { signal: AbortSignal.timeout(2500) })).json()) as any;
        return s?.setUp ? { url: `http://${h}:${PORT}`, homeName: String(s.homeName ?? ""), owner: String(s.owner ?? ""), version: String(s.vincent ?? "") } : null;
      } catch { return null; }
    }));
    return found.filter((x): x is OtherHub => !!x);
  }

  /**
   * Brings the home on another hub onto this one. Returns at once; how it goes (a wrong PIN included) is followed through `state`.
   */
  async bring(url: string, pin: string): Promise<void> {
    if (!/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(url)) throw new Error("That is not a hub's address.");
    if (!["", "done", "failed"].includes(this.state.step)) throw new Error("A home is already being brought over.");
    this.state = { step: "asking", from: url };
    (async () => {
      const r = await fetch(`${url}/api/backup/hand`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }), signal: AbortSignal.timeout(25 * 60_000) });
      const j = (await r.json().catch(() => ({}))) as any;
      if (!r.ok) throw new Error(r.status === 404 ? "The other hub needs the newest Vincent first. Update it, then try again." : r.status === 403 ? (j.code === "wait" ? "Too many wrong PINs at the other hub. Try again in a minute." : "That is not the other home's PIN.") : j.error ?? "The other hub would not hand its home over.");
      if (newer(String(j.version ?? ""), this.version())) throw new Error("The other hub has a newer Vincent than this one. Update this hub first, then try again.");
      await this.carry(url, j);
    })().catch((e) => { console.log(`[backup] bringing the home over failed: ${(e as Error).message}`); this.state = { step: "failed", error: (e as Error).message, from: url }; });
  }

  private async carry(url: string, h: { pass: string; key: string }): Promise<void> {
    this.state = { step: "taking", from: url };
    const tar = join(dir, "incoming.tar");
    const r = await fetch(`${url}/api/backup/file?pass=${h.pass}`);
    if (!r.ok || !r.body) throw new Error("The copy could not be fetched from the other hub.");
    await pipeline(Readable.fromWeb(r.body as any), createWriteStream(tar));
    const form = new FormData();
    form.append("file", await openAsBlob(tar), "vincent-home.tar");
    const up = await fetch("http://supervisor/backups/new/upload", { method: "POST", headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` }, body: form });
    const uj = (await up.json().catch(() => ({}))) as any;
    rmSync(tar, { force: true });
    if (!up.ok || !uj.data?.slug) throw new Error(uj.message ?? "This hub could not read the copy.");
    const slug = String(uj.data.slug);
    const info = await this.sup("GET", `/backups/${slug}/info`);
    const self = (await this.sup("GET", "/addons/self/info")).slug as string;
    // Everything but Vincent's own service: that one is running this, and its records are laid over afterwards.
    const addons = ((info.addons ?? []) as any[]).map((a) => String(a.slug)).filter((s) => s !== self && !s.endsWith("_vincent_hub"));
    // The phones that joined this hub stay joined to the home that arrives.
    let paired = {};
    try { paired = JSON.parse(readFileSync(join(dir, "vincent.json"), "utf8")).paired ?? {}; } catch { /* none */ }
    writeFileSync(PENDING, JSON.stringify({ slug, paired, at: new Date().toISOString() }));
    this.state = { step: "restoring", from: url };
    console.log(`[backup] putting the home back from ${slug}: Home Assistant, ${addons.length} other service(s)`);
    await this.sup("POST", `/backups/${slug}/restore/partial`, 45 * 60_000, { homeassistant: true, addons, folders: info.folders ?? [], password: h.key });
    this.state = { step: "finishing", from: url };
    await this.finish();
  }

  /** True when a move was cut short after the hub's own records arrived: finishing it is all that is left. */
  get unfinished(): boolean { return existsSync(PENDING) && existsSync(join(RIDE, "manifest.json")); }

  /** Lays the arrived home's Vincent records over this hub's, keeps this hub's phones, and starts Vincent again. */
  async finish(): Promise<void> {
    const pending = JSON.parse(readFileSync(PENDING, "utf8"));
    const manifest = JSON.parse(readFileSync(join(RIDE, "manifest.json"), "utf8"));
    const from = join(RIDE, "data");
    for (const f of readdirSync(dir)) if (!SKIP.has(f) && f !== "vincent.json") rmSync(join(dir, f), { recursive: true, force: true });
    for (const f of readdirSync(from)) if (!SKIP.has(f) && f !== "vincent.json") cpSync(join(from, f), join(dir, f), { recursive: true });
    const home = JSON.parse(readFileSync(join(from, "vincent.json"), "utf8"));
    home.paired = { ...(home.paired ?? {}), ...(pending.paired ?? {}) };
    // The settings of Vincent's service (keys for pictures and the like) come along too.
    const options = manifest.options ?? {};
    if (Object.keys(options).length) await this.sup("POST", "/addons/self/options", 20_000, { options }).catch((e) => console.log(`[backup] the service's settings did not carry over: ${(e as Error).message}`));
    await this.sup("DELETE", `/backups/${pending.slug}`).catch(() => {});
    rmSync(RIDE, { recursive: true, force: true });
    rmSync(PENDING, { force: true });
    // Written last, and nothing of the old home is saved after it: the service starts again at once.
    freeze();
    writeFileSync(join(dir, "vincent.json"), JSON.stringify(home, null, 1));
    this.state = { step: "done" };
    console.log(`[backup] the home "${manifest.homeName ?? ""}" is on this hub now; starting again`);
    setTimeout(() => { this.sup("POST", "/addons/self/restart").catch(() => process.exit(0)); }, 1500);
  }

  /** How big the folder that rides in a copy is, for a report. */
  static sizeOf(p: string): number {
    try { const s = statSync(p); return s.isDirectory() ? readdirSync(p).reduce((n, f) => n + Backup.sizeOf(join(p, f)), 0) : s.size; } catch { return 0; }
  }
}

function newer(a: string, b: string): boolean {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}
