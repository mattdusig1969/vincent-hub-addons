/**
 * The household's lists (shopping, to-do). They live in Home Assistant's own list keeper,
 * so anything else in the home that adds to a list (a voice assistant) lands in the same place.
 */
import { createHash } from "node:crypto";
import type { HA } from "./ha.ts";
import type { ListItem, ListSummary } from "../../../packages/core/src/index.ts";

const idOf = (entityId: string) => createHash("sha256").update(entityId).digest("hex").slice(0, 12);

export class Lists {
  private ha: HA;
  constructor(ha: HA) { this.ha = ha; }

  private entities(): string[] { return [...this.ha.states.keys()].filter((id) => id.startsWith("todo.")).sort(); }
  private entity(id: string): string {
    const e = this.entities().find((x) => idOf(x) === id);
    if (!e) throw new Error("That list is gone.");
    return e;
  }
  idOf(entityId: string): string { return idOf(entityId); }

  /** Every item in one list, by the list's own name on the hub. */
  async raw(entity: string): Promise<{ uid: string; text: string; done: boolean }[]> {
    const r = await this.ha.call({ type: "call_service", domain: "todo", service: "get_items", service_data: {}, target: { entity_id: entity }, return_response: true });
    return ((r?.response?.[entity]?.items ?? []) as { uid: string; summary: string; status: string }[]).map((i) => ({ uid: i.uid, text: String(i.summary ?? ""), done: i.status === "completed" }));
  }

  async rename(entity: string, uid: string, text: string): Promise<void> { await this.ha.service("todo", "update_item", entity, { item: uid, rename: text.trim().slice(0, 200) }); }

  /** The list called this (give or take "list" on the end). With `make`, one is made when the home has none. */
  async entityNamed(name: string, make: boolean): Promise<string | undefined> {
    const flat = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/list$/, "");
    const find = () => this.entities().find((e) => flat(String(this.ha.states.get(e)?.attributes.friendly_name ?? "")) === flat(name));
    let e = find();
    if (e || !make) return e;
    await this.create(name);
    for (let i = 0; i < 20 && !(e = find()); i++) await new Promise((r) => setTimeout(r, 250));
    return e;
  }

  shows(entityId: string): boolean { return entityId.startsWith("todo."); }

  all(): ListSummary[] {
    return this.entities().map((e) => {
      const s = this.ha.states.get(e)!;
      return { id: idOf(e), name: String(s.attributes.friendly_name ?? "List"), open: Number(s.state) || 0 };
    });
  }

  async items(id: string): Promise<{ open: ListItem[]; done: ListItem[] }> {
    const entity = this.entity(id);
    const r = await this.ha.call({ type: "call_service", domain: "todo", service: "get_items", service_data: {}, target: { entity_id: entity }, return_response: true });
    const all = ((r?.response?.[entity]?.items ?? []) as { uid: string; summary: string; status: string }[]).map((i) => ({ id: i.uid, text: i.summary, done: i.status === "completed" }));
    return { open: all.filter((i) => !i.done), done: all.filter((i) => i.done).slice(-15).reverse() };
  }

  async change(id: string, b: { op?: string; text?: string; item?: string }): Promise<void> {
    const entity = this.entity(id);
    const call = (service: string, data: Record<string, unknown>) => this.ha.service("todo", service, entity, data);
    const text = String(b.text ?? "").trim().slice(0, 200), item = String(b.item ?? "");
    switch (b.op) {
      case "add": if (!text) throw new Error("Nothing to add."); await call("add_item", { item: text }); break;
      case "done": await call("update_item", { item, status: "completed" }); break;
      case "reopen": await call("update_item", { item, status: "needs_action" }); break;
      case "remove": await call("remove_item", { item: [item] }); break;
      case "clear": await call("remove_completed_items", {}); break;
      default: throw new Error("unknown change");
    }
  }

  /** A new list of the household's own. */
  async create(name: string): Promise<void> {
    const clean = name.trim().slice(0, 40);
    if (!clean) throw new Error("A list needs a name.");
    const flow = await this.ha.rest("POST", "/config/config_entries/flow", { handler: "local_todo", show_advanced_options: false });
    if (flow?.type !== "form") throw new Error("The hub could not make a list.");
    const r = await this.ha.rest("POST", `/config/config_entries/flow/${flow.flow_id}`, { todo_list_name: clean });
    if (r?.type !== "create_entry") throw new Error(r?.reason === "already_configured" ? "There is already a list by that name." : "The hub could not make that list.");
  }

  /** The lists every home starts with. Skips one the home already has under a similar name. */
  async seed(names: string[]): Promise<void> {
    const flat = (x: string) => x.toLowerCase().replace(/[^a-z]/g, "");
    for (const name of names) {
      const key = flat(name);
      const match = this.entities().find((e) => { const h = flat(String(this.ha.states.get(e)?.attributes.friendly_name ?? "")); return h === key || h === `${key}list`; });
      if (match) {
        // The hub's own "Shopping list" becomes plain "Shopping".
        if (String(this.ha.states.get(match)?.attributes.friendly_name) !== name) await this.ha.call({ type: "config/entity_registry/update", entity_id: match, name }).catch(() => {});
        continue;
      }
      await this.create(name).catch((e: Error) => console.log(`[lists] could not make "${name}": ${e.message}`));
    }
  }
}
