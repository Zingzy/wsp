// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";

/** Where this install keeps what must never travel with a WSP_HOME: the OS-local config dir. XDG_CONFIG_HOME wins on
 * every platform when set, which is also how the test suite keeps its runs out of the developer's real dir. */
export function localConfigDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg !== "") return join(xdg, "wsp");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "wsp");
  return join(homedir(), ".config", "wsp");
}

let warned = false;

/** This machine's name plus a per-install id, made once, so two machines over one state file never read each
 * other's holds as their own. The id is not a secret: a dir that cannot be read or written costs the id, not the run. */
export function hostIdentity(dir = localConfigDir()): string {
  const path = join(dir, "host-id");
  try {
    let id = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
    if (id === "") {
      id = randomBytes(4).toString("hex");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, `${id}\n`);
    }
    return `${hostname()}:${id}`;
  } catch (e) {
    if (!warned) {
      warned = true;
      console.warn(`host id not kept in ${dir} (${e instanceof Error ? e.message : String(e)}); holds carry the hostname alone`);
    }
    return hostname();
  }
}
