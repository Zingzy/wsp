// SPDX-License-Identifier: AGPL-3.0-only
// Where a run that names no project goes: beside the thread whose line it is,
// on whichever computer that thread runs, which the host reads off the token.
import { describe, expect, it } from "vitest";
import { guestNamesWorkspaceLine, HERE_PLACE_ID, TURN_TOKEN_ENV, type ProjectView } from "@wsp/protocol";
import type { HostClient } from "../src/verbs/client.js";
import { runTarget } from "../src/verbs/turns-help.js";

/** A host nothing may be asked of: where the run goes is read off the line alone. */
const untouched = new Proxy({}, {
  get: () => {
    throw new Error("the host was asked something");
  },
}) as HostClient;

describe("a run that names no project", () => {
  it("starts beside the thread whose line it is, a line typed on a computer the person joined included", async () => {
    const env = { [TURN_TOKEN_ENV]: "turn-token-fake" };
    expect(await runTarget(untouched, undefined, "/root/spoo-ts", env, true, {})).toMatchObject({ here: {} });
    expect(await runTarget(untouched, undefined, "/root/spoo-ts", env, true, { cwd: "/root/spoo-ts/web" })).toMatchObject({ here: { cwd: "/root/spoo-ts/web" } });
  });

  it("still names the workspace on a line from a machine that is no thread's", async () => {
    await expect(runTarget(untouched, undefined, "/root/spoo-ts", {}, true, {})).rejects.toThrow(guestNamesWorkspaceLine);
  });
});

describe("a run that names a project", () => {
  it("takes the thread's own project where a project on another computer shares its name, whichever was added first", async () => {
    const mac = { id: "pr_mac", name: "spoo-ts", computer: HERE_PLACE_ID, path: "/Users/dev/spoo-ts" } as ProjectView;
    const box = { id: "pr_box", name: "spoo-ts", computer: "pl_hetzner", path: "/root/spoo-ts" } as ProjectView;
    // The host answers the word off the thread's token, as the runtime's resolve does; the list holds both.
    const replies: Record<string, (p: Record<string, unknown>) => Record<string, unknown>> = {
      "projects.list": () => ({ projects: [mac, box] }),
      "projects.resolve": p => {
        if (p["ref"] === "spoo-ts" || p["ref"] === box.id) return { project: box };
        throw new Error(`no project "${String(p["ref"])}"`);
      },
      "workspaces.landing": () => ({ kind: "place" }),
    };
    const client = { request: async (op: string, p: Record<string, unknown> = {}) => replies[op]!(p) } as unknown as HostClient;
    const env = { [TURN_TOKEN_ENV]: "turn-token-fake" };
    expect(await runTarget(client, "spoo-ts", "/root/spoo-ts", env, true, {})).toMatchObject({ here: { project: { id: "pr_box", path: "/root/spoo-ts" } } });
  });
});
