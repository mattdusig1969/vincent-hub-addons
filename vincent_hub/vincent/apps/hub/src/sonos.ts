/**
 * Talking to a Sonos speaker directly (UPnP on port 1400) for what Home Assistant does not pass through:
 * which service each favourite belongs to, the household's identity, and playing a music-service
 * stream through the account the household linked in the Sonos app.
 */
export const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function upnp(host: string, path: string, service: string, action: string, args = "", ms = 6000): Promise<string> {
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:${service}:1">${args}</u:${action}></s:Body></s:Envelope>`;
  const res = await fetch(`http://${host}:1400${path}`, { method: "POST", headers: { "content-type": 'text/xml; charset="utf-8"', SOAPACTION: `"urn:schemas-upnp-org:service:${service}:1#${action}"` }, body, signal: AbortSignal.timeout(ms) });
  const text = await res.text();
  if (!res.ok) throw new Error(`the speaker refused (${text.match(/<errorCode>(\d+)<\/errorCode>/)?.[1] ?? res.status})`);
  return text;
}

/** The raw entries of one list on a speaker: "FV:2" = favourites, "SQ:" = Sonos playlists. */
export async function browseRaw(host: string, objectId: string): Promise<{ id: string; xml: string }[]> {
  const text = await upnp(host, "/MediaServer/ContentDirectory/Control", "ContentDirectory", "Browse",
    `<ObjectID>${objectId}</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter>*</Filter><StartingIndex>0</StartingIndex><RequestedCount>300</RequestedCount><SortCriteria></SortCriteria>`);
  const didl = unescapeXml(text.match(/<Result>([\s\S]*?)<\/Result>/)?.[1] ?? "");
  return [...didl.matchAll(/<(item|container) id="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => ({ id: unescapeXml(m[2]), xml: m[3] }));
}

/**
 * How this household's speakers reach one music service, copied from a favourite of that service:
 * the account token and account number the Sonos app saved. Vincent never holds the account itself.
 * `prefer` picks a favourite of the right kind (a live SiriusXM channel, not an on-demand one).
 */
export interface ServiceTemplate { sid: number; sn: string; flags: string; scheme: string; idPrefix: string; descToken: string }

export async function serviceTemplate(host: string, sid: number, prefer?: RegExp): Promise<ServiceTemplate | undefined> {
  let first: ServiceTemplate | undefined;
  for (const { xml } of await browseRaw(host, "FV:2")) {
    const res = xml.match(/<res[^>]*>([^<]*)<\/res>/)?.[1];
    const m = res && unescapeXml(res).match(/^(x-[a-z-]+):([^?]+)\?sid=(\d+)&flags=(\d+)&sn=(\d+)/);
    if (!m || Number(m[3]) !== sid) continue;
    const md = unescapeXml(xml.match(/<r:resMD>([\s\S]*?)<\/r:resMD>/)?.[1] ?? "");
    const idAttr = md.match(/<item id="([^"]+)"/)?.[1] ?? "";
    const descToken = md.match(/<desc[^>]*>([^<]*)<\/desc>/)?.[1] ?? "";
    if (!descToken) continue;
    const item = m[2];
    const t = { sid, sn: m[5], flags: m[4], scheme: m[1], idPrefix: idAttr.endsWith(item) ? idAttr.slice(0, idAttr.length - item.length) : idAttr.replace(/[A-Za-z].*$/, ""), descToken };
    if (!prefer || prefer.test(decodeURIComponent(item))) return t;
    first ??= t;
  }
  return first;
}

/** Play a live stream of a music service (a SiriusXM channel) the way a saved favourite of it plays. */
export async function playServiceStream(host: string, t: ServiceTemplate, itemId: string, title: string): Promise<void> {
  const enc = encodeURIComponent(itemId);
  const uri = `${t.scheme}:${enc}?sid=${t.sid}&flags=${t.flags}&sn=${t.sn}`;
  const didl = `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="${t.idPrefix}${enc}" parentID="${t.idPrefix}${enc}" restricted="true"><dc:title>${escXml(title)}</dc:title><upnp:class>object.item.audioItem.audioBroadcast</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">${escXml(t.descToken)}</desc></item></DIDL-Lite>`;
  const av = (action: string, args: string, ms: number) => upnp(host, "/MediaRenderer/AVTransport/Control", "AVTransport", action, `<InstanceID>0</InstanceID>${args}`, ms);
  // Leaving a queue for a live stream can take a speaker well over ten seconds to acknowledge; the stream
  // still lands, so a slow answer is not a failure. Then press Play, and press it again if it did not take.
  try { await av("SetAVTransportURI", `<CurrentURI>${escXml(uri)}</CurrentURI><CurrentURIMetaData>${escXml(didl)}</CurrentURIMetaData>`, 20_000); }
  catch (e) { if (!/timeout|aborted/i.test((e as Error).message)) throw e; }
  await av("Play", "<Speed>1</Speed>", 15_000);
  void (async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = (await av("GetTransportInfo", "", 5000).catch(() => "")).match(/<CurrentTransportState>(\w+)/)?.[1];
      if (s === "PLAYING") return;
      if (s === "STOPPED" || s === "PAUSED_PLAYBACK") await av("Play", "<Speed>1</Speed>", 10_000).catch(() => undefined);
    }
  })();
}

export interface ServiceDesc { sid: number; name: string; secureUri: string; manifest?: string }

/** What one speaker knows: its household, its own identity, and the music services Sonos offers it. */
export async function speakerContext(host: string): Promise<{ householdId: string; deviceId: string; services: ServiceDesc[] }> {
  const zp = await (await fetch(`http://${host}:1400/status/zp`, { signal: AbortSignal.timeout(4000) })).text();
  const householdId = zp.match(/<HouseholdControlID>([^<]+)</)?.[1] ?? "";
  const deviceId = zp.match(/<SerialNumber>([^<]+)</)?.[1] ?? "";
  if (!householdId || !deviceId) throw new Error("the speaker did not say which household it belongs to");
  const xml = unescapeXml(await upnp(host, "/MusicServices/Control", "MusicServices", "ListAvailableServices"));
  const services: ServiceDesc[] = [];
  for (const m of xml.matchAll(/<Service Id="(\d+)" Name="([^"]+)" Version="[^"]*" Uri="[^"]*" SecureUri="([^"]*)"[^>]*>([\s\S]*?)<\/Service>/g))
    services.push({ sid: Number(m[1]), name: unescapeXml(m[2]), secureUri: m[3], manifest: m[4].match(/<Manifest [^>]*Uri="([^"]+)"/)?.[1] });
  return { householdId, deviceId, services };
}
