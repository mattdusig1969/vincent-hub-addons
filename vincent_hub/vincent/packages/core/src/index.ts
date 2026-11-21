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
  /** Room name, when the hub knows one. */
  room?: string;
  /** The controls this device offers. Empty until it is ready. */
  controls: Control[];
}

interface ControlBase {
  id: string;
  name: string;
  /** False when the device is offline or unpowered. */
  available: boolean;
}

export type Control =
  | (ControlBase & { kind: "light"; on: boolean; dimmable: boolean; brightness: number })
  | (ControlBase & { kind: "switch"; on: boolean })
  | (ControlBase & { kind: "media"; state: "playing" | "paused" | "idle" | "off"; title?: string; artist?: string; volume?: number })
  | (ControlBase & { kind: "climate"; current?: number; target?: number; mode: string })
  | (ControlBase & { kind: "lock"; locked: boolean })
  | (ControlBase & { kind: "cover"; open: boolean })
  | (ControlBase & { kind: "camera" });

export type Action =
  | "on" | "off" | "brightness"
  | "play" | "pause" | "volume"
  | "target"
  | "lock" | "unlock"
  | "open" | "close";

export interface ControlRequest { id: string; action: Action; value?: number }

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
