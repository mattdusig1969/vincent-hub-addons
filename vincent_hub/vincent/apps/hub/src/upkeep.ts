/**
 * Looking after a hub: erasing a home so the hub can start again somewhere else,
 * and writing a report of what the hub sees when something goes wrong.
 */
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HA } from "./ha.ts";
import type { Devices } from "./devices.ts";
import type { Media } from "./media.ts";
import type { Lists } from "./lists.ts";
import { dir, store } from "./store.ts";
import { hubLog } from "./log.ts";
import { BRANDS } from "./brands.ts";

/** Parts of Home Assistant itself, and the radios the hub needs wherever it goes. Everything else belongs to a home. */
const HUB_OWN = new Set(["sun", "backup", "go2rtc", "hassio", "matter", "thread", "otbr", "radio_browser", "google_translate", "shopping_list", "analytics", "cloud", "homeassistant", "raspberry_pi", "rpi_power", "homeassistant_green", "homeassistant_hardware"]);
/** Kept in the hub's folder through an erase: the hub's own settings and a channel guide that is the same in every home. */
const KEEP_FILES = new Set(["options.json", "sxm_lineup.json"]);
/** Entries the household never sees as a "maker". */
const QUIET = new Set(["local_todo", "met"]);

interface Entry { entry_id: string; domain: string; title: string; source: string; state: string; reason?: string | null }
/** The maker's name as the household knows it. */
const titled = (domain: string) => BRANDS.find((b) => b.driver === domain)?.name ?? domain.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
/** Accounts are named by their email address; a report says only that there is one. */
const noEmails = (s: string) => s.replace(/[^\s"<>(),;:]+@[^\s"<>(),;:]+\.[a-z]{2,}/gi, "(an email address)");

export interface ErasePreview { makers: string[]; devices: number; rooms: number; lists: number; phones: number }

async function homeEntries(ha: HA): Promise<Entry[]> {
  const all = (await ha.call({ type: "config_entries/get" })) as Entry[];
  return all.filter((e) => !HUB_OWN.has(e.domain) && e.source !== "system" && e.source !== "import");
}

/** What an erase would remove, for the household to read before agreeing. */
export async function erasePreview(ha: HA, devices: Devices, lists: Lists): Promise<ErasePreview> {
  const entries = await homeEntries(ha);
  const makers = [...new Set(entries.filter((e) => !QUIET.has(e.domain) && e.source !== "ignore").map((e) => titled(e.domain)))].sort();
  if ((await matterDevices(ha)).length) makers.push("Matter");
  return { makers, devices: (await devices.all()).filter((d) => d.status === "added").length, rooms: store.rooms().length, lists: lists.all().length, phones: store.pairedCount };
}

async function matterDevices(ha: HA): Promise<{ id: string; name: string; entry: string }[]> {
  const entries = (await ha.call({ type: "config_entries/get" })) as Entry[];
  const ids = new Set(entries.filter((e) => e.domain === "matter").map((e) => e.entry_id));
  if (!ids.size) return [];
  const devs = (await ha.call({ type: "config/device_registry/list" })) as any[];
  return devs
    .filter((d) => d.entry_type !== "service" && (d.config_entries as string[]).some((e) => ids.has(e)))
    .map((d) => ({ id: d.id, name: d.name_by_user || d.name || d.model || "A Matter device", entry: (d.config_entries as string[]).find((e) => ids.has(e))! }));
}

/**
 * Removes this home from the hub: every maker's devices, lists, music sign-ins, history, rooms, photos,
 * the PIN and every joined phone. The hub's own software stays, ready to be set up again.
 * Returns, in plain words, anything that could not be undone from here.
 */
export async function erase(ha: HA, media: Media): Promise<string[]> {
  const left: string[] = [];
  console.log("[erase] started");

  // Matter devices are told to forget this hub, one at a time, while they can still be reached.
  for (const d of await matterDevices(ha).catch(() => [])) {
    try { await ha.call({ type: "config/device_registry/remove_config_entry", device_id: d.id, config_entry_id: d.entry }, 25_000); }
    catch (e) {
      console.log(`[erase] Matter device "${d.name}" not released: ${(e as Error).message}`);
      left.push(`${d.name} did not answer, so it still lists this hub. In its maker's app, remove "Home Assistant" from its connected Matter controllers.`);
    }
  }

  await media.spotifyForget().catch((e: Error) => console.log(`[erase] Spotify sign-in not forgotten: ${e.message}`));

  const entries = await homeEntries(ha);
  for (const e of entries) {
    try { await ha.rest("DELETE", `/config/config_entries/entry/${e.entry_id}`); }
    catch (err) {
      console.log(`[erase] ${e.domain} "${e.title}" not removed: ${(err as Error).message}`);
      if (!QUIET.has(e.domain)) left.push(`${titled(e.domain)} could not be removed from the hub. Erase again once the hub has restarted.`);
    }
  }
  console.log(`[erase] removed ${entries.length} integrations: ${[...new Set(entries.map((e) => e.domain))].join(", ") || "none"}`);

  // Discoveries still waiting for a yes belong to this home too.
  const flows = (await ha.call({ type: "config_entries/flow/progress" }).catch(() => [])) as { flow_id: string }[];
  for (const f of flows) await ha.restRaw("DELETE", `/config/config_entries/flow/${f.flow_id}`).catch(() => {});

  // What the hub remembers of this home's devices: their names and what they did.
  await ha.call({ type: "call_service", domain: "recorder", service: "purge", service_data: { keep_days: 0, repack: true } }).catch((e: Error) => console.log(`[erase] history not cleared: ${e.message}`));
  await ha.call({ type: "call_service", domain: "system_log", service: "clear", service_data: {} }).catch(() => {});

  // Vincent's own record of the home: rooms, photos, pictures, the PIN, joined phones.
  for (const name of readdirSync(dir)) if (!KEEP_FILES.has(name)) rmSync(join(dir, name), { recursive: true, force: true });
  store.erase();
  hubLog.clear();
  console.log(`[erase] done${left.length ? `, ${left.length} left behind` : ""}`);
  return left;
}

export interface ReportParts {
  ha: HA; devices: Devices; media: Media; lists: Lists;
  /** The hub's supervisor, when there is one. */
  supervisor: (method: string, path: string) => Promise<any>;
  picture: () => unknown;
  matter: unknown;
  /** How Matter itself is on the hub, and what was done to keep it working. */
  matterCare: { state: string; message: string; lost: boolean; history: string[] } | null;
  note: string;
  /** What the phone or tablet says about itself. */
  app: unknown;
}

/** Everything a person fixing a problem would ask for, as plain text. No PIN, no keys, no passwords, no contact details. */
export async function report(p: ReportParts): Promise<string> {
  const out: string[] = [];
  const head = (t: string) => out.push("", `== ${t} ==`);
  const safe = async <T,>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try { return await fn(); } catch (e) { out.push(`(${what} not read: ${(e as Error).message})`); return undefined; }
  };
  const short = (v: unknown, n = 900) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + "…" : s ?? ""; };

  out.push("Vincent report", `Made: ${new Date().toISOString()}`);
  if (p.note.trim()) out.push(`What went wrong: ${p.note.trim().slice(0, 1000)}`);

  head("This phone or tablet");
  out.push(short(p.app, 2500) || "(nothing sent)");

  head("Hub");
  const info = await safe("Vincent's version", () => p.supervisor("GET", "/addons/self/info"));
  out.push(`Vincent: ${info?.version ?? "development copy"}${info?.update_available ? ` (newer available: ${info.version_latest})` : ""}`);
  out.push(`Home Assistant: ${p.ha.version || "?"} · connected: ${p.ha.connected ? "yes" : "NO"} · things it reports: ${p.ha.states.size}`);
  out.push(`Service running for: ${Math.round(process.uptime() / 60)} min · memory: ${Math.round(process.memoryUsage().rss / 1e6)} MB`);
  const host = await safe("hub details", () => p.supervisor("GET", "/info"));
  if (host) out.push(`Hub: ${host.machine ?? "?"} · ${host.operating_system ?? "?"} · supervisor ${host.supervisor ?? "?"} · time zone ${host.timezone ?? "?"}`);
  const hw = await safe("hub storage", () => p.supervisor("GET", "/host/info"));
  if (hw) out.push(`Storage: ${hw.disk_free ?? "?"} GB free of ${hw.disk_total ?? "?"} GB`);
  const net = await safe("network", () => p.supervisor("GET", "/network/info"));
  for (const i of (net?.interfaces ?? []) as any[]) if (i.connected) out.push(`Network: ${i.interface} (${i.type}) ${(i.ipv4?.address ?? []).join(", ")} gateway ${i.ipv4?.gateway ?? "?"}`);
  if (net) out.push(`Internet: ${net.host_internet === false ? "NO" : "yes"}`);

  head("Home");
  out.push(`Set up: ${store.setUp ? "yes" : "no"} · first device review done: ${store.reviewed ? "yes" : "no"} · rooms: ${store.rooms().length} · phones and tablets joined: ${store.pairedCount}`);
  out.push(`Look: ${store.theme} / ${store.style} · host: ${store.character} (${store.rotate}) · place set: ${store.place?.place ? "yes" : "no"} · lists: ${p.lists.all().length}`);

  if (p.ha.connected) {
    head("Makers set up on the hub");
    const entries = await safe("integrations", () => p.ha.call({ type: "config_entries/get" }) as Promise<Entry[]>);
    for (const e of entries ?? []) out.push(`${e.domain} · "${e.title}" · from ${e.source} · ${e.state}${e.reason ? ` · ${e.reason}` : ""}`);

    head("Found, waiting for a yes");
    const flows = await safe("discoveries", () => p.ha.call({ type: "config_entries/flow/progress" }) as Promise<any[]>);
    for (const f of flows ?? []) out.push(`${f.handler} · ${short(f.context?.title_placeholders ?? {}, 160)} · from ${f.context?.source ?? "?"} · step ${f.step_id ?? "?"}`);
    if (!flows?.length) out.push("(none)");

    head("Devices");
    const devs = await safe("devices", () => p.devices.all());
    for (const d of devs ?? []) {
      const dead = d.controls.filter((c) => (c as any).available === false).length;
      out.push(`${d.status.padEnd(7)} ${d.maker} ${d.model} · "${d.name}" · ${d.category} · rooms ${d.rooms.length} · controls ${d.controls.length}${dead ? ` (${dead} NOT ANSWERING)` : ""}${d.needs !== "ready" ? ` · needs ${d.needs}` : ""}`);
    }
    if (!devs?.length) out.push("(none)");

    head("Music and pictures");
    out.push(`Spotify: ${short(await safe("Spotify", () => p.media.spotifyStatus().then((s) => ({ linked: s.linked, waitingForSignIn: !!s.signIn }))))}`);
    out.push(`Matter, last code tried: ${short(p.matter)}`);
    out.push(`Pictures: ${short(p.picture(), 700)}`);

    head("Matter on the hub");
    if (!p.matterCare) out.push("(not looked after on a development copy)");
    else {
      out.push(`State: ${p.matterCare.state}${p.matterCare.lost ? " · set up afresh, devices need adding again" : ""}`);
      out.push(...(p.matterCare.history.length ? p.matterCare.history : ["(nothing has needed doing)"]));
    }

    head("Home Assistant's own warnings and errors");
    const log = await safe("its log", () => p.ha.call({ type: "system_log/list" }) as Promise<any[]>);
    for (const l of (log ?? []).slice(0, 60))
      out.push(`${new Date((l.timestamp ?? 0) * 1000).toISOString()} ${l.level} ×${l.count ?? 1} ${l.name}: ${short(Array.isArray(l.message) ? l.message[0] : l.message, 400)}${l.exception ? `\n    ${short(String(l.exception).trim().split("\n").slice(-3).join(" | "), 500)}` : ""}`);
    if (!log?.length) out.push("(none)");
  }

  head("Vincent's log on the hub (newest last)");
  out.push(...hubLog.recent(250));
  return noEmails(out.join("\n")) + "\n";
}
