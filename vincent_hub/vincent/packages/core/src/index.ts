/**
 * The objects the Vincent app and the hub service speak.
 *
 * The app never sees a Home Assistant entity id. Ids here are opaque strings the
 * hub hands out; what they map to inside Home Assistant stays on the hub.
 */

export type Category = "lights" | "media" | "security" | "climate" | "other";

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: "lights", label: "Lights" },
  { id: "media", label: "Music & TV" },
  { id: "security", label: "Security" },
  { id: "climate", label: "Climate" },
  { id: "other", label: "Everything else" },
];

/**
 * Vincent's own list, kept on top of whatever Home Assistant holds:
 *  found   — the hub knows about it; the household has not chosen it
 *  added   — shown and controlled in the app (and by voice)
 *  ignored — hidden from "Add a device" until restored
 */
export type ListStatus = "found" | "added" | "ignored";

/**
 * What stands between a found device and control:
 *  ready   — nothing; adding it is instant
 *  confirm — Home Assistant found it and waits for a yes (no account needed)
 *  login   — the maker requires an account or a pairing code
 */
export type Needs = "ready" | "confirm" | "login";

export interface Device {
  id: string;
  /** What the household calls it. Their own name when they gave one, else the maker's. */
  name: string;
  /** What the device calls itself. Never changed by Vincent. */
  makerName: string;
  maker: string;
  model: string;
  category: Category;
  status: ListStatus;
  needs: Needs;
  /** The rooms it is in (room ids). A device can be in several: a speaker that covers the kitchen and the dining room. */
  rooms: string[];
  /** A room name the hub can guess (the device told it, e.g. a Sonos named "Office"). Offered when adding. */
  suggestedRoom?: string;
  /** The controls this device offers. Empty until it is ready. */
  controls: Control[];
}

interface ControlBase {
  id: string;
  name: string;
  /** False when the device is offline or unpowered. */
  available: boolean;
  /** When it last changed (ISO time), so the home screen can lead with what just happened. */
  changed?: string;
}

export type Control =
  | (ControlBase & {
      kind: "light"; on: boolean; dimmable: boolean; brightness: number;
      /** True when it can show colours. */
      colors?: boolean;
      /** The whites it can show, warmest to coolest, in kelvin. Absent when it has one white only. */
      whites?: [number, number];
      /** What it shows now: a colour (0xRRGGBB) or a white (kelvin). Neither when off or not known. */
      rgb?: number; kelvin?: number;
    })
  | (ControlBase & { kind: "switch"; on: boolean })
  | (ControlBase & {
      kind: "media"; state: "playing" | "paused" | "idle" | "off"; title?: string; artist?: string; album?: string; volume?: number;
      /** Address of the cover art on the hub; changes when the art does. */
      art?: string;
      /** The input in use ("TV", "Line-in") and the ones it can switch to. */
      source?: string; inputs: string[];
      /** The players playing together with this one, itself included, the leader first (control ids). One entry = playing alone. */
      group: string[];
      /** True when it can play together with other speakers of its kind. */
      groups: boolean;
      /** "sonos" = the hub can list this speaker's favourites and playlists. */
      library: "sonos" | "none";
    })
  | (ControlBase & {
      kind: "climate"; current?: number;
      /** The temperature it is set to, in heat or cool. In "both" it keeps the room between `low` and `high` instead. */
      target?: number; low?: number; high?: number;
      /** What it is set to do: heat · cool · both (heat and cool) · auto · fan · dry · off. */
      mode: string;
      /** The modes this thermostat has. */
      modes?: string[];
      /** What it is doing this minute: heating · cooling · fan · idle. */
      doing?: string;
    })
  | (ControlBase & { kind: "lock"; locked: boolean })
  | (ControlBase & { kind: "cover"; open: boolean })
  | (ControlBase & {
      kind: "camera";
      /** Address of its newest picture on the hub ("" = none to show). */
      still: string;
      /** True when it can be watched live. */
      live: boolean;
      /** The last time it saw motion or its button was pressed. */
      event?: { at: string; kind: "motion" | "ding" };
    });

export type Action =
  | "on" | "off" | "brightness" | "color" | "white"
  | "play" | "pause" | "volume" | "next" | "previous"
  | "target" | "low" | "high" | "mode"
  | "lock" | "unlock"
  | "open" | "close";

/** A thermostat's modes in plain words, in the order they are offered. */
export const CLIMATE_MODES: { id: string; name: string }[] = [
  { id: "heat", name: "Heat" }, { id: "cool", name: "Cool" }, { id: "both", name: "Heat and cool" }, { id: "auto", name: "Auto" },
  { id: "fan", name: "Fan" }, { id: "dry", name: "Dry" }, { id: "off", name: "Off" },
];

export interface ControlRequest {
  id: string; action: Action; value?: number;
  /** For a thermostat's "mode": the mode to switch to. */
  mode?: string;
  /** For a light: the colour (0xRRGGBB) or the white (kelvin) to show. With "color" / "white", or along with "brightness". */
  rgb?: number; kelvin?: number;
  /** For a speaker in a scene: what "play" starts. `value` is then the volume. */
  item?: { kind: string; id: string; title: string };
}

/** Something a speaker can be asked to play. */
export interface MediaItem {
  kind: "favourite" | "playlist" | "radio" | "input" | "sxm" | "spotify";
  id: string;
  title: string;
  subtitle?: string;
  art?: string;
  /** True when it holds more things (an album, a playlist, an artist) and can be opened. */
  opens?: boolean;
  /** False when it can only be opened, not played as a whole. */
  plays?: boolean;
}

export interface MediaGroup { label: string; items: MediaItem[] }

/** A streaming service the household signs in to once, so Vincent can show its catalogue. */
export interface ServiceStatus {
  linked: boolean;
  /** The account's name, once linked. */
  account: string;
  /** The service's sign-in page, while a sign-in is under way. */
  signIn?: string;
}

/** What a speaker offers. Favourites come grouped by the service they belong to ("Spotify", "SiriusXM"). */
export interface MediaSources {
  favourites: { service: string; items: MediaItem[] }[];
  playlists: MediaItem[];
  inputs: MediaItem[];
  /** False when internet radio is not available on this hub. */
  radio: boolean;
  /** True when the household has SiriusXM (a saved SiriusXM station): the whole channel guide can be played. */
  siriusxm: boolean;
  /** True when this player can play Spotify through the household's Sonos. */
  spotify: boolean;
}

/** The weather at the home. `condition` is a plain word: sunny, cloudy, partlycloudy, rainy, snowy, fog, clear-night… */
export interface Weather {
  place: string;
  condition: string;
  temperature: number;
  unit: string;
  high?: number;
  low?: number;
  days: { date: string; condition: string; high: number; low?: number }[];
}

export interface ListSummary { id: string; name: string; /** How many things are still to do. */ open: number }
export interface ListItem { id: string; text: string; done: boolean }

/** Where the home is. Empty until a ZIP code is given. */
export interface HomePlace { zip: string; place: string; timeZone: string; contact: string }

/** The hub's own software. */
export interface Software { version: string; latest: string; canUpdate: boolean }

export interface Room {
  id: string;
  name: string;
  /** What kind of room it is, when the household said. Otherwise guessed from the name (see roomKind). */
  kind?: import("./scenes.ts").RoomKind;
  /** Address of the room's photo on the hub (changes when the photo does), if one was taken. */
  photo?: string;
}

/** The pre-made looks. The hub remembers the home's choice so every phone and tablet matches. */
export const THEMES = [
  { id: "ivory", name: "Ivory" },
  { id: "midnight", name: "Midnight" },
  { id: "slate", name: "Slate" },
  { id: "forest", name: "Forest" },
  { id: "terracotta", name: "Terracotta" },
  { id: "onyx", name: "Onyx" },
] as const;

export interface HubStatus {
  connected: boolean;
  /** Home Assistant's version on the hub. */
  version: string;
  homeName: string;
  /** True once the household has been through the device review once. */
  reviewed: boolean;
  /** True once an owner and an admin PIN exist. */
  setUp: boolean;
  owner: string;
}

/** What the app hands the hub service at the end of first-time setup. */
export interface SetupRequest {
  owner: string;
  pin: string;
  /** The hub's own Home Assistant login, kept on the hub so the household can reach it later. */
  ha?: { username: string; password: string };
}

/** A brand the household can add by name, for devices the hub cannot find by listening. */
export interface Brand {
  id: string;
  name: string;
  category: Category;
  /** search = the hub goes looking · steps = the maker asks for something · matter = added by Matter code · link = needs the maker's website (not yet) · none = the maker gives no way in */
  how: "search" | "steps" | "matter" | "link" | "none";
  /** What to check first. Shown before starting, and again if nothing is found. */
  tips: string;
  /** "matter" when a Matter code is another way to add this brand. */
  also?: string;
  /** Where to find this maker's Matter code, one short step per line. */
  guide?: string[];
  /** Which of the maker's devices this works for, in a sentence. */
  works?: string;
}

/** One question from a maker while a device is being added. */
export interface StepField {
  name: string;
  label: string;
  help?: string;
  /** code = a short number shown on the device or sent to the owner */
  type: "text" | "password" | "number" | "code" | "toggle" | "choice";
  required: boolean;
  value?: string | number | boolean;
  options?: { value: string; label: string }[];
}

/**
 * Where adding a device stands:
 *  form    — the maker asks something; answer `fields`
 *  wait    — the maker is waiting on the device (a button press, a search); ask again shortly
 *  done    — added
 *  stopped — not added; `text` says why
 */
export interface Step {
  /** link = the maker's own website has to be visited (`url`); the hub notices when that is finished. */
  kind: "form" | "wait" | "done" | "stopped" | "link";
  /** With `wait`: what is going on, in a word ("Installing…"). */
  doing?: string;
  /** With `link`: the page to open. */
  url?: string;
  /** Names the setup under way, for the next answer. Absent once it has ended. */
  flow?: string;
  title: string;
  text: string;
  fields: StepField[];
  errors?: Record<string, string>;
  message?: string;
  /** With `done`: the devices the maker brought (device ids), waiting to be given rooms. */
  brought?: string[];
  /** With `done`: the maker's name ("Ring"). */
  maker?: string;
}

/** One line of "where does each of these live": add it or leave it out, and its rooms. */
export interface Placement { id: string; add: boolean; rooms: string[]; newRooms?: string[] }

export interface AddResult {
  ok: boolean;
  /** Set when the maker asks for more before the device can be added: the first question. */
  step?: Step;
  /** Set when the device could not be added in one step. */
  needs?: Needs;
  message?: string;
}


/** A style changes shapes and lettering (fonts, corners, borders); a colour palette changes only colours. Any style goes with any palette. */
export const STYLES = [
  { id: "traditional", name: "Traditional", note: "Serif headings, soft corners" },
  { id: "modern", name: "Modern", note: "Clean sans, crisp corners" },
  { id: "contemporary", name: "Contemporary", note: "Rounded, no outlines" },
  { id: "classy", name: "Classy", note: "Fine lettering, gold hairlines" },
  { id: "trailer", name: "Trailer Park", note: "Loud, chunky, a good time" },
] as const;

/** The voices every character can take: three men and two women per accent, named for their manner; `id` is the voice maker's own name. */
export const VOICES = [
  { id: "Enceladus", sex: "Male", name: "Hushed and unhurried", note: "Never once raised his voice" },
  { id: "Charon", sex: "Male", name: "Calm and knowing", note: "Has an answer, and the patience to give it" },
  { id: "Fenrir", sex: "Male", name: "Eager and exuberant", note: "Delighted you asked" },
  { id: "Leda", sex: "Female", name: "Fresh and light", note: "Quick with a smile" },
  { id: "Sulafat", sex: "Female", name: "Warm and reassuring", note: "The host everyone remembers" },
] as const;
/** Roxy is a woman, so all five of hers are women's voices. */
const LADIES = [
  ...VOICES.filter((v) => v.sex === "Female"),
  { id: "Kore", sex: "Female", name: "Firm, but fair", note: "Consider it handled" },
  { id: "Aoede", sex: "Female", name: "Breezy and relaxed", note: "Nothing is ever a problem" },
  { id: "Zephyr", sex: "Female", name: "Bright and sparkling", note: "A morning person, all day" },
] as const;
/** Julian is a man: his own voice first, then four more men's. */
const GENTS = [
  { id: "Sadachbia", sex: "Male", name: "Lively and quick", note: "Has a line for everything" },
  { id: "Algieba", sex: "Male", name: "Smooth and easy", note: "Never in a hurry" },
  ...VOICES.filter((v) => v.sex === "Male"),
] as const;
/** Sora's own voice first, then four more women's. */
const SCHOLARS = [
  { id: "Achernar", sex: "Female", name: "Soft and clear", note: "Says it once, and says it right" },
  ...VOICES.filter((v) => v.sex === "Female"),
  { id: "Aoede", sex: "Female", name: "Breezy and relaxed", note: "Nothing is ever a problem" },
  { id: "Zephyr", sex: "Female", name: "Bright and sparkling", note: "A morning person, all day" },
] as const;
/** `voice` is what the character sounds like until the home chooses otherwise. */
export const CHARACTERS = [
  { id: "vincent", name: "Vincent", note: "The butler. Dry, courteous, unflappable.", locale: "en-GB", voice: "Enceladus", voices: VOICES },
  { id: "roxy", name: "Roxy", note: "The house manager. Warm, polished, quick.", locale: "en-US", voice: "Leda", voices: LADIES },
  { id: "otto", name: "Otto", note: "The all-seeing machine. Knows everything, and will remind you.", locale: "en-US", voice: "Charon", voices: VOICES },
  { id: "ernest", name: "Ernest", note: "The nervous one in the box. Scared of his own shadow, bless him.", locale: "en-US", voice: "Fenrir", voices: VOICES },
  { id: "julian", name: "Julian", note: "The well-read one. Witty, friendly, and has read the manual. All of them.", locale: "en-US", voice: "Sadachbia", voices: GENTS },
  { id: "sora", name: "Sora", note: "The mathematician in the library. Brilliant, cheerful, always has the answer.", locale: "en-US", voice: "Achernar", voices: SCHOLARS },
] as const;

export const VOICE_LANGUAGES = [
  { id: "en", name: "English", accents: [{ id: "en-GB", name: "British" }, { id: "en-US", name: "American" }, { id: "en-AU", name: "Australian" }, { id: "en-IN", name: "Indian" }] },
  { id: "es", name: "Español", accents: [{ id: "es-ES", name: "España" }, { id: "es-US", name: "Latinoamérica" }] },
  { id: "fr", name: "Français", accents: [{ id: "fr-FR", name: "France" }, { id: "fr-CA", name: "Canada" }] },
  { id: "de", name: "Deutsch", accents: [{ id: "de-DE", name: "Deutschland" }] },
  { id: "it", name: "Italiano", accents: [{ id: "it-IT", name: "Italia" }] },
] as const;

export interface VoiceChoice { locale: string; voice: string }
/** What a character sounds like when the home has not chosen. */
export function defaultVoice(character: string): VoiceChoice {
  const c = CHARACTERS.find((x) => x.id === character) ?? CHARACTERS[0];
  return { locale: c.locale, voice: c.voice };
}


/** Pictures of the characters in this home. `version` is 0 while the standard picture is in use. */
export interface PortraitJob { state: "idle" | "waiting" | "working" | "done" | "failed"; startedAt?: number; message?: string }
export interface PortraitStatus {
  /** False when this hub cannot make pictures (the service is not switched on). */
  available: boolean;
  photos: string[];
  /** About how long one picture takes, in seconds. */
  seconds: number;
  characters: Record<string, PortraitJob & { version: number; /** The outfit the home picture was drawn in. */ style?: string }>;
}


/** The household's own style: their home in the pictures, their choice of lettering and shapes. Offered once they have added a photo of their home. */
export const HOME_STYLE = { id: "home", name: "Custom Home", note: "Your photos, your choices" } as const;
export const FONTS = [
  { id: "serif", name: "Bookish" },
  { id: "clean", name: "Clean" },
  { id: "rounded", name: "Rounded" },
  { id: "fine", name: "Fine" },
  { id: "chunky", name: "Chunky" },
] as const;
/** `shape` is one of STYLES: its corners, borders and buttons, and the characters' clothes in the pictures. */
export interface CustomStyle {
  font: string; shape: string;
  /** In My Home each character can wear a different style's outfit: character id to style id. */
  outfits?: Record<string, string>;
}
/** The style whose outfit a character wears in My Home. */
export const outfitOf = (custom: CustomStyle | undefined, character: string): string => custom?.outfits?.[character] ?? custom?.shape ?? "traditional";
export const DEFAULT_CUSTOM: CustomStyle = { font: "serif", shape: "traditional" };

export * from "./scenes.ts";

/** What the owner can stop one phone or tablet from controlling. */
export const RULES = [
  { id: "lights", name: "Lights and plugs", kinds: ["light", "switch"] },
  { id: "media", name: "Music and TV", kinds: ["media"] },
  { id: "climate", name: "Thermostats", kinds: ["climate"] },
  { id: "locks", name: "Locks", kinds: ["lock"] },
  { id: "doors", name: "Garage doors and shades", kinds: ["cover"] },
  { id: "announce", name: "Announcements to other rooms", kinds: [] },
  { id: "call", name: "Video calls between rooms", kinds: [] },
  { id: "talk", name: "Talking to the host", kinds: [] },
] as const;
export type RuleId = (typeof RULES)[number]["id"];
export const ruleFor = (kind: string): RuleId | undefined => RULES.find((r) => (r.kinds as readonly string[]).includes(kind))?.id;
/** The kinds of line in the home's activity log, for filtering it. */
export const LOG_KINDS = [
  { id: "settings", name: "Settings" }, { id: "locks", name: "Locks" }, { id: "doors", name: "Doors" }, { id: "lights", name: "Lights" },
  { id: "climate", name: "Climate" }, { id: "media", name: "Music and TV" }, { id: "scenes", name: "Scenes" },
] as const;
export type LogKind = (typeof LOG_KINDS)[number]["id"];
/** One thing done to one control, in the log's words. "" = not worth a line (a slider nudged, a colour changed). */
export function controlWords(name: string, kind: string, action: string, value?: number, mode?: string): string {
  switch (action) {
    case "on": return `Turned on ${name}`;
    case "off": return `Turned off ${name}`;
    case "lock": return `Locked ${name}`;
    case "unlock": return `Unlocked ${name}`;
    case "open": return `Opened ${name}`;
    case "close": return `Closed ${name}`;
    case "target": return `Set ${name} to ${value}°`;
    case "mode": return `Set ${name} to ${mode ?? "a new mode"}`;
    case "play": return kind === "media" ? `Started ${name} playing` : "";
    case "pause": return kind === "media" ? `Paused ${name}` : "";
    default: return "";
  }
}
export * from "./reminders.ts";
