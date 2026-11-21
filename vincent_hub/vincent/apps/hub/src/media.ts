/**
 * What a speaker can play, and playing it.
 *
 * Sonos: favourites and playlists are read from the speaker itself (they are saved in the
 * Sonos app and belong to the whole Sonos household, so any speaker answers for all of them).
 * Home Assistant lists favourites too, but not which service each belongs to, and that is
 * how the app groups them. Playing always goes through Home Assistant.
 *
 * Internet radio: the public Radio Browser directory. No account, no key.
 */
import type { HA } from "./ha.ts";
import type { Devices } from "./devices.ts";
import type { MediaItem, MediaSources } from "../../../packages/core/src/index.ts";

interface SonosEntry { id: string; title: string; service: string; art?: string }

const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

const browsed = new Map<string, { at: number; items: SonosEntry[] }>();

/** One list on a speaker: "FV:2" = favourites, "SQ:" = Sonos playlists. Cached for a minute. */
async function sonosBrowse(host: string, objectId: string): Promise<SonosEntry[]> {
  const cacheKey = `${host}|${objectId}`;
  const hit = browsed.get(cacheKey);
  if (hit && Date.now() - hit.at < 60_000) return hit.items;
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><ObjectID>${objectId}</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter>*</Filter><StartingIndex>0</StartingIndex><RequestedCount>300</RequestedCount><SortCriteria></SortCriteria></u:Browse></s:Body></s:Envelope>`;
  const res = await fetch(`http://${host}:1400/MediaServer/ContentDirectory/Control`, {
    method: "POST",
    headers: { "content-type": 'text/xml; charset="utf-8"', SOAPACTION: '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"' },
    body,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`the speaker answered ${res.status}`);
  const didl = unescapeXml((await res.text()).match(/<Result>([\s\S]*?)<\/Result>/)?.[1] ?? "");
  const items: SonosEntry[] = [];
  for (const m of didl.matchAll(/<(item|container) id="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)) {
    const inner = m[3];
    const pick = (tag: string) => unescapeXml(inner.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? "").trim();
    const title = pick("dc:title");
    if (!title) continue;
    const art = pick("upnp:albumArtURI");
    items.push({ id: unescapeXml(m[2]), title, service: pick("r:description") || "Sonos", art: art ? (art.startsWith("/") ? `http://${host}:1400${art}` : art) : undefined });
  }
  browsed.set(cacheKey, { at: Date.now(), items });
  return items;
}

// ───────────────────────── internet radio ─────────────────────────

const RADIO_HOSTS = ["https://de1.api.radio-browser.info", "https://fi1.api.radio-browser.info", "https://at1.api.radio-browser.info"];
interface Station { stationuuid: string; name: string; favicon: string; country: string; tags: string; codec: string }
let radioHost = 0;
const stations = new Map<string, { at: number; items: MediaItem[] }>();
/** station id -> the kind of stream it is, remembered from the listing so playing needs no second lookup */
const streamType = new Map<string, string>();

async function radioGet(path: string): Promise<Station[]> {
  for (let i = 0; i < RADIO_HOSTS.length; i++) {
    const n = (radioHost + i) % RADIO_HOSTS.length;
    try {
      const res = await fetch(RADIO_HOSTS[n] + path, { headers: { "User-Agent": "Vincent/1.0 (home hub)" }, signal: AbortSignal.timeout(6000) });
      if (res.ok) { radioHost = n; return (await res.json()) as Station[]; }
    } catch { /* try the next mirror */ }
  }
  throw new Error("The radio directory did not answer.");
}

export async function radio(q: string, tag: string): Promise<MediaItem[]> {
  const cacheKey = tag ? `tag:${tag}` : q.length >= 2 ? `q:${q.toLowerCase()}` : "popular";
  const hit = stations.get(cacheKey);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.items;
  const tail = "&limit=30&order=votes&reverse=true&hidebroken=true";
  const found = await radioGet(tag ? `/json/stations/search?tag=${encodeURIComponent(tag)}${tail}` : q.length >= 2 ? `/json/stations/search?name=${encodeURIComponent(q)}${tail}` : `/json/stations/search?countrycode=US${tail}`);
  const items = found.filter((s) => s.name?.trim() && s.stationuuid).map((s): MediaItem => {
    const codec = (s.codec || "MP3").toLowerCase();
    streamType.set(s.stationuuid, codec.startsWith("aac") ? "audio/aac" : codec === "ogg" ? "audio/ogg" : "audio/mpeg");
    return { kind: "radio", id: s.stationuuid, title: s.name.trim(), subtitle: [s.country, s.tags.split(",").slice(0, 3).join(", ")].filter(Boolean).join(" · "), art: s.favicon?.startsWith("https") ? s.favicon : undefined };
  });
  stations.set(cacheKey, { at: Date.now(), items });
  return items;
}

// ───────────────────────── a player's sources, and playing one ─────────────────────────

export class Media {
  private ha: HA;
  private devices: Devices;
  private radioReady?: { at: number; ok: boolean };

  constructor(ha: HA, devices: Devices) { this.ha = ha; this.devices = devices; }

  /** Home Assistant plays radio through its own radio integration, which every new hub has. */
  private async hasRadio(): Promise<boolean> {
    if (!this.radioReady || Date.now() - this.radioReady.at > 60_000) this.radioReady = { at: Date.now(), ok: await this.ha.has("radio_browser").catch(() => false) };
    return this.radioReady.ok;
  }

  async sources(controlId: string): Promise<MediaSources> {
    const p = await this.devices.player(controlId);
    const a = this.ha.states.get(p.entityId)?.attributes ?? {};
    const out: MediaSources = { favourites: [], playlists: [], inputs: [], radio: await this.hasRadio() };
    const list: string[] = Array.isArray(a.source_list) ? a.source_list : [];

    if (p.integration === "sonos" && p.host) {
      const [favs, lists] = await Promise.all([sonosBrowse(p.host, "FV:2"), sonosBrowse(p.host, "SQ:").catch(() => [])]);
      const groups = new Map<string, MediaItem[]>();
      for (const f of favs) groups.set(f.service, [...(groups.get(f.service) ?? []), { kind: "favourite", id: f.id, title: f.title, subtitle: f.service, art: f.art }]);
      out.favourites = [...groups].map(([service, items]) => ({ service, items })).sort((x, y) => y.items.length - x.items.length);
      out.playlists = lists.map((l) => ({ kind: "playlist", id: l.title, title: l.title, art: l.art }));
      out.inputs = list.filter((x) => /^(tv|line-in)$/i.test(x)).map((x) => ({ kind: "input", id: x, title: x }));
    } else {
      out.inputs = list.map((x) => ({ kind: "input", id: x, title: x }));
    }
    return out;
  }

  async play(controlId: string, item: { kind?: string; id?: string }): Promise<void> {
    const p = await this.devices.player(controlId);
    const id = String(item.id ?? "");
    if (!id) throw new Error("Nothing was chosen to play.");
    const play = (type: string, content: string) => this.ha.service("media_player", "play_media", p.entityId, { media_content_type: type, media_content_id: content });
    switch (item.kind) {
      case "favourite": await play("favorite_item_id", id); break;
      case "playlist": await play("playlist", id); break;
      case "radio":
        if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("That station is not in the directory.");
        await play(streamType.get(id) ?? "audio/mpeg", `media-source://radio_browser/${id}`);
        break;
      case "input": await this.ha.service("media_player", "select_source", p.entityId, { source: id }); break;
      default: throw new Error("Vincent does not know how to play that.");
    }
  }

  /** The cover art of what a player is playing. */
  async art(controlId: string): Promise<{ type: string; data: Buffer }> {
    const p = await this.devices.player(controlId);
    const pic = this.ha.states.get(p.entityId)?.attributes?.entity_picture;
    if (!pic) throw new Error("no picture");
    return this.ha.picture(String(pic));
  }
}
