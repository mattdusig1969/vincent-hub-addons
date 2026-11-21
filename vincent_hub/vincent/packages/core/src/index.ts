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
  name: string;
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
  | (ControlBase & { kind: "light"; on: boolean; dimmable: boolean; brightness: number })
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
  | (ControlBase & { kind: "climate"; current?: number; target?: number; mode: string })
  | (ControlBase & { kind: "lock"; locked: boolean })
  | (ControlBase & { kind: "cover"; open: boolean })
  | (ControlBase & { kind: "camera" });

export type Action =
  | "on" | "off" | "brightness"
  | "play" | "pause" | "volume" | "next" | "previous"
  | "target"
  | "lock" | "unlock"
  | "open" | "close";

export interface ControlRequest { id: string; action: Action; value?: number }

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
  kind: "form" | "wait" | "done" | "stopped";
  /** Names the setup under way, for the next answer. Absent once it has ended. */
  flow?: string;
  title: string;
  text: string;
  fields: StepField[];
  errors?: Record<string, string>;
  message?: string;
}

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
] as const;

/** The home's concierge. Each has five voices per accent, named for their manner; `id` is the voice maker's own name. */
export const CHARACTERS = [
  { id: "vincent", name: "Vincent", note: "The butler. Dry, courteous, unflappable.", locale: "en-GB", voices: [
    { id: "Enceladus", name: "Hushed and unhurried", note: "Never once raised his voice" },
    { id: "Charon", name: "Calm and knowing", note: "Has an answer, and the patience to give it" },
    { id: "Orus", name: "Firm, but friendly", note: "Runs a tight house, kindly" },
    { id: "Puck", name: "Bright and upbeat", note: "A spring in his step" },
    { id: "Fenrir", name: "Eager and exuberant", note: "Delighted you asked" },
  ] },
  { id: "roxy", name: "Roxy", note: "The house manager. Warm, polished, quick.", locale: "en-US", voices: [
    { id: "Leda", name: "Fresh and light", note: "Quick with a smile" },
    { id: "Sulafat", name: "Warm and reassuring", note: "The host everyone remembers" },
    { id: "Kore", name: "Firm, but fair", note: "Consider it handled" },
    { id: "Aoede", name: "Breezy and relaxed", note: "Nothing is ever a problem" },
    { id: "Zephyr", name: "Bright and sparkling", note: "A morning person, all day" },
  ] },
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
  return { locale: c.locale, voice: c.voices[0].id };
}
