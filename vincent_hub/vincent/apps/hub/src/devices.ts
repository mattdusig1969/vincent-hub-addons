/**
 * Turns what Home Assistant holds into Vincent's device list, and carries commands back.
 *
 * Two sources make up "found":
 *  - devices Home Assistant already set up (it adds no-login devices on its own)
 *  - discoveries waiting for a yes (its config flows in progress)
 */
import type { HA, HaState } from "./ha.ts";
import { store } from "./store.ts";
import type { AddResult, Category, Control, ControlRequest, Device, Needs } from "../../../packages/core/src/index.ts";

/** Entity kinds the app can control, and the category each one puts a device in. */
const KIND: Record<string, { kind: Control["kind"]; category: Category; rank: number }> = {
  camera: { kind: "camera", category: "security", rank: 1 },
  lock: { kind: "lock", category: "security", rank: 1 },
  climate: { kind: "climate", category: "climate", rank: 2 },
  media_player: { kind: "media", category: "media", rank: 3 },
  light: { kind: "light", category: "lights", rank: 4 },
  cover: { kind: "cover", category: "other", rank: 5 },
  switch: { kind: "switch", category: "other", rank: 6 },
  fan: { kind: "switch", category: "other", rank: 6 },
};

/** For a discovery that has no entities yet: what kind of thing its integration brings. */
const BY_INTEGRATION: Record<string, Category> = {
  hue: "lights", wled: "lights", lifx: "lights", tplink: "lights", govee_light_local: "lights", nanoleaf: "lights", yeelight: "lights", lutron_caseta: "lights",
  sonos: "media", apple_tv: "media", cast: "media", webostv: "media", samsungtv: "media", roku: "media", androidtv_remote: "media", heos: "media", denonavr: "media", bluesound: "media", yamaha_musiccast: "media",
  ring: "security", unifiprotect: "security", onvif: "security", reolink: "security", august: "security", yale: "security", schlage: "security", axis: "security", doorbird: "security",
  nest: "climate", ecobee: "climate", homekit_controller: "other", tado: "climate", sensibo: "climate",
};

/** Integrations whose setup asks for an account or a pairing code. Placeholder list; the real flows come later. */
const LOGIN = new Set(["apple_tv", "nest", "ring", "ecobee", "august", "yale", "schlage", "unifiprotect", "reolink", "onvif", "tado", "sensibo", "samsungtv", "webostv", "androidtv_remote", "homekit_controller", "hue", "lutron_caseta"]);

/** Found on the network but not part of running a home: printers, routers. Never offered. */
const NOT_HOME = new Set(["ipp", "brother", "upnp", "dlna_dmr", "dlna_dms", "synology_dsm", "fritz", "thread", "otbr"]);

const DISCOVERED = new Set(["zeroconf", "ssdp", "dhcp", "homekit", "bluetooth", "usb", "mqtt", "integration_discovery", "hassio"]);

interface Snapshot {
  devices: Device[];
  /** control id -> entity id + the device that owns it */
  controls: Map<string, { entityId: string; deviceId: string; domain: string; integration: string; host?: string; name?: string }>;
  /** entity id -> control id, for naming the other players in a group */
  byEntity: Map<string, string>;
  /** device id -> waiting flow */
  flows: Map<string, { flowId: string; handler: string }>;
}

export class Devices {
  private snap?: Snapshot;
  private at = 0;
  private ha: HA;

  constructor(ha: HA) { this.ha = ha; }

  /** A registry changed: rebuild on the next read. */
  invalidate(): void { this.at = 0; }

  async all(): Promise<Device[]> { return (await this.snapshot()).devices; }

  private async snapshot(): Promise<Snapshot> {
    // The structure is cached briefly; live values are filled in fresh on every read.
    if (!this.snap || Date.now() - this.at > 5000) { this.snap = await this.build(); this.at = Date.now(); }
    for (const d of this.snap.devices) {
      // Vincent's own choices are read fresh every time: they change without Home Assistant knowing.
      const entryIds = this.entriesOf.get(d.id) ?? [];
      d.status = store.status(d.id, entryIds);
      d.rooms = store.roomsOf(d.id, entryIds);
      d.name = store.nameOf(d.id) || d.makerName;
      d.controls = d.controls.map((c) => {
        const ref = this.snap!.controls.get(c.id)!;
        // A control named after its device follows the household's name for that device.
        const own = ref.name ?? (ref.name = c.name);
        return project(c.id, own === d.makerName ? d.name : own, ref.domain, this.ha.states.get(ref.entityId), ref.integration, this.snap!.byEntity);
      });
    }
    return this.snap;
  }

  /** device id -> the Home Assistant integrations that brought it */
  private entriesOf = new Map<string, string[]>();

  private async build(): Promise<Snapshot> {
    const ha = this.ha;
    const [devs, ents, entries, flows, areas] = await Promise.all([
      ha.call({ type: "config/device_registry/list" }),
      ha.call({ type: "config/entity_registry/list" }),
      ha.call({ type: "config_entries/get" }),
      ha.call({ type: "config_entries/flow/progress" }),
      ha.call({ type: "config/area_registry/list" }),
    ]);
    const entryDomain = new Map<string, string>(entries.map((e: any) => [e.entry_id, e.domain]));
    const areaName = new Map<string, string>(areas.map((a: any) => [a.area_id, a.name]));
    const snap: Snapshot = { devices: [], controls: new Map(), byEntity: new Map(), flows: new Map() };
    this.entriesOf.clear();

    for (const d of devs) {
      if (d.entry_type === "service" || d.disabled_by) continue;
      const integration = (d.config_entries as string[]).map((id) => entryDomain.get(id)).find(Boolean) ?? "";
      const mine = ents.filter((e: any) => e.device_id === d.id && !e.disabled_by && !e.hidden_by && !e.entity_category);
      const controls: Control[] = [];
      let best: { category: Category; rank: number } | undefined;
      for (const e of mine) {
        const domain = String(e.entity_id).split(".")[0];
        const k = KIND[domain];
        if (!k) continue;
        if (!best || k.rank < best.rank) best = k;
        const name = e.name || e.original_name || d.name_by_user || d.name || "";
        // The device's own address (a Sonos speaker answers there), never pinned: Home Assistant keeps it current.
        const host = typeof d.configuration_url === "string" ? /\/\/([^:/]+)/.exec(d.configuration_url)?.[1] : undefined;
        snap.controls.set(e.id, { entityId: e.entity_id, deviceId: d.id, domain, integration, host });
        snap.byEntity.set(e.entity_id, e.id);
        controls.push(project(e.id, name, domain, undefined, integration, snap.byEntity));
      }
      if (!controls.length) continue; // nothing the app could do with it
      const entryIds = d.config_entries as string[];
      this.entriesOf.set(d.id, entryIds);
      snap.devices.push({
        id: d.id,
        name: d.name_by_user || d.name || d.model || "Unnamed device",
        makerName: d.name_by_user || d.name || d.model || "Unnamed device",
        maker: d.manufacturer || titled(integration),
        model: d.model || "",
        category: best!.category,
        status: "found",
        needs: "ready",
        rooms: [],
        suggestedRoom: d.area_id ? areaName.get(d.area_id) : undefined,
        controls,
      });
    }

    for (const f of flows) {
      if (!DISCOVERED.has(f.context?.source) || NOT_HOME.has(f.handler)) continue;
      const id = `found:${f.handler}:${f.context?.unique_id ?? f.flow_id}`;
      const needs: Needs = LOGIN.has(f.handler) ? "login" : "confirm";
      snap.flows.set(id, { flowId: f.flow_id, handler: f.handler });
      snap.devices.push({
        id,
        name: f.context?.title_placeholders?.name || titled(f.handler),
        makerName: f.context?.title_placeholders?.name || titled(f.handler),
        maker: titled(f.handler),
        model: "",
        category: BY_INTEGRATION[f.handler] ?? "other",
        status: "found",
        needs,
        rooms: [],
        controls: [],
      });
    }

    snap.devices.sort((a, b) => a.name.localeCompare(b.name));
    return snap;
  }

  /** The household chose a device and said where it is. Ready ones are instant; waiting ones get their yes. */
  async add(id: string, rooms: string[]): Promise<AddResult> {
    const snap = await this.snapshot();
    const dev = snap.devices.find((d) => d.id === id);
    if (!dev) return { ok: false, message: "That device is no longer on the network." };
    const flow = snap.flows.get(id);
    if (!flow) { store.set(id, "added"); store.setRooms(id, rooms); return { ok: true }; }

    // Something the hub found that waits for an answer: a plain yes, or whatever its maker asks for.
    if (!this.steps) return { ok: false, message: `${dev.maker} needs a step Vincent cannot do yet.` };
    const step = await this.steps(flow.flowId, flow.handler, rooms);
    this.invalidate();
    if (step.kind === "done") return { ok: true };
    if (step.kind === "stopped") return { ok: false, message: step.text };
    return { ok: false, step };
  }

  /** Set by the hub service: walks a waiting discovery through its maker's questions. */
  steps?: (flowId: string, handler: string, rooms: string[]) => Promise<import("../../../packages/core/src/index.ts").Step>;

  async setRooms(id: string, rooms: string[]): Promise<void> {
    if (!(await this.snapshot()).devices.some((d) => d.id === id)) throw new Error("That device is no longer on the network.");
    store.setRooms(id, rooms);
  }

  async rename(id: string, name: string): Promise<void> {
    if (!(await this.snapshot()).devices.some((d) => d.id === id)) throw new Error("That device is no longer on the network.");
    store.setName(id, name);
  }

  async setStatus(id: string, status: "found" | "ignored"): Promise<void> {
    store.set(id, status);
  }

  /** Commands only reach devices the household added. */
  async control(req: ControlRequest): Promise<void> {
    const snap = await this.snapshot();
    const ref = snap.controls.get(req.id);
    const dev = ref && snap.devices.find((d) => d.id === ref.deviceId);
    if (!ref || !dev) throw new Error("unknown control");
    if (dev.status !== "added") throw new Error("that device has not been added to Vincent");
    const { domain, entityId } = ref;
    const v = req.value;
    const call = (service: string, data = {}, dom = domain) => this.ha.service(dom, service, entityId, data);
    switch (req.action) {
      case "on": await call("turn_on", {}, "homeassistant"); break;
      case "off": await call("turn_off", {}, "homeassistant"); break;
      case "brightness": await call("turn_on", { brightness_pct: clamp(v, 1, 100) }); break;
      case "play": await call("media_play"); break;
      case "pause": await call("media_pause"); break;
      case "next": await call("media_next_track"); break;
      case "previous": await call("media_previous_track"); break;
      case "volume": await call("volume_set", { volume_level: clamp(v, 0, 100) / 100 }); break;
      case "target": await call("set_temperature", { temperature: v }); break;
      case "lock": await call("lock"); break;
      case "unlock": await call("unlock"); break;
      case "open": await call("open_cover"); break;
      case "close": await call("close_cover"); break;
      default: throw new Error("unknown action");
    }
  }

  /** A media player the household added: what the hub needs to browse it and play on it. */
  async player(controlId: string): Promise<{ entityId: string; integration: string; host?: string }> {
    const snap = await this.snapshot();
    const ref = snap.controls.get(controlId);
    const dev = ref && snap.devices.find((d) => d.id === ref.deviceId);
    if (!ref || !dev || ref.domain !== "media_player") throw new Error("unknown player");
    if (dev.status !== "added") throw new Error("that device has not been added to Vincent");
    return ref;
  }

  /** The network address of the device behind an entity, or of any device of one make. */
  async hostOf(entityId: string): Promise<string | undefined> {
    for (const ref of (await this.snapshot()).controls.values()) if (ref.entityId === entityId) return ref.host;
    return undefined;
  }
  async anyHost(integration: string): Promise<string | undefined> {
    for (const ref of (await this.snapshot()).controls.values()) if (ref.integration === integration && ref.host) return ref.host;
    return undefined;
  }

  /** Does this entity belong to a device the app shows? Decides whether a change is worth a push. */
  shown(entityId: string): boolean {
    if (!this.snap) return false;
    for (const ref of this.snap.controls.values()) if (ref.entityId === entityId) return true;
    return false;
  }
}

function project(id: string, name: string, domain: string, s: HaState | undefined, integration: string, byEntity: Map<string, string>): Control {
  const a = s?.attributes ?? {};
  const base = { id, name, available: !!s && s.state !== "unavailable" && s.state !== "unknown", changed: s?.last_changed };
  switch (KIND[domain].kind) {
    case "light": {
      const modes: string[] = a.supported_color_modes ?? [];
      return { ...base, kind: "light", on: s?.state === "on", dimmable: modes.some((m) => m !== "onoff"), brightness: a.brightness ? Math.round((a.brightness / 255) * 100) : 0 };
    }
    case "media": {
      const st = s?.state === "playing" ? "playing" : s?.state === "paused" ? "paused" : s?.state === "off" ? "off" : "idle";
      const sonos = integration === "sonos";
      // A Sonos lists its favourites as inputs too; those are shown as favourites, so only the real inputs stay here.
      const inputs = (Array.isArray(a.source_list) ? (a.source_list as string[]) : []).filter((x) => !sonos || /^(tv|line-in)$/i.test(x));
      return {
        ...base, kind: "media", state: st, title: a.media_title, artist: a.media_artist, album: a.media_album_name,
        volume: typeof a.volume_level === "number" ? Math.round(a.volume_level * 100) : undefined,
        art: a.entity_picture ? `/api/art/${id}?v=${hash(String(a.entity_picture))}` : undefined,
        source: typeof a.source === "string" ? a.source : undefined, inputs, library: sonos ? "sonos" : "none",
        group: (Array.isArray(a.group_members) && a.group_members.length ? (a.group_members as string[]).map((e) => byEntity.get(e)).filter((x): x is string => !!x) : [id]),
        groups: sonos,
      };
    }
    case "climate": return { ...base, kind: "climate", current: a.current_temperature, target: a.temperature, mode: s?.state ?? "off" };
    case "lock": return { ...base, kind: "lock", locked: s?.state === "locked" };
    case "cover": return { ...base, kind: "cover", open: s?.state !== "closed" };
    case "camera": return { ...base, kind: "camera" };
    default: return { ...base, kind: "switch", on: s?.state === "on" };
  }
}

const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const clamp = (v: number | undefined, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number(v ?? lo)));
const titled = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
