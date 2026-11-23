/**
 * The characters, pictured in this home.
 *
 * The household gives a few photos of their home; an image model draws each character there.
 * Photos and pictures are kept on the hub. The photos are sent to the image service only to
 * make the pictures. One picture at a time can be made again.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CHARACTERS, STYLES } from "../../../packages/core/src/index.ts";
import type { PortraitJob, PortraitStatus } from "../../../packages/core/src/index.ts";

const MODELS = ["gemini-3.1-flash-image", "gemini-3.1-flash-lite-image"];
const MAX_PHOTOS = 4;
const AT_ONCE = 2;

const LOOKS: Record<string, string> = {
  vincent: "a man of about sixty with silver hair swept back and a grey handlebar moustache: Vincent, the butler",
  roxy: "a woman in her mid-forties with blonde hair in a braided updo: Roxy, the house manager",
  otto: "an upright brass cabinet machine with one large living eye behind a round porthole and a plate reading OTTO",
  julian: "a Black man in his mid-thirties with short hair, a trim full beard and round tortoiseshell glasses: Julian, the well-read one",
  sora: "a Japanese woman in her mid-twenties with long black hair in a low ponytail and a soft fringe, smiling brightly: Sora, the mathematician",
  ernest: "a small riveted brass box with two big round worried eyes peering from a dark slot and a plate reading ERNEST",
};
const MACHINES = new Set(["otto", "ernest"]);

export class Portraits {
  private dir: string;
  private dist: string;
  private changed: () => void;
  private jobs = new Map<string, PortraitJob>();
  private waiting: { id: string; style: string }[] = [];
  private running = 0;
  /** How long a picture has been taking, in seconds; starts as a fair guess. */
  private typical = 12;

  constructor(dataDir: string, distDir: string, changed: () => void) {
    this.dir = join(dataDir, "portraits"); this.dist = distDir; this.changed = changed;
    mkdirSync(join(this.dir, "photos"), { recursive: true });
  }

  /** The image service's key: the hub service's own setting, never part of the published code. */
  private key(): string {
    if (process.env.VINCENT_IMAGE_KEY) return process.env.VINCENT_IMAGE_KEY;
    try { return String(JSON.parse(readFileSync("/data/options.json", "utf8")).image_key ?? ""); } catch { return ""; }
  }

  photos(): string[] { return readdirSync(join(this.dir, "photos")).filter((f) => f.endsWith(".jpg")).sort().map((f) => f.slice(0, -4)); }
  photoFile(id: string): string { return join(this.dir, "photos", `${id.replace(/[^a-z0-9]/g, "")}.jpg`); }
  file(character: string): string { return join(this.dir, `${character.replace(/[^a-z]/g, "")}.img`); }

  addPhoto(jpeg: Buffer): string {
    if (this.photos().length >= MAX_PHOTOS) throw new Error(`${MAX_PHOTOS} photos is plenty. Remove one to add another.`);
    const id = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
    writeFileSync(this.photoFile(id), jpeg);
    return id;
  }
  removePhoto(id: string): void { rmSync(this.photoFile(id), { force: true }); }

  status(): PortraitStatus {
    const characters: PortraitStatus["characters"] = {};
    for (const c of CHARACTERS) {
      const job = this.jobs.get(c.id);
      let version = 0;
      try { version = Number(readFileSync(this.file(c.id) + ".at", "utf8")) || 0; } catch { /* none made */ }
      let style: string | undefined;
      try { style = readFileSync(this.file(c.id) + ".style", "utf8"); } catch { /* drawn before outfits were kept */ }
      characters[c.id] = { state: job?.state ?? "idle", startedAt: job?.startedAt, message: job?.message, version, style };
    }
    return { available: !!this.key(), photos: this.photos(), seconds: Math.round(this.typical), characters };
  }

  /** Back to the standard picture. */
  reset(character: string): void {
    rmSync(this.file(character), { force: true }); rmSync(this.file(character) + ".at", { force: true }); rmSync(this.file(character) + ".photo", { force: true }); rmSync(this.file(character) + ".style", { force: true });
    this.claims.delete(character);
    this.jobs.delete(character);
  }

  /** The photo each character is being, or was last, drawn in during this run of the service. */
  private claims = new Map<string, string>();

  start(ids: string[], styleOf: (id: string) => string): void {
    if (!this.key()) throw new Error("Pictures of your home are not switched on for this hub yet.");
    if (!this.photos().length) throw new Error("Add a photo of your home first.");
    for (const id of ids) {
      if (!CHARACTERS.some((c) => c.id === id)) continue;
      const now = this.jobs.get(id)?.state;
      if (now === "waiting" || now === "working") continue;
      this.jobs.set(id, { state: "waiting" });
      const style = styleOf(id);
      this.waiting.push({ id, style: STYLES.some((s) => s.id === style) ? style : "traditional" });
    }
    this.pump();
  }

  private pump(): void {
    while (this.running < AT_ONCE && this.waiting.length) {
      const next = this.waiting.shift()!;
      this.running++;
      this.jobs.set(next.id, { state: "working", startedAt: Date.now() });
      this.changed();
      const began = Date.now();
      this.make(next.id, next.style)
        .then(() => { this.typical = this.typical * 0.6 + ((Date.now() - began) / 1000) * 0.4; this.jobs.set(next.id, { state: "done" }); })
        .catch((e: Error) => { console.log(`[portraits] ${next.id}: ${e.message}`); this.jobs.set(next.id, { state: "failed", message: e.message }); })
        .finally(() => { this.running--; this.changed(); this.pump(); });
    }
  }

  /**
   * One photo per character, so with enough photos nobody shares a room.
   * A photo no other character is standing in comes first; among those, one this character was not just drawn in.
   */
  private photoFor(id: string): string {
    const photos = this.photos();
    const used = (c: string) => { try { return existsSync(this.file(c)) ? readFileSync(this.file(c) + ".photo", "utf8") : ""; } catch { return ""; } };
    const last = used(id);
    const taken = new Set(CHARACTERS.filter((c) => c.id !== id).map((c) => this.claims.get(c.id) ?? used(c.id)));
    const from = last ? photos.indexOf(last) + 1 : Math.max(0, CHARACTERS.findIndex((c) => c.id === id));
    const order = photos.map((_, i) => photos[(from + i) % photos.length]);
    const pick = order.find((p) => !taken.has(p) && p !== last) ?? order.find((p) => !taken.has(p)) ?? order.find((p) => p !== last) ?? order[0];
    this.claims.set(id, pick);
    return pick;
  }

  private async make(id: string, style: string): Promise<void> {
    const inline = (file: string, type: string) => ({ inline_data: { mime_type: type, data: readFileSync(file).toString("base64") } });
    const parts: unknown[] = [];
    // The character as drawn for this style, falling back to any drawing of them we have.
    const refs = [style, ...STYLES.map((s) => s.id)].map((s) => join(this.dist, "characters", s, `${id}.jpg`)).filter((f) => existsSync(f));
    const who = LOOKS[id] ?? id;
    const where = MACHINES.has(id)
      ? "sitting on a table, shelf or counter in this home, at the size of a small cabinet, whole object in view"
      : "standing naturally in this home, seen from the waist up, looking at the camera with a friendly expression";
    parts.push({ text:
      `The first image shows a character: ${who}. The second image is a photograph of a real home. ` +
      `Make a new upright 4:5 picture of exactly this character, same face or design and same clothing, ${where}. ` +
      "Use the place in the photograph: its real architecture, furniture, colours and light. Do not invent a different place and do not include any people from the photograph. " +
      "Keep the polished, colourful illustrated look of the first image. No text, no border, no watermark." });
    if (refs[0]) parts.push(inline(refs[0], "image/jpeg"));
    const photo = this.photoFor(id);
    parts.push(inline(this.photoFile(photo), "image/jpeg"));

    let why = "The picture could not be made. Try again.";
    for (const model of MODELS) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.key()}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(150_000),
          body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ["IMAGE"] } }),
        });
        const j: any = await r.json().catch(() => ({}));
        const got = (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.inline_data ?? p.inlineData).find(Boolean);
        if (got?.data) {
          writeFileSync(this.file(id), Buffer.from(got.data, "base64"));
          writeFileSync(this.file(id) + ".at", String(Date.now()));
          writeFileSync(this.file(id) + ".photo", photo);
          writeFileSync(this.file(id) + ".style", style);
          return;
        }
        if (r.status === 402 || r.status === 429 || r.status === 403) why = "The picture service is not taking requests right now, so no new pictures were made. This is on Vincent's side, not yours. Please try again later.";
        else if (j.promptFeedback?.blockReason || j.candidates?.[0]?.finishReason === "SAFETY") why = "The picture service would not use one of these photos. Try different photos.";
        console.log(`[portraits] ${model} gave no picture (${r.status} ${j.error?.message?.slice(0, 120) ?? j.candidates?.[0]?.finishReason ?? ""})`);
      } catch (e) { console.log(`[portraits] ${model}: ${(e as Error).message}`); }
    }
    throw new Error(why);
  }
}

/** What kind of picture a file is, from its first bytes. */
export function pictureType(b: Buffer): string {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49) return "image/webp";
  return "image/jpeg";
}
