/**
 * Amazon Echo speakers.
 *
 * Home Assistant's own Alexa sign-in only takes a code from an authenticator app, which most households do not have.
 * The community's Alexa Media Player shows Amazon's real sign-in page instead (a texted code works) and gives each Echo
 * a player. It is not part of Home Assistant, so the hub fetches it once, the first time a household asks for Echo.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HA } from "./ha.ts";

/** The release the hub installs. Moved forward by hand, after trying it on the test hub. */
const VERSION = "v5.22.1";
const ZIP = `https://github.com/alandtse/alexa_media_player/releases/download/${VERSION}/alexa_media.zip`;
export const ECHO_DRIVER = "alexa_media";

type Sup = (method: string, path: string, data?: unknown, timeout?: number) => Promise<any>;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export class Echo {
  private ha: HA;
  private sup: Sup;
  /** Home Assistant's own settings folder, shared with this service ("/homeassistant" on a hub). */
  private dir: string;
  private work: Promise<void> | null = null;
  state: "idle" | "working" | "ready" | "failed" = "idle";
  message = "";

  constructor(ha: HA, sup: Sup, dir = process.env.VINCENT_HA_CONFIG ?? "/homeassistant") { this.ha = ha; this.sup = sup; this.dir = dir; }

  /** Whether Home Assistant can already start an Amazon sign-in. */
  async has(): Promise<boolean> {
    const r = await this.ha.restRaw("GET", "/config/config_entries/flow_handlers").catch(() => null);
    return Array.isArray(r?.body) && r!.body.includes(ECHO_DRIVER);
  }

  /** Fetches the Echo part and restarts Home Assistant to load it. Safe to call again while it runs. */
  prepare(): void {
    if (this.work) return;
    this.state = "working"; this.message = "";
    this.work = this.install().then(
      () => { this.state = "ready"; },
      (e: Error) => { this.state = "failed"; this.message = e.message; console.log(`[echo] could not be made ready: ${e.message}`); },
    ).finally(() => { this.work = null; });
  }

  private async install(): Promise<void> {
    if (await this.has()) return;
    if (!existsSync(this.dir)) throw new Error("This hub needs its latest update before Echo speakers can be added. Update it under Settings, Home, then try again.");
    const into = join(this.dir, "custom_components", ECHO_DRIVER);
    if (!existsSync(join(into, "manifest.json"))) {
      console.log(`[echo] fetching Alexa Media Player ${VERSION}`);
      const r = await fetch(ZIP, { signal: AbortSignal.timeout(90_000) }).catch(() => null);
      if (!r?.ok) throw new Error("The hub could not reach the internet to get what it needs for Echo speakers. Check its connection and try again.");
      const zip = join(this.dir, ".vincent-echo.zip");
      writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
      rmSync(into, { recursive: true, force: true });
      mkdirSync(into, { recursive: true });
      try {
        await new Promise<void>((ok, fail) => execFile("unzip", ["-o", "-q", zip, "-d", into], (e) => (e ? fail(e) : ok())));
      } catch (e) { rmSync(into, { recursive: true, force: true }); throw new Error(`The hub could not unpack what it fetched (${(e as Error).message}).`); }
      finally { rmSync(zip, { force: true }); }
    }
    console.log("[echo] restarting Home Assistant to load it");
    // The restart call itself often never answers (the thing answering it is what restarts).
    await this.sup("POST", "/core/restart", undefined, 5 * 60_000).catch(() => {});
    for (let i = 0; i < 90; i++) { await sleep(4000); if (await this.has()) { console.log("[echo] ready"); return; } }
    throw new Error("The hub took too long to come back. Give it a few minutes and try again.");
  }
}
