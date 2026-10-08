// SPDX-License-Identifier: AGPL-3.0-only
// A lead thread on a folder here whose repository moved, starting children on a computer the person joined: the
// projects there recorded under the old name and the new both read as its repository, at the listing, at the name
// and at the create, and no saved remote is written.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HERE_PLACE_ID, type Caller } from "@wsp/protocol";
import { createRuntime } from "../src/runtime.js";
import { newPlaceKeyPair } from "../src/places.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { branchDaemons, fakeLocal, stubBackend } from "./stub-backend.js";
import { WsClient } from "./ws-client.js";
import { joinAt, wiring } from "./place-join.js";
import { ctx, sockets, forks, HOLDS_PROJECTS } from "./places-fixture.js";

describe("a lead on a folder here whose repository moved, on a computer the person joined", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("lists, names and starts children on the box projects recorded under the old name and the new, and on no other", async () => {
    root = mkdtempSync(joinPath(tmpdir(), "wsp-box-repo-"));
    const repo = joinPath(root, "wsp");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:Acme/Lab.git"]);
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, local: { ...fakeLocal(joinPath(root, "home")), daemonRoad: async () => ({ url: "http://127.0.0.1:1", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: "t" }) }, placeLinks: wiring(hostKey), daemonChannel: branchDaemons().open });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    const minted = await WsClient.connect(ctx.srv.port, { token: "host-token" });
    const code = String((await minted.request("pair.issue"))["code"]);
    minted.close();
    const { client } = await joinAt(ctx.srv.port, hostKey, {
      code,
      name: "srv",
      answers: c => {
        forks(c, undefined, undefined, HOLDS_PROJECTS);
        c.onFrame(raw => {
          const frame = raw as unknown as Record<string, unknown>;
          if (frame["op"] === "git.startOn") c.say({ id: frame["id"], ok: true, branch: String(frame["branch"]), oid: "c0ffee" });
        });
      },
    });
    sockets.push(client.ws);
    const rt = ctx.runtime;
    const wsp = await rt.projects.add({ source: repo, on: HERE_PLACE_ID, name: "wsp" });
    await rt.projects.add({ source: "https://github.com/acme/lab", on: "srv", name: "wsp-boat" });
    await rt.projects.add({ source: "https://github.com/lab-co/lab.git", on: "srv", name: "wsp-hertzner" });
    await rt.projects.add({ source: "https://github.com/lab-co/else.git", on: "srv", name: "else" });
    const saved = async (): Promise<Record<string, string | undefined>> => Object.fromEntries((await rt.projects.list()).map(p => [p.name, p.remote]));
    const before = await saved();
    execFileSync("git", ["-C", repo, "remote", "set-url", "origin", "https://github.com/lab-co/lab.git"]);
    const lead = await rt.workspaces.create({ project: wsp.id, name: "lead", agents: { spawn: true } });
    const asLead: Caller = { origin: "here", by: { kind: "thread", threadId: "lead-thread", workspaceId: lead.id, rootThreadId: "lead-thread" } };

    expect((await rt.projects.list(asLead)).map(p => p.name)).toEqual(["wsp", "wsp-boat", "wsp-hertzner"]);
    expect((await rt.projects.resolve("wsp-boat", asLead)).name).toBe("wsp-boat");
    expect((await rt.projects.resolve("wsp-hertzner", asLead)).name).toBe("wsp-hertzner");
    await expect(rt.projects.resolve("else", asLead)).rejects.toThrow("another repository");
    for (const project of ["wsp-boat", "wsp-hertzner"]) {
      const child = await rt.workspaces.create({ project, name: `on-${project}` }, asLead);
      expect(child).toMatchObject({ project: { name: project }, parentWorkspaceId: lead.id });
    }
    expect((await rt.workspaces.list(asLead)).map(w => w.name).sort()).toEqual([lead.name, "on-wsp-boat", "on-wsp-hertzner"].sort());
    expect(await saved()).toEqual(before);
  });
});
