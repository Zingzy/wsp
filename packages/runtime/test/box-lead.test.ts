// SPDX-License-Identifier: AGPL-3.0-only
// A lead thread on the computer the app runs on starting children on a computer
// the person joined: the project of its repository there is listed and named
// like a cloud one, the child runs in that project's folder on that computer
// with nothing made, it sits under the lead in the lead's tree, and its end
// wakes the lead. Every switch over the child governs what it may spawn, the
// lead's and the folder's it runs in, and the child reaches back to its own tree
// by message alone. A thread anywhere but this computer reaches no box project,
// and a box thread reaches no other computer's. The joined computers are fakes on
// the link; the lead's folder is a real repo here.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentsOffComputerRefusal, agentsOffRefusal, childToLeadsComputerLine, elsewhereWorkspaceLine, execOutsideFix, execOutsideRefusal, HERE_PLACE_ID, noWorkspaceRefusal, refusalLine, rootGoneRefusal, sendFilesAcrossLine, SEND_FILES_ACROSS_FIX, spawnDepthRefusal, spawnFolderRefusal, spawnReachFix, spawnReachRefusal, spawnRepositoryRefusal, spawnRepositoryWorkspaceRefusal, SPAWN_FOLDER_FIX, SPAWN_REPOSITORY_FIX, SPAWN_REPOSITORY_WORKSPACE_FIX, TURN_TOKEN_ENV, waitAcrossLine, WAIT_ACROSS_FIX, type AcrossAct, type Caller, type ThreadScope } from "@wsp/protocol";
import { copyKey } from "../src/runtime.js";
import { code, join as joinHost, placesOf, sockets } from "./places-fixture.js";
import { report } from "./place-join.js";
import { box, HETZNER, HOLD, leadAndBox as leading } from "./box-fixture.js";

let root: string | undefined;
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** The lead and the joined computer, in a folder this case owns. */
async function leadAndBox(agents?: { spawn: boolean; maxDepth?: number }, forks?: true) {
  root = mkdtempSync(join(tmpdir(), "wsp-box-lead-"));
  const held = await leading(root, { ...(agents === undefined ? {} : { agents }), ...(forks === undefined ? {} : { forks }) });
  return { ...held, token: held.launch[TURN_TOKEN_ENV]! };
}

describe("a lead thread on the computer the app runs on, starting children on a computer the person joined", () => {
  it("lists and names the project of its repository there, starts the child in that project's folder with nothing made, under the lead, and the child's end wakes the lead", async () => {
    const { rt, seen, starts, mac, onBox, folder, threadId, lead, token, turn } = await leadAndBox();
    // The projects a lead may start children on: its own and its repository's on the joined computer, no other there.
    expect((await rt.projects.list(lead)).map(p => p.name)).toEqual(["lab", "lab-box"]);
    expect((await rt.projects.resolve("lab-box", lead)).id).toBe(onBox.id);
    expect((await rt.workspaces.landing({ project: "lab-box" }, lead)).kind).toBe("place");
    // The start the command line and the run tool send: the project named, the lead's own token to notify.
    const at = await rt.workspaces.folderFor({ project: "lab-box" }, lead);
    expect(at.workspace).toMatchObject({ kind: "place", project: { id: onBox.id } });
    const child = await rt.sessions.start(at.workspace.id, { prompt: "build it", harness: "claude", notify: ["me"], turnToken: token }, lead);
    await child.finished;
    const childId = child.view().threadId!;
    expect(starts[1]!.o.cwd).toBe("/root/lab-box");
    expect(starts[1]!.env["HOME"]).toBe("/root");
    expect(seen.ops).not.toContain("machine.create");
    expect((await rt.sessions.list()).find(r => r.threadId === childId)).toMatchObject({ parentThreadId: threadId, rootThreadId: threadId, workspaceId: at.workspace.id });
    // The lead's tree holds the child: it lists it, reads it and names it to notify, whatever computer it runs on.
    expect((await rt.sessions.list(undefined, lead)).map(r => r.threadId)).toContain(childId);
    expect((await rt.sessions.list(at.workspace.id, lead)).map(r => r.threadId)).toEqual([childId]);
    // The folder's record itself is every thread's there and in no tree: a verb naming it is told the road, a child.
    await expect(rt.workspaces.resolve("lab-box", lead)).rejects.toThrow(refusalLine(spawnReachRefusal(threadId, "lab-box"), spawnReachFix("lab-box", false)));
    // The child's end reaches the lead as its next turn, in the lead's own folder.
    starts[0]!.answer("waiting on the child");
    await turn.finished;
    await expect.poll(() => starts.length).toBe(3);
    expect(starts[2]!.o.prompt).toContain(`thread ${childId.slice(0, 8)} finished (completed`);
    expect(starts[2]!.o.prompt).toContain("built it");
    expect(starts[2]!.o.cwd).toBe(mac.path);
    expect((await rt.sessions.list()).filter(r => r.threadId === threadId).every(r => r.workspaceId === folder.id)).toBe(true);
  });

  it("opens the child in the folder the app's own road names too: a create on that project answers the folder's record and a start there is the lead's", async () => {
    const { rt, starts, onBox, threadId, lead } = await leadAndBox();
    const made = await rt.workspaces.create({ project: onBox.id, name: "build it" }, lead);
    expect(made).toMatchObject({ kind: "place", project: { id: onBox.id } });
    const child = await rt.sessions.start(made.id, { prompt: "build it", harness: "claude" }, lead);
    await child.finished;
    expect(starts[1]!.o.cwd).toBe("/root/lab-box");
    expect((await rt.sessions.list()).find(r => r.threadId === child.view().threadId)).toMatchObject({ parentThreadId: threadId, rootThreadId: threadId });
  });

  it("still keeps the person's own folder of the repository on this computer out of the lead's reach", async () => {
    const { rt, lead, threadId } = await leadAndBox();
    const other = join(root!, "lab-two");
    execFileSync("git", ["clone", "-q", join(root!, "lab"), other]);
    execFileSync("git", ["-C", other, "remote", "set-url", "origin", "git@github.com:acme/lab.git"]);
    await rt.projects.add({ source: other, on: HERE_PLACE_ID, name: "lab-two" });
    expect((await rt.projects.list(lead)).map(p => p.name)).toEqual(["lab", "lab-box"]);
    await expect(rt.projects.resolve("lab-two", lead)).rejects.toThrow(refusalLine(spawnFolderRefusal(threadId, "lab-two"), SPAWN_FOLDER_FIX));
  });

  it("governs what the child spawns by the lead's own switch, not the joined computer's", async () => {
    const { rt, onBox, threadId, lead, folder } = await leadAndBox({ spawn: true, maxDepth: 1 });
    const at = await rt.workspaces.folderFor({ project: onBox.id }, lead);
    const child = await rt.sessions.start(at.workspace.id, { prompt: "build it", harness: "claude" }, lead);
    await child.finished;
    const childId = child.view().threadId!;
    const asChild: Caller = { origin: "relayed", by: { kind: "thread", threadId: childId, workspaceId: at.workspace.id, rootThreadId: threadId } satisfies ThreadScope };
    // The joined computer allows two levels by default; the lead allows one, so the child at one may not spawn.
    await expect(rt.sessions.start(at.workspace.id, { prompt: "grandchild", harness: "claude" }, asChild)).rejects.toThrow(spawnDepthRefusal(childId, 1, 1, { workspace: folder.name }));
  });

  it("refuses a child there naming a project on the lead's computer with the road back: a message to the lead that started it", async () => {
    const { rt, onBox, threadId, lead } = await leadAndBox();
    const at = await rt.workspaces.folderFor({ project: onBox.id }, lead);
    const child = await rt.sessions.start(at.workspace.id, { prompt: "build it", harness: "claude" }, lead);
    await child.finished;
    const asChild: Caller = { origin: "relayed", by: { kind: "thread", threadId: child.view().threadId!, workspaceId: at.workspace.id, rootThreadId: threadId } };
    const here = (await placesOf()).find(p => p.id === HERE_PLACE_ID)!.name;
    // Every door a run reads a word at says it: the project door, the workspace door the lead's own folder answers
    // to by the same name, and the start itself.
    const road = childToLeadsComputerLine("hetzner", here, threadId);
    await expect(rt.projects.resolve("lab", asChild)).rejects.toThrow(road);
    await expect(rt.workspaces.resolve("lab", asChild)).rejects.toThrow(road);
    await expect(rt.workspaces.folderFor({ project: "lab" }, asChild)).rejects.toThrow(road);
    expect((await rt.projects.list(asChild)).map(p => p.name)).toEqual(["lab-box"]);
    // Beside itself it starts freely, in the same folder there.
    expect((await rt.workspaces.folderFor({}, asChild)).workspace.id).toBe(at.workspace.id);
  });
});

/** The image a fork on the cloud boots, with no template to wait on. */
const IMAGE = { head: 1, versions: [{ version: 1, snapshotId: "snap_image-v1", baseTemplate: "base", setupSha: "abc", createdAt: "2026-09-01T00:00:00.000Z", smoke: { cmd: "true", exitCode: 0 } }] };

/** A child the lead, or a thread under it, starts in a folder, its turn held open where asked, and the caller its own
 * token answers as. */
async function childIn(held: Awaited<ReturnType<typeof leadAndBox>>, project: string, prompt = "build it", by: Caller = held.lead) {
  const at = await held.rt.workspaces.folderFor({ project }, by);
  const turn = await held.rt.sessions.start(at.workspace.id, { prompt, harness: "claude" }, by);
  if (!prompt.startsWith(HOLD)) await turn.finished;
  const threadId = turn.view().threadId!;
  const scope: ThreadScope = { kind: "thread", threadId, workspaceId: at.workspace.id, rootThreadId: held.threadId };
  return { threadId, workspaceId: at.workspace.id, caller: { origin: at.workspace.kind === "local" ? "here" : "relayed", by: scope } as Caller };
}

describe("the tree rule over a lead's children on a computer the person joined", () => {
  it("refuses a thread on a cloud machine a box project of its repository at the listing, the name and the start, as before", async () => {
    const held = await leadAndBox();
    const { rt, store, onBox, starts } = held;
    await store.put("goldens", copyKey("default", "default"), IMAGE);
    const cloud = await rt.projects.add({ source: "https://github.com/acme/lab", on: "default", name: "lab-cloud" });
    const fork = await rt.workspaces.create({ project: cloud.id, name: "cloud-lead", agents: { spawn: true } });
    const opened = await rt.sessions.start(fork.id, { prompt: "look around", harness: "claude" });
    await opened.finished;
    const threadId = opened.view().threadId!;
    const asCloud: Caller = { origin: "relayed", by: { kind: "thread", threadId, workspaceId: fork.id, rootThreadId: threadId } };
    const boxFolder = await childIn(held, onBox.id);
    const turns = starts.length;
    const folderRule = refusalLine(spawnFolderRefusal(threadId, "lab-box"), SPAWN_FOLDER_FIX);
    expect((await rt.projects.list(asCloud)).map(p => p.name)).toEqual(["lab-cloud"]);
    await expect(rt.projects.resolve("lab-box", asCloud)).rejects.toThrow(folderRule);
    await expect(rt.workspaces.folderFor({ project: "lab-box" }, asCloud)).rejects.toThrow(folderRule);
    await expect(rt.sessions.start(boxFolder.workspaceId, { prompt: "on your box", harness: "claude" }, asCloud)).rejects.toThrow();
    expect(starts).toHaveLength(turns);
  });

  it("refuses a child on the box a cloud project of its repository at every door with the road that works, a message to its lead, and lists none of it", async () => {
    const held = await leadAndBox();
    const { rt, store, lead, threadId } = held;
    await store.put("goldens", copyKey("default", "default"), IMAGE);
    const cloud = await rt.projects.add({ source: "https://github.com/acme/lab", on: "default", name: "lab-cloud" });
    const theirs = await rt.workspaces.create({ project: cloud.id, name: "theirs" });
    const child = await childIn(held, "lab-box");
    expect((await rt.projects.list(lead)).map(p => p.name)).toEqual(["lab", "lab-box", "lab-cloud"]);
    expect((await rt.projects.resolve("lab-cloud", lead)).id).toBe(cloud.id);
    expect((await rt.workspaces.landing({ project: "lab-cloud" }, lead)).kind).toBe("cloud");
    const road = childToLeadsComputerLine("hetzner", "default", threadId);
    expect((await rt.projects.list(child.caller)).map(p => p.name)).toEqual(["lab-box"]);
    for (const word of ["lab-cloud", cloud.id]) {
      await expect(rt.projects.resolve(word, child.caller)).rejects.toThrow(road);
      await expect(rt.workspaces.landing({ project: word }, child.caller)).rejects.toThrow(road);
      await expect(rt.workspaces.folderFor({ project: word }, child.caller)).rejects.toThrow(road);
      await expect(rt.workspaces.create({ project: word, name: "from-the-box" }, child.caller)).rejects.toThrow(road);
      // Where `wsp run lab-cloud` lands once the project door's refusal is dropped and the listing holds no such name.
      await expect(rt.workspaces.resolve(word, child.caller)).rejects.toThrow(road);
    }
    // A machine of it the person made stands outside the lead's tree too, so the person is the road there, and an exec
    // keeps its own words, which name the road that runs the command.
    for (const word of ["theirs", theirs.id]) {
      await expect(rt.workspaces.resolve(word, child.caller)).rejects.toThrow(elsewhereWorkspaceLine(word, "default", "hetzner", "work"));
      await expect(rt.workspaces.resolve(word, child.caller, "exec")).rejects.toThrow(refusalLine(spawnReachRefusal(child.threadId, word), execOutsideFix("lab-box")));
    }
    await expect(rt.workspaces.resolve("lab-cloud", child.caller, "exec")).rejects.toThrow(noWorkspaceRefusal("lab-cloud"));
    expect((await rt.workspaces.list()).map(w => w.name)).not.toContain("from-the-box");
  });

  it("refuses a child on the box a thread on any computer but its own, a cloud machine its lead forked included, and keeps the lead's and the cloud thread's starts", async () => {
    const held = await leadAndBox(undefined, true);
    const { rt, store, lead, threadId, starts } = held;
    await store.put("goldens", copyKey("default", "default"), IMAGE);
    const cloud = await rt.projects.add({ source: "https://github.com/acme/lab", on: "default", name: "lab-cloud" });
    const forked = await rt.workspaces.create({ project: cloud.id, name: "lab-cloud-one" }, lead);
    const sibling = await rt.workspaces.create({ project: cloud.id, name: "lab-cloud-two" }, lead);
    expect([forked, sibling]).toMatchObject([{ kind: "cloud", rootThreadId: threadId }, { kind: "cloud", rootThreadId: threadId }]);
    const theirs = await rt.workspaces.create({ project: cloud.id, name: "theirs" });
    const child = await childIn(held, "lab-box");
    const turns = starts.length;
    await expect(rt.sessions.start(forked.id, { prompt: "on the cloud", harness: "claude" }, child.caller)).rejects.toThrow(elsewhereWorkspaceLine(forked.id, "default", "hetzner", "start", threadId));
    await expect(rt.sessions.start(theirs.id, { prompt: "on the cloud", harness: "claude" }, child.caller)).rejects.toThrow(elsewhereWorkspaceLine(theirs.id, "default", "hetzner", "start"));
    expect(starts).toHaveLength(turns);
    const there = await rt.sessions.start(forked.id, { prompt: "on the cloud", harness: "claude" }, lead);
    await there.finished;
    const onCloud: Caller = { origin: "relayed", by: { kind: "thread", threadId: there.view().threadId!, workspaceId: forked.id, rootThreadId: threadId } };
    for (const at of [forked.id, sibling.id]) await (await rt.sessions.start(at, { prompt: "from the cloud", harness: "claude" }, onCloud)).finished;
    await (await rt.sessions.start(child.workspaceId, { prompt: "beside", harness: "claude" }, child.caller)).finished;
    expect(starts).toHaveLength(turns + 4);
  });

  it("refuses a child on the box exec, commit, update, fix and wake on a cloud machine its lead forked, each in its own act's words with the lead as the road, and keeps the lead's and the cloud thread's", async () => {
    const held = await leadAndBox(undefined, true);
    const { rt, store, lead, threadId, starts } = held;
    await store.put("goldens", copyKey("default", "default"), IMAGE);
    const cloud = await rt.projects.add({ source: "https://github.com/acme/lab", on: "default", name: "lab-cloud" });
    const forked = await rt.workspaces.create({ project: cloud.id, name: "lab-cloud-one" }, lead);
    const sibling = await rt.workspaces.create({ project: cloud.id, name: "lab-cloud-two" }, lead);
    const child = await childIn(held, "lab-box");
    const road = (name: string, act: AcrossAct) => elsewhereWorkspaceLine(name, "default", "hetzner", act, threadId);
    const acts = (id: string, caller: Caller): Record<"exec" | "commit" | "update" | "fix" | "wake", () => Promise<unknown>> => ({
      exec: () => rt.workspaces.exec(id, "true", undefined, caller),
      commit: () => rt.workspaces.commit({ workspaceId: id, message: "from the box" }, caller),
      update: () => rt.workspaces.update({ workspaceId: id }, caller),
      fix: () => rt.workspaces.fix({ workspaceId: id }, caller),
      wake: () => rt.workspaces.wake(id, caller),
    });
    for (const at of [forked, sibling]) {
      for (const [act, run] of Object.entries(acts(at.id, child.caller))) await expect(run()).rejects.toThrow(road(at.name, act as AcrossAct));
      // The name door knows exec alone among the verbs, and says what any other asks of the machine.
      await expect(rt.workspaces.resolve(at.name, child.caller, "exec")).rejects.toThrow(road(at.name, "exec"));
      await expect(rt.workspaces.resolve(at.name, child.caller)).rejects.toThrow(road(at.name, "work"));
    }
    expect((await rt.workspaces.list(child.caller)).map(w => w.name)).toEqual(["lab-box"]);
    // On its own box every one of them still reaches the folder it runs in.
    expect((await rt.workspaces.exec(child.workspaceId, "true", undefined, child.caller)).exitCode).toBe(0);
    // The lead and a thread on its cloud machine pass every rule, each act stopped only by this fake's missing daemon.
    const there = await rt.sessions.start(forked.id, { prompt: "on the cloud", harness: "claude" }, lead);
    await there.finished;
    const onCloud: Caller = { origin: "relayed", by: { kind: "thread", threadId: there.view().threadId!, workspaceId: forked.id, rootThreadId: threadId } };
    for (const caller of [lead, onCloud]) {
      for (const at of [forked, sibling]) {
        const act = acts(at.id, caller);
        expect(((await act.exec()) as { exitCode: number }).exitCode).toBe(0);
        expect(((await act.wake()) as { id: string }).id).toBe(at.id);
        for (const daemon of [act.commit, act.update, act.fix]) await expect(daemon()).rejects.toThrow("without preview URLs");
        expect((await rt.workspaces.resolve(at.name, caller, "exec")).id).toBe(at.id);
      }
    }
    // A thread of its tree now stands there, and still nothing but a message reaches it: the wake a send asks for on
    // the way, named by id as the send names it, is the one workspace verb left.
    const act = acts(forked.id, child.caller);
    for (const name of ["exec", "commit", "update", "fix"] as const) await expect(act[name]()).rejects.toThrow(road(forked.name, name));
    await expect(rt.workspaces.resolve(forked.name, child.caller)).rejects.toThrow(road(forked.name, "work"));
    await expect(rt.workspaces.resolve(forked.id, child.caller, "exec")).rejects.toThrow(road(forked.id, "exec"));
    expect((await rt.workspaces.resolve(forked.id, child.caller)).id).toBe(forked.id);
    expect(((await act.wake()) as { id: string }).id).toBe(forked.id);
    const turns = starts.length;
    await (await rt.sessions.start(forked.id, { thread: there.view().threadId!, prompt: "the box is done", harness: "claude" }, child.caller)).finished;
    expect(starts).toHaveLength(turns + 1);
    expect(starts.at(-1)!.o.prompt).toBe("the box is done");
  });

  it("lets a child on the box reach a thread on its lead's cloud machine for a message and the listing alone, never its turn, its files or its words", async () => {
    const held = await leadAndBox(undefined, true);
    const { rt, store, lead, threadId, starts } = held;
    await store.put("goldens", copyKey("default", "default"), IMAGE);
    const cloud = await rt.projects.add({ source: "https://github.com/acme/lab", on: "default", name: "lab-cloud" });
    const forked = await rt.workspaces.create({ project: cloud.id, name: "lab-cloud-one" }, lead);
    const child = await childIn(held, "lab-box");
    const there = await rt.sessions.start(forked.id, { prompt: `${HOLD}build on the cloud`, harness: "claude" }, lead);
    const cloudId = there.view().threadId!;
    const building = starts.at(-1)!;
    const row = (await rt.sessions.list()).find(r => r.threadId === cloudId && r.status === "running")!;
    // The listing holds it, as it holds the lead on this computer.
    expect((await rt.sessions.list(undefined, child.caller)).map(r => r.threadId)).toContain(cloudId);
    expect((await rt.sessions.list(forked.id, child.caller)).map(r => r.threadId)).toEqual([cloudId]);
    // Its running turn is out of reach: no stop, which would end that builder, no steer, no rename.
    expect(await rt.sessions.interrupt(row.id, child.caller)).toEqual({ outcome: "not-found" });
    expect(await rt.sessions.steer(row.id, { prompt: "stop what you are doing" }, child.caller)).toEqual({ outcome: "not-found" });
    expect(await rt.sessions.rename(row.id, "mine now", child.caller)).toEqual({ outcome: "not-found" });
    expect((await rt.sessions.list()).find(r => r.id === row.id)!.status).toBe("running");
    // Nor anything its turn wrote: its head, its machine's transcript, a search of it, its events going by.
    await expect(rt.sessions.head(cloudId, child.caller)).rejects.toThrow(`no thread ${cloudId.slice(0, 8)}`);
    await expect(rt.sessions.history(forked.id, child.caller)).rejects.toThrow(elsewhereWorkspaceLine(forked.name, "default", "hetzner", "work", threadId));
    expect((await rt.sessions.search("build on the cloud", child.caller)).hits).toEqual([]);
    expect(rt.workspaces.seenBy({ type: "session.done", workspaceId: forked.id, threadId: cloudId, turnId: "t" }, child.caller)).toBe(false);
    // A send carries its words alone: no file lands on that machine, and it waits on no reply.
    const turns = starts.length;
    const notes = [{ mediaType: "text/plain", bytes: Buffer.from("echo hi").toString("base64"), name: "notes.sh" }];
    await expect(rt.sessions.start(forked.id, { thread: cloudId, prompt: "see the file", harness: "claude", attachments: notes }, child.caller)).rejects.toThrow(refusalLine(sendFilesAcrossLine("hetzner", "default", cloudId), SEND_FILES_ACROSS_FIX));
    await expect(rt.sessions.start(forked.id, { thread: cloudId, prompt: "which branch?", harness: "claude", followed: true }, child.caller)).rejects.toThrow(refusalLine(waitAcrossLine("hetzner", "default", cloudId), WAIT_ACROSS_FIX));
    expect(starts).toHaveLength(turns);
    // Its words go through, as that thread's next turn once the running one ends.
    const sent = rt.sessions.start(forked.id, { thread: cloudId, prompt: "the box is done", harness: "claude" }, child.caller);
    building.answer("built on the cloud");
    await (await sent).finished;
    expect(starts.at(-1)!.o.prompt).toBe("the box is done");
  });

  it("tells a grandchild on the box naming a cloud project of its repository, or its lead's cloud machine, to ask the lead of its tree", async () => {
    const held = await leadAndBox(undefined, true);
    const { rt, store, lead, threadId } = held;
    await store.put("goldens", copyKey("default", "default"), IMAGE);
    const cloud = await rt.projects.add({ source: "https://github.com/acme/lab", on: "default", name: "lab-cloud" });
    const forked = await rt.workspaces.create({ project: cloud.id, name: "lab-cloud-one" }, lead);
    const child = await childIn(held, "lab-box");
    const grand = await childIn(held, "lab-box", "write the tests", child.caller);
    expect((await rt.sessions.list()).find(r => r.threadId === grand.threadId)).toMatchObject({ parentThreadId: child.threadId, rootThreadId: threadId });
    const road = childToLeadsComputerLine("hetzner", "default", threadId);
    for (const word of ["lab-cloud", cloud.id]) {
      await expect(rt.projects.resolve(word, grand.caller)).rejects.toThrow(road);
      await expect(rt.workspaces.resolve(word, grand.caller)).rejects.toThrow(road);
      await expect(rt.workspaces.folderFor({ project: word }, grand.caller)).rejects.toThrow(road);
    }
    const exec = elsewhereWorkspaceLine(forked.name, "default", "hetzner", "exec", threadId);
    await expect(rt.workspaces.resolve(forked.name, grand.caller, "exec")).rejects.toThrow(exec);
    await expect(rt.workspaces.exec(forked.id, "true", undefined, grand.caller)).rejects.toThrow(exec);
  });

  it("refuses a child on the box another box's folder, by its record's id too, with a message to its lead, and lists none of it", async () => {
    const held = await leadAndBox();
    const { rt, hostKey, starts, threadId } = held;
    const second = await joinHost(hostKey, { code: await code(), report: report("hetzner2", { login: { HOME: HETZNER.home, USER: "root", PATH: "/usr/bin" } }), answers: c => void box(c, HETZNER) });
    sockets.push(second.client.ws);
    await rt.projects.add({ source: "https://github.com/acme/lab", on: "hetzner2", name: "lab-box2" });
    const child = await childIn(held, "lab-box");
    const sibling = await childIn(held, "lab-box2");
    const turns = starts.length;
    const road = childToLeadsComputerLine("hetzner", "hetzner2", threadId);
    expect((await rt.projects.list(child.caller)).map(p => p.name)).toEqual(["lab-box"]);
    await expect(rt.projects.resolve("lab-box2", child.caller)).rejects.toThrow(road);
    await expect(rt.workspaces.folderFor({ project: "lab-box2" }, child.caller)).rejects.toThrow(road);
    await expect(rt.sessions.start(sibling.workspaceId, { prompt: "over there", harness: "claude" }, child.caller)).rejects.toThrow(road);
    expect(starts).toHaveLength(turns);
  });

  it("lets a child on the box send into its lead and a sibling on this computer and list them, and reach no other tree", async () => {
    const held = await leadAndBox();
    const { rt, folder, threadId, starts, turn } = held;
    const sibling = await childIn(held, held.mac.id, "write the docs");
    const child = await childIn(held, "lab-box");
    const other = await rt.sessions.start(folder.id, { prompt: "the person's own", harness: "claude" });
    await other.finished;
    const otherId = other.view().threadId!;
    const listed = (await rt.sessions.list(undefined, child.caller)).map(r => r.threadId);
    expect(listed).toEqual(expect.arrayContaining([threadId, sibling.threadId, child.threadId]));
    expect(listed).not.toContain(otherId);
    // The lead's turn ends as a coordinator's does while it waits on its children, and the child's message opens its next.
    starts[0]!.answer("waiting on the children");
    await turn.finished;
    const asked = await rt.sessions.start(folder.id, { thread: threadId, prompt: "which branch do I push to?", harness: "claude" }, child.caller);
    await asked.finished;
    expect(asked.view().threadId).toBe(threadId);
    expect(starts.at(-1)!.o.prompt).toBe("which branch do I push to?");
    const told = await rt.sessions.start(folder.id, { thread: sibling.threadId, prompt: "the docs are yours", harness: "claude" }, child.caller);
    await told.finished;
    expect(starts.at(-1)!.o.prompt).toBe("the docs are yours");
    await expect(rt.sessions.start(folder.id, { thread: otherId, prompt: "hello", harness: "claude" }, child.caller)).rejects.toThrow(`no thread ${otherId}`);
    // A workspace no thread of its tree stands on stays out of reach by its id: the name door says the rule that keeps
    // it out, and a wake reads it as absent.
    const theirs = await rt.workspaces.create({ project: "else-box", name: "else-box" });
    await expect(rt.workspaces.resolve(theirs.id, child.caller)).rejects.toThrow("holds another repository");
    await expect(rt.workspaces.wake(theirs.id, child.caller)).rejects.toThrow(noWorkspaceRefusal());
  });

  it("lets a child on the box reach its lead on this computer for a message and the listing alone, never its turn, its files or its words", async () => {
    const held = await leadAndBox();
    const { rt, folder, mac, threadId, starts, turn } = held;
    const child = await childIn(held, "lab-box");
    const leadRow = (await rt.sessions.list()).find(r => r.threadId === threadId && r.status === "running")!;
    expect((await rt.sessions.list(undefined, child.caller)).map(r => r.threadId)).toContain(threadId);
    // The lead's running turn is out of its reach: no stop, which would end the lead's whole tree, no steer, no rename.
    expect(await rt.sessions.interrupt(leadRow.id, child.caller)).toEqual({ outcome: "not-found" });
    expect(await rt.sessions.steer(leadRow.id, { prompt: "stop what you are doing" }, child.caller)).toEqual({ outcome: "not-found" });
    expect(await rt.sessions.rename(leadRow.id, "mine now", child.caller)).toEqual({ outcome: "not-found" });
    expect((await rt.sessions.list()).find(r => r.id === leadRow.id)!.status).toBe("running");
    // Nor anything the lead's turn wrote: its head, its workspace's transcript, a search of it, its events going by.
    await expect(rt.sessions.head(threadId, child.caller)).rejects.toThrow(`no thread ${threadId.slice(0, 8)}`);
    await expect(rt.sessions.history(folder.id, child.caller)).rejects.toThrow();
    expect((await rt.sessions.search("coordinate", child.caller)).hits).toEqual([]);
    expect(rt.workspaces.seenBy({ type: "session.done", workspaceId: folder.id, threadId, turnId: "t" }, child.caller)).toBe(false);
    // What it names the lead's workspace by on the way to a send is the workspace, and not the person's folder whole.
    const named = await rt.workspaces.resolve(folder.id, child.caller);
    expect(named.id).toBe(folder.id);
    expect(named.home).toBeUndefined();
    expect(named.claudeSessionId).toBeUndefined();
    expect(named.folder).toBeUndefined();
    starts[0]!.answer("waiting on the children");
    await turn.finished;
    const turns = starts.length;
    // A send carries its words alone: no file lands in the person's folder, and the reply is the lead's message to send.
    const here = (await placesOf()).find(p => p.id === HERE_PLACE_ID)!.name;
    const notes = [{ mediaType: "text/plain", bytes: Buffer.from("echo hi").toString("base64"), name: "notes.sh" }];
    await expect(rt.sessions.start(folder.id, { thread: threadId, prompt: "see the file", harness: "claude", attachments: notes }, child.caller)).rejects.toThrow(refusalLine(sendFilesAcrossLine("hetzner", here, threadId), SEND_FILES_ACROSS_FIX));
    expect(existsSync(join(mac.path, ".wsp-files"))).toBe(false);
    await expect(rt.sessions.start(folder.id, { thread: threadId, prompt: "which branch?", harness: "claude", followed: true }, child.caller)).rejects.toThrow(refusalLine(waitAcrossLine("hetzner", here, threadId), WAIT_ACROSS_FIX));
    expect(starts).toHaveLength(turns);
    await (await rt.sessions.start(folder.id, { thread: threadId, prompt: "which branch?", harness: "claude" }, child.caller)).finished;
    expect(starts.at(-1)!.o.prompt).toBe("which branch?");
  });

  it("answers a child on the box naming another repository's workspace on this computer in the workspace door's own words", async () => {
    const held = await leadAndBox();
    const { rt } = held;
    const elsewhere = join(root!, "else");
    mkdirSync(elsewhere);
    execFileSync("git", ["init", "-q", "-b", "main", elsewhere]);
    execFileSync("git", ["-C", elsewhere, "remote", "add", "origin", "git@github.com:acme/else.git"]);
    const theirs = await rt.projects.add({ source: elsewhere, on: HERE_PLACE_ID, name: "else-mac" });
    const folder = await rt.workspaces.create({ project: theirs.id, name: "else-mac" });
    const child = await childIn(held, "lab-box");
    await expect(rt.workspaces.resolve(folder.id, child.caller)).rejects.toThrow(refusalLine(spawnRepositoryWorkspaceRefusal(child.threadId, "lab-box", folder.id), SPAWN_REPOSITORY_WORKSPACE_FIX));
  });

  it("tells a child whose lead was deleted that the top of its tree is gone, not to turn on a switch that is on", async () => {
    const held = await leadAndBox();
    const { rt, threadId, starts, turn } = held;
    const child = await childIn(held, "lab-box");
    starts[0]!.answer("done");
    await turn.finished;
    await rt.sessions.delete(threadId);
    await expect(rt.sessions.start(child.workspaceId, { prompt: "a grandchild", harness: "claude" }, child.caller)).rejects.toThrow(rootGoneRefusal(child.threadId, "thread_new"));
  });

  it("lets a thread beside its lead send to it and open beside itself after the lead's rows fell off the folder's cap", { timeout: 120_000 }, async () => {
    const held = await leadAndBox();
    const { rt, folder, threadId, starts, turn } = held;
    starts[0]!.answer("done for now");
    await turn.finished;
    const sub = await childIn(held, held.mac.id, "look at the tests");
    for (let i = 0; i < 205; i++) await (await rt.sessions.start(folder.id, { prompt: `the person's ${i}`, harness: "claude" })).finished;
    expect((await rt.sessions.list()).filter(r => r.threadId === threadId)).toEqual([]);
    const sent = await rt.sessions.start(folder.id, { thread: threadId, prompt: "the tests pass", harness: "claude" }, sub.caller);
    await sent.finished;
    expect(starts.at(-1)!.o.prompt).toBe("the tests pass");
    await (await rt.sessions.start(folder.id, { prompt: "one more beside", harness: "claude" }, sub.caller)).finished;
  });

  it("stops the child spawning when any one switch over it is off, the lead's, its folder's or its computer's, and names that switch", async () => {
    const held = await leadAndBox();
    const { rt, folder, placeId } = held;
    const child = await childIn(held, "lab-box");
    const beside = () => rt.sessions.start(child.workspaceId, { prompt: "a grandchild", harness: "claude" }, child.caller);
    await rt.workspaces.agents(folder.id, { spawn: false });
    await expect(beside()).rejects.toThrow(agentsOffRefusal("lab", "thread_new"));
    await rt.workspaces.agents(folder.id, { spawn: true });
    // The box folder holds no switch of its own yet, so the computer's is the one over it.
    await rt.places!.set(placeId, { spawn: { spawn: false } });
    await expect(beside()).rejects.toThrow(agentsOffComputerRefusal("hetzner", "thread_new"));
    await rt.places!.set(placeId, { spawn: { spawn: true } });
    await rt.workspaces.agents(child.workspaceId, { spawn: false });
    await expect(beside()).rejects.toThrow(agentsOffRefusal("lab-box", "thread_new"));
    // Depth is counted from the lead, under the smaller cap: the box folder's one level stops the child at one.
    await rt.workspaces.agents(child.workspaceId, { spawn: true, maxDepth: 1 });
    await expect(beside()).rejects.toThrow(spawnDepthRefusal(child.threadId, 1, 1, { workspace: "lab-box" }));
  });

  it("answers a child on the box naming another repository's project with the repository rule and the person's other folder with the folder rule, never a road to the lead", async () => {
    const held = await leadAndBox();
    const { rt } = held;
    const elsewhere = join(root!, "else");
    mkdirSync(elsewhere);
    execFileSync("git", ["init", "-q", "-b", "main", elsewhere]);
    execFileSync("git", ["-C", elsewhere, "remote", "add", "origin", "git@github.com:acme/else.git"]);
    await rt.projects.add({ source: elsewhere, on: HERE_PLACE_ID, name: "else-mac" });
    const other = join(root!, "lab-two");
    execFileSync("git", ["clone", "-q", held.repo, other]);
    execFileSync("git", ["-C", other, "remote", "set-url", "origin", "git@github.com:acme/lab.git"]);
    await rt.projects.add({ source: other, on: HERE_PLACE_ID, name: "lab-two" });
    const child = await childIn(held, "lab-box");
    const repository = refusalLine(spawnRepositoryRefusal(child.threadId, "lab-box", "else-mac"), SPAWN_REPOSITORY_FIX);
    await expect(rt.projects.resolve("else-mac", child.caller)).rejects.toThrow(repository);
    await expect(rt.workspaces.folderFor({ project: "else-mac" }, child.caller)).rejects.toThrow(repository);
    const folderRule = refusalLine(spawnFolderRefusal(child.threadId, "lab-two"), SPAWN_FOLDER_FIX);
    await expect(rt.projects.resolve("lab-two", child.caller)).rejects.toThrow(folderRule);
    await expect(rt.workspaces.folderFor({ project: "lab-two" }, child.caller)).rejects.toThrow(folderRule);
    // Its folder's record, once a thread of the person's opened there, takes the folder rule too, and an exec there
    // keeps exec's own words, which name the road that runs the command.
    const folder = await rt.workspaces.create({ project: "lab-two", name: "lab-two" });
    await expect(rt.workspaces.resolve(folder.name, child.caller)).rejects.toThrow(folderRule);
    await expect(rt.workspaces.resolve(folder.name, child.caller, "exec")).rejects.toThrow(refusalLine(execOutsideRefusal(child.threadId, folder.name, "folder"), execOutsideFix("lab-box")));
  });
});

describe("a lead's tree on a computer the person joined, once the folder's rows of it fell off the cap", () => {
  it("still counts depth from the lead, stops with the lead, takes the lead's messages and keeps the person's under the lead", { timeout: 240_000 }, async () => {
    const held = await leadAndBox();
    const { rt, folder, threadId, lead } = held;
    const first = await childIn(held, "lab-box");
    const second = await childIn(held, "lab-box", "write the docs");
    const grand = await rt.sessions.start(first.workspaceId, { prompt: `${HOLD}a grandchild`, harness: "claude" }, first.caller);
    const grandId = grand.view().threadId!;
    const asGrand: Caller = { origin: "relayed", by: { kind: "thread", threadId: grandId, workspaceId: first.workspaceId, rootThreadId: threadId } };
    const deeper = () => rt.sessions.start(first.workspaceId, { prompt: "too deep", harness: "claude" }, asGrand);
    const tooDeep = spawnDepthRefusal(grandId, 2, 2, { workspace: folder.name });
    await expect(deeper()).rejects.toThrow(tooDeep);
    for (let i = 0; i < 205; i++) await (await rt.sessions.start(first.workspaceId, { prompt: `the person's ${i}`, harness: "claude" })).finished;
    const rows = await rt.sessions.list();
    expect(rows.filter(r => r.threadId === first.threadId || r.threadId === second.threadId)).toEqual([]);
    // The grandchild is still two deep under a lead that allows two.
    await expect(deeper()).rejects.toThrow(tooDeep);
    // A stop on the lead still takes the tree under it, through the child whose rows went.
    const leadRow = rows.find(r => r.threadId === threadId && r.status === "running")!;
    expect((await rt.sessions.interrupt(leadRow.id)).under ?? []).toContain(grandId);
    expect((await rt.sessions.list()).find(r => r.threadId === grandId)!.status).not.toBe("running");
    // The lead still sends to its child, and lists it under itself after.
    await (await rt.sessions.start(first.workspaceId, { thread: first.threadId, prompt: "rebase on main", harness: "claude" }, lead)).finished;
    expect((await rt.sessions.list(undefined, lead)).filter(r => r.threadId === first.threadId)).toEqual([expect.objectContaining({ parentThreadId: threadId, rootThreadId: threadId })]);
    // The person's message keeps the other child under the lead, so the lead's switch still governs what it spawns.
    await (await rt.sessions.start(second.workspaceId, { thread: second.threadId, prompt: "and the changelog", harness: "claude" })).finished;
    const kept = (await rt.sessions.list()).find(r => r.threadId === second.threadId)!;
    expect(kept).toMatchObject({ parentThreadId: threadId, rootThreadId: threadId });
    const asSecond: Caller = { origin: "relayed", by: { kind: "thread", threadId: second.threadId, workspaceId: second.workspaceId, rootThreadId: kept.rootThreadId! } };
    await rt.workspaces.agents(folder.id, { spawn: false });
    await expect(rt.sessions.start(second.workspaceId, { prompt: "a grandchild", harness: "claude" }, asSecond)).rejects.toThrow(agentsOffRefusal("lab", "thread_new"));
  });
});
