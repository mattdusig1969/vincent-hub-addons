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
import { askedToPlay } from "./devices.ts";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HA } from "./ha.ts";
import type { Devices } from "./devices.ts";
import { browseRaw, playServiceStream, serviceTemplate, speakerContext, unescapeXml } from "./sonos.ts";
import { SmapiService, type SmapiItem } from "./smapi.ts";
import { lineupGroups, SxmLineup } from "./sxm.ts";
import { dir } from "./store.ts";
import type { MediaGroup, MediaItem, MediaSources, ServiceStatus } from "../../../packages/core/src/index.ts";

/** Sonos's own numbers for the services Vincent knows how to show. */
const SIRIUSXM = 37, SPOTIFY = 12;

/**
 * Pictures of things to play are fetched by the hub, not by the phone: several services
 * refuse a browser that asks directly, and the phone should not be calling them anyway.
 * Only addresses the hub itself handed out can be asked for.
 */
const pictures = new Map<string, string>();
const fetched = new Map<string, { type: string; data: Buffer }>();
// The addresses are kept on disk: a starred station holds only its token, and must still have its picture after the hub restarts.
const picturesFile = join(dir, "pictures.json");
try { for (const [k, v] of Object.entries(JSON.parse(readFileSync(picturesFile, "utf8")) as Record<string, string>)) pictures.set(k, v); } catch { /* none kept yet */ }
let keeping: ReturnType<typeof setTimeout> | undefined;
function picture(url: string | undefined): string | undefined {
  if (!url || !/^https?:\/\//.test(url)) return undefined;
  const token = createHash("sha256").update(url).digest("hex").slice(0, 24);
  if (pictures.get(token) === url) return `/api/thumb/${token}`;
  if (pictures.size >= 20_000) pictures.delete(pictures.keys().next().value!);
  pictures.set(token, url);
  keeping ??= setTimeout(() => { keeping = undefined; try { mkdirSync(dir, { recursive: true }); writeFileSync(picturesFile, JSON.stringify(Object.fromEntries(pictures))); } catch { /* next time */ } }, 2000);
  return `/api/thumb/${token}`;
}
/** Where a picture's token points, when this hub knows. */
export const pictureSource = (art: string | undefined): string | undefined => pictures.get(String(art ?? "").replace(/^\/api\/thumb\//, ""));
/** The picture address for a source address, known to this hub from now on. */
export const pictureFor = (url: string | undefined): string | undefined => picture(url);

export async function thumb(token: string): Promise<{ type: string; data: Buffer } | null> {
  const hit = fetched.get(token);
  if (hit) return hit;
  const url = pictures.get(token);
  if (!url) return null;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  const type = r?.headers.get("content-type") ?? "";
  if (!r?.ok || !type.startsWith("image/")) return null;
  const data = Buffer.from(await r.arrayBuffer());
  if (data.length > 3_000_000) return null;
  if (fetched.size >= 300) fetched.delete(fetched.keys().next().value!);
  fetched.set(token, { type, data });
  return fetched.get(token)!;
}

interface SonosEntry { id: string; title: string; service: string; art?: string; uri?: string }
const browsed = new Map<string, { at: number; items: SonosEntry[] }>();

/** One list on a speaker: "FV:2" = favourites, "SQ:" = Sonos playlists. Cached for a minute. */
async function sonosBrowse(host: string, objectId: string): Promise<SonosEntry[]> {
  const cacheKey = `${host}|${objectId}`;
  const hit = browsed.get(cacheKey);
  if (hit && Date.now() - hit.at < 60_000) return hit.items;
  const items: SonosEntry[] = [];
  for (const { id, xml } of await browseRaw(host, objectId)) {
    const pick = (tag: string) => unescapeXml(xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? "").trim();
    const title = pick("dc:title");
    if (!title) continue;
    const art = pick("upnp:albumArtURI");
    items.push({ id, title, service: pick("r:description") || "Sonos", art: art ? (art.startsWith("/") ? `http://${host}:1400${art}` : art) : undefined, uri: pick("res") || undefined });
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
    return { kind: "radio", id: s.stationuuid, title: s.name.trim(), subtitle: [s.country, s.tags.split(",").slice(0, 3).join(", ")].filter(Boolean).join(" · "), art: picture(s.favicon) };
  });
  stations.set(cacheKey, { at: Date.now(), items });
  return items;
}

// ───────────────────────── a player's sources, and playing one ─────────────────────────

/** Home Assistant's name for the Echo driver. An Echo is asked for music by name: play_media(<service>, "<what>"). */
const ECHO = "alexa_media";
/** A start for an Echo's Amazon Music tab: names Amazon Music answers to. Anything else can be typed. */
const AMAZON_PICKS: { label: string; picks: string[] }[] = [
  { label: "Today", picks: ["Today's hits", "Pop hits", "Country hits", "Hip-hop hits", "Rock hits", "Latin hits"] },
  { label: "Decades", picks: ["60s hits", "70s hits", "80s hits", "90s hits", "2000s hits", "Classic rock"] },
  { label: "Moods", picks: ["Dinner party music", "Relaxing music", "Jazz for a quiet evening", "Classical for focus", "Feel-good music", "Workout music"] },
  { label: "For the house", picks: ["Music for cooking", "Sunday morning music", "Kids' music", "Acoustic favourites", "Soul classics", "Yacht rock"] },
];
/** What to ask an Echo's Spotify for, from something chosen in the Spotify catalogue. */
function spotifyAsk(id: string, title: string, subtitle = ""): string {
  const first = subtitle.split(" · ")[0]?.trim() ?? "";
  const by = first && !/^\d+ /.test(first) && first !== "Artist" ? ` by ${first}` : "";
  const kind = id.split(":")[1];
  return kind === "album" ? `the album ${title}${by}` : kind === "playlist" ? `the playlist ${title}` : `${title}${by}`;
}

export class Media {
  private ha: HA;
  private devices: Devices;
  private radioReady?: { at: number; ok: boolean };
  private lineup = new SxmLineup(join(dir, "sxm_lineup.json"));
  private spotifyService?: SmapiService;
  private linkTimer?: NodeJS.Timeout;
  private browseCache = new Map<string, { at: number; items: MediaItem[] }>();

  constructor(ha: HA, devices: Devices) { this.ha = ha; this.devices = devices; }

  /** Home Assistant plays radio through its own radio integration, which every new hub has. */
  private async hasRadio(): Promise<boolean> {
    if (!this.radioReady || Date.now() - this.radioReady.at > 60_000) this.radioReady = { at: Date.now(), ok: await this.ha.has("radio_browser").catch(() => false) };
    return this.radioReady.ok;
  }

  async sources(controlId: string): Promise<MediaSources> {
    const p = await this.devices.player(controlId);
    const a = this.ha.states.get(p.entityId)?.attributes ?? {};
    const out: MediaSources = { favourites: [], playlists: [], inputs: [], radio: await this.hasRadio(), siriusxm: false, spotify: false };
    const list: string[] = Array.isArray(a.source_list) ? a.source_list : [];

    if (p.integration === "sonos" && p.host) {
      const [favs, lists] = await Promise.all([sonosBrowse(p.host, "FV:2"), sonosBrowse(p.host, "SQ:").catch(() => [])]);
      const groups = new Map<string, MediaItem[]>();
      for (const f of favs) groups.set(f.service, [...(groups.get(f.service) ?? []), { kind: "favourite", id: f.id, title: f.title, subtitle: f.service, art: picture(f.art) }]);
      out.favourites = [...groups].map(([service, items]) => ({ service, items })).sort((x, y) => y.items.length - x.items.length);
      out.playlists = lists.map((l) => ({ kind: "playlist", id: l.title, title: l.title, art: picture(l.art) }));
      out.inputs = list.filter((x) => /^(tv|line-in)$/i.test(x)).map((x) => ({ kind: "input", id: x, title: x }));
      // The whole SiriusXM guide plays through a saved station's link, so one saved live station is what makes it possible.
      out.siriusxm = favs.some((f) => new RegExp(`[?&]sid=${SIRIUSXM}&`).test(f.uri ?? "") && /channel-linear/.test(f.uri ?? ""));
      out.spotify = true;
    } else if (p.integration === ECHO) {
      // An Echo has no catalogue to read, but it plays whatever it is asked for by name, on the service named.
      out.siriusxm = true;
      out.radio = true;
      out.spotify = !!(await this.devices.anyHost("sonos").catch(() => undefined)); // the Spotify catalogue is read through a Sonos
      out.amazon = AMAZON_PICKS.map((g) => ({ label: g.label, items: g.picks.map((name): MediaItem => ({ kind: "amazon", id: name, title: name, subtitle: "Amazon Music" })) }));
    } else {
      out.inputs = list.map((x) => ({ kind: "input", id: x, title: x }));
    }
    return out;
  }

  /**
   * Starred things keep their pictures on any hub: each star carries where its picture really is (`src`),
   * so a hub that has never listed it (a new hub, an erased one) can still show it. A SiriusXM channel's
   * picture is looked up afresh in the channel guide.
   */
  async mendStars<T extends { kind: string; id: string; art?: string; src?: string }>(stars: T[]): Promise<T[]> {
    let channels: Awaited<ReturnType<SxmLineup["channels"]>> | undefined;
    const out: T[] = [];
    for (const st of stars) {
      let src = st.src ?? pictureSource(st.art);
      if (!src && st.kind === "sxm") { channels ??= await this.lineup.channels().catch(() => []); src = channels.find((c) => c.uuid === st.id)?.logo; }
      const art = src ? pictureFor(src) : st.art;
      out.push({ ...st, ...(art ? { art } : {}), ...(src ? { src } : {}) });
    }
    return out;
  }

  // ── SiriusXM ──

  /** The channel guide, with the household's saved stations first. */
  async siriusxm(controlId: string): Promise<MediaGroup[]> {
    const p = await this.devices.player(controlId);
    const channels = await this.lineup.channels();
    const item = (c: (typeof channels)[number]): MediaItem => ({ kind: "sxm", id: c.uuid, title: c.name, subtitle: [c.number != null ? `Ch ${c.number}` : "", c.desc].filter(Boolean).join(" · "), art: picture(c.logo) });
    const groups: MediaGroup[] = lineupGroups(channels).map((g) => ({ label: g.label, items: g.channels.map(item) }));
    if (p.host) {
      const saved = new Set((await sonosBrowse(p.host, "FV:2").catch(() => [])).map((f) => f.uri?.match(/channel-linear(?:%3A|:)([0-9a-f-]{36})/i)?.[1]?.toLowerCase()).filter(Boolean));
      const mine = channels.filter((c) => saved.has(c.uuid)).map(item);
      if (mine.length) groups.unshift({ label: "Saved", items: mine });
    }
    return groups;
  }

  // ── Spotify, through the household's Sonos ──

  private async spotify(): Promise<SmapiService> {
    if (this.spotifyService) return this.spotifyService;
    const host = await this.devices.anyHost("sonos");
    if (!host) throw new Error("A Sonos speaker is needed to reach Spotify.");
    const ctx = await speakerContext(host);
    const desc = ctx.services.find((s) => s.sid === SPOTIFY);
    if (!desc) throw new Error("Spotify is not offered on this Sonos system.");
    return (this.spotifyService = new SmapiService(desc, ctx.householdId, ctx.deviceId, join(dir, "services.json")));
  }

  async spotifyStatus(): Promise<ServiceStatus> {
    const s = await this.spotify();
    return { linked: s.linked, account: s.nickname, signIn: s.linked ? undefined : s.pending?.regUrl };
  }

  /** Starts the one-time sign-in and keeps asking Spotify whether it happened (the person may finish it on another device). */
  async spotifyLink(onLinked: () => void): Promise<ServiceStatus> {
    const s = await this.spotify();
    if (s.linked) return this.spotifyStatus();
    const signIn = await s.beginLink();
    if (!this.linkTimer) {
      const until = Date.now() + 8 * 60_000;
      const stop = () => { clearInterval(this.linkTimer); this.linkTimer = undefined; };
      this.linkTimer = setInterval(async () => {
        try {
          if (s.linked || !s.pending || Date.now() > until) return stop();
          if (await s.completeLink()) { console.log("[media] Spotify linked"); stop(); onLinked(); }
        } catch (e) { console.log(`[media] Spotify sign-in ended: ${(e as Error).message}`); stop(); onLinked(); }
      }, 5000);
    }
    return { linked: false, account: "", signIn };
  }

  async spotifyForget(): Promise<void> { (await this.spotify()).forget(); this.browseCache.clear(); }

  private spotifyItem(it: SmapiItem): MediaItem {
    // What a Sonos will play from Spotify as a whole: songs, albums, playlists. An artist can only be opened.
    const playable = /^spotify:(track|album|playlist|episode|show)/.test(it.id);
    return { kind: "spotify", id: it.id, title: it.title, subtitle: it.summary, art: picture(it.art), opens: it.collection, plays: playable };
  }

  async spotifyBrowse(id: string): Promise<MediaItem[]> {
    const hit = this.browseCache.get(id);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.items;
    const s = await this.spotify();
    if (!s.linked) throw new Error("Spotify is not connected yet.");
    const items = (await s.browse(id || "root")).filter((it) => it.id && it.title).map((it) => this.spotifyItem(it));
    this.browseCache.set(id, { at: Date.now(), items });
    return items;
  }

  async spotifySearch(q: string): Promise<MediaGroup[]> {
    const s = await this.spotify();
    if (!s.linked) throw new Error("Spotify is not connected yet.");
    const cats = Object.entries(await s.searchCategories());
    const groups = await Promise.all(cats.slice(0, 5).map(async ([name, id]): Promise<MediaGroup> => ({
      label: name.replace(/^\w/, (c) => c.toUpperCase()),
      items: (await s.search(id, q).catch(() => [])).filter((it) => it.id && it.title).map((it) => this.spotifyItem(it)),
    })));
    return groups.filter((g) => g.items.length);
  }

  /**
   * Finds something to play by name for one speaker and starts it.
   * What the person starred themselves wins outright. Otherwise the household's saved things, the SiriusXM guide and
   * internet radio are looked through; when more than one of them has something by that name, nothing is played and the
   * choices are handed back so the host can ask which was meant (`from` then says which). With no clear match: Spotify,
   * then a loose match, then radio. An Echo with no clear match is simply asked. null = nothing by that name.
   */
  async playByName(controlId: string, query: string, opts: { from?: string; stars?: MediaItem[] } = {}): Promise<{ title: string; from: string } | { choices: { title: string; from: string; source: string }[] } | null> {
    const words = query.toLowerCase().replace(/\b(some|a|an|the|music|songs?|play|station|channel|radio|playlist|please)\b/g, " ").split(/[^a-z0-9']+/).filter(Boolean);
    if (!words.length) return null;
    /** How well a title answers what was asked: every word present is best, then most words. 0 = not it. */
    const plain = (t: string) => t.toLowerCase().replace(/\b(the|a|an)\b/g, " ").split(/[^a-z0-9']+/).filter(Boolean).join(" ");
    const score = (title: string, more = "") => { const t = `${title} ${more}`.toLowerCase(); const hit = words.filter((w) => t.includes(w)).length; return hit === words.length ? 2 + (plain(title) === words.join(" ") ? 1 : 0) : hit / words.length >= 0.6 ? 1 : 0; };
    const best = <T extends MediaItem>(items: T[]) => items.map((it) => ({ it, s: score(it.title, it.subtitle) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s)[0];
    const start = async (it: MediaItem, from: string) => { await this.play(controlId, it); return { title: it.title, from }; };
    const echo = (await this.devices.player(controlId)).integration === ECHO;
    const want = (opts.from ?? "").toLowerCase();

    // What this person starred is what they mean, when one of their stars has that name.
    if (!want) {
      const mine = best((opts.stars ?? []).filter((it) => (echo ? ["sxm", "spotify", "radio", "amazon"] : ["favourite", "playlist", "sxm", "spotify", "radio"]).includes(it.kind)));
      if (mine && mine.s >= 2) { try { return await start(mine.it, "your favourites"); } catch { /* no longer playable here: look further */ } }
    }

    const src = await this.sources(controlId).catch(() => null);
    const NAMES: Record<string, string> = { favourites: "the household's favourites", siriusxm: "SiriusXM", radio: "internet radio" };
    const strong = new Map<string, MediaItem>();
    const saved = src ? best([...src.favourites.flatMap((g) => g.items), ...src.playlists]) : undefined;
    if (saved && saved.s >= 2) strong.set("favourites", saved.it);
    if (src?.siriusxm) {
      const guide = await this.siriusxm(controlId).catch(() => []);
      const ch = best([...new Map(guide.flatMap((g) => g.items).map((it) => [it.id, it])).values()]);
      // A SiriusXM station the household saved is the same station, not a second one.
      if (ch && ch.s >= 2 && !(saved && saved.s >= 2 && /sirius/i.test(saved.it.subtitle ?? "") && plain(saved.it.title) === plain(ch.it.title))) strong.set("siriusxm", ch.it);
    }
    // Radio lists thousands of stations, so only one whose name is exactly what was said counts as a second meaning.
    const stations = src?.radio ? await radio(query, "").catch(() => []) : [];
    const exact = stations.find((st) => score(st.title) === 3);
    if (exact) strong.set("radio", exact);

    if (want) {
      const it = strong.get(want);
      if (it) return start(it, NAMES[want]);
      if (want === "amazon" && echo) return start({ kind: "amazon", id: query, title: query }, "Amazon Music");
    } else if (strong.size > 1) {
      return { choices: [...strong].map(([source, it]) => ({ title: it.title, from: NAMES[source], source })) };
    } else if (strong.size === 1) {
      const [[source, it]] = [...strong];
      return start(it, NAMES[source]);
    }

    // Nothing by exactly that name. An Echo is simply asked: Alexa finds it on the household's own music service.
    if (echo && want !== "spotify") {
      await this.play(controlId, { kind: "amazon", id: query, title: query, service: "DEFAULT" });
      return { title: query, from: "Alexa" };
    }
    if (src?.spotify) {
      const groups = await this.spotifySearch(query).catch(() => []);
      // Something that plays as a whole (a playlist, an album, an artist) before a single song, unless a song is the clear match.
      const playable = groups.flatMap((g) => g.items.map((it) => ({ it, label: g.label }))).filter((x) => x.it.plays !== false);
      const pick = playable.find((x) => score(x.it.title, x.it.subtitle) >= 2) ?? playable[0];
      if (pick) return start(pick.it, "Spotify");
    }
    if (saved) return start(saved.it, "the household's favourites");
    if (stations[0]) return start(stations[0], "internet radio");
    if (src?.radio) { const more = await radio("", words[0]).catch(() => []); if (more[0]) return start(more[0], "internet radio"); }
    return null;
  }

  // ── playing ──

  /** The picture of what was last started on a player, for sources that give the speaker none of their own (a radio station). */
  private lastArt = new Map<string, string>();
  artFor(controlId: string): string | undefined { return this.lastArt.get(controlId); }

  async play(controlId: string, item: { kind?: string; id?: string; title?: string; subtitle?: string; art?: string; service?: string }): Promise<void> {
    const p = await this.devices.player(controlId);
    if (item.art && /^\/api\//.test(item.art)) this.lastArt.set(controlId, item.art); else this.lastArt.delete(controlId);
    const id = String(item.id ?? "");
    if (!id) throw new Error("Nothing was chosen to play.");
    const play = (type: string, content: string) => this.ha.service("media_player", "play_media", p.entityId, { media_content_type: type, media_content_id: content });
    if (p.integration === ECHO) {
      const title = String(item.title ?? id).slice(0, 120);
      askedToPlay(p.entityId, title, ({ sxm: "SiriusXM", spotify: "Spotify", radio: "Radio", amazon: "Amazon Music" } as Record<string, string>)[item.kind ?? ""] ?? "", String(this.ha.states.get(p.entityId)?.attributes?.media_title ?? ""));
      switch (item.kind) {
        case "sxm": await play("SIRIUSXM", this.lineup.has(id)?.name ?? title); break;
        case "spotify": await play("SPOTIFY", spotifyAsk(id, title, item.subtitle)); break;
        case "radio": await play("TUNEIN", title); break;
        case "amazon": await play(item.service === "DEFAULT" ? "DEFAULT" : "AMAZON_MUSIC", id.slice(0, 120)); break;
        default: throw new Error("An Echo cannot play that. Choose something from SiriusXM, Spotify, Amazon Music or Radio.");
      }
      return;
    }
    switch (item.kind) {
      case "favourite": await play("favorite_item_id", id); break;
      case "playlist": await play("playlist", id); break;
      case "radio":
        if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("That station is not in the directory.");
        await play(streamType.get(id) ?? "audio/mpeg", `media-source://radio_browser/${id}`);
        break;
      case "input": await this.ha.service("media_player", "select_source", p.entityId, { source: id }); break;
      case "spotify":
        if (!/^spotify:(track|album|playlist|episode|show):[A-Za-z0-9]+$/.test(id)) throw new Error("A Sonos cannot play that from Spotify as a whole. Open it and choose something inside.");
        await play("music", id);
        break;
      case "sxm": {
        if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("That is not a SiriusXM channel.");
        // A grouped speaker plays what its group's leader plays, so the leader is the one to ask.
        const leader = (this.ha.states.get(p.entityId)?.attributes?.group_members as string[] | undefined)?.[0];
        const host = (leader && (await this.devices.hostOf(leader))) || p.host;
        if (!host) throw new Error("Vincent cannot reach that speaker directly.");
        const t = await serviceTemplate(host, SIRIUSXM, /^channel-linear/);
        if (!t) throw new Error("Save one SiriusXM station as a favourite in the Sonos app first. Vincent uses it to reach your SiriusXM.");
        await playServiceStream(host, t, `channel-linear:${id}`, this.lineup.has(id)?.name ?? item.title ?? "SiriusXM");
        break;
      }
      default: throw new Error("Vincent does not know how to play that.");
    }
  }

  /**
   * Makes the group this player plays in exactly `members` (control ids; the player itself always stays).
   * Speakers joining pick up what the group is playing; speakers leaving go quiet on their own.
   */
  async group(controlId: string, members: unknown): Promise<void> {
    const p = await this.devices.player(controlId);
    if (p.integration !== "sonos") throw new Error("That player cannot play together with others.");
    const wanted = new Set<string>([p.entityId]);
    for (const id of Array.isArray(members) ? members.map(String) : []) {
      const m = await this.devices.player(id);
      if (m.integration !== p.integration) throw new Error("Only speakers of the same kind can play together.");
      wanted.add(m.entityId);
    }
    const now = (this.ha.states.get(p.entityId)?.attributes?.group_members as string[] | undefined) ?? [p.entityId];
    // Whoever leads the group today keeps leading, unless it is being let go; then this player leads.
    const leader = wanted.has(now[0]) ? now[0] : p.entityId;
    for (const e of now) if (!wanted.has(e)) await this.ha.service("media_player", "unjoin", e);
    const joining = [...wanted].filter((e) => e !== leader && !(now.includes(e) && now[0] === leader));
    if (joining.length) await this.ha.service("media_player", "join", leader, { group_members: joining });
  }

  /** The cover art of what a player is playing. */
  async art(controlId: string): Promise<{ type: string; data: Buffer }> {
    const p = await this.devices.player(controlId);
    const pic = this.ha.states.get(p.entityId)?.attributes?.entity_picture;
    if (!pic) throw new Error("no picture");
    return this.ha.picture(String(pic));
  }
}
