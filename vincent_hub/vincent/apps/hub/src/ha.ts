/**
 * The one connection to Home Assistant.
 *
 * Two ways in:
 *  - on the hub (as an add-on): SUPERVISOR_TOKEN is set and Home Assistant is at
 *    http://supervisor/core. No account, no password.
 *  - on a developer's machine: dev-hub.json holds the hub's address and a refresh token.
 *
 * No npm dependencies: Node's own WebSocket and fetch.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface HaState { entity_id: string; state: string; attributes: Record<string, any>; last_changed: string }

type Target = { ws: string; rest: string; token: () => Promise<string> };

function target(): Target {
  const sup = process.env.SUPERVISOR_TOKEN;
  if (sup) return { ws: "ws://supervisor/core/websocket", rest: "http://supervisor/core/api", token: async () => sup };

  const file = fileURLToPath(new URL("../dev-hub.json", import.meta.url));
  if (!existsSync(file)) throw new Error("No hub to talk to: not running as an add-on and apps/hub/dev-hub.json is missing");
  const cfg = JSON.parse(readFileSync(file, "utf8")) as { url: string; clientId: string; refreshToken: string };
  let access = "", expires = 0;
  const token = async () => {
    if (access && Date.now() < expires) return access;
    const r = await fetch(`${cfg.url}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: cfg.refreshToken, client_id: cfg.clientId }),
    });
    if (!r.ok) throw new Error(`hub refused the saved login (${r.status})`);
    const j = (await r.json()) as { access_token: string; expires_in: number };
    access = j.access_token;
    expires = Date.now() + (j.expires_in - 60) * 1000;
    return access;
  };
  return { ws: cfg.url.replace(/^http/, "ws") + "/api/websocket", rest: cfg.url + "/api", token };
}

export class HA {
  connected = false;
  version = "";
  homeName = "Home";
  states = new Map<string, HaState>();
  /** Called with the entity id on every state change, and with "" when a registry changed. */
  onChange: (entityId: string) => void = () => {};

  private t = target();
  private ws?: WebSocket;
  private nextId = 1;
  private waiting = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  private subs = new Map<number, (event: any) => void>();

  start(): void {
    this.connect().catch((e) => this.retry(e));
  }

  private retry(e: unknown): void {
    if (this.connected) console.log(`[ha] connection lost: ${(e as Error)?.message ?? e}`);
    else console.log(`[ha] not reachable: ${(e as Error)?.message ?? e}`);
    this.connected = false;
    for (const w of this.waiting.values()) w.fail(new Error("hub connection lost"));
    this.waiting.clear();
    this.subs.clear();
    setTimeout(() => this.start(), 5000);
  }

  private async connect(): Promise<void> {
    const token = await this.t.token();
    const ws = new WebSocket(this.t.ws);
    this.ws = ws;
    let failed = false;
    const fail = (e: unknown) => { if (!failed) { failed = true; try { ws.close(); } catch {} this.retry(e); } };
    ws.addEventListener("error", () => fail(new Error("socket error")));
    ws.addEventListener("close", () => fail(new Error("socket closed")));
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: token }));
      else if (m.type === "auth_invalid") fail(new Error("hub refused the token"));
      else if (m.type === "auth_ok") { this.version = m.ha_version ?? ""; this.ready().catch(fail); }
      else if (m.type === "result") {
        const w = this.waiting.get(m.id);
        if (!w) return;
        this.waiting.delete(m.id);
        m.success ? w.ok(m.result) : w.fail(new Error(m.error?.message ?? "hub refused the request"));
      } else if (m.type === "event") this.subs.get(m.id)?.(m.event);
    });
  }

  private async ready(): Promise<void> {
    await this.subscribe("state_changed", (e) => {
      const s = e.data.new_state as HaState | null;
      if (s) this.states.set(s.entity_id, s); else this.states.delete(e.data.entity_id);
      this.onChange(e.data.entity_id);
    });
    for (const type of ["device_registry_updated", "entity_registry_updated", "area_registry_updated", "config_entry_discovered"])
      await this.subscribe(type, () => this.onChange(""));
    const all = (await this.call({ type: "get_states" })) as HaState[];
    this.states = new Map(all.map((s) => [s.entity_id, s]));
    const cfg = await this.call({ type: "get_config" });
    this.homeName = cfg.location_name ?? "Home";
    this.connected = true;
    console.log(`[ha] connected: Home Assistant ${this.version}, ${all.length} states`);
    this.onChange("");
  }

  private async subscribe(eventType: string, fn: (event: any) => void): Promise<void> {
    const id = this.nextId;
    this.subs.set(id, fn);
    await this.call({ type: "subscribe_events", event_type: eventType });
  }

  call(msg: Record<string, unknown>): Promise<any> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("hub not connected"));
    const id = this.nextId++;
    return new Promise((ok, fail) => {
      this.waiting.set(id, { ok, fail });
      ws.send(JSON.stringify({ ...msg, id }));
      setTimeout(() => { if (this.waiting.delete(id)) fail(new Error("hub did not answer in time")); }, 30000);
    });
  }

  service(domain: string, service: string, entityId: string, data: Record<string, unknown> = {}): Promise<any> {
    return this.call({ type: "call_service", domain, service, target: { entity_id: entityId }, service_data: data });
  }

  /** A picture Home Assistant holds (cover art). `path` is the address it gave in a state, relative or absolute. */
  async picture(path: string): Promise<{ type: string; data: Buffer }> {
    const url = /^https?:/.test(path) ? path : this.t.rest.replace(/\/api$/, "") + path;
    const mine = !/^https?:/.test(path);
    const r = await fetch(url, { headers: mine ? { Authorization: `Bearer ${await this.t.token()}` } : {}, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`no picture (${r.status})`);
    return { type: r.headers.get("content-type") ?? "image/jpeg", data: Buffer.from(await r.arrayBuffer()) };
  }

  /** Is this integration set up on the hub? */
  async has(domain: string): Promise<boolean> {
    const entries = (await this.call({ type: "config_entries/get" })) as { domain: string }[];
    return entries.some((e) => e.domain === domain);
  }

  async rest(method: string, path: string, body?: unknown): Promise<any> {
    const r = await fetch(this.t.rest + path, {
      method,
      headers: { Authorization: `Bearer ${await this.t.token()}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`hub answered ${r.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
}
