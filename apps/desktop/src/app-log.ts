// SPDX-License-Identifier: AGPL-3.0-only
// The desktop app's own log: one file under the wsp home's logs folder that
// keeps every error and warning the main process and its pages met, each with
// its time, so a crash or a failed update a person reports has its whole
// sentence somewhere. Bounded by size, a few files kept; secrets never enter
// it, by the host's redaction rule and every credential-named value this
// launch was handed.
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { SECRET_NAME, redact } from "@wsp/host";

export const APP_LOG = "app.log";
/** The size app.log is rotated at. */
export const LOG_BYTES = 2 * 1024 * 1024;
/** Files kept, app.log among them: app.1.log is the one before it. */
export const LOGS_KEPT = 4;
/** One entry's ceiling, so a page that throws a megabyte of text cannot rotate the log away in one line. */
export const ENTRY_CHARS = 16 * 1024;

export type LogLevel = "info" | "warn" | "error";

export interface AppLog {
  readonly path: string;
  write(level: LogLevel, text: string): void;
}

export interface AppLogOptions {
  now?: () => Date;
  maxBytes?: number;
  kept?: number;
  /** Every value under a credential's name here is blanked wherever it turns up. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** The values a log must never hold: each one this environment carries under a name that says credential. */
export function credentialValues(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(env).flatMap(([name, value]) => (value !== undefined && SECRET_NAME.test(name) ? [value] : []));
}

/** The log at dir/app.log, the folder made. A write that fails is dropped: the app never stops for its log. */
export function openAppLog(dir: string, opts: AppLogOptions = {}): AppLog {
  const { now = () => new Date(), maxBytes = LOG_BYTES, kept = LOGS_KEPT } = opts;
  const path = join(dir, APP_LOG);
  const hidden = credentialValues(opts.env ?? {});
  let size = 0;
  try {
    mkdirSync(dir, { recursive: true });
    size = statSync(path).size;
  } catch {
    // A first launch has no log yet; a folder that cannot be made fails every write below the same quiet way.
  }
  const rotate = (): void => {
    rmSync(join(dir, `app.${kept - 1}.log`), { force: true });
    for (let n = kept - 2; n >= 1; n--) if (existsSync(join(dir, `app.${n}.log`))) renameSync(join(dir, `app.${n}.log`), join(dir, `app.${n + 1}.log`));
    renameSync(path, join(dir, "app.1.log"));
    size = 0;
  };
  return {
    path,
    write(level, text) {
      // Blanked before the cut, so the cut never leaves half a secret that no longer matches the whole.
      const clean = redact(text, hidden);
      const body = clean.length > ENTRY_CHARS ? `${clean.slice(0, ENTRY_CHARS)} (${clean.length - ENTRY_CHARS} characters cut)` : clean;
      const entry = `${now().toISOString()} ${level} ${body.replace(/\n/g, "\n  ")}\n`;
      const bytes = Buffer.byteLength(entry);
      try {
        if (size > 0 && size + bytes > maxBytes) {
          // A file another launch rotated first is no reason to drop this entry.
          try {
            rotate();
          } catch {
            size = 0;
          }
        }
        appendFileSync(path, entry);
        size += bytes;
      } catch {
        // Nowhere to say it: the log is the place it would be said.
      }
    },
  };
}

/** What the preload sends for an error a page threw and nobody caught. */
export interface RendererError {
  kind: "error" | "rejection";
  message: string;
  stack?: string;
  /** The page's path and hash, which is the route the app was on. */
  route: string;
}

/** The log's line for what a page sent, or nothing for a shape the preload never sends. */
export function rendererReport(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { kind, message, stack, route } = raw as Record<string, unknown>;
  if ((kind !== "error" && kind !== "rejection") || typeof message !== "string" || typeof route !== "string") return undefined;
  const head = `renderer: ${kind === "error" ? "uncaught" : "unhandled rejection"} at ${route}: ${message}`;
  return typeof stack === "string" && stack !== "" ? `${head}\n${stack}` : head;
}
