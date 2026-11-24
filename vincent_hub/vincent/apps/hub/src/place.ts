/**
 * Where the home is, and the weather there.
 *
 * The household gives a ZIP code. From it the hub learns the town and its position (a public
 * postal directory), tells Home Assistant, and has Home Assistant's own forecast service
 * (the Norwegian Meteorological Institute; no account) follow that position.
 * The time zone comes from the phone doing the setup, which is standing in the home.
 *
 * v1 is United States ZIP codes. The directory also knows other countries' postcodes; the
 * country is already a parameter here for when the app asks for it.
 */
import type { HA } from "./ha.ts";
import { store } from "./store.ts";
import type { Weather } from "../../../packages/core/src/index.ts";

interface Looked { place: string; region: string; latitude: number; longitude: number }

async function lookUp(country: string, code: string): Promise<Looked> {
  const r = await fetch(`https://api.zippopotam.us/${country.toLowerCase()}/${encodeURIComponent(code)}`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!r) throw new Error("The postal directory did not answer. Try again in a moment.");
  if (r.status === 404) throw new Error("That ZIP code was not found.");
  const j = (await r.json().catch(() => null)) as { places?: { "place name": string; "state abbreviation": string; latitude: string; longitude: string }[] } | null;
  const p = j?.places?.[0];
  if (!r.ok || !p) throw new Error("That ZIP code was not found.");
  return { place: p["place name"], region: p["state abbreviation"], latitude: Number(p.latitude), longitude: Number(p.longitude) };
}

export class Place {
  private ha: HA;
  private days: { at: number; entity: string; list: Weather["days"] } | undefined;
  private fetching = false;

  constructor(ha: HA) { this.ha = ha; }

  /** Sets the home's position from a ZIP code. `timeZone` is the setting-up phone's own ("America/Los_Angeles"). */
  async set(zip: string, timeZone: string | undefined, country = "US"): Promise<string> {
    const code = zip.trim();
    if (country === "US" && !/^\d{5}$/.test(code)) throw new Error("A ZIP code is five digits.");
    const at = await lookUp(country, code);
    const zone = timeZone && /^[A-Za-z_]+\/[A-Za-z_/+-]+$/.test(timeZone) ? timeZone : undefined;
    await this.ha.call({ type: "config/core/update", latitude: at.latitude, longitude: at.longitude, country, unit_system: country === "US" ? "us_customary" : "metric", ...(zone ? { time_zone: zone } : {}) });

    // The forecast follows one fixed position, so a new ZIP code means a new forecast source.
    const entries = (await this.ha.call({ type: "config_entries/get" })) as { entry_id: string; domain: string }[];
    for (const e of entries.filter((x) => x.domain === "met")) await this.ha.rest("DELETE", `/config/config_entries/entry/${e.entry_id}`).catch(() => {});
    const flow = await this.ha.rest("POST", "/config/config_entries/flow", { handler: "met", show_advanced_options: false });
    if (flow?.type === "form") await this.ha.rest("POST", `/config/config_entries/flow/${flow.flow_id}`, { location: { latitude: at.latitude, longitude: at.longitude }, elevation: 0 });
    this.days = undefined;

    const place = [at.place, at.region].filter(Boolean).join(", ");
    store.setPlace({ zip: code, country, place, ...(zone ? { timeZone: zone } : {}) });
    return place;
  }

  private entity(): string | undefined {
    for (const id of this.ha.states.keys()) if (id.startsWith("weather.")) return id;
    return undefined;
  }

  /** Is this the entity the header's weather comes from? (Decides whether its change is worth a push.) */
  shows(entityId: string): boolean { return entityId.startsWith("weather."); }

  /** The weather now, with the coming days when they are known. Never waits on the network. */
  weather(): Weather | undefined {
    const id = this.entity();
    const s = id ? this.ha.states.get(id) : undefined;
    if (!id || !s || s.state === "unavailable" || s.state === "unknown" || typeof s.attributes.temperature !== "number") return undefined;
    if ((!this.days || this.days.entity !== id || Date.now() - this.days.at > 30 * 60_000) && !this.fetching) this.refresh(id);
    const days = this.days?.entity === id ? this.days.list : [];
    const n = (k: string) => (typeof s.attributes[k] === "number" ? Math.round(s.attributes[k]) : undefined);
    return { place: store.place?.place ?? "", condition: s.state, temperature: Math.round(s.attributes.temperature), unit: String(s.attributes.temperature_unit ?? "°F"), high: days[0]?.high, low: days[0]?.low,
      feels: n("apparent_temperature"), humidity: n("humidity"), wind: n("wind_speed"), uv: n("uv_index"), windUnit: String(s.attributes.wind_speed_unit ?? "mph"), wetUnit: String(s.attributes.precipitation_unit ?? "in"), days };
  }

  private refresh(entity: string): void {
    this.fetching = true;
    type Row = { datetime: string; condition: string; temperature: number; templow?: number; precipitation?: number; precipitation_probability?: number; wind_speed?: number; humidity?: number; uv_index?: number };
    const read = (type: "daily" | "hourly") => this.ha.call({ type: "call_service", domain: "weather", service: "get_forecasts", service_data: { type }, target: { entity_id: entity }, return_response: true })
      .then((r) => (r?.response?.[entity]?.forecast ?? []) as Row[]);
    // The day a moment falls on at the home, so the hours land under the right day.
    const zone = store.place?.timeZone || this.ha.timeZone || undefined;
    const dayOf = (iso: string) => { try { return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)); } catch { return iso.slice(0, 10); } };
    const num = (v: unknown, places = 0) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10 ** places) / 10 ** places : undefined);
    Promise.all([read("daily"), read("hourly").catch(() => [] as Row[])])
      .then(([list, hourly]) => {
        const hours = hourly.filter((h) => Date.parse(h.datetime) > Date.now() - 3600_000).slice(0, 48);
        this.days = { at: Date.now(), entity, list: list.slice(0, 6).map((d, i) => {
          const mine = hours.filter((h) => dayOf(h.datetime) === dayOf(d.datetime)).map((h) => ({ at: h.datetime, condition: h.condition, temperature: Math.round(h.temperature), rain: num(h.precipitation_probability) }));
          return { date: d.datetime, condition: d.condition, high: Math.round(d.temperature), low: typeof d.templow === "number" ? Math.round(d.templow) : undefined,
            rain: num(d.precipitation_probability), wet: num(d.precipitation, 2), wind: num(d.wind_speed), humidity: num(d.humidity), uv: i > 0 && !d.uv_index ? undefined : num(d.uv_index), // the source gives no sun strength for later days, and says 0 ...(mine.length ? { hours: mine } : {}) };
        }) };
        this.onDays();
      })
      .catch((e: Error) => { console.log(`[place] forecast not read: ${e.message}`); this.days = { at: Date.now() - 25 * 60_000, entity, list: this.days?.list ?? [] }; })
      .finally(() => { this.fetching = false; });
  }

  /** Called when the coming days arrive, so open apps re-read. */
  onDays: () => void = () => {};
}
