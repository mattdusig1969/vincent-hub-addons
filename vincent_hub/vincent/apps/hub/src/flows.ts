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
const PLAINER: Record<string, Record<string, { label: string; help: string }>> = {
  alexa_devices: {
    username: { label: "Amazon email", help: "The email you sign in to Amazon with." },
    password: { label: "Amazon password", help: "Sent encrypted, straight to Amazon." },
    code: { label: "Six-digit code from your authenticator app", help: "Open your authenticator app (Google Authenticator, Microsoft Authenticator, 1Password or similar), find Amazon, and type the six digits it shows right now. Nothing is texted to you: Amazon only allows an authenticator app for this. No Amazon entry in an authenticator app yet? On amazon.com go to Account, Login and security, Two-step verification, and add an authenticator app first." },
  },
};
const OURS: Record<string, string> = { host: "Address", ip_address: "Address", address: "Address", device_input: "Name or address" };

const plain = (s: string, vars: Record<string, unknown> = {}) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? "")).replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`]{1,2}([^*_`]+)[*_`]{1,2}/g, "$1")
    .replace(/Home Assistant/g, "Vincent").replace(/\bSubmit\b/g, "Continue").replace(/\b[Tt]he host\b/g, "the address").replace(/\bIP address\b/g, "address").replace(/\n{2,}/g, "\n").trim();
const titled = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

interface Open { domain: string; rooms: string[]; fields: StepField[]; menu: boolean; tips?: string; name?: string }

export class Flows {
  private ha: HA;
  private devices: Devices;
  private open = new Map<string, Open>();
  private words = new Map<string, Record<string, string>>();

  constructor(ha: HA, devices: Devices) { this.ha = ha; this.devices = devices; }

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
  async startBrand(brandId: string, rooms: string[] = []): Promise<Step> {
    const b = brand(brandId);
    if (!b) return stopped("Vincent does not know that brand.");
    if (b.how === "none" || !b.driver) return stopped(b.tips);
    if (b.how === "link") return stopped(`${b.tips} Vincent cannot open that link for you yet.`);
    const r = await this.ha.restRaw("POST", "/config/config_entries/flow", { handler: b.driver, show_advanced_options: false });
    return this.read(r.body, b.driver, rooms, undefined, b.tips, b.name);
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
    const data: Record<string, unknown> = {};
    if (o.menu) data.next_step_id = String(values.choice ?? "");
    else for (const f of o.fields) {
      const v = values[f.name];
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
    const r = await this.ha.restRaw("GET", `/config/config_entries/flow/${flowId}`);
    if (r.status === 404) return stopped("That setup has ended. Start it again.");
    return this.read(r.body, o.domain, o.rooms, flowId, o.tips);
  }

  async cancel(flowId: string): Promise<void> {
    if (!this.open.delete(flowId)) return;
    this.last.delete(flowId);
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
        // Nothing found, or nothing answered: say what to check, not just that it failed.
        return end(stopped(tips && /no_dev|cannot_connect|timeout/.test(reason) ? `${why} ${tips}` : why));
      }
      case "external": case "external_done":
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
        // Optional questions the app has no way to draw (lists of several answers) are left out; the maker's default stands.
        const fields = ((r.data_schema ?? []) as any[]).filter((e) => e.required || !(e.type === "multi_select" || e.selector?.select?.multiple || e.selector?.select?.custom_value))
          .map((e): StepField => field(e, say(`step.${r.step_id}.data.${e.name}`), say(`step.${r.step_id}.data_description.${e.name}`)))
          .map((f): StepField => ({ ...f, ...(PLAINER[String(r.handler)]?.[f.name] ?? {}) }));
        const errors = Object.fromEntries(Object.entries((r.errors ?? {}) as Record<string, string>).map(([k, v]) => [k, plain(WHY[v] ?? say(`error.${v}`) ?? titled(String(v)))]));
        this.open.set(id!, { domain, rooms, fields, menu: false, tips, name });
        const step: Step = { kind: "form", flow: id, title: plain(say(`step.${r.step_id}.title`) ?? name ?? "A question from the maker"), text: plain(say(`step.${r.step_id}.description`) ?? "", r.description_placeholders), fields, errors };
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
