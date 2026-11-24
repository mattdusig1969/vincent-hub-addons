/**
 * What is on the home's network, by maker.
 *
 * Many makers (Amazon, Ring, Nest, eufy) never announce their devices, so listening alone misses them.
 * Every device does carry its maker in its network address, though. The hub knocks on each address of
 * the home network once, reads who answered, and says "there are five Amazon devices here" so the
 * household can go straight to that maker's setup instead of hunting through the brand list.
 *
 * Nothing leaves the home: the knock is one empty packet per address, and only makers are counted.
 */
import { createSocket } from "node:dgram";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import type { Seen } from "../../../packages/core/src/index.ts";
import type { Ha } from "./ha.ts";
import { brand } from "./brands.ts";
import { MAKERS } from "./oui.ts";

const byPrefix = new Map<string, number>();
MAKERS.forEach((m, i) => { for (const p of m.prefixes.split(" ")) if (p) byPrefix.set(p, i); });

/** Devices that say who they are in the name they give the router, whatever chip they are built on. */
const BY_NAME: [RegExp, string, string[]][] = [
  [/^wled/i, "WLED", ["wled"]],
  [/govee|^ihoment/i, "Govee", ["govee"]],
  [/^schlage/i, "Schlage", ["schlage"]],
  [/^ring[-_]/i, "Ring", ["ring"]],
  [/^shelly/i, "Shelly", ["shelly"]],
  [/^eufy/i, "eufy", ["eufy_camera", "eufy"]],
  [/^wyze/i, "Wyze", ["wyze"]],
  [/^(lifx|lutron|roku|nanoleaf|ecobee|meross)/i, "", []],
];
/** Connections made once per device, so having one says nothing about the maker's other devices. */
const PER_DEVICE = new Set(["generic", "homekit_controller", "onvif"]);
/** One look serves for half an hour: knocking on every address is not something to do often (some routers take a burst of it for an attack). */
const KEEP_MS = 30 * 60_000;
const clean = (mac: string) => mac.split(/[:-]/).map((x) => x.padStart(2, "0")).join("").toLowerCase();

export class Network {
  private ha: Ha;
  private names = new Map<string, string>(); // address -> the name the device gave the router
  private last: Seen[] = [];
  private at = 0;
  private running?: Promise<void>;
  private makerByIp = new Map<string, string>(); // home address -> maker, for devices that do not say who made them
  /** Who made the device at this address, when its network address tells. A camera added by its stream address has no other name. */
  makerAt(ip: string): string | undefined { return this.makerByIp.get(ip); }
  private listening = false;

  constructor(ha: Ha) { this.ha = ha; }

  /** Home Assistant hears each device ask the router for an address; the name it gives then is kept. */
  private async listen(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    await this.ha.open({ type: "dhcp/subscribe_discovery" }, (e) => {
      for (const d of e?.add ?? []) if (d.mac_address && d.hostname) this.names.set(clean(String(d.mac_address)), String(d.hostname));
    }).catch(() => { this.listening = false; });
    await new Promise((r) => setTimeout(r, 300)); // the names Home Assistant already knows arrive at once
  }

  /** Makers seen on the network that the home has not added yet. Never waits long: an old answer is given while a new look runs. */
  async seen(): Promise<Seen[]> {
    if (Date.now() - this.at > KEEP_MS) {
      const look = this.look().catch(() => undefined);
      if (!this.at) await Promise.race([look, new Promise((r) => setTimeout(r, 12_000))]);
    }
    return this.last;
  }

  private look(): Promise<void> {
    return (this.running ??= this.sweep().finally(() => { this.running = undefined; }));
  }

  private async sweep(): Promise<void> {
    await this.listen();
    const macs = await this.answering();
    for (const m of this.names.keys()) macs.add(m);
    const [devs, entries] = await Promise.all([
      this.ha.call({ type: "config/device_registry/list" }) as Promise<any[]>,
      this.ha.call({ type: "config_entries/get" }) as Promise<any[]>,
    ]);
    const known = new Set<string>(devs.flatMap((d) => (d.connections ?? []).filter((c: string[]) => c[0] === "mac").map((c: string[]) => clean(c[1]))));
    const drivers = new Set<string>(entries.filter((e) => !e.disabled_by).map((e) => String(e.domain)));
    const makers = devs.map((d) => String(d.manufacturer ?? "").toLowerCase());

    const found = new Map<string, { brands: string[]; count: number }>();
    for (const mac of macs) {
      if (known.has(mac)) continue;
      let who: { name: string; brands: string[] } | undefined;
      const said = this.names.get(mac);
      const named = said ? BY_NAME.find(([re]) => re.test(said)) : undefined;
      if (named?.[1]) who = { name: named[1], brands: named[2] };
      const i = byPrefix.get(mac.slice(0, 6));
      if (!who && i !== undefined) who = MAKERS[i];
      if (!who) continue;
      const f = found.get(who.name) ?? found.set(who.name, { brands: who.brands, count: 0 }).get(who.name)!;
      f.count++;
    }

    const out: Seen[] = [];
    for (const [name, f] of found) {
      // A maker the home already connected is not offered again.
      const open = f.brands.filter((id) => { const d = brand(id)?.driver; return !d || PER_DEVICE.has(d) || !drivers.has(d); });
      if (!open.length) continue;
      const first = name.toLowerCase().split(/[ (]/)[0];
      if (makers.filter((m) => m.includes(first)).length >= f.count) continue;
      out.push({ name, brands: open, count: f.count });
    }
    this.last = out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    this.at = Date.now();
    console.log(`[network] ${macs.size} devices answered; not yet added: ${this.last.map((s) => `${s.count} ${s.name}`).join(", ") || "none"}`);
  }

  /** Knocks on every address of the home network and reads which answered. */
  private async answering(): Promise<Set<string>> {
    const targets: string[] = [];
    for (const list of Object.values(networkInterfaces())) for (const n of list ?? []) {
      // Not the hub's own inner networks (172.x), and not addresses a device makes up when it has no router.
      if (n.family !== "IPv4" || n.internal || /^(172\.|169\.254\.|127\.)/.test(n.address)) continue;
      const ip = n.address.split(".").map(Number), mask = n.netmask.split(".").map(Number);
      const size = mask[2] === 255 ? 256 : Math.min(1024, (256 - mask[2]) * 256);
      const base = ((ip[0] << 24) | (ip[1] << 16) | ((ip[2] & (mask[2] === 255 ? 255 : mask[2])) << 8)) >>> 0;
      for (let i = 1; i < size - 1; i++) { const a = (base + i) >>> 0; targets.push(`${a >>> 24}.${(a >> 16) & 255}.${(a >> 8) & 255}.${a & 255}`); }
    }
    if (targets.length) {
      const sock = createSocket("udp4");
      sock.on("error", () => undefined);
      // Slowly, a few addresses at a time, and once.
      for (let i = 0; i < targets.length; i += 8) {
        for (const t of targets.slice(i, i + 8)) sock.send("", 9, t, () => undefined);
        await new Promise((r) => setTimeout(r, 250));
      }
      await new Promise((r) => setTimeout(r, 1500));
      sock.close();
    }
    const macs = new Set<string>();
    const text = await readFile("/proc/net/arp", "utf8").catch(() => new Promise<string>((ok) => execFile("arp", ["-an"], (_e, out) => ok(out ?? ""))));
    for (const line of text.split("\n")) {
      const m = /\b([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})\b/i.exec(line);
      if (!m) continue;
      const c = clean(m[1]);
      if (c === "000000000000" || c === "ffffffffffff") continue;
      macs.add(c);
      const ip = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(line)?.[1], maker = byPrefix.get(c.slice(0, 6));
      if (ip && maker !== undefined) this.makerByIp.set(ip, MAKERS[maker].name.replace(/ \(.*$/, ""));
    }
    return macs;
  }
}
