/**
 * Switching on a television that is off.
 *
 * A TV that is off is not listening to its maker's usual commands; an LG wakes only to a "magic packet"
 * sent to its network card by its hardware address. So while a TV is on, the hub notes that address
 * (from the network's own table, by the TV's address in Home Assistant's records), and keeps it for when
 * the TV is off. The packet stays on the home network.
 */
import { createSocket } from "node:dgram";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { store } from "./store.ts";

const HA_DIR = process.env.VINCENT_HA_CONFIG ?? "/homeassistant";
const MAC = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

/** setup id -> the TV's address, for the makers whose TVs wake this way. Empty off a hub. */
async function tvHosts(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const text = await readFile(`${HA_DIR}/.storage/core.config_entries`, "utf8").catch(() => "");
  if (!text) return out;
  try {
    for (const e of JSON.parse(text)?.data?.entries ?? []) if (e?.domain === "webostv" && typeof e?.data?.host === "string") out.set(String(e.entry_id), e.data.host);
  } catch { /* not readable this time */ }
  return out;
}

/** address -> hardware address, for everything the hub has spoken to lately. */
async function neighbours(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const text = await readFile("/proc/net/arp", "utf8").catch(() => new Promise<string>((ok) => execFile("arp", ["-an"], (_e, o) => ok(o ?? ""))));
  for (const line of text.split("\n")) {
    const ip = /(\d+\.\d+\.\d+\.\d+)/.exec(line)?.[1], mac = /(([0-9a-f]{1,2}:){5}[0-9a-f]{1,2})/i.exec(line)?.[1];
    if (ip && mac && !/^(00:){5}00$/.test(mac)) out.set(ip, mac.split(":").map((x) => x.padStart(2, "0")).join(":").toLowerCase());
  }
  return out;
}

let learnedAt = 0;
/** Notes the hardware address of each TV that is on right now. Cheap, and asked at most every few minutes. */
export async function learnTvs(): Promise<void> {
  if (Date.now() - learnedAt < 5 * 60_000) return;
  learnedAt = Date.now();
  const hosts = await tvHosts();
  if (!hosts.size) return;
  const near = await neighbours();
  for (const [entry, host] of hosts) { const mac = near.get(host); if (mac && store.tvMac(entry) !== mac) { store.setTvMac(entry, mac); console.log(`[tv] noted how to wake the TV at ${host}`); } }
}

/** Sends the wake-up to every hardware address given. True when anything was sent. */
export async function wakeTv(macs: (string | undefined)[]): Promise<boolean> {
  const list = [...new Set(macs.filter((m): m is string => !!m && MAC.test(m)).map((m) => m.toLowerCase().replace(/-/g, ":")))];
  if (!list.length) return false;
  // Out of every network the hub is on, to everyone on it: the TV is asleep and has no address to send to.
  const to = new Set(["255.255.255.255"]);
  for (const nets of Object.values(networkInterfaces())) for (const n of nets ?? []) {
    if (n.family !== "IPv4" || n.internal) continue;
    const ip = n.address.split(".").map(Number), mask = n.netmask.split(".").map(Number);
    to.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join("."));
  }
  const sock = createSocket({ type: "udp4", reuseAddr: true });
  await new Promise<void>((ok) => sock.bind(0, () => { try { sock.setBroadcast(true); } catch { /* still try */ } ok(); }));
  const send = (buf: Buffer, addr: string, port: number) => new Promise<void>((ok) => sock.send(buf, port, addr, () => ok()));
  for (let round = 0; round < 3; round++) {
    for (const mac of list) {
      const bytes = Buffer.from(mac.split(":").map((x) => parseInt(x, 16)));
      const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => bytes)]);
      for (const addr of to) { await send(packet, addr, 9); await send(packet, addr, 7); }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  sock.close();
  return true;
}
