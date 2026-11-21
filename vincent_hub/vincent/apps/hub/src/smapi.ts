/**
 * The Sonos Music API: how the Sonos app browses a streaming service's catalogue.
 *
 * A speaker only ever lists favourites. To show a service's own playlists, charts and search,
 * Vincent does what the Sonos app does: the household signs in once on the service's own
 * "allow Sonos" page, the service hands back a token, and Vincent browses with it.
 * The token is for browsing only. Playing still goes through the account the household
 * linked in the Sonos app.
 *
 * Tokens are kept on the hub (services.json, readable by the hub service only), by Sonos service id.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { ServiceDesc } from "./sonos.ts";

const NS = "http://www.sonos.com/Services/1.1";
const UA = "Linux UPnP/1.0 Sonos/78.1-32040 (WDCR:Vincent)";

interface Link { token: string; key: string; householdId: string; deviceId: string; nickname?: string }
interface Pending { linkCode: string; regUrl: string; startedAt: number }
type Saved = Record<string, Link | Pending>;

export interface SmapiItem { id: string; title: string; itemType: string; collection: boolean; canPlay: boolean; art?: string; summary?: string }

function unesc(s: string): string {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d))).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
/** First <name>…</name>, with or without a namespace prefix. */
function tag(xml: string, name: string): string | undefined {
  const m = xml.match(new RegExp(`<(?:[A-Za-z0-9_]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?${name}>`));
  return m ? unesc(m[1]) : undefined;
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export class SmapiService {
  readonly desc: ServiceDesc;
  private householdId: string;
  private deviceId: string;
  private file: string;
  private saved: Saved = {};

  constructor(desc: ServiceDesc, householdId: string, deviceId: string, file: string) {
    this.desc = desc; this.householdId = householdId; this.deviceId = deviceId; this.file = file;
    try { this.saved = JSON.parse(readFileSync(file, "utf8")) as Saved; } catch { /* nothing linked yet */ }
  }

  private save(): void { writeFileSync(this.file, JSON.stringify(this.saved, null, 1), { mode: 0o600 }); }
  private get link(): Link | undefined { return this.saved[String(this.desc.sid)] as Link | undefined; }
  get linked(): boolean { return !!this.link?.token; }
  get nickname(): string { return this.link?.nickname ?? ""; }
  /** A sign-in that was started and not finished. Services let a link code lapse within minutes. */
  get pending(): Pending | null {
    const p = this.saved[`pending_${this.desc.sid}`] as Pending | undefined;
    return p && Date.now() - p.startedAt < 8 * 60_000 ? p : null;
  }
  private setPending(p: Pending | null): void {
    if (p) this.saved[`pending_${this.desc.sid}`] = p; else delete this.saved[`pending_${this.desc.sid}`];
    this.save();
  }
  forget(): void { delete this.saved[String(this.desc.sid)]; this.setPending(null); }

  private async call(action: string, args: Record<string, string | number>, withToken = true): Promise<string> {
    const link = this.link;
    const cred = withToken && link
      ? `<credentials xmlns="${NS}"><deviceId>${esc(this.deviceId)}</deviceId><deviceProvider>Sonos</deviceProvider><loginToken><token>${esc(link.token)}</token><key>${esc(link.key)}</key><householdId>${esc(link.householdId)}</householdId></loginToken></credentials>`
      : `<credentials xmlns="${NS}"><deviceId>${esc(this.deviceId)}</deviceId><deviceProvider>Sonos</deviceProvider></credentials>`;
    const body = Object.entries(args).map(([k, v]) => `<${k}>${esc(String(v))}</${k}>`).join("");
    const env = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Header>${cred}</s:Header><s:Body><${action} xmlns="${NS}">${body}</${action}></s:Body></s:Envelope>`;
    const res = await fetch(this.desc.secureUri, {
      method: "POST",
      headers: { "content-type": 'text/xml; charset="utf-8"', SOAPACTION: `"${NS}#${action}"`, "User-Agent": UA, "Accept-Language": "en-US" },
      body: env,
      signal: AbortSignal.timeout(15_000),
    });
    const xml = await res.text();
    // A fault can carry attributes (<faultstring xml:lang="en">) and arrives inside an HTTP 500.
    const fault = xml.match(/<(?:\w+:)?faultstring\b[^>]*>([\s\S]*?)<\/(?:\w+:)?faultstring>/)?.[1];
    if (fault) {
      const code = xml.match(/<(?:\w+:)?faultcode\b[^>]*>([\s\S]*?)<\/(?:\w+:)?faultcode>/)?.[1] ?? "";
      // The service renewed the token: the new one rides in this same reply. Keep it and ask again.
      if (/TokenRefreshRequired/i.test(code + fault) && link) {
        const token = tag(xml, "authToken"), key = tag(xml, "privateKey");
        if (token && key) { this.saved[String(this.desc.sid)] = { ...link, token, key }; this.save(); return this.call(action, args, withToken); }
      }
      throw new Error(`${this.desc.name}: ${fault.trim()} ${code.trim()}`);
    }
    if (!res.ok) throw new Error(`${this.desc.name} answered ${res.status}`);
    return xml;
  }

  /** Step 1: the address of the service's sign-in page for this household. */
  async beginLink(): Promise<string> {
    const p = this.pending;
    if (p) return p.regUrl;
    const xml = await this.call("getAppLink", { householdId: this.householdId, hardware: "", osVersion: "", sonosAppName: "", callbackPath: "" }, false);
    const regUrl = tag(xml, "regUrl"), linkCode = tag(xml, "linkCode");
    if (!regUrl || !linkCode) throw new Error(`${this.desc.name} did not offer a sign-in page.`);
    this.setPending({ regUrl, linkCode, startedAt: Date.now() });
    return regUrl;
  }

  /** Step 2: once the person has signed in, trade the link code for a token. False while they have not yet. */
  async completeLink(): Promise<boolean> {
    const p = this.pending;
    if (!p) throw new Error("expired");
    try {
      const xml = await this.call("getDeviceAuthToken", { householdId: this.householdId, linkCode: p.linkCode, linkDeviceId: this.deviceId }, false);
      const token = tag(xml, "authToken"), key = tag(xml, "privateKey");
      if (!token || !key) throw new Error("no token in the reply");
      this.saved[String(this.desc.sid)] = { token, key, householdId: this.householdId, deviceId: this.deviceId, nickname: tag(xml, "nickname") };
      this.setPending(null);
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      if (/NOT_LINKED_RETRY/i.test(msg)) return false;
      if (/NOT_LINKED_FAILURE/i.test(msg)) { this.setPending(null); throw new Error("expired"); }
      throw e;
    }
  }

  private items(result: string): SmapiItem[] {
    const out: SmapiItem[] = [];
    for (const m of result.matchAll(/<(?:[A-Za-z0-9_]+:)?(mediaCollection|mediaMetadata)(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?\1>/g)) {
      const x = m[2], collection = m[1] === "mediaCollection";
      out.push({
        id: tag(x, "id") ?? "", title: tag(x, "title") ?? "", itemType: tag(x, "itemType") ?? "", collection,
        canPlay: (tag(x, "canPlay") ?? (collection ? "false" : "true")) === "true",
        art: tag(x, "albumArtURI") ?? tag(x, "logo") ?? undefined,
        summary: tag(x, "artist") ?? tag(x, "summary") ?? undefined,
      });
    }
    return out;
  }

  /** Everything in a container ("root" to start), following the service's pages. */
  async browse(id = "root", max = 300): Promise<SmapiItem[]> {
    const all: SmapiItem[] = [];
    for (;;) {
      const result = tag(await this.call("getMetadata", { id, index: all.length, count: 100, recursive: "false" }), "getMetadataResult") ?? "";
      const page = this.items(result);
      all.push(...page);
      if (!page.length || all.length >= Math.min(Number(tag(result, "total") ?? all.length), max)) return all;
    }
  }

  /** The service's own search categories (tracks, albums, playlists…), from the map Sonos publishes for it. */
  private cats?: Promise<Record<string, string>>;
  searchCategories(): Promise<Record<string, string>> {
    this.cats ??= (async () => {
      if (!this.desc.manifest) return {};
      const man = (await (await fetch(this.desc.manifest, { signal: AbortSignal.timeout(5000) })).json()) as { presentationMap?: { uri?: string } };
      if (!man.presentationMap?.uri) return {};
      const pm = await (await fetch(man.presentationMap.uri, { signal: AbortSignal.timeout(5000) })).text();
      const out: Record<string, string> = {};
      for (const m of pm.matchAll(/<Category id="([^"]+)" mappedId="([^"]+)"/g)) out[m[1]] ??= m[2];
      return out;
    })().catch(() => { this.cats = undefined; return {}; });
    return this.cats;
  }

  async search(category: string, term: string, count = 20): Promise<SmapiItem[]> {
    return this.items(tag(await this.call("search", { id: category, term, index: 0, count }), "searchResult") ?? "");
  }
}
