/**
 * Vincent's own service on the internet.
 *
 * The keys for the hosts' conversation and for pictures are not on any hub: a hub asks our service, which
 * holds them, counts what each home and device uses, and can say no when a home has had its day's worth.
 * A hub gets a name on our books the first time it asks, and keeps it (its copies carry it, so a replaced
 * hub is the same home to us).
 *
 * A hub given a key of its own in its settings (a developer's) asks Google directly instead.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dir } from "./store.ts";

const CLOUD = (process.env.VINCENT_CLOUD ?? "https://vincent-cloud.vercel.app").replace(/\/$/, "");
const FILE = join(dir, "cloud.json");
let version = "";
export function cloudVersion(v: string): void { version = v; }

function ownKey(): string {
  if (process.env.VINCENT_TALK_KEY) return process.env.VINCENT_TALK_KEY;
  if (process.env.VINCENT_IMAGE_KEY) return process.env.VINCENT_IMAGE_KEY;
  try { const o = JSON.parse(readFileSync("/data/options.json", "utf8")); return String(o.talk_key || o.image_key || ""); } catch { return ""; }
}

let me: { hub: string; secret: string } | undefined;
let asking: Promise<{ hub: string; secret: string }> | undefined;
/** One name for the home, however many things ask at once. */
function who(): Promise<{ hub: string; secret: string }> {
  asking ??= whoNow().finally(() => { asking = undefined; });
  return asking;
}
async function whoNow(): Promise<{ hub: string; secret: string }> {
  if (me) return me;
  if (existsSync(FILE)) { try { const j = JSON.parse(readFileSync(FILE, "utf8")); if (j.hub && j.secret) return (me = j); } catch { /* ask again */ } }
  const r = await fetch(`${CLOUD}/api/register`, { method: "POST", signal: AbortSignal.timeout(12_000) });
  const j = (await r.json().catch(() => ({}))) as { hub?: string; secret?: string };
  if (!r.ok || !j.hub || !j.secret) throw new Error("Vincent's service did not answer");
  me = { hub: j.hub, secret: j.secret };
  writeFileSync(FILE, JSON.stringify(me), { mode: 0o600 });
  console.log(`[cloud] this home is known to Vincent's service as ${me.hub}`);
  return me;
}

/** The home has had its share for today, or our service has stopped it. */
export class CloudLimit extends Error {
  scope: string;
  constructor(scope: string) { super("limit"); this.scope = scope; }
}

export type GoogleKind = "talk" | "live" | "picture";
/**
 * Asks Google's service for something: `path` as Google names it (`v1beta/models/x:generateContent`), `body` as Google wants it.
 * The answer is Google's own, whichever way it travelled. Throws CloudLimit when the home may not ask again today.
 */
export async function google(path: string, body: unknown, o: { kind: GoogleKind; device?: string; timeout: number }): Promise<Response> {
  const key = ownKey();
  const init = { method: "POST", headers: { "Content-Type": "application/json" } as Record<string, string>, body: JSON.stringify(body), signal: AbortSignal.timeout(o.timeout) };
  if (key) return fetch(`https://generativelanguage.googleapis.com/${path}?key=${key}`, init);
  const id = await who();
  init.headers.Authorization = `Bearer ${id.hub}.${id.secret}`;
  const r = await fetch(`${CLOUD}/api/g?path=${encodeURIComponent(path)}&kind=${o.kind}&device=${encodeURIComponent(o.device ?? "")}&v=${encodeURIComponent(version)}`, init);
  if (r.status === 429) { const j = (await r.json().catch(() => ({}))) as { scope?: string }; console.log(`[cloud] ${o.kind} refused: ${j.scope ?? "limit"}`); throw new CloudLimit(String(j.scope ?? "home")); }
  if (r.status === 401) { me = undefined; console.log("[cloud] this home's name was not accepted"); }
  return r;
}
