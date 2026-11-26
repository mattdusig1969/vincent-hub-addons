/**
 * Walking the household through whatever a maker asks for when a device is added:
 * an address, a sign-in, a code shown on the TV, a button to press.
 *
 * Home Assistant already knows each maker's questions (its "config flows"). This turns one
 * question at a time into a plain form the app can show, carries the answers back, and when
 * the maker is satisfied marks what it brought as added to Vincent.
 */
import type { HA } from "./ha.ts";
import type { Devices } from "./devices.ts";
import { store } from "./store.ts";
import { brand, BRANDS } from "./brands.ts";
import type { Step, StepField } from "../../../packages/core/src/index.ts";

/** Words for the questions makers ask most, when the maker's own wording is missing. */
const LABELS: Record<string, string> = {
  port: "Port", username: "Username", email: "Email", password: "Password",
  pin: "Code", code: "Code", pairing_code: "Pairing code", api_key: "API key", token: "Token", access_token: "Token", name: "Name", device: "Device",
  device_input: "Name or address", "2fa": "Code sent to you", verify_ssl: "Check the device's certificate", mac: "Hardware address",
};
const WHY: Record<string, string> = {
  cannot_connect: "The hub could not reach it. Check the address and that it is switched on.",
  invalid_auth: "That sign-in was not accepted.",
  invalid_host: "That address does not look right.",
  timeout: "It did not answer in time.", timeout_connect: "It did not answer in time.",
  unknown: "Something unexpected went wrong. Try again.",
  already_configured: "That is already on your hub. Look for it under Add a device.",
  already_in_progress: "That is already being set up.",
  no_devices_found: "Nothing was found.",
  single_instance_allowed: "That is already on your hub. Look for it under Add a device.",
  not_supported: "That device is not supported.",
};

/** These always get our word, whatever the maker calls them: nobody at home says "host". */
/** Where a maker's own wording leaves people guessing, ours: by driver, then by the field's name. */
const PLAINER: Record<string, Record<string, { label: string; help: string; required?: boolean }>> = {
  tuya: { user_code: { label: "User Code", help: "From the Smart Life or Tuya Smart app: Me, the gear, Account and Security. Letters and numbers, typed exactly." } },
  generic: {
    stream_source: { required: true, label: "The camera's stream address", help: "Starts with rtsp:// and is shown in the camera's own app where you switched the stream on. Type it exactly." },
    username: { label: "Stream username", help: "Shown beside the address in the camera's app. Not your account email. If the app shows one, type it here." },
    password: { label: "Stream password", help: "Shown beside the address in the camera's app. If the app shows one, type it here." },
  },
  alexa_devices: {
    username: { label: "Amazon email", help: "The email you sign in to Amazon with." },
    password: { label: "Amazon password", help: "Sent encrypted, straight to Amazon." },
    code: { label: "Six-digit code from your authenticator app", help: "Open your authenticator app (Google Authenticator, Microsoft Authenticator, 1Password or similar), find Amazon, and type the six digits it shows right now. Nothing is texted to you: Amazon only allows an authenticator app for this. No Amazon entry in an authenticator app yet? On amazon.com go to Account, Login and security, Two-step verification, and add an authenticator app first." },
  },
};
/** Tuya says "login error" for two different things; which one depends on the step. */
/** When the hub could not find the device by itself: what to do, and where the address is. */
const HOST_HELP: Record<string, { text: string; help: string }> = {
  webostv: { text: "No LG TV is answering on your home network. Turn the TV on, then tap Continue and Vincent looks again. If the TV is already on, it has dropped off the network: on the TV open Settings, then Network, and check it says Connected, on the same network as your hub.", help: "Leave this empty and Vincent looks for the TV. Only if that keeps failing: on the TV open Settings, then Network, then your Wi-Fi or wired connection, and type the address shown there. It is four numbers with dots, like 192.168.1.42." },
};
/** Said under the address when looking again still found nothing, or a typed address is not the device. */
const HOST_STILL: Record<string, { none: string; wrong: string }> = {
  webostv: { none: "Still no LG TV answering. On the TV open Settings, then Network. If it does not say Connected, connect it there, then tap Continue.", wrong: "No LG TV answers at that address. Check the numbers, and that the TV is on." },
};
/** A maker's reasons in our words where the general ones mislead: by driver. */
const WHY_FOR: Record<string, Record<string, string>> = {
  webostv: { cannot_connect: "The TV did not answer. Check it is on and connected to your home network (on the TV: Settings, then Network), then tap Continue.", error_pairing: "The TV did not get a yes. Tap Continue, then choose Yes on the TV with its remote." },
};
const TUYA_WHY: Record<string, string> = {
  user: "That User Code was not accepted. Look at it again in the app (Me, the gear, Account and Security) and type it exactly: capitals matter.",
  scan: "The Smart Life app has not approved it yet, or the code ran out. Scan the new code below and confirm in the app, then tap Continue.",
};
/** Where a maker's own words for a whole step leave people guessing, ours: by driver, then by the step. */
const STEPS: Record<string, Record<string, { title: string; text: string; picture?: string }>> = {
  webostv: { pairing: { title: "Say yes on the TV", text: "Tap Continue, then look at the TV. It asks whether Vincent may connect: choose Yes with the TV's remote. Nothing to type." } },
  tuya: {
    user: { title: "Your Tuya or Smart Life account", text: "Vincent uses the account you already have, with everything already set up in it. Open the Smart Life or Tuya Smart app on your phone and tap Me at the bottom right. Tap the settings button at the top right, then Account and Security. Your User Code is at the bottom of that page." },
    scan: { title: "Approve it in the Smart Life app", picture: "help/tuya-scan.jpg", text: "Open the Smart Life or Tuya Smart app and tap Me at the bottom right. The scan button is at the top right, next to the settings button, as circled in the picture. Point it at the code below and confirm. If the app is on this same phone, take a screenshot of this page first, then in the app's scanner choose the picture from your photos. Come back here and tap Continue." },
  },
};
/** Questions a household cannot answer and need not: left out, the maker's default stands. */
const HIDDEN: Record<string, string[]> = { generic: ["still_image_url"] };
/** Technical settings a brand needs set differently from the driver's suggestion: by driver, then by the brand's name. */
const NESTED: Record<string, Record<string, Record<string, unknown>>> = { generic: { "eufy cameras": { authentication: "digest", rtsp_transport: "tcp" } } };
const OURS: Record<string, string> = { host: "Address", ip_address: "Address", address: "Address", device_input: "Name or address" };

const plain = (s: string, vars: Record<string, unknown> = {}) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? "")).replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`]{1,2}([^*_`]+)[*_`]{1,2}/g, "$1")
    .replace(/Home Assistant/g, "Vincent").replace(/\bSubmit\b/g, "Continue").replace(/\b[Tt]he host\b/g, "the address").replace(/\bIP address\b/g, "address").replace(/\n{2,}/g, "\n").trim();
const titled = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

interface Open { domain: string; rooms: string[]; fields: StepField[]; menu: boolean; tips?: string; name?: string; step?: string; look?: boolean; link?: boolean; hassUrl?: string; prepare?: boolean; nested?: Record<string, Record<string, unknown>> }

/** Something a brand needs on the hub before its sign-in can start (Echo: a part fetched once). */
export interface Preparer { has(): Promise<boolean>; prepare(): void; state: string; message: string }
const AMAZONS = [["amazon.com", "United States"], ["amazon.ca", "Canada"], ["amazon.co.uk", "United Kingdom"], ["amazon.de", "Germany"], ["amazon.fr", "France"], ["amazon.it", "Italy"], ["amazon.es", "Spain"], ["amazon.com.au", "Australia"], ["amazon.co.jp", "Japan"], ["amazon.in", "India"], ["amazon.com.mx", "Mexico"], ["amazon.com.br", "Brazil"], ["amazon.nl", "Netherlands"]];
const GETTING_READY = "Getting your hub ready for Echo speakers. This happens once and takes about two minutes. Keep this open.";

export class Flows {
  private ha: HA;
  private devices: Devices;
  private open = new Map<string, Open>();
  private words = new Map<string, Record<string, string>>();

  constructor(ha: HA, devices: Devices) { this.ha = ha; this.devices = devices; }

  /** By driver: what must be on the hub first. */
  preparers: Record<string, Preparer> = {};
  /** The address a phone on the home Wi-Fi can open Home Assistant's own pages at, given the address it reaches this hub by. */
  haUrl?: (host: string) => Promise<string>;
  /** By driver: the addresses on the home network where that maker's device is answering now, so the household is not asked to type one. */
  hostsFor?: (driver: string) => Promise<string[]>;
  /** Whether the device of this driver really answers at an address, so a wrong one is caught before the maker's step. */
  hostAnswers?: (driver: string, host: string) => Promise<boolean>;
  /** Sign-ins whose website visit has finished (Home Assistant says so; asking it before then would end the visit early). */
  private finished = new Set<string>();
  /** The hub saw the website visit finish (the closing page was asked for). */
  linkDone(flowId: string): void { this.finished.add(flowId); }
  private unlisten?: () => void;
  /** Subscribed afresh for each visit: a subscription does not survive Home Assistant restarting. */
  private async listen(): Promise<void> {
    try { this.unlisten?.(); } catch { /* the old line had already gone */ }
    this.unlisten = await this.ha.open({ type: "subscribe_events", event_type: "data_entry_flow_progressed" }, (e) => { const id = e?.data?.flow_id; if (id) this.finished.add(String(id)); }).catch(() => undefined);
  }

  /** The maker's own wording for its questions, in English. */
  private async wording(domain: string): Promise<Record<string, string>> {
    const hit = this.words.get(domain);
    if (hit) return hit;
    const r = await this.ha.call({ type: "frontend/get_translations", language: "en", category: "config", integration: [domain] }).catch(() => null);
    const words = (r?.resources ?? {}) as Record<string, string>;
    this.words.set(domain, words);
    return words;
  }

  /** Starts adding a brand. `rooms` are where what it brings should go. */
  async startBrand(brandId: string, rooms: string[] = [], host = ""): Promise<Step> {
    const b = brand(brandId);
    if (!b) return stopped("Vincent does not know that brand.");
    if (b.how === "none" || !b.driver) return stopped(b.tips);
    if (b.how === "link") return stopped(`${b.tips} Vincent cannot open that link for you yet.`);
    const hassUrl = this.haUrl && host ? await this.haUrl(host).catch(() => undefined) : undefined;
    const prep = this.preparers[b.driver];
    if (prep && !(await prep.has())) {
      prep.prepare();
      const id = `prepare${Math.random().toString(36).slice(2, 12)}`;
      this.open.set(id, { domain: b.driver, rooms, fields: [], menu: false, tips: b.tips, name: b.name, prepare: true, hassUrl });
      const step: Step = { kind: "wait", flow: id, title: b.name, text: GETTING_READY, doing: "Installing…", fields: [] };
      this.last.set(id, step);
      return step;
    }
    return this.begin(b.driver, rooms, b.tips, b.name, hassUrl);
  }
  private async begin(driver: string, rooms: string[], tips?: string, name?: string, hassUrl?: string): Promise<Step> {
    const r = await this.ha.restRaw("POST", "/config/config_entries/flow", { handler: driver, show_advanced_options: false });
    let step = await this.read(r.body, driver, rooms, undefined, tips, name);
    if (step.flow && hassUrl) { const o = this.open.get(step.flow); if (o) o.hassUrl = hassUrl; }
    // The maker asks for the device's address first. Nobody knows that by heart: the hub looks for it instead.
    const asksHost = step.kind === "form" && step.flow && step.fields.some((f) => f.name === "host") && step.fields.every((f) => f.name === "host" || !f.required);
    if (asksHost && this.hostsFor) {
      const hosts = await this.hostsFor(driver).catch(() => [] as string[]);
      if (hosts.length === 1) {
        const next = await this.answer(step.flow!, { host: hosts[0] });
        // Only when that address was accepted; otherwise the question stands, with what to check.
        if (!(next.kind === "form" && next.fields.some((f) => f.name === "host"))) return next;
      } else if (hosts.length > 1) {
        return this.which(step, hosts);
      }
    }
    const lost = HOST_HELP[driver];
    if (asksHost && lost) { step = { ...step, text: lost.text, fields: step.fields.map((f) => (f.name === "host" ? { ...f, label: "The TV's address, only if Vincent cannot find it", required: false, help: lost.help } : f)) }; const o = this.open.get(step.flow!); if (o) { o.fields = step.fields; o.look = true; } this.last.set(step.flow!, step); }
    return step;
  }
  /** More than one found: which one is asked, never an address typed. */
  private which(step: Step, hosts: string[]): Step {
    const o = this.open.get(step.flow!);
    const field: StepField = { name: "host", label: "Which TV?", help: "Vincent found more than one that is on. If you are not sure which is which, the TV shows its address under Settings, Network.", type: "choice", required: true, value: hosts[0], options: hosts.map((h, i) => ({ value: h, label: `TV ${i + 1} (${h})` })) };
    if (o) { o.fields = [field]; o.look = false; }
    const next: Step = { ...step, text: "Turn on the TV you want to add, then choose it.", errors: {}, fields: [field] };
    this.last.set(step.flow!, next);
    return next;
  }

  /** Carries on with something the hub found that is waiting for an answer. */
  async startFound(flowId: string, domain: string, rooms: string[]): Promise<Step> {
    const r = await this.ha.restRaw("GET", `/config/config_entries/flow/${flowId}`);
    if (r.status === 404) return stopped("That device is no longer waiting. Look for it again in a moment.");
    return this.read(r.body, domain, rooms);
  }

  async answer(flowId: string, values: Record<string, unknown>): Promise<Step> {
    const o = this.open.get(flowId);
    if (!o) return stopped("That setup has ended. Start it again.");
    // The hub was asked to look again (nothing answered the first time), or an address was typed: it must really be the device.
    if (o.look) {
      const still = HOST_STILL[o.domain]; const was = this.last.get(flowId)!;
      const typed = String(values.host ?? "").trim();
      if (typed) { if (this.hostAnswers && !(await this.hostAnswers(o.domain, typed).catch(() => true))) return { ...was, errors: { host: still?.wrong ?? WHY.cannot_connect } }; }
      else {
        const hosts = this.hostsFor ? await this.hostsFor(o.domain).catch(() => [] as string[]) : [];
        if (!hosts.length) return { ...was, errors: { host: still?.none ?? WHY.cannot_connect } };
        if (hosts.length > 1) return this.which(was, hosts);
        values = { ...values, host: hosts[0] };
      }
    }
    const data: Record<string, unknown> = {};
    // Echo: the household is asked three things; the hub fills in where Amazon's page is to be shown from.
    if (o.domain === "alexa_media" && o.step === "user") { data.email = ""; data.password = ""; if (o.hassUrl) data.hass_url = o.hassUrl; }
    Object.assign(data, o.nested ?? {});
    if (o.menu) data.next_step_id = String(values.choice ?? "");
    else for (const f of o.fields) {
      const v = values[f.name];
      if (f.type === "qr") continue;
      if (f.type === "toggle") data[f.name] = !!v;
      else if (v === undefined || v === null || v === "") { if (f.required) return { ...this.last.get(flowId)!, errors: { [f.name]: "This is needed." } }; }
      else data[f.name] = f.type === "number" ? Number(v) : String(v);
    }
    const r = await this.ha.restRaw("POST", `/config/config_entries/flow/${flowId}`, data);
    if (r.status >= 400 && !r.body?.type) {
      // Home Assistant refused the answers outright (a missing or mistyped field).
      const bad = (r.body?.errors ?? {}) as Record<string, string>;
      return { ...this.last.get(flowId)!, errors: Object.fromEntries(Object.entries(bad).map(([k, v]) => [k, titled(String(v))])), message: r.body?.message ? plain(String(r.body.message)) : undefined };
    }
    return this.read(r.body, o.domain, o.rooms, flowId, o.tips);
  }

  /** For a step that is waiting on the device itself (a button press, a search): ask again. */
  async poll(flowId: string): Promise<Step> {
    const o = this.open.get(flowId);
    if (!o) return stopped("That setup has ended. Start it again.");
    if (o.prepare) {
      const prep = this.preparers[o.domain];
      if (prep?.state === "failed") { this.open.delete(flowId); this.last.delete(flowId); return stopped(prep.message || "The hub could not get ready. Try again in a few minutes."); }
      if (!prep || prep.state === "working" || !(await prep.has())) return this.last.get(flowId)!;
      this.open.delete(flowId); this.last.delete(flowId);
      return this.begin(o.domain, o.rooms, o.tips, o.name, o.hassUrl);
    }
    // A website visit under way: Home Assistant must not be asked until it says the visit is over.
    if (o.link && !this.finished.has(flowId)) return this.last.get(flowId)!;
    this.finished.delete(flowId);
    const r = await this.ha.restRaw("GET", `/config/config_entries/flow/${flowId}`);
    if (r.status === 404) return stopped("That setup has ended. Start it again.");
    return this.read(r.body, o.domain, o.rooms, flowId, o.tips);
  }

  async cancel(flowId: string): Promise<void> {
    const was = this.open.get(flowId);
    if (!this.open.delete(flowId)) return;
    this.last.delete(flowId);
    if (was?.prepare) return;
    await this.ha.restRaw("DELETE", `/config/config_entries/flow/${flowId}`).catch(() => {});
  }

  private last = new Map<string, Step>();

  private async read(r: any, domain: string, rooms: string[], was?: string, tips?: string, name?: string): Promise<Step> {
    name ??= (was && this.open.get(was)?.name) || undefined;
    const words = await this.wording(domain);
    const say = (key: string) => words[`component.${domain}.config.${key}`];
    const id: string | undefined = r?.flow_id ?? was;
    const end = (step: Step): Step => { if (id) { this.open.delete(id); this.last.delete(id); } return step; };

    switch (r?.type) {
      case "create_entry": {
        const entry = r.result?.entry_id as string | undefined;
        const maker = (name && !/^Anything/.test(name) ? name : undefined) ?? brandOf(domain) ?? (r.title ? String(r.title) : titled(domain));
        const brought = entry ? await this.devices.settle(() => this.devices.broughtBy(entry)) : [];
        // One device, and the household already said where it goes: nothing more to ask.
        if (brought.length === 1 && rooms.length) {
          await this.devices.place([{ id: brought[0], add: true, rooms }]);
          return end({ kind: "done", title: `${maker} is in Vincent`, text: "It is in the room you chose, ready to use.", fields: [], maker });
        }
        if (brought.length) return end({ kind: "done", title: `${maker} is connected`, text: "", fields: [], brought, maker });
        // Nothing has arrived yet. If rooms were chosen, whatever comes is added there; otherwise it waits under Add a device.
        if (entry && rooms.length) { store.addEntry(entry); store.setEntryRooms(entry, rooms); }
        this.devices.invalidate();
        return end({ kind: "done", title: `${maker} is connected`, text: rooms.length ? "Nothing has shown up from it yet. When it does, it goes in the room you chose." : "Nothing has shown up from it yet. Give it a minute, then look under Add a device.", fields: [], maker });
      }
      case "abort": {
        const reason = String(r.reason ?? "unknown");
        const why = plain(WHY[reason] ?? say(`abort.${reason}`) ?? titled(reason), r.description_placeholders);
        // An Apple Home code only works on a device that is in nobody's Apple Home: say so plainly, and what to do.
        if (domain === "homekit_controller" && reason === "no_devices") return end(stopped("The hub could not find this device waiting to be paired. First check that it has been set up in its maker's own app (that is what puts it on your Wi-Fi), and that it is plugged in and has had a minute to come back: a device that is new out of the box, or unplugged to read its code, cannot be found. If it is on, it is already paired somewhere else, most likely Apple Home (or another home hub), and a device with an Apple Home code can only be paired in one place at a time: open the Home app on an iPhone, remove the device there (it stays in its maker's own app), then scan its code here again."));
        const sentence = /[.!?]$/.test(why) ? why : `${why}.`;
        // Nothing found, or nothing answered: say what to check, not just that it failed.
        return end(stopped(tips && /no_dev|cannot_connect|timeout/.test(reason) ? `${sentence} ${tips}` : why));
      }
      case "external": case "external_done":
        if (r.type === "external" && r.url && domain === "alexa_media" && id) {
          await this.listen();
          this.finished.delete(id);
          const before = this.open.get(id);
          this.open.set(id, { domain, rooms, fields: [], menu: false, tips, name, link: true, hassUrl: before?.hassUrl });
          const step: Step = { kind: "link", flow: id, url: String(r.url), title: name ?? "Amazon", text: "Amazon's sign-in opens next, shown through your hub. Sign in the way you always do. If Amazon texts you a code, type it there. Vincent carries on by itself when you are done.", fields: [] };
          this.last.set(id, step);
          return step;
        }
        if (id) await this.ha.restRaw("DELETE", `/config/config_entries/flow/${id}`).catch(() => {});
        return end(stopped("This maker needs an account link on its own website. Vincent cannot open that for you yet."));
      case "progress": case "show_progress": {
        this.open.set(id!, { domain, rooms, fields: [], menu: false, tips, name });
        const step: Step = { kind: "wait", flow: id, title: plain(say(`step.${r.step_id}.title`) ?? "Working"), text: plain(say(`progress.${r.progress_action}`) ?? say(`step.${r.step_id}.description`) ?? "One moment.", r.description_placeholders), fields: [] };
        this.last.set(id!, step);
        return step;
      }
      case "menu": {
        const opts: string[] = Array.isArray(r.menu_options) ? r.menu_options : Object.keys(r.menu_options ?? {});
        const fields: StepField[] = [{ name: "choice", label: "Choose one", type: "choice", required: true, value: opts[0], options: opts.map((o) => ({ value: o, label: plain(say(`step.${r.step_id}.menu_options.${o}`) ?? (Array.isArray(r.menu_options) ? titled(o) : String(r.menu_options[o]))) })) }];
        this.open.set(id!, { domain, rooms, fields, menu: true, tips, name });
        const step: Step = { kind: "form", flow: id, title: plain(say(`step.${r.step_id}.title`) ?? "Choose"), text: plain(say(`step.${r.step_id}.description`) ?? "", r.description_placeholders), fields };
        this.last.set(id!, step);
        return step;
      }
      case "form": {
        // A camera's stream has already been opened and checked by the hub when this step arrives; "everything looks good" is not a question for the household.
        if (domain === "generic" && r.step_id === "user_confirm" && id && !r.errors?.base) {
          const next = await this.ha.restRaw("POST", `/config/config_entries/flow/${id}`, { confirmed_ok: true });
          if (next.body?.type && !(next.body.type === "form" && next.body.step_id === "user_confirm")) return this.read(next.body, domain, rooms, id, tips, name);
        }
        // Optional questions the app has no way to draw (lists of several answers) are left out; the maker's default stands.
        // A folded-away group of technical settings ("advanced") is not asked: its suggested answers are sent as they stand.
        const nested: Record<string, Record<string, unknown>> = {};
        for (const e of (r.data_schema ?? []) as any[]) if (e.type === "expandable") {
          nested[e.name] = Object.fromEntries(((e.schema ?? []) as any[]).flatMap((x): [string, unknown][] => { const v = x.default ?? x.description?.suggested_value; return v === undefined ? [] : [[x.name, v]]; }));
          Object.assign(nested[e.name], NESTED[domain]?.[name ?? ""] ?? {});
        }
        let fields = ((r.data_schema ?? []) as any[]).filter((e) => e.type !== "expandable" && !HIDDEN[domain]?.includes(e.name)).filter((e) => e.required || !(e.type === "multi_select" || e.selector?.select?.multiple || e.selector?.select?.custom_value))
          .map((e): StepField => field(e, say(`step.${r.step_id}.data.${e.name}`), say(`step.${r.step_id}.data_description.${e.name}`)))
          .map((f): StepField => ({ ...f, ...(PLAINER[String(r.handler)]?.[f.name] ?? {}) }));
        const errors = Object.fromEntries(Object.entries((r.errors ?? {}) as Record<string, string>).map(([k, v]) => [k, plain(WHY_FOR[domain]?.[v] ?? WHY[v] ?? (domain === "tuya" && v === "login_error" ? TUYA_WHY[String(r.step_id)] : undefined) ?? say(`error.${v}`) ?? titled(String(v)), r.description_placeholders)]));
        // Echo's first form has a dozen technical settings; a household is asked for three things and the rest keep their defaults.
        const echoFirst = domain === "alexa_media" && r.step_id === "user";
        if (echoFirst) {
          const was = (n: string) => fields.find((f) => f.name === n)?.value;
          fields = [
            { name: "url", label: "Your Amazon site", help: "The Amazon you shop at. It decides which Alexa your speakers belong to.", type: "choice", required: true, value: String(was("url") || "amazon.com"), options: AMAZONS.map(([value, label]) => ({ value, label: `${label} (${value})` })) },
          ];
        }
        this.open.set(id!, { domain, rooms, fields, menu: false, tips, name, step: String(r.step_id ?? ""), hassUrl: this.open.get(id!)?.hassUrl, nested });
        const step: Step = { kind: "form", flow: id, title: plain(say(`step.${r.step_id}.title`) ?? name ?? "A question from the maker"), text: echoFirst ? "Amazon's sign-in opens next. You type your email and password there, and a code texted to your phone works." : plain(say(`step.${r.step_id}.description`) ?? "", r.description_placeholders), fields, errors };
        const ours = STEPS[domain]?.[String(r.step_id)];
        if (ours) { step.title = ours.title; step.text = ours.text; step.picture = ours.picture; }
        this.last.set(id!, step);
        return step;
      }
      default:
        return end(stopped(r?.message ? plain(String(r.message)) : "The hub could not start that. Try again in a moment."));
    }
  }
}

/** The household's name for a maker, from Home Assistant's name for its driver. */
const brandOf = (domain: string): string | undefined => BRANDS.find((b) => b.driver === domain && b.id !== "homekit" && b.id !== "ecobee")?.name;
const stopped = (text: string): Step => ({ kind: "stopped", title: "Not added", text, fields: [] });

/** One of the maker's questions as a field the app can draw. */
function field(e: any, label: string | undefined, help: string | undefined): StepField {
  const name = String(e.name);
  const sel = e.selector ? Object.keys(e.selector)[0] : "";
  const selCfg = sel ? e.selector[sel] ?? {} : {};
  let type: StepField["type"] = "text";
  let options: StepField["options"];
  // A square code for the maker's own app to scan (Tuya): shown, never answered.
  if (sel === "qr_code") return { name, label: "Scan this with the maker's app", type: "qr", required: false, value: String(selCfg.data ?? "") };
  if (e.type === "boolean" || sel === "boolean") type = "toggle";
  else if (e.type === "integer" || e.type === "float" || e.type === "positive_int" || sel === "number") type = "number";
  else if (e.type === "select" || sel === "select") {
    type = "choice";
    const raw: any[] = e.options ?? selCfg.options ?? [];
    options = raw.map((o) => (Array.isArray(o) ? { value: String(o[0]), label: String(o[1]) } : typeof o === "object" ? { value: String(o.value), label: String(o.label ?? o.value) } : { value: String(o), label: titled(String(o)) }));
  } else if (selCfg.type === "password" || /pass|secret|token|api_key/i.test(name)) type = "password";
  else if (/^(pin|code|pairing_code|2fa)$/i.test(name)) type = "code";
  const value = e.default ?? e.description?.suggested_value;
  return { name, label: OURS[name] ?? (label ? plain(label) : LABELS[name] ?? titled(name)), help: help ? plain(help) : undefined, type, required: !!e.required, value: value === undefined || typeof value === "object" ? undefined : value, options };
}
