/**
 * The hub service's recent log lines, kept in memory and in a small file on the hub,
 * so a report can say what happened even after the service restarted.
 * Imported first by index.ts: everything logged after that is kept.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dir } from "./store.ts";

const file = join(dir, "hub.log");
const KEEP = 400;
const lines: string[] = [];
try { lines.push(...readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-KEEP)); } catch { /* no log yet */ }

const plain = console.log.bind(console);
console.log = (...parts: unknown[]) => {
  plain(...parts);
  const line = `${new Date().toISOString()} ${parts.map(String).join(" ")}`.slice(0, 600);
  lines.push(line);
  if (lines.length > KEEP) lines.splice(0, lines.length - KEEP);
  try {
    mkdirSync(dir, { recursive: true });
    let big = false;
    try { big = statSync(file).size > 300_000; } catch { /* not there yet */ }
    if (big) writeFileSync(file, lines.join("\n") + "\n"); else appendFileSync(file, line + "\n");
  } catch { /* the log is a convenience; never stop the service for it */ }
};

// A crash is the most useful line a report can carry. The service still stops, as it did before.
process.on("uncaughtException", (e) => { console.log(`[hub] stopped by an error: ${e?.stack ?? e}`); process.exit(1); });
process.on("unhandledRejection", (e) => { console.log(`[hub] stopped by an error: ${(e as Error)?.stack ?? e}`); process.exit(1); });

export const hubLog = {
  recent: (n = 300): string[] => lines.slice(-n),
  clear(): void { lines.length = 0; rmSync(file, { force: true }); },
};
console.log("[hub] service starting");
