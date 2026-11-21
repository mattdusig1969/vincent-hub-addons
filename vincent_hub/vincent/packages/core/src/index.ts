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

export interface AddResult {
  ok: boolean;
  /** Set when the device could not be added in one step. */
  needs?: Needs;
  message?: string;
}
