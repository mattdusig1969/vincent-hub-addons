/**
 * Apple Reminders, kept in step with the home's lists and reminders.
 *
 * The hub cannot reach iCloud. A phone that has Vincent hands over what its chosen Apple lists hold; the hub works
 * out what changed on either side since the last time, changes the home's side itself, and answers with what the
 * phone must change on Apple's side. Each phone or tablet is set up by itself and keeps its own record.
 *
 * In a list shared with the home: items with no date live in a home list of the same name, items with a date are
 * reminders for everyone. In a list kept to the one device: only items with a date come in, as that device's own reminders.
 */
import { randomBytes } from "node:crypto";
import type { Reminder, Repeat } from "../../../packages/core/src/index.ts";
import type { AppleRow, AppleSaved } from "./store.ts";
import { store } from "./store.ts";
import type { Lists } from "./lists.ts";

export interface AppleItem { id: string; text: string; done: boolean; at?: string; repeat?: Repeat | "odd" }
export interface AppleList { id: string; name: string; items: AppleItem[] }
export type AppleOp =
  | { op: "add"; ref: string; list: string; text: string; at?: string; repeat?: Repeat }
  | { op: "edit"; id: string; text?: string; at?: string; repeat?: Repeat }
  | { op: "done" | "reopen" | "remove"; id: string };

const flat = (x: string) => x.trim().toLowerCase().replace(/\s+/g, " ");
/** Two times are the same when they fall in the same minute. */
const minute = (at?: string) => (at ? Math.floor(Date.parse(at) / 60_000) : 0);
const repeatOf = (r: AppleItem["repeat"]): Repeat => (r === "odd" || !r ? "" : r);
const clean = (t: string) => t.trim().slice(0, 200);

export class Apple {
  private lists: Lists;
  private busy = new Map<string, Promise<unknown>>();
  constructor(lists: Lists) { this.lists = lists; }

  /** What one device chose, for its settings screen. */
  chosen(deviceId: string): { lists: Record<string, { name: string; share: boolean }>; into: string; at: string } | undefined {
    const c = store.appleOf(deviceId);
    return c && { lists: Object.fromEntries(Object.entries(c.lists).map(([id, l]) => [id, { name: l.name, share: l.share }])), into: c.into, at: c.at ?? "" };
  }

  /** The device's choice of lists. A list no longer chosen is let go: what it brought stays in the home, and rings like any other reminder. */
  choose(deviceId: string, lists: Record<string, { name?: unknown; share?: unknown }>, into: string): void {
    const was = store.appleOf(deviceId);
    const now: AppleSaved = { lists: {}, into: "", rows: [], at: was?.at };
    for (const [id, l] of Object.entries(lists ?? {}).slice(0, 40)) {
      const name = String(l?.name ?? "").trim().slice(0, 60);
      if (!id || id.length > 120 || !name) continue;
      // Sharing switched on or off starts that list afresh, so its reminders land with the right people.
      const kept = was?.lists[id]?.share === !!l.share ? was.lists[id] : undefined;
      now.lists[id] = { name, share: !!l.share, entity: kept?.entity };
      if (kept) now.rows.push(...was!.rows.filter((r) => r.l === id));
    }
    if (now.lists[into]) now.into = into;
    store.setApple(deviceId, Object.keys(now.lists).length ? now : null);
  }

  /** One device at a time, one pass at a time. */
  sync(deviceId: string, by: string, lists: AppleList[]): Promise<{ ops: AppleOp[]; changed: boolean }> {
    const run = (this.busy.get(deviceId) ?? Promise.resolve()).catch(() => {}).then(() => this.pass(deviceId, by, lists));
    this.busy.set(deviceId, run);
    return run;
  }

  /** The phone made these on Apple's side: `ref` -> Apple's own id for it. */
  made(deviceId: string, made: Record<string, unknown>): void {
    const cfg = store.appleOf(deviceId);
    if (!cfg) return;
    for (const row of cfg.rows) {
      const id = row.ref ? made?.[row.ref] : undefined;
      if (typeof id !== "string" || !id) continue;
      row.a = id; delete row.ref;
    }
    store.setApple(deviceId, cfg);
  }

  private async pass(deviceId: string, by: string, given: AppleList[]): Promise<{ ops: AppleOp[]; changed: boolean }> {
    const cfg = store.appleOf(deviceId);
    if (!cfg) return { ops: [], changed: false };
    const ops: AppleOp[] = [];
    let changed = false;

    // Only lists the device chose, and only ones Apple still has. A list missing from what the phone sent is left alone entirely.
    const here = new Map<string, AppleList>();
    for (const l of Array.isArray(given) ? given : []) if (l && cfg.lists[l.id] && Array.isArray(l.items)) here.set(l.id, l);
    const apple = new Map<string, AppleItem & { l: string }>();
    for (const l of here.values()) {
      for (const i of l.items.slice(0, 600)) {
        if (!i || typeof i.id !== "string" || !clean(String(i.text ?? ""))) continue;
        const at = i.at && !Number.isNaN(Date.parse(i.at)) ? new Date(i.at).toISOString() : undefined;
        apple.set(i.id, { id: i.id, text: clean(String(i.text)), done: !!i.done, at, repeat: i.repeat, l: l.id });
      }
      if (cfg.lists[l.id].name !== l.name && l.name) cfg.lists[l.id].name = String(l.name).slice(0, 60);
    }

    // The home's side, as it stands.
    let reminders = store.allReminders;
    let remindersChanged = false;
    const setReminder = (id: string, fn: (r: Reminder) => Reminder | null) => {
      reminders = reminders.flatMap((r) => { if (r.id !== id) return [r]; const n = fn(r); return n ? [n] : []; });
      remindersChanged = true;
    };
    const todo = new Map<string, { uid: string; text: string; done: boolean }[]>();
    const itemsOf = async (entity: string) => {
      if (!todo.has(entity)) todo.set(entity, await this.lists.raw(entity).catch(() => []));
      return todo.get(entity)!;
    };

    const rows: AppleRow[] = [];
    const linked = new Set(cfg.rows.map((r) => r.a).filter(Boolean));
    for (const row of cfg.rows) {
      if (!here.has(row.l)) { rows.push(row); continue; }
      const entity = cfg.lists[row.l].entity ?? "";
      const items = row.kind === "item" && entity ? await itemsOf(entity) : [];
      const item = row.kind === "item" ? items.find((i) => i.uid === row.v) : undefined;
      const rem = row.kind === "rem" ? reminders.find((r) => r.id === row.v) : undefined;
      const has = !!(item ?? rem);

      // Still waiting for the phone to say it made this one on Apple's side.
      if (!row.a) {
        if (!has) continue;
        const twin = [...apple.values()].find((a) => a.l === row.l && !linked.has(a.id) && !a.done && flat(a.text) === flat(row.text) && (row.kind === "rem") === !!a.at);
        if (twin) { row.a = twin.id; delete row.ref; linked.add(twin.id); rows.push(row); continue; }
        row.ref ??= randomBytes(5).toString("hex");
        ops.push({ op: "add", ref: row.ref, list: row.l, text: row.text, ...(row.kind === "rem" ? { at: row.at, repeat: row.repeat ?? "" } : {}) });
        rows.push(row); continue;
      }

      const a = apple.get(row.a);
      if (!a || a.l !== row.l) {
        // Gone from Apple (or moved to a list not kept here). Something open goes from the home too; something finished stays as the home's record.
        if (has && !row.done) {
          if (item) await this.lists.change(this.lists.idOf(entity), { op: "remove", item: item.uid }).catch(() => {});
          if (rem) setReminder(rem.id, () => null);
          changed = true;
        }
        if (a) linked.delete(a.id);
        continue;
      }
      if (!has) {
        // Removed in Vincent. Something still open goes from Apple too; a finished one is left as Apple's record.
        if (!row.done && !a.done) ops.push({ op: "remove", id: a.id });
        else if (!a.done) linked.delete(a.id); // finished here and cleared away, then opened again on Apple: it comes in anew
        continue;
      }
      if ((row.kind === "rem") !== !!a.at) {
        // Given a date on Apple, or its date taken away: it changes shelves. Out of the old one here, in afresh below.
        if (item) await this.lists.change(this.lists.idOf(entity), { op: "remove", item: item.uid }).catch(() => {});
        if (rem) setReminder(rem.id, () => null);
        linked.delete(a.id); changed = true;
        continue;
      }

      // On both sides. For each thing that can differ: Apple's change wins, else Vincent's change goes to Apple.
      const vText = item ? item.text : rem!.text, vDone = item ? item.done : !!rem!.done;
      const edit: { text?: string; at?: string; repeat?: Repeat } = {};
      if (flat(a.text) !== flat(row.text)) {
        if (item) await this.lists.rename(entity, item.uid, a.text).catch(() => {}); else setReminder(rem!.id, (r) => ({ ...r, text: a.text }));
        row.text = a.text; changed = true;
      } else if (flat(vText) !== flat(row.text)) { edit.text = clean(vText); row.text = clean(vText); }

      if (a.done !== row.done) {
        if (item) await this.lists.change(this.lists.idOf(entity), { op: a.done ? "done" : "reopen", item: item.uid }).catch(() => {});
        else setReminder(rem!.id, (r) => { const { done: _d, ...open } = r; return a.done ? { ...r, done: new Date().toISOString() } : open; });
        row.done = a.done; changed = true;
      } else if (vDone !== row.done) { ops.push({ op: vDone ? "done" : "reopen", id: a.id }); row.done = vDone; }

      if (rem) {
        const now = reminders.find((r) => r.id === rem.id)!;
        if (minute(a.at) !== minute(row.at)) { setReminder(rem.id, (r) => ({ ...r, at: a.at! })); row.at = a.at; changed = true; }
        else if (minute(now.at) !== minute(row.at)) { edit.at = now.at; row.at = now.at; }
        row.odd = a.repeat === "odd";
        if (!row.odd) {
          if (repeatOf(a.repeat) !== (row.repeat ?? "")) { setReminder(rem.id, (r) => ({ ...r, repeat: repeatOf(a.repeat) })); row.repeat = repeatOf(a.repeat); changed = true; }
          else if (now.repeat !== (row.repeat ?? "")) { edit.repeat = now.repeat; row.repeat = now.repeat; }
        }
      }
      if (Object.keys(edit).length) ops.push({ op: "edit", id: a.id, ...edit });
      rows.push(row);
    }

    // New on Apple's side: bring it in. Something the home already holds by the same name is joined up, not doubled.
    const mine = () => new Set(rows.map((r) => `${r.kind}:${r.v}`));
    for (const a of apple.values()) {
      if (linked.has(a.id) || a.done) continue;
      const list = cfg.lists[a.l];
      if (a.at) {
        const taken = mine();
        const same = reminders.find((r) => !r.done && !taken.has(`rem:${r.id}`) && (!r.for || r.for === deviceId) && flat(r.text) === flat(a.text) && minute(r.at) === minute(a.at));
        let id = same?.id;
        if (!same) { id = randomBytes(6).toString("hex"); reminders = [...reminders, { id, text: a.text, at: a.at, repeat: repeatOf(a.repeat), for: list.share ? "" : deviceId, by }]; remindersChanged = true; changed = true; }
        rows.push({ a: a.id, l: a.l, kind: "rem", v: id!, text: a.text, done: false, at: a.at, repeat: repeatOf(a.repeat), odd: a.repeat === "odd" });
        continue;
      }
      if (!list.share) continue; // a list kept to this device brings only its dated reminders
      list.entity ??= await this.lists.entityNamed(here.get(a.l)!.name, true).catch(() => undefined);
      if (!list.entity) continue;
      const items = await itemsOf(list.entity), taken = mine();
      let twin = items.find((i) => !i.done && !taken.has(`item:${i.uid}`) && flat(i.text) === flat(a.text));
      if (!twin) {
        await this.lists.change(this.lists.idOf(list.entity), { op: "add", text: a.text });
        todo.delete(list.entity); changed = true;
        twin = (await itemsOf(list.entity)).find((i) => !i.done && !taken.has(`item:${i.uid}`) && flat(i.text) === flat(a.text));
        if (!twin) continue;
      }
      rows.push({ a: a.id, l: a.l, kind: "item", v: twin.uid, text: a.text, done: false });
    }

    // New on the home's side: an item in a list that is kept in step, and reminders this device made, go to Apple.
    for (const [id, list] of Object.entries(cfg.lists)) {
      if (!here.has(id) || !list.share) continue;
      list.entity ??= await this.lists.entityNamed(here.get(id)!.name, false).catch(() => undefined);
      if (!list.entity) continue;
      const taken = mine();
      for (const i of await itemsOf(list.entity)) {
        if (i.done || taken.has(`item:${i.uid}`) || !clean(i.text)) continue;
        const ref = randomBytes(5).toString("hex");
        rows.push({ a: "", ref, l: id, kind: "item", v: i.uid, text: clean(i.text), done: false });
        ops.push({ op: "add", ref, list: id, text: clean(i.text) });
      }
    }
    if (cfg.into && here.has(cfg.into)) {
      const taken = mine();
      for (const r of reminders) {
        if (r.done || r.made !== deviceId || taken.has(`rem:${r.id}`)) continue;
        const ref = randomBytes(5).toString("hex");
        rows.push({ a: "", ref, l: cfg.into, kind: "rem", v: r.id, text: r.text, done: false, at: r.at, repeat: r.repeat });
        ops.push({ op: "add", ref, list: cfg.into, text: r.text, at: r.at, repeat: r.repeat });
      }
    }

    if (remindersChanged) store.setReminders(reminders);
    store.setApple(deviceId, { ...cfg, rows: rows.slice(0, 4000), at: new Date().toISOString() });
    return { ops: ops.slice(0, 300), changed: changed || remindersChanged };
  }
}
