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
import { CLIMATE_MODES } from "../../../packages/core/src/index.ts";

/** Home Assistant's names for a thermostat's modes, and ours. */
const MODE_OURS: Record<string, string> = { heat: "heat", cool: "cool", heat_cool: "both", auto: "auto", fan_only: "fan", dry: "dry", off: "off" };

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
  controls: Map<string, { entityId: string; deviceId: string; domain: string; integration: string; host?: string; name?: string; events?: string[]; activity?: string }>;
  /** entity id -> control id, for naming the other players in a group */
  byEntity: Map<string, string>;
  /** device id -> waiting flow */
  flows: Map<string, { flowId: string; handler: string }>;
}

/** What an Echo was last asked to play, and the song it was reporting just before: see the media control below. */
const asked = new Map<string, { title: string; from: string; was: string; at: number }>();
export function askedToPlay(entityId: string, title: string, from: string, was: string): void { asked.set(entityId, { title, from, was, at: Date.now() }); }

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
        const now = project(c.id, own === d.makerName ? d.name : own, ref.domain, this.ha.states.get(ref.entityId), ref.integration, this.snap!.byEntity);
        if (now.kind === "camera") now.event = this.lastEvent(ref);
        return now;
      });
    }
    return this.snap;
  }

  /** camera entity -> the last motion or ring seen while this service has been running */
  private seen = new Map<string, { at: string; kind: "motion" | "ding" }>();

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
    // Alexa lists every speaker on the Amazon account, Sonos speakers among them. Those are better added through Sonos itself
    // (favourites, grouping, the whole catalogue), and adding both would put the same speaker in the home twice.
    const twinOf = (integration: string, model: string, name: string) => (integration === "alexa_media" && /sonos/i.test(`${model} ${name}`) ? "Sonos" : undefined);
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
        // A camera's "someone rang" and "something moved" live in entities beside it.
        const beside = domain === "camera" ? ents.filter((x: any) => x.device_id === d.id && !x.disabled_by).map((x: any) => String(x.entity_id)) : [];
        snap.controls.set(e.id, { entityId: e.entity_id, deviceId: d.id, domain, integration, host,
          ...(beside.length ? { events: beside.filter((x: string) => /^event\..*_(ding|motion)$/.test(x)), activity: beside.find((x: string) => /^sensor\..*_last_activity$/.test(x)) } : {}) });
        snap.byEntity.set(e.entity_id, e.id);
        controls.push(project(e.id, name, domain, undefined, integration, snap.byEntity));
      }
      if (!controls.length) continue; // nothing the app could do with it
      const entryIds = d.config_entries as string[];
      this.entriesOf.set(d.id, entryIds);
      // A camera added by its stream address is named after that address and made by "Generic". Its network address says who really made it.
      const own = String(d.name_by_user || d.name || "");
      const at = integration === "generic" ? /^(\d{1,3})[._](\d{1,3})[._](\d{1,3})[._](\d{1,3})$/.exec(own.trim()) : null;
      const madeBy = integration === "generic" ? (at && this.makerAt?.(at.slice(1).join("."))) || "" : "";
      const plain = integration === "generic" && (at || !own) ? `${madeBy || "Stream"} camera` : "";
      snap.devices.push({
        id: d.id,
        name: plain || d.name_by_user || d.name || d.model || "Unnamed device",
        makerName: plain || d.name_by_user || d.name || d.model || "Unnamed device",
        maker: madeBy || (integration === "generic" ? "Camera" : d.manufacturer || titled(integration)),
        model: d.model || "",
        category: best!.category,
        status: "found",
        needs: "ready",
        rooms: [],
        suggestedRoom: d.area_id ? areaName.get(d.area_id) : undefined,
        controls,
        twin: twinOf(integration, String(d.model ?? ""), String(d.name ?? "")),
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
    // Set up, and it brought devices (a Sonos system is several speakers): hand them back so each can be given its room.
    if (step.kind === "done") return step.brought?.length ? { ok: true, step } : { ok: true };
    if (step.kind === "stopped") return { ok: false, message: step.text };
    return { ok: false, step };
  }

  /** Set by the hub service: who made the device at a home address, when its network address tells. */
  makerAt?: (ip: string) => string | undefined;
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
    await this.detach(id);
    store.set(id, status);
  }

  /** The devices one maker's account brought (device ids). */
  async broughtBy(entry: string): Promise<string[]> {
    this.invalidate();
    return (await this.snapshot()).devices.filter((d) => this.entriesOf.get(d.id)?.includes(entry)).map((d) => d.id);
  }

  /** A maker's devices arrive a few at a time after its account is connected: wait until the count stops growing. */
  async settle(read: () => Promise<string[]>, longest = 14_000): Promise<string[]> {
    const until = Date.now() + longest;
    let last: string[] = [];
    for (;;) {
      const now = await read();
      if (now.length && now.length === last.length) return now;
      last = now;
      if (Date.now() > until) return last;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  async ids(): Promise<string[]> { this.invalidate(); return (await this.snapshot()).devices.map((d) => d.id); }

  /**
   * An account that was added whole ("everything it brings") is turned into one choice per device,
   * so a single device of it can be left out or moved without the rest following.
   */
  private async detach(id: string): Promise<void> {
    const whole = (this.entriesOf.get(id) ?? []).filter((e) => store.hasEntry(e));
    if (!whole.length) return;
    const snap = await this.snapshot();
    for (const d of snap.devices) {
      const entries = this.entriesOf.get(d.id) ?? [];
      if (!entries.some((e) => whole.includes(e))) continue;
      if (!store.hasOwnRooms(d.id)) store.setRooms(d.id, store.roomsOf(d.id, entries));
      if (!store.own(d.id)) store.set(d.id, "added");
    }
    for (const e of whole) store.dropEntry(e);
  }

  /** Several devices at once: each is added to its rooms, or left under "Add a device". */
  async place(items: { id: string; add: boolean; rooms: string[] }[]): Promise<void> {
    const snap = await this.snapshot();
    for (const it of items) {
      if (!snap.devices.some((d) => d.id === it.id) || snap.flows.has(it.id)) continue;
      await this.detach(it.id);
      if (it.add) { store.set(it.id, "added"); store.setRooms(it.id, it.rooms); }
      else store.set(it.id, "found");
    }
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
      case "brightness": await call("turn_on", { brightness_pct: clamp(v, 1, 100), ...tint(req) }); break;
      case "color": case "white": if (domain !== "light" || !Object.keys(tint(req)).length) throw new Error("unknown action"); await call("turn_on", tint(req)); break;
      case "play": await call("media_play"); break;
      case "pause": await call("media_pause"); break;
      case "next": await call("media_next_track"); break;
      case "previous": await call("media_previous_track"); break;
      case "volume": await call("volume_set", { volume_level: clamp(v, 0, 100) / 100 }); break;
      case "target": await call("set_temperature", { temperature: v }); break;
      case "low": case "high": {
        // A thermostat keeping a range wants both ends each time; the other end is what it has now.
        const now = this.ha.states.get(entityId)?.attributes ?? {};
        const low = req.action === "low" ? v : now.target_temp_low, high = req.action === "high" ? v : now.target_temp_high;
        if (typeof low !== "number" || typeof high !== "number") throw new Error("That thermostat is not keeping a range right now.");
        await call("set_temperature", { target_temp_low: Math.min(low, high - 1), target_temp_high: Math.max(high, low + 1) });
        break;
      }
      case "mode": {
        const theirs = Object.entries(MODE_OURS).find(([, ours]) => ours === req.mode)?.[0];
        const has = (this.ha.states.get(entityId)?.attributes?.hvac_modes as string[] | undefined) ?? [];
        if (domain !== "climate" || !theirs || !has.includes(theirs)) throw new Error("That thermostat does not have that mode.");
        await call("set_hvac_mode", { hvac_mode: theirs });
        break;
      }
      case "lock": case "unlock": {
        await call(req.action);
        // Many locks answer through their maker's service and are only read every half minute: asked again a few times, the app sees the lock move sooner.
        for (const ms of [3000, 8000, 16000]) setTimeout(() => { this.ha.service("homeassistant", "update_entity", entityId).catch(() => {}); }, ms);
        break;
      }
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

  async camera(controlId: string): Promise<{ entityId: string }> {
    const snap = await this.snapshot();
    const ref = snap.controls.get(controlId);
    const dev = ref && snap.devices.find((d) => d.id === ref.deviceId);
    if (!ref || !dev || ref.domain !== "camera") throw new Error("unknown camera");
    if (dev.status !== "added") throw new Error("that device has not been added to Vincent");
    return ref;
  }
  /** Every added camera: control id and entity. */
  async cameras(): Promise<[string, string][]> {
    const snap = await this.snapshot();
    const added = new Set(snap.devices.filter((d) => d.status === "added").map((d) => d.id));
    return [...snap.controls].filter(([, r]) => r.domain === "camera" && added.has(r.deviceId)).map(([id, r]) => [id, r.entityId]);
  }

  /**
   * The last time a camera saw motion or its button was pressed. Two sources, the later wins:
   * the maker's instant event, and a slower polled "last activity" that keeps up when the instant one stalls.
   */
  private lastEvent(ref: { entityId: string; events?: string[]; activity?: string }): { at: string; kind: "motion" | "ding" } | undefined {
    // Remembered, because the polled source forgets: watching live replaces "motion" there with "on demand".
    let best = this.seen.get(ref.entityId);
    const take = (at: unknown, kind: unknown) => {
      if (typeof at !== "string" || (kind !== "motion" && kind !== "ding") || isNaN(Date.parse(at))) return;
      if (!best || Date.parse(at) > Date.parse(best.at)) best = { at, kind };
    };
    for (const e of ref.events ?? []) take(this.ha.states.get(e)?.state, e.endsWith("_ding") ? "ding" : "motion");
    const a = ref.activity && this.ha.states.get(ref.activity);
    if (a) take(a.state, a.attributes?.category);
    if (best) this.seen.set(ref.entityId, best);
    return best;
  }

  /** The network address of the device behind an entity, or of any device of one make. */
  async hostOf(entityId: string): Promise<string | undefined> {
    for (const ref of (await this.snapshot()).controls.values()) if (ref.entityId === entityId) return ref.host;
    return undefined;
  }
  /** The entities of every added player that one maker's driver brought. */
  async playersOf(integration: string): Promise<string[]> {
    const snap = await this.snapshot();
    return [...snap.controls.values()].filter((r) => r.integration === integration && r.domain === "media_player" && snap.devices.find((d) => d.id === r.deviceId)?.status === "added").map((r) => r.entityId);
  }

  async anyHost(integration: string): Promise<string | undefined> {
    for (const ref of (await this.snapshot()).controls.values()) if (ref.integration === integration && ref.host) return ref.host;
    return undefined;
  }

  /** Does this entity belong to a device the app shows? Decides whether a change is worth a push. */
  shown(entityId: string): boolean {
    if (!this.snap) return false;
    for (const ref of this.snap.controls.values()) if (ref.entityId === entityId || ref.activity === entityId || ref.events?.includes(entityId)) return true;
    return false;
  }
}

function project(id: string, name: string, domain: string, s: HaState | undefined, integration: string, byEntity: Map<string, string>): Control {
  const a = s?.attributes ?? {};
  const base = { id, name, available: !!s && s.state !== "unavailable" && s.state !== "unknown", changed: s?.last_changed };
  switch (KIND[domain].kind) {
    case "light": {
      const modes: string[] = a.supported_color_modes ?? [];
      const isOn = s?.state === "on";
      const colors = modes.some((m) => ["hs", "rgb", "rgbw", "rgbww", "xy"].includes(m));
      const lo = Number(a.min_color_temp_kelvin), hi = Number(a.max_color_temp_kelvin);
      const whites = modes.includes("color_temp") && lo > 0 && hi > lo ? ([lo, hi] as [number, number]) : undefined;
      const rgb = Array.isArray(a.rgb_color) ? (a.rgb_color[0] << 16) | (a.rgb_color[1] << 8) | a.rgb_color[2] : undefined;
      // A light showing a white reports that white; one showing a colour reports the colour.
      const white = isOn && a.color_mode === "color_temp" && a.color_temp_kelvin ? Number(a.color_temp_kelvin) : undefined;
      return {
        ...base, kind: "light", on: isOn, dimmable: modes.some((m) => m !== "onoff"), brightness: a.brightness ? Math.round((a.brightness / 255) * 100) : 0,
        ...(colors ? { colors } : {}), ...(whites ? { whites } : {}), ...(white ? { kelvin: white } : isOn && colors && rgb !== undefined ? { rgb } : {}),
      };
    }
    case "media": {
      const st = s?.state === "playing" ? "playing" : s?.state === "paused" ? "paused" : s?.state === "off" ? "off" : "idle";
      const sonos = integration === "sonos";
      // A Sonos lists its favourites as inputs too; those are shown as favourites, so only the real inputs stay here.
      const inputs = (Array.isArray(a.source_list) ? (a.source_list as string[]) : []).filter((x) => !sonos || /^(tv|line-in)$/i.test(x));
      // An Echo asked for something new sometimes keeps reporting the song it played before. Until its report changes,
      // what was asked for is shown, rather than a song that is no longer playing.
      const ask = s ? asked.get(s.entity_id) : undefined;
      const stale = !!ask && st === "playing" && Date.now() - ask.at < 30 * 60_000 && String(a.media_title ?? "") === ask.was;
      if (ask && !stale && (Date.now() - ask.at > 15_000 || String(a.media_title ?? "") !== ask.was)) asked.delete(s!.entity_id);
      return {
        ...base, kind: "media", state: st, title: a.media_title, artist: a.media_artist, album: a.media_album_name,
        volume: typeof a.volume_level === "number" ? Math.round(a.volume_level * 100) : undefined,
        art: a.entity_picture ? `/api/art/${id}?v=${hash(String(a.entity_picture))}` : undefined,
        source: typeof a.source === "string" ? a.source : undefined, inputs, library: sonos ? "sonos" : "none",
        group: (Array.isArray(a.group_members) && a.group_members.length ? (a.group_members as string[]).map((e) => byEntity.get(e)).filter((x): x is string => !!x) : [id]),
        groups: sonos,
        ...(stale ? { title: ask!.title, artist: ask!.from, album: undefined, art: undefined } : {}),
      };
    }
    case "climate": {
      const modes = (Array.isArray(a.hvac_modes) ? (a.hvac_modes as string[]) : []).map((m) => MODE_OURS[m]).filter(Boolean);
      const num = (v: unknown) => (typeof v === "number" ? v : undefined);
      const doing = ({ heating: "heating", preheating: "heating", cooling: "cooling", fan: "fan", idle: "idle", drying: "drying" } as Record<string, string>)[String(a.hvac_action ?? "")];
      return {
        ...base, kind: "climate", current: num(a.current_temperature), target: num(a.temperature), low: num(a.target_temp_low), high: num(a.target_temp_high),
        mode: MODE_OURS[s?.state ?? ""] ?? "off", modes: CLIMATE_MODES.map((m) => m.id).filter((m) => modes.includes(m)), ...(doing ? { doing } : {}),
      };
    }
    case "lock": return { ...base, kind: "lock", locked: s?.state === "locked" };
    case "cover": return { ...base, kind: "cover", open: s?.state !== "closed", door: ["garage", "door", "gate"].includes(String(a.device_class ?? "")) };
    // Feature 2 = it can stream. A sleeping battery camera says "idle", never "unavailable".
    case "camera": return { ...base, kind: "camera", still: `/api/cameras/${id}/still`, live: (Number(a.supported_features ?? 0) & 2) === 2 };
    default: return { ...base, kind: "switch", on: s?.state === "on" };
  }
}

const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const clamp = (v: number | undefined, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number(v ?? lo)));
const titled = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** The colour or white a request asks a light for, in Home Assistant's words. Nothing when it asks for neither. */
function tint(req: ControlRequest): Record<string, unknown> {
  if (req.kelvin && req.kelvin >= 1500 && req.kelvin <= 9000) return { color_temp_kelvin: Math.round(req.kelvin) };
  if (typeof req.rgb === "number" && req.rgb >= 0 && req.rgb <= 0xffffff) return { rgb_color: [req.rgb >> 16, (req.rgb >> 8) & 255, req.rgb & 255] };
  return {};
}
