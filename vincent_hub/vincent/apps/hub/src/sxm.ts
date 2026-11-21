/**
 * The whole SiriusXM channel guide.
 *
 * Sonos shows SiriusXM's catalogue to nobody but its own app, but SiriusXM's public channel page
 * lists every channel with the same id a Sonos plays. The guide is read from that page once a day
 * and kept on the hub; a channel plays through the household's own SiriusXM link (see sonos.ts),
 * so Vincent never signs in to SiriusXM.
 *
 * Only the live ("linear") channels are listed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface SxmChannel { uuid: string; name: string; number?: number; category: string; genre: string; desc?: string; logo?: string }

const PAGE = "https://www.siriusxm.com/channels";
const DAY = 24 * 3600_000;

/** One JSON object starting at `i` (brace matching that respects strings). */
function objectAt(s: string, i: number): string | undefined {
  let depth = 0, inStr = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inStr) { if (c === "\\") j++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(i, j + 1);
  }
  return undefined;
}

export function parseLineup(page: string): SxmChannel[] {
  // The guide is a JSON string inside the page, so its quotes arrive escaped once.
  const y = page.replace(/\\"/g, '"').replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  const out = new Map<string, SxmChannel>();
  for (const m of y.matchAll(/\{"artistsYouHear"/g)) {
    const raw = objectAt(y, m.index!);
    if (!raw) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
    if (o.channel_type !== "Linear" || typeof o.uuid !== "string" || typeof o.displayName !== "string") continue;
    out.set(o.uuid, {
      uuid: o.uuid, name: o.displayName, number: typeof o.streamingChannelNumber === "number" ? o.streamingChannelNumber : undefined,
      category: String(o.categoryTitle ?? "Other"), genre: String(o.genreTitle ?? o.categoryTitle ?? "Other"),
      desc: typeof o.shortDescription === "string" ? o.shortDescription : undefined,
      logo: typeof o.colorLogo === "string" && o.colorLogo ? `https://www.siriusxm.com${o.colorLogo}` : undefined,
    });
  }
  return [...out.values()].sort((a, b) => (a.number ?? 9999) - (b.number ?? 9999));
}

export class SxmLineup {
  private list: SxmChannel[] = [];
  private at = 0;
  private fetching?: Promise<void>;
  private file: string;

  constructor(file: string) {
    this.file = file;
    if (existsSync(file)) { try { const d = JSON.parse(readFileSync(file, "utf8")) as { at: number; list: SxmChannel[] }; this.list = d.list ?? []; this.at = d.at ?? 0; } catch { /* read it again */ } }
  }

  /** The guide. The first call waits for it; later ones answer at once and refresh a stale copy behind the scenes. */
  async channels(): Promise<SxmChannel[]> {
    if (Date.now() - this.at > DAY && !this.fetching) this.fetching = this.refresh().finally(() => { this.fetching = undefined; });
    if (!this.list.length) await this.fetching;
    return this.list;
  }

  has(uuid: string): SxmChannel | undefined { return this.list.find((c) => c.uuid === uuid); }

  private async refresh(): Promise<void> {
    try {
      const res = await fetch(PAGE, { headers: { "user-agent": "Mozilla/5.0 (Macintosh) Vincent" }, signal: AbortSignal.timeout(20_000) });
      const list = parseLineup(await res.text());
      if (list.length < 50) throw new Error(`only ${list.length} channels read`); // the page changed shape: keep the old guide
      this.list = list; this.at = Date.now();
      writeFileSync(this.file, JSON.stringify({ at: this.at, list }));
      console.log(`[sxm] guide refreshed: ${list.length} channels`);
    } catch (e) {
      console.log(`[sxm] guide not refreshed (${(e as Error).message}); keeping the saved one`);
      this.at = Date.now() - DAY + 3600_000; // try again in an hour
    }
  }
}

/** The guide in the order it is shown: music by genre, then talk, news and comedy, then sports. */
export function lineupGroups(list: SxmChannel[]): { label: string; channels: SxmChannel[] }[] {
  const label = (c: SxmChannel) => (c.category === "Music" ? c.genre : c.category === "Sports" ? (c.genre === "Sports" ? "Sports Talk" : c.genre) : c.category === "Howard Stern" ? "Talk & Entertainment" : c.category);
  const rank = (l: string, c: SxmChannel) => (c.category === "Music" ? 0 : c.category === "Sports" ? (l === "Sports Talk" ? 2 : 3) : 1);
  const g = new Map<string, { rank: number; first: number; channels: SxmChannel[] }>();
  for (const c of list) {
    if (c.category === "Music" && c.genre === "All Xtra") continue;
    const l = label(c);
    const e = g.get(l) ?? { rank: rank(l, c), first: c.number ?? 9999, channels: [] };
    e.channels.push(c);
    g.set(l, e);
  }
  return [...g.entries()].sort((a, b) => a[1].rank - b[1].rank || a[1].first - b[1].first).map(([l, e]) => ({ label: l, channels: e.channels }));
}
