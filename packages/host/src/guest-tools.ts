// SPDX-License-Identifier: AGPL-3.0-only
// The tool server kind of a guest session, where this computer's binary
// carries one: that binary as the thread's scoped server with the guest's
// rules, one process per session, its stdio carrying the session's messages.
// It dials this host's own socket door on the thread's token, so what a fork's
// agent may do is exactly what that token may do. A Linux host's binary is the
// static guest build and carries no tool server, so the TypeScript server
// answers there: a platform gap, not a second road.
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { CLOUD_ENV, type GuestKind } from "@wsp/protocol";
import type { GuestKindModule } from "@wsp/runtime";
import { guestCli } from "./guest-cli.js";
import { guestMcp } from "./guest-mcp.js";
import { runningWsp, toolServerOf, type RunningWsp } from "./mcp-install.js";

/** The kinds this host answers a guest session with, for the wsp it runs as. */
export function guestKinds(statePath: string, run: RunningWsp = runningWsp()): Record<GuestKind, GuestKindModule> {
  return { mcp: guestTools(statePath, toolServerOf(run)), cli: guestCli(statePath, run) };
}

export function guestTools(statePath: string, toolServer: string | false): GuestKindModule {
  if (toolServer === false) return guestMcp(statePath);
  return {
    open(o) {
      // The launch pair and the turn's token alone, as the TypeScript server's tools read them: nothing else of this
      // host's environment is a guest's to read a value out of by name. The cloud's state and the zone a time is
      // printed in are this host's, as they are for the server that runs inside it.
      const own = Object.fromEntries([CLOUD_ENV, "TZ"].flatMap(name => (process.env[name] !== undefined ? [[name, process.env[name]!]] : [])));
      const env = { ...o.env, ...own };
      // Not the guest's folder, which is on its machine and which the guest's rules never read.
      const child = spawn(toolServer, ["mcp", "--state", statePath, "--scoped", "--guest"], { cwd: dirname(statePath), env, stdio: ["pipe", "pipe", "pipe"] });
      let live = true;
      let said = "";
      // Its last line is what the guest reads when it ends first; the rest is not kept.
      child.stderr.setEncoding("utf8").on("data", (text: string) => (said = (said + text).slice(-4096)));
      createInterface({ input: child.stdout }).on("line", line => {
        try {
          o.reply(JSON.parse(line));
        } catch {
          // A line that is no message is dropped, as a stdio transport drops it.
        }
      });
      child.stdin.on("error", () => undefined);
      const ended = (): void => {
        if (!live) return;
        live = false;
        const last = said.trim().split("\n").at(-1);
        o.close(last === undefined || last === "" ? undefined : last);
      };
      child.once("error", ended);
      child.once("close", ended);
      return {
        message(message) {
          if (live) child.stdin.write(`${JSON.stringify(message)}\n`);
        },
        close() {
          live = false;
          child.kill();
        },
      };
    },
  };
}
