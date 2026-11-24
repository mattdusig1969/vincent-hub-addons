/**
 * Reminders: something to remember at a date and time, told to the household's phones and tablets when it comes due.
 * The hub keeps them; each phone schedules its own notifications from what the hub holds.
 */
export type Repeat = "" | "day" | "weekdays" | "week" | "month" | "year";
export interface Reminder {
  id: string; text: string;
  /** When it is due (ISO). For one that repeats, the next time. */
  at: string;
  repeat: Repeat;
  /** "" = everyone in the home; otherwise the one device it belongs to. */
  for: string;
  /** Who made it, as the home knows them. */
  by: string;
  /** When it was ticked off (only ones that do not repeat are ever finished). */
  done?: string;
  /** True when it belongs to the device asking. */
  mine?: boolean;
  /** The device that made it (kept on the hub). */
  made?: string;
  /** True when the asking device's own Apple Reminders holds it too: Apple rings it there, so Vincent does not. */
  quiet?: boolean;
}

export const REPEATS: { id: Repeat; name: string; short: string }[] = [
  { id: "", name: "Once", short: "" },
  { id: "day", name: "Every day", short: "every day" },
  { id: "weekdays", name: "Weekdays", short: "weekdays" },
  { id: "week", name: "Every week", short: "every week" },
  { id: "month", name: "Every month", short: "every month" },
  { id: "year", name: "Every year", short: "every year" },
];

/** The next time a repeating reminder is due after `after`, by the clock of the device asking. */
export function nextTime(at: string, repeat: Repeat, after = Date.now()): string {
  const d = new Date(at);
  if (!repeat || Number.isNaN(d.getTime())) return at;
  const day = d.getDate();
  for (let i = 0; i < 4000 && (d.getTime() <= after || (repeat === "weekdays" && (d.getDay() === 0 || d.getDay() === 6))); i++) {
    if (repeat === "day" || repeat === "weekdays") d.setDate(d.getDate() + 1);
    else if (repeat === "week") d.setDate(d.getDate() + 7);
    else if (repeat === "month") { d.setDate(1); d.setMonth(d.getMonth() + 1); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); }
    else d.setFullYear(d.getFullYear() + 1);
  }
  return d.toISOString();
}

/** "Today 6:00 PM", "Tomorrow 9:00 AM", "Thu 7:00 PM", "Dec 3, 9:00 AM". */
export function remindWhen(at: string, now = new Date()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString([], { weekday: "long" })} ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" })}, ${time}`;
}

/** Due now or earlier, and not finished. */
export const isDue = (r: Reminder, now = Date.now()): boolean => !r.done && Date.parse(r.at) <= now;
