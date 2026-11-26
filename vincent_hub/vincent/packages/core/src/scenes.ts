/**
 * Scenes: one tap sets several things in a room (or the whole home) the way the household likes them.
 *
 * A scene is nothing more than a list of the same requests the app sends when a person
 * taps a control. This file holds everything both sides need to agree on: what a scene is,
 * which scenes suit which kind of room, how to say what a scene does in plain words, and
 * how to tell whether a room is already set the way a scene sets it.
 * The hub keeps the scenes and runs them; the app (and the demo home) work out the suggestions.
 */
import type { Control, ControlRequest, Device, Room } from "./index.ts";

/** A scene's room when it is for the whole home. */
export const WHOLE_HOME = "";

export interface Scene {
  id: string;
  name: string;
  /** Room id, or WHOLE_HOME. */
  room: string;
  icon: string;
  steps: ControlRequest[];
  /** When it runs by itself, if it does. */
  when?: SceneWhen;
  /** "off" = the home's own Everything off: its steps are worked out afresh each time, so lights and speakers added later are included. */
  auto?: "off";
}

/** A scene's schedule: a time of day, or the sun, on chosen days. */
export interface SceneWhen {
  on: boolean;
  at: "time" | "sunrise" | "sunset";
  /** "HH:MM", 24-hour, for at = "time". */
  time: string;
  /** Minutes after (or, negative, before) the sun, for at = "sunrise" / "sunset". */
  offset: number;
  /** Days of the week it runs, 0 = Sunday. */
  days: number[];
}
/** The next sunrise and sunset at the home (ISO times). */
export interface SunTimes { rise: string; set: string }

/** A scene the household has not made yet, offered because the room has what it needs. */
export interface SceneIdea extends Omit<Scene, "id"> {
  /** Stays the same for this room and this idea, so "not for this room" can be remembered. */
  key: string;
}

export type RoomKind = "living" | "media" | "bedroom" | "child" | "kitchen" | "dining" | "office" | "bathroom" | "entry" | "outside" | "utility" | "play" | "other";

export const ROOM_KINDS: { id: RoomKind; label: string }[] = [
  { id: "living", label: "Living or family room" },
  { id: "media", label: "Theater or TV room" },
  { id: "bedroom", label: "Bedroom" },
  { id: "child", label: "Child's room" },
  { id: "kitchen", label: "Kitchen" },
  { id: "dining", label: "Dining room" },
  { id: "office", label: "Office or study" },
  { id: "bathroom", label: "Bathroom" },
  { id: "entry", label: "Entry, hall or stairs" },
  { id: "outside", label: "Outside" },
  { id: "utility", label: "Garage, laundry or basement" },
  { id: "play", label: "Gym, playroom or bar" },
  { id: "other", label: "Something else" },
];

/** The first that matches wins, so the narrower names come before the broader ones ("Kids' Bedroom" is a child's room). */
const KIND_WORDS: [RoomKind, RegExp][] = [
  ["media", /theat(er|re)|cinema|media|\btv\b|screening/i],
  ["child", /kid|child|nursery|\bbaby|boys?'?s? room|girls?'?s? room|bunk|\w['’]s (bed)?room$/i],
  ["bathroom", /bath|powder|ensuite|en-suite|restroom|toilet|shower/i],
  ["bedroom", /bed|primary|master|guest|sleep/i],
  ["kitchen", /kitchen|pantry/i],
  ["dining", /dining|breakfast|\bnook/i],
  ["office", /office|study|library|\bdesk/i],
  ["play", /gym|exercise|workout|play ?room|game|\bbar\b|\brec\b|billiard|pool table/i],
  ["outside", /patio|deck|porch|yard|garden|\bpool\b|balcony|terrace|outside|outdoor|driveway|lanai|veranda/i],
  ["utility", /garage|workshop|laundry|basement|attic|closet|utility|storage|cellar|shed/i],
  ["entry", /entry|foyer|\bhall|stair|mud ?room|front door|landing|vestibule/i],
  ["living", /living|family|great room|\bden\b|lounge|sitting|parlou?r|salon/i],
];

/** What kind of room this is: the household's own word for it when they gave one, else a guess from its name. */
export function roomKind(room: Pick<Room, "name" | "kind">): RoomKind {
  if (room.kind) return room.kind;
  for (const [kind, words] of KIND_WORDS) if (words.test(room.name)) return kind;
  return "other";
}

// The parts of a room a scene can set

interface Part { c: Control; d: Device }
const partsOf = (devices: Device[], room: string): Part[] =>
  devices.filter((d) => d.status === "added" && (room === WHOLE_HOME || d.rooms.includes(room))).flatMap((d) => d.controls.map((c) => ({ c, d })));
/** A lamp on a smart plug is a light; a plug on anything else (a fridge, a fish tank) is left alone unless the household says so. */
const isLight = (p: Part) => p.c.kind === "light" || (p.c.kind === "switch" && p.d.category === "lights");
const dims = (p: Part) => p.c.kind === "light" && p.c.dimmable;
/** The small lights that stay on when the big ones go off. */
const ACCENT = /lamp|sconce|accent|strip|shelf|cabinet|night|bedside|\bled\b|toe.?kick|cove/i;

/** On at a level, and in a white that suits the moment where the light can change its white. */
const on = (p: Part, pct = 100, kelvin = 0): ControlRequest => {
  if (!dims(p)) return { id: p.c.id, action: "on" };
  const w = p.c.kind === "light" && kelvin ? p.c.whites : undefined;
  return { id: p.c.id, action: "brightness", value: pct, ...(w ? { kelvin: Math.min(w[1], Math.max(w[0], kelvin)) } : {}) };
};
/** Music speakers (not televisions): a scene that turns a room off stops them too. */
const speakers = (parts: Part[]) => parts.filter((p) => p.c.kind === "media" && p.c.library !== "none");
const hush = (p: Part): ControlRequest => ({ id: p.c.id, action: "pause" });
const CANDLE = 2200, WARM = 2700, MORNING = 3500, CLEAR = 4000, DAY = 5000;
const off = (p: Part): ControlRequest => ({ id: p.c.id, action: "off" });

interface Has { lights: Part[]; dim: Part[]; covers: Part[]; locks: Part[]; music: Part[] }
type Recipe = (h: Has) => ControlRequest[];

const brightAt = (kelvin: number): Recipe => (h) => h.lights.map((p) => on(p, 100, kelvin));
const bright = brightAt(CLEAR);
const allAt = (pct: number, kelvin = 0): Recipe => (h) => h.lights.map((p) => on(p, pct, kelvin));
/** Needs a dimmer: the dimmable lights at a level, anything that can only be on or off goes off. */
const level = (pct: number, kelvin = WARM): Recipe => (h) => (h.dim.length ? h.lights.map((p) => (dims(p) ? on(p, pct, kelvin) : off(p))) : []);
const allOff: Recipe = (h) => (h.lights.length ? [...h.lights.map(off), ...h.music.map(hush)] : []);
const movie: Recipe = (h) => {
  if (!h.dim.length) return [];
  const accents = h.dim.filter((p) => ACCENT.test(p.c.name) || ACCENT.test(p.d.name));
  const few = accents.length > 0 && accents.length < h.lights.length;
  return [...h.lights.map((p) => (few ? (accents.includes(p) ? on(p, 20, CANDLE) : off(p)) : dims(p) ? on(p, 10, CANDLE) : off(p))), ...h.covers.map((p): ControlRequest => ({ id: p.c.id, action: "close" }))];
};
const night: Recipe = (h) => {
  if (!h.dim.length) return [];
  const one = h.dim.find((p) => ACCENT.test(p.c.name) || ACCENT.test(p.d.name)) ?? h.dim[0];
  return h.lights.map((p) => (p === one ? on(p, 5, CANDLE) : off(p)));
};
const morning: Recipe = (h) => [...h.lights.map((p) => on(p, 70, MORNING)), ...h.covers.map((p): ControlRequest => ({ id: p.c.id, action: "open" }))];
const sleep: Recipe = (h) => [...h.lights.map(off), ...h.music.map(hush), ...h.covers.map((p): ControlRequest => ({ id: p.c.id, action: "close" }))];

// Televisions

/** A television or a TV box, as against a music speaker. */
export const isScreen = (c: Control): boolean => c.kind === "media" && c.library === "none" && (!!c.remote || c.inputs.length >= 2);
/**
 * Whether one of a TV's sources is a socket on its back (something plugged in) rather than an app on the TV itself.
 * A TV lists both together, and an app can carry the same name as a box: LG's "Apple TV" is its app, "Apple OTT" the box on HDMI.
 */
export const isPlugged = (name: string): boolean =>
  /hdmi|\bott\b|set.?top|\bstb\b|console|blu.?ray|\bdvd\b|\bpc\b|\bav ?\d?\b|component|composite|antenna|live ?tv|home theat|sound ?bar|receiver|streaming (box|stick)|playstation|\bps ?[345]\b|xbox|nintendo|cable|satellite|\busb\b/i.test(name);
/** Things plugged into a TV, by how their input is usually named, and what using one is called. */
const SOURCES: { id: string; test: RegExp; name: string; icon: string }[] = [
  { id: "appletv", test: /apple ?(tv|ott|box)/i, name: "Watch Apple TV", icon: "tv" },
  { id: "playstation", test: /playstation|\bps ?[345]\b/i, name: "Play PlayStation", icon: "game" },
  { id: "xbox", test: /xbox/i, name: "Play Xbox", icon: "game" },
  { id: "nintendo", test: /nintendo|\bswitch\b/i, name: "Play Nintendo", icon: "game" },
  { id: "roku", test: /roku/i, name: "Watch Roku", icon: "tv" },
  { id: "firetv", test: /fire ?(tv|stick)/i, name: "Watch Fire TV", icon: "tv" },
  { id: "chromecast", test: /chromecast|google tv/i, name: "Watch Google TV", icon: "tv" },
  { id: "cable", test: /cable|satellite|set.?top|directv|xfinity|spectrum|\bdish\b/i, name: "Watch cable", icon: "tv" },
  { id: "console", test: /game|console/i, name: "Play games", icon: "game" },
  { id: "disc", test: /blu.?ray|\bdvd\b/i, name: "Watch a disc", icon: "tv" },
];
/** A box that plugs into a TV (it shows apps, not HDMI inputs), by what its maker calls it. */
const isBox = (p: Part) => /apple ?tv|roku|fire ?tv|chromecast|shield|playstation|xbox/i.test(`${p.d.model} ${p.d.makerName}`);

/**
 * "Watch Apple TV", "Play PlayStation", "TV off": one tap brings up the TV on the right input, with the box that feeds it.
 * The hub switches each thing on first and waits for it before asking for the input.
 */
function watching(parts: Part[]): { id: string; name: string; icon: string; steps: ControlRequest[] }[] {
  const screens = parts.filter((p) => isScreen(p.c));
  if (!screens.length) return [];
  const boxes = screens.filter(isBox), tvs = screens.filter((p) => !isBox(p));
  const out: { id: string; name: string; icon: string; steps: ControlRequest[] }[] = [];
  const input = (p: Part, name: string): ControlRequest => ({ id: p.c.id, action: "play", item: { kind: "input", id: name, title: name } });
  for (const src of SOURCES) {
    if (out.length >= 3) break;
    const box = boxes.find((b) => src.test.test(`${b.d.model} ${b.d.makerName} ${b.d.name}`));
    // The socket the box is plugged into comes before an app of the same name on the TV. With the box in the room, the app is never what was meant.
    const pick = (p: Part) => { const m = (p.c as Extract<Control, { kind: "media" }>).inputs.filter((i) => src.test.test(i)); return m.find(isPlugged) ?? (box ? undefined : m[0]); };
    const tv = tvs.map((p) => ({ p, name: pick(p) })).find((x) => x.name);
    const steps: ControlRequest[] = [...(tv ? [input(tv.p, tv.name!)] : []), ...(box ? [{ id: box.c.id, action: "on" } as ControlRequest] : [])];
    if (steps.length) out.push({ id: `watch-${src.id}`, name: src.name, icon: src.icon, steps });
  }
  if (out.length) out.push({ id: "tvoff", name: "TV off", icon: "off", steps: screens.map(off) });
  return out;
}

interface Template { id: string; name: string; icon: string; make: Recipe }
const T = (id: string, name: string, icon: string, make: Recipe): Template => ({ id, name, icon, make });
const BRIGHT = T("bright", "Bright", "sun", bright), ALL_OFF = T("off", "All off", "off", allOff), MOVIE = T("movie", "Movie night", "film", movie);

const TEMPLATES: Record<RoomKind, Template[]> = {
  living: [MOVIE, T("evening", "Evening", "moon", level(40)), BRIGHT],
  media: [MOVIE, T("intermission", "Intermission", "moon", level(30)), T("up", "Lights up", "sun", bright)],
  bedroom: [T("wind", "Wind down", "moon", level(20, CANDLE)), T("morning", "Good morning", "sunrise", morning), T("sleep", "Sleep", "bed", sleep)],
  child: [T("bedtime", "Bedtime", "moon", level(15, CANDLE)), T("nightlight", "Night light", "bed", night), T("morning", "Good morning", "sunrise", morning)],
  kitchen: [T("cooking", "Cooking", "pot", bright), T("snack", "Late snack", "moon", level(15)), ALL_OFF],
  dining: [T("dinner", "Dinner", "fork", level(40)), BRIGHT, ALL_OFF],
  office: [T("focus", "Focus", "desk", brightAt(DAY)), T("call", "Video call", "sun", level(75, CLEAR)), T("done", "Done for the day", "off", allOff)],
  bathroom: [BRIGHT, T("night", "Night", "moon", night), T("relax", "Relax", "drop", level(30))],
  entry: [T("welcome", "Welcome", "door", allAt(80, WARM)), T("path", "Night path", "moon", level(10)), ALL_OFF],
  outside: [T("evening", "Evening outside", "leaf", allAt(60, WARM)), T("party", "Party", "star", bright), ALL_OFF],
  utility: [T("working", "Working", "sun", brightAt(DAY)), ALL_OFF],
  play: [T("workout", "Workout", "sun", brightAt(DAY)), T("game", "Game night", "star", level(50)), ALL_OFF],
  other: [BRIGHT, T("dim", "Dim", "moon", level(30)), ALL_OFF],
};

const same = (a: ControlRequest[], b: ControlRequest[]) => {
  const key = (s: ControlRequest[]) => s.map((x) => `${x.id}:${x.action}:${x.value ?? ""}:${x.rgb ?? ""}:${x.kelvin ?? ""}:${x.item?.id ?? ""}`).sort().join("|");
  return key(a) === key(b);
};

/** Everything off, for the whole home as it is now: every light (and lamp on a plug) off, every speaker and television paused. */
export function everythingOff(devices: Device[]): ControlRequest[] {
  const parts = partsOf(devices, WHOLE_HOME);
  return [...parts.filter(isLight).map(off), ...parts.filter((p) => p.c.kind === "media").map(hush)];
}

/**
 * The scenes worth offering for one room (or WHOLE_HOME), given what is in it.
 * Never one the household already has, said no to, or that would do the same as another.
 */
export function sceneIdeas(room: string, rooms: Room[], devices: Device[], scenes: Scene[], refused: string[], most = room === WHOLE_HOME ? 4 : 3): SceneIdea[] {
  const here = scenes.filter((s) => s.room === room);
  const out: SceneIdea[] = [];
  const offer = (id: string, name: string, icon: string, steps: ControlRequest[]) => {
    const key = `${room}:${id}`;
    if (!steps.length || out.length >= most || refused.includes(key)) return;
    if (here.some((s) => s.name.toLowerCase() === name.toLowerCase() || same(s.steps, steps)) || out.some((o) => same(o.steps, steps))) return;
    out.push({ key, name, room, icon, steps });
  };
  const has = (parts: Part[]): Has => ({ lights: parts.filter(isLight), dim: parts.filter(dims), covers: parts.filter((p) => p.c.kind === "cover"), locks: parts.filter((p) => p.c.kind === "lock"), music: speakers(parts) });

  if (room !== WHOLE_HOME) {
    const r = rooms.find((x) => x.id === room);
    if (!r) return [];
    const parts = partsOf(devices, room);
    // A room with a TV: what to watch comes first, and does not use up the room's other ideas.
    const watch = watching(parts), others = most;
    most += watch.length;
    for (const w of watch) offer(w.id, w.name, w.icon, w.steps);
    most = others + out.length;
    const h = has(parts);
    for (const t of TEMPLATES[roomKind(r)]) offer(t.id, t.name, t.icon, t.make(h));
    return out;
  }

  const all = has(partsOf(devices, WHOLE_HOME));
  const inKinds = (...kinds: RoomKind[]) => has(rooms.filter((r) => kinds.includes(roomKind(r))).flatMap((r) => partsOf(devices, r.id)));
  // A whole-home scene is only worth a button when it saves several taps.
  if (all.lights.length >= 2 || all.locks.length)
    offer("goodnight", "Good night", "bed", [...sleep(all), ...all.locks.map((p): ControlRequest => ({ id: p.c.id, action: "lock" }))]);
  if (all.lights.length >= 2) {
    // The home comes with Everything off; "All off" is only offered where that was removed.
    if (!scenes.some((s) => s.room === WHOLE_HOME && (s.auto === "off" || /^(everything|all) off$/i.test(s.name.trim())))) offer("alloff", "All off", "off", allOff(all));
    offer("allon", "All on", "sun", bright(all));
  }
  const lived = inKinds("living", "kitchen");
  if (lived.lights.length || all.covers.length)
    offer("goodmorning", "Good morning", "sunrise", [...lived.lights.map((p) => on(p, 70, MORNING)), ...all.covers.map((p): ControlRequest => ({ id: p.c.id, action: "open" }))]);
  const arriving = inKinds("entry", "living", "kitchen");
  if (arriving.lights.length >= 2) offer("welcome", "Welcome home", "door", arriving.lights.map((p) => on(p, 80, WARM)));
  return out;
}

// Reading a scene

const find = (devices: Device[], id: string): Part | undefined => {
  for (const d of devices) for (const c of d.controls) if (c.id === id) return { c, d };
  return undefined;
};
/** What to call one control in a sentence: its own name, or its device's when the device is just the one thing. */
export const partName = (p: { c: Control; d: Device }) => (p.d.controls.length === 1 ? p.d.name : p.c.name);

/** One step in plain words: "Reading lamp at 20%". Empty when the control is gone. */
export function stepWords(step: ControlRequest, devices: Device[]): string {
  const p = find(devices, step.id);
  if (!p) return "";
  const name = partName(p);
  switch (step.action) {
    case "off": return `${name} off`;
    case "on": return `${name} on`;
    case "brightness": { const tint = tintName(step); return `${name} at ${step.value}%${tint ? `, ${tint.toLowerCase()}` : ""}`; }
    case "pause": return `${name}: music stops`;
    case "play": if (step.item?.kind === "input" && p.c.kind === "media" && p.c.library === "none") return isPlugged(step.item.title) ? `${name} switches to ${step.item.title}` : `${name} opens its ${step.item.title} app`;
      return step.item ? `${name} plays ${step.item.title}${step.value !== undefined ? ` at ${step.value}%` : ""}` : `${name} plays`;
    case "open": return `${name} open`;
    case "close": return `${name} closed`;
    case "target": return `${name} to ${step.value}°`;
    case "lock": return `${name} locked`;
    default: return "";
  }
}

/** What a scene does, as a few short lines. A long scene is counted up instead of listed. */
export function sceneWords(steps: ControlRequest[], devices: Device[]): string[] {
  const known = steps.filter((s) => find(devices, s.id));
  if (known.length <= 6) return known.map((s) => stepWords(s, devices));
  const n = (test: (s: ControlRequest, p: Part) => boolean) => known.filter((s) => test(s, find(devices, s.id)!)).length;
  const say = (count: number, one: string, many: string, what: string) => (count ? `${count} ${count === 1 ? one : many} ${what}` : "");
  const lit = (s: ControlRequest, p: Part) => p.c.kind === "light" || p.c.kind === "switch";
  return [
    say(n((s, p) => lit(s, p) && s.action === "off"), "light", "lights", "off"),
    say(n((s, p) => lit(s, p) && s.action !== "off"), "light", "lights", "on"),
    say(n((s) => s.action === "close"), "shade", "shades", "closed"),
    say(n((s) => s.action === "open"), "shade", "shades", "open"),
    say(n((s) => s.action === "lock"), "door", "doors", "locked"),
    say(n((s) => s.action === "pause"), "speaker", "speakers", "stopped"),
    ...known.filter((s) => s.action === "play").map((s) => stepWords(s, devices)),
  ].filter(Boolean);
}

/** Is this control already the way the step would leave it? */
export function stepHolds(step: ControlRequest, c: Control): boolean {
  switch (c.kind) {
    case "light": return step.action === "off" ? !c.on : step.action === "on" ? c.on : step.action === "brightness" ? c.on && Math.abs(c.brightness - (step.value ?? 0)) <= 3 && tintHolds(step, c) : false;
    case "media":
      if (step.action === "on") return c.state !== "off";
      if (step.action === "off") return c.state === "off";
      if (step.action === "play" && step.item?.kind === "input" && c.library === "none") return c.state !== "off" && (c.source === step.item.id || c.app === step.item.id);
      return step.action === "pause" ? c.state !== "playing" : step.action === "play" ? c.state === "playing" : false;
    case "switch": return step.action === "off" ? !c.on : step.action === "on" ? c.on : false;
    case "cover": return step.action === "open" ? c.open : step.action === "close" ? !c.open : false;
    case "lock": return step.action === "lock" && c.locked;
    case "climate": return step.action === "target" && c.target === step.value;
    default: return false;
  }
}

/** True while the room is exactly how the scene sets it (things that are not answering are left out of the count). */
export function sceneHolds(scene: Pick<Scene, "steps">, devices: Device[]): boolean {
  let seen = 0;
  for (const s of scene.steps) {
    const p = find(devices, s.id);
    if (!p || !p.c.available) continue;
    if (!stepHolds(s, p.c)) return false;
    seen++;
  }
  return seen > 0;
}

/** Can a scene set this control at all? Thermostats and cameras are not for scenes (yet). */
export const sceneCan = (c: Control) => c.kind === "light" || c.kind === "switch" || c.kind === "cover" || c.kind === "lock" || c.kind === "media";

/** What a scene may ask of each kind of thing. No "unlock": a scene never opens a door. */
const FITS: Record<string, string[]> = { light: ["on", "off", "brightness"], switch: ["on", "off"], cover: ["open", "close"], lock: ["lock"], media: ["play", "pause", "on", "off"] };
export const stepFits = (step: ControlRequest, c: Control) => (FITS[c.kind] ?? []).includes(step.action);

/** The step that would put this control back the way it is right now. Never an unlock: a scene must not open a door. */
export function stepNow(c: Control): ControlRequest | undefined {
  switch (c.kind) {
    case "light": return c.on ? (c.dimmable ? { id: c.id, action: "brightness", value: Math.max(1, Math.round(c.brightness)), ...(c.kelvin ? { kelvin: c.kelvin } : c.rgb !== undefined ? { rgb: c.rgb } : {}) } : { id: c.id, action: "on" }) : { id: c.id, action: "off" };
    // Enough to put a speaker back: playing again, or quiet. What it was playing cannot be asked for again.
    case "media":
      // A TV is put back to off, or on at the input it was showing.
      if (isScreen(c)) return c.state === "off" ? { id: c.id, action: "off" } : c.source && c.inputs.includes(c.source) ? { id: c.id, action: "play", item: { kind: "input", id: c.source, title: c.source } } : { id: c.id, action: "on" };
      return { id: c.id, action: c.state === "playing" ? "play" : "pause" };
    case "switch": return { id: c.id, action: c.on ? "on" : "off" };
    case "cover": return { id: c.id, action: c.open ? "open" : "close" };
    case "climate": return c.target === undefined ? undefined : { id: c.id, action: "target", value: c.target };
    case "lock": return c.locked ? { id: c.id, action: "lock" } : undefined;
    default: return undefined;
  }
}

/** Everything in the room a scene could set, in the order the room shows it. */
export function sceneParts(devices: Device[], room: string): { c: Control; d: Device }[] {
  return partsOf(devices, room).filter((p) => sceneCan(p.c));
}

/**
 * "How the room is now", as a scene. Lights and shades are taken; locks and plugs that are
 * not lamps are left for the household to switch in, so saving a look never quietly
 * switches off the fridge.
 */
export function roomNow(devices: Device[], room: string): ControlRequest[] {
  return partsOf(devices, room).filter((p) => p.c.available && (isLight(p) || p.c.kind === "cover")).map((p) => stepNow(p.c)).filter((s): s is ControlRequest => !!s);
}

/** The drawings a scene's button can wear. */
export const SCENE_ICONS: Record<string, string> = {
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.900 4.900l1.400 1.400M17.700 17.700l1.400 1.400M2 12h2M20 12h2M4.900 19.100l1.400-1.400M17.700 6.300l1.400-1.400",
  moon: "M20 14.500A8 8 0 0 1 9.500 4a8 8 0 1 0 10.500 10.500z",
  film: "M4 5h16v14H4zM8 5v14M16 5v14M4 9.500h4M4 14.500h4M16 9.500h4M16 14.500h4",
  bed: "M3 18v-7a2 2 0 0 1 2-2h9a4 4 0 0 1 4 4v5M3 14h18M21 18v-4M3 9V6",
  sunrise: "M12 3v5M5.600 9.600l1.400 1.400M18.400 9.600l-1.400 1.400M3 17h18M7 17a5 5 0 0 1 10 0M8 21h8",
  pot: "M5 10h14v6a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3zM3 10h18M9 6c0-1 1-1 1-2M14 6c0-1 1-1 1-2",
  fork: "M7 3v7a2 2 0 0 0 4 0V3M9 12v9M17 3c-2 2-2 6 0 8v10",
  desk: "M3 8h18M5 8v11M19 8v11M5 13h6v6M12 4h6v4h-6z",
  off: "M12 3v9M6.300 6.300a8 8 0 1 0 11.400 0",
  door: "M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M4 21h16M14.500 12v1",
  leaf: "M5 19c0-8 5-13 14-14 0 9-5 14-13 14zM5 19l7-7",
  star: "M12 3l2.700 5.600 6.100.800-4.500 4.300 1.100 6.100L12 16.900 6.600 19.800l1.100-6.100L3.200 9.400l6.100-.800z",
  drop: "M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z",
  tv: "M3 5h18v12H3zM8 21h8M12 17v4",
  game: "M7 8h10a5 5 0 0 1 4.900 4l.900 4.500a2 2 0 0 1-3.500 1.600L17.500 16h-11l-1.800 2.100a2 2 0 0 1-3.500-1.600L2.100 12A5 5 0 0 1 7 8zM7.500 10.500v3M6 12h3M15.500 11h.010M17.500 13h.010",
  play: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM10 8.500v7l6-3.500z",
  trophy: "M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.500 20h7M10 17h4",
  music: "M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  spark: "M12 3v6M12 15v6M3 12h6M15 12h6M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3",
};

// Colours and whites a light can be given. A short, named set: easier to choose from than a colour wheel, and a scene can say its name.

export const LIGHT_WHITES: { name: string; kelvin: number }[] = [
  { name: "Candle", kelvin: 2200 }, { name: "Warm", kelvin: 2700 }, { name: "Soft", kelvin: 3200 }, { name: "Clear", kelvin: 4000 }, { name: "Daylight", kelvin: 5200 },
];
export const LIGHT_COLORS: { name: string; rgb: number }[] = [
  { name: "Red", rgb: 0xff2a1f }, { name: "Orange", rgb: 0xff7a1a }, { name: "Amber", rgb: 0xffb030 }, { name: "Yellow", rgb: 0xffe033 }, { name: "Green", rgb: 0x35d04a },
  { name: "Teal", rgb: 0x1fd6c0 }, { name: "Blue", rgb: 0x2a6bff }, { name: "Purple", rgb: 0x8a3dff }, { name: "Pink", rgb: 0xff4fb0 },
];
const far = (a: number, b: number) => Math.abs((a >> 16) - (b >> 16)) + Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) + Math.abs((a & 255) - (b & 255));
/** The nearest named colour or white to what is asked for (or shown). "" when there is none. */
export function tintName(t: { rgb?: number; kelvin?: number }): string {
  if (t.kelvin) return LIGHT_WHITES.reduce((best, w) => (Math.abs(w.kelvin - t.kelvin!) < Math.abs(best.kelvin - t.kelvin!) ? w : best)).name;
  if (t.rgb !== undefined) return LIGHT_COLORS.reduce((best, c) => (far(c.rgb, t.rgb!) < far(best.rgb, t.rgb!) ? c : best)).name;
  return "";
}
/** A white as a colour for the screen, warm to cool. */
export function whiteRgb(kelvin: number): string {
  const t = Math.min(1, Math.max(0, (kelvin - 2000) / 4000));
  return `rgb(255, ${Math.round(170 + 80 * t)}, ${Math.round(90 + 165 * t)})`;
}
export const rgbCss = (rgb: number) => `#${rgb.toString(16).padStart(6, "0")}`;
/** Does the light show the colour or white a step asks for? Lights report back slightly different numbers than they were given. */
function tintHolds(step: ControlRequest, c: Extract<Control, { kind: "light" }>): boolean {
  if (step.kelvin) return c.kelvin !== undefined && Math.abs(c.kelvin - step.kelvin) <= 200;
  if (step.rgb !== undefined) return c.rgb !== undefined && far(c.rgb, step.rgb) <= 90;
  return true;
}

// Schedules. Worked out here so the hub, the app and the demo home all agree on when a scene is due.

const DAY_MS = 86_400_000;
/** The home's own clock at a moment: day of the week, minutes since midnight, and the date as a sortable word. */
function local(at: number, zone: string): { day: number; minutes: number; key: string } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone || undefined, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")), minutes: Number(get("hour")) * 60 + Number(get("minute")), key: `${get("year")}-${get("month")}-${get("day")}` };
}

/** The moment a schedule falls on the home's day that holds `at`. Undefined when the sun's times are not known. */
function dueOn(when: SceneWhen, at: number, zone: string, sun?: SunTimes): number | undefined {
  const here = local(at, zone);
  if (when.at === "time") {
    const [h, m] = when.time.split(":").map(Number);
    if (!(h >= 0 && h < 24 && m >= 0 && m < 60)) return undefined;
    return Math.floor(at / 60_000) * 60_000 - (here.minutes - (h * 60 + m)) * 60_000;
  }
  let t = Date.parse((when.at === "sunrise" ? sun?.rise : sun?.set) ?? "");
  if (isNaN(t)) return undefined;
  // The hub knows the NEXT sunrise and sunset; the same event on another day is within a minute or two of it.
  for (let i = 0; i < 400 && local(t, zone).key > here.key; i++) t -= DAY_MS;
  for (let i = 0; i < 400 && local(t, zone).key < here.key; i++) t += DAY_MS;
  return t + when.offset * 60_000;
}

/** Is this schedule due right now? True for five minutes from its moment, so a hub that was busy still catches it. */
export function whenDue(when: SceneWhen | undefined, now: number, zone: string, sun?: SunTimes): boolean {
  if (!when?.on || !when.days.includes(local(now, zone).day)) return false;
  const due = dueOn(when, now, zone, sun);
  return due !== undefined && now >= due && now - due < 5 * 60_000;
}
/** The home's date at a moment ("2026-11-22"): a scheduled scene runs once per such day. */
export const dayKey = (at: number, zone: string) => local(at, zone).key;

/** The next time it will run, for showing. Undefined when it is off, has no days, or the sun is not known. */
export function whenNext(when: SceneWhen | undefined, now: number, zone: string, sun?: SunTimes): number | undefined {
  if (!when?.on) return undefined;
  for (let d = 0; d <= 7; d++) {
    const due = dueOn(when, now + d * DAY_MS, zone, sun);
    if (due !== undefined && due > now && when.days.includes(local(due, zone).day)) return due;
  }
  return undefined;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** A schedule in plain words: "Every day at 10:30 PM", "Weekdays, 30 min before sunset". */
export function whenWords(when: SceneWhen): string {
  const d = [...new Set(when.days)].sort();
  const days = d.length === 7 ? "Every day" : d.join() === "1,2,3,4,5" ? "Weekdays" : d.join() === "0,6" ? "Weekends" : d.map((n) => DAY_NAMES[n]).join(", ");
  if (when.at === "time") {
    const [h, m] = when.time.split(":").map(Number);
    return `${days} at ${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  }
  const o = Math.abs(when.offset);
  return `${days}${o ? `, ${o} min ${when.offset < 0 ? "before" : "after"}` : " at"} ${when.at}`;
}
