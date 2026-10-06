// SPDX-License-Identifier: AGPL-3.0-only
// The wsp verbs against a host over the fake runtime: each one a client of
// the protocol on localhost, authenticated with the token the host wrote,
// reading the same session index the sidebar reads.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { type fakeCopier, NapRefusedError, NoProviderBackend, passphraseCipher, type MachineBackend } from "@wsp/engine";
import { homeShortened, localFolderRefusal, localWorktreeRefusal, threadDeletedLine, AGENTS_ON, type AgentRow, childStartedLine, type ProjectView, type DaemonErrorCode, noProjectImageLine, projectImageInUseRefusal, projectImageRemoveNotice, projectImageRemovedLine, napRefusedLine, HERE_PLACE_ID, LIST_PRICE_WORD, goneRoadRefusal, notAnsweringYet, runForTheList, askingLine, needsYouLine, QUESTION_TOOL, permissionModeOptionLabel, PERMISSION_DENY, type PermissionAsk, DEFAULT_PREFERENCES, PERMISSION_ALLOW, effortsFor, HOST_KEY_ENV, HOST_TOKEN_ENV, HOST_URL_ENV, noWorkspaceRefusal, EMPTY_MESSAGE_LINE, EXIT_CODES, IMAGE_NO_VAULT, IMAGE_PASSPHRASE_ENV, IMAGE_PASSPHRASE_MIN, HOST_STOPPING_LINE, UP_RESTART_LINE, IMAGE_ALREADY_NEWEST, IMAGE_MOVE_CONFIRM, imageKeptLine, markedDefault, NO_SUCH_TURN, noReplyLine, noThreadTargetLine, notifyLine, RuntimeRequest, threadStateWord, placeBuildsNoImageLine, registeredLine, REGISTERING_LINE, registerTakesNoConsentLine, signInRefusalLine, threadForgetRefusal, threadOpenedLine, threadWithoutIdRefusal, ThreadView, TURN_TOKEN_ENV, unknownAgentLine, workspaceAsleepAgainLine, thisComputer, type WorkspaceOut, WorkspaceView, forgetUndrivenRefusal, THIS_COMPUTER, noSuchPlaceRefusal, type PlaceView, localRunsOneFix, localRunsOneLine, MEMORY_KEPT_CLAUSE, projectRemovedOnComputerLine, type HarnessCatalogAnswer, noFastLine, shellLine, NOT_DELIVERED_LINE, BUILT_IN_LIST_CLAUSE, BUILT_IN_TABLE_CLAUSE } from "@wsp/protocol";
import { copyKey, createRuntime, harnessCatalog, memoryStore, type AgentsReader, type DaemonChannel, type HarnessAdapterFactory, type HostSsh, type PlaceBackends, type Runtime, type Store } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { HELP, agentPage, cli, commandPage, COMMANDS_FOR_HELP, localWiring, localWorkFolder, serve } from "../src/cli.js";
import { hostKeyHere, placeWiring } from "../src/places.js";
import { hostTokenPath, lockPathFor } from "../src/host-lock.js";
import type { HostHandle } from "../src/server.js";
import { awake, CLI_VERBS, hasTool, VERBS, runVerb, PLAN_ONLY, ANSWER_IN_THE_APP, answerKeysLine, answerVerbsLine, answeredLine, noSuchAnswerLine, deleteQuestion, deletedLine, deleting, dialHost, firstEnded, messageTo, napAfterDeadLaunch, noHostServingLine, noOpenAskLine, threadRows, threadTree, threadsOf, type HostClient } from "../src/verbs.js";
import { HOST_RESTARTING_LINE, HOST_SIDE_VAULT, SSH_PIPES_HERE_LINE, hostAgain, hostPlatform, hostRestartedLine, THREAD_PREFIX_WORD } from "../src/verbs.js";
import { restartRoads, type RestartRoad } from "../src/restart.js";
import { hostSideOnlyFix, hostSideOnlyLine } from "../src/hosts.js";
import type { WatchSignals } from "../src/watch.js";
import { writeHost } from "../src/hosts.js";
import { withRefused } from "../../runtime/test/fs-refusal.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { TEST_ENV } from "../../../vitest.env.js";
import { writeStub } from "../../protocol/test/stub-script.js";
import { runningWsp } from "../src/mcp-install.js";
import { wspArgvOf } from "../src/place-report.js";
import { guestAnswer, stubBackend, withDaemonRoads, type StubBackend } from "./stub-backend.js";
import { copyingFake, createOn, fakeDaemonStart, projectOn, CUT_LINE, EXPORT_SESSION, EXPORT_SOURCE, PAGE, UNREACHED_LINE, bornDeadAgent, captured, doneOnlyAgent, execGuest, exportGuest, heldAgent, lastingAgent, launchedScript, launchedScripts, projectBundler, sayingAgent, scriptedAgent, stuckAgent, toolingAgent, type Captured } from "./verbs-fixture.js";
import { runsFromItsOwnFolder } from "./own-folder.js";
import { CLOUD_ON } from "../src/cloud.js";
import { AGENTS_HERE, fakeGitDaemon, HOST_KEY, PROBE_CMD, probing, verbsHost } from "./verbs-host.js";

runsFromItsOwnFolder();

// A path the process may not read is refused here and not by chmod: these tests run as root, which reads anything.
vi.mock("node:fs", async importOriginal => (await import("../../runtime/test/fs-refusal.js")).refusingFs(await importOriginal<typeof import("node:fs")>()));

describe("wsp verbs over the host", () => {
  const h = verbsHost();

  it.runIf(CLOUD_ON)("fork takes --size as <cpu>x<memGb>, which reaches the create's size; a size the provider does not offer, or no size at all, is refused in one line naming the list, and nothing is minted", async () => {
    const big = await h.run("new", "big", "--size", "2x8");
    expect(big.code).toBe(0);
    expect(h.backend.machines.at(-1)!.spec).toMatchObject({ cpu: 2, memMb: 8192 });
    const [status] = await h.rt.status.list();
    expect(status).toMatchObject({ name: "big", size: { cpu: 2, memMb: 8192 } });

    withDaemonRoads(h.backend);
    const forked = await h.run("fork", "big", "--name", "wide", "--size", "4x8");
    expect(forked.code).toBe(0);
    expect(h.backend.machines.at(-1)!.spec).toMatchObject({ cpu: 4, memMb: 8192 });
    expect((await h.rt.status.list()).find(w => w.name === "wide")!.size).toEqual({ cpu: 4, memMb: 8192 });

    const list = "the sizes are 2x4 ($0.11/hr), 2x8 ($0.15/hr), 4x8 ($0.22/hr)";
    const odd = await h.run("fork", "big", "--name", "odd", "--size", "8x16");
    expect(odd.code).toBe(3);
    expect(odd.io.errors).toEqual([`wsp fork: 8x16 is not a size this provider offers; ${list}. Name one of those with --size.`]);
    const word = await h.run("fork", "big", "--size", "large");
    expect(word.code).toBe(3);
    expect(word.io.errors).toEqual([`wsp fork: large is not a size this provider offers; ${list}. Name one of those with --size.`]);
    expect(h.backend.machines).toHaveLength(2);
    expect((await h.rt.workspaces.list()).map(w => w.name).sort()).toEqual(["big", "wide"]);

    // Without --size the golden's own size stands.
    await h.run("new", "plain");
    expect(h.backend.machines.at(-1)!.spec).toMatchObject({ cpu: 2, memMb: 4096 });
  });

  it("new --engine reaches the create's spec, and a recipe that asks for the engine gives every fork one without the flag", async () => {
    await h.run("new", "plain");
    expect(h.backend.machines.at(-1)!.spec.engine).toBeUndefined();
    const asked = await h.run("new", "eng", "--engine");
    expect(asked.code).toBe(0);
    expect(h.backend.machines.at(-1)!.spec).toMatchObject({ engine: true });
    // The sealed image's small recipe asks for the engine: a fork made without the flag gets one too.
    await h.store.put("images", "default", { ...h.RECORD(3), recipe: { version: 1, at: "2026-09-12T00:00:00.000Z", histories: [], rows: [], engine: true } });
    const viaRecipe = await h.run("new", "viarecipe");
    expect(viaRecipe.code).toBe(0);
    expect(h.backend.machines.at(-1)!.spec).toMatchObject({ engine: true });
    await h.store.delete("images", "default");
    await h.run("new", "afterwards");
    expect(h.backend.machines.at(-1)!.spec.engine).toBeUndefined();
  });

  it.runIf(CLOUD_ON)("a fork the provider refuses at the machine cap is one line naming the workspaces holding the slots, never the provider's sentence", async () => {
    await h.run("new", "first");
    await h.run("new", "t-cap");
    const create = h.backend.create.bind(h.backend);
    h.backend.create = async spec => {
      if (spec.fromSnapshot !== undefined) throw Object.assign(new Error("Too many concurrent sessions"), { kind: "concurrency", status: 429 });
      return create(spec);
    };
    withDaemonRoads(h.backend);
    const refused = await h.run("fork", "first", "--name", "f2");
    expect(refused.code).toBe(1);
    expect(refused.io.errors).toEqual(["wsp fork: both machine slots are in use: first, t-cap. Pause one or wait for a nap."]);
    expect((await h.rt.workspaces.list()).map(w => w.name).sort()).toEqual(["first", "t-cap"]);
  });

  it("threads --watch redraws the same table where it stands until Ctrl-C, on one socket", async () => {
    await h.run("new", "alpha");
    for (const word of ["threads"] as const) {
      const frames: string[] = [];
      const io: Captured = { ...captured(), redraw: { write: text => void frames.push(text), columns: () => 100 } };
      // Ctrl-C, without a real signal: one would take the test runner with it.
      const held = new Set<() => void>();
      const signals: WatchSignals = {
        on: (_s, l) => {
          held.add(l);
          return undefined;
        },
        off: (_s, l) => held.delete(l),
      };
      // Every socket this line opens to the host, counted: a watch that dialled per frame would be a number here.
      let dials = 0;
      const dial: typeof dialHost = (path, opts) => {
        dials++;
        return dialHost(path, opts);
      };
      const verb = CLI_VERBS.find(v => v.name === word)!;
      const watching = runVerb(verb, [word, "--watch", "--state", h.statePath], io, () => h.statePath, { cwd: h.dir, env: h.env, signals, dial });
      // Past the one second tick, so what is waited for is a second frame and not the first one twice over.
      await vi.waitFor(() => expect(frames.filter(f => f.includes("\n")).length).toBeGreaterThan(1), { timeout: 5_000 });
      for (const stop of [...held]) stop();
      expect(await watching, word).toBe(0);
      // The cursor comes off the screen for the frames and is back on the last write.
      expect(frames[0], word).toBe("\x1b[?25l");
      expect(frames.at(-1), word).toBe("\x1b[?25h");
      const drawn = frames.slice(1, -1);
      expect(drawn.length, word).toBeGreaterThan(1);
      expect(drawn[0], word).toContain("THREAD");
      // The first frame has nothing above it; every frame after it rewinds the rows it drew, so the table never
      // walks down the screen.
      expect(drawn[0]!.startsWith("\x1b["), word).toBe(false);
      for (const frame of drawn.slice(1)) {
        expect(frame, word).toMatch(/^\x1b\[\d+A\x1b\[G\x1b\[J/);
        expect(frame, word).toContain("THREAD");
      }
      // One socket for every frame of it, which is the whole of why the flag is worth having.
      expect(dials, word).toBe(1);
      // Nothing went to stdout as lines: a watched list is frames, and only frames.
      expect(io.lines, word).toEqual([]);
    }
  });

  it("--watch is refused off a terminal and beside --json, each in two halves, and nothing is drawn", async () => {
    await h.run("new", "alpha");
    const noTerminal = await h.run("threads", "--watch");
    expect(noTerminal.code).toBe(EXIT_CODES.usage);
    expect(noTerminal.io.errors).toEqual(["wsp threads --watch redraws where it stands, and this run has no terminal to redraw on. Run wsp threads without --watch to print the list once."]);
    expect(noTerminal.io.lines).toEqual([]);

    const io: Captured = { ...captured(), redraw: { write: () => {}, columns: () => 100 } };
    const asJson = await cli(["threads", "--watch", "--json", "--state", h.statePath], io, undefined, h.env);
    expect(asJson).toBe(EXIT_CODES.usage);
    expect(io.errors.map(l => (JSON.parse(l) as { error: string }).error)).toEqual(["wsp threads --watch redraws a table and --json answers with objects. Take one of the two: wsp threads --watch at a terminal, or wsp threads --json for the objects."]);
  });

  it.runIf(CLOUD_ON)("fork makes a sibling from the source's own golden version, by name or id, and --send opens its first thread", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    withDaemonRoads(h.backend);
    const plain = await h.run("fork", "alpha");
    expect(plain.code).toBe(0);
    const forks = (await h.rt.workspaces.list()).filter(w => w.id !== alpha!.id);
    expect(forks.map(w => [w.name, w.golden])).toEqual([["alpha-fork", alpha!.golden]]);
    // A fork is a child of the workspace it was forked from: the record says so, and a bring back from it reads
    // that parent's own branch as the base its work lands in.
    expect(forks[0]!.parentWorkspaceId).toBe(alpha!.id);
    // The fork's copy is put on the branch its source is on, and the line says so.
    expect(plain.io.lines).toEqual([`created alpha-fork ${forks[0]!.id}, a copy of ${forks[0]!.project.name} at ${forks[0]!.project.path}\n${childStartedLine("alpha-fork", "work")}`]);

    const sent = await h.run("fork", alpha!.id, "--name", "worker", "--send", "build it");
    expect(sent.code).toBe(0);
    const worker = (await h.rt.workspaces.list()).find(w => w.name === "worker")!;
    const [thread] = await h.rt.sessions.list(worker.id);
    expect(thread).toMatchObject({ harness: "claude", startedBy: "cli", prompt: "build it", status: "completed" });
    expect(sent.io.lines).toEqual([`created worker ${worker.id}, a copy of ${worker.project.name} at ${worker.project.path}\n${childStartedLine("worker", "work")}`, `thread ${thread!.threadId}  ${THREAD_PREFIX_WORD}`, "re: build it"]);
    expect(sent.io.streamed.endsWith("ready\nre: \n$ ls\nbuild it\ncompleted\n")).toBe(true);
  });

  it("run --title names the thread from the first second, in the agent's own launch and in the table", async () => {
    await h.run("new", "alpha");
    const opened = await h.run("run", "alpha", "--title", "Ticket 411 review", "build it");
    expect(opened.code).toBe(0);
    expect(h.claude.starts.at(-1)?.title).toBe("Ticket 411 review");
    const [row] = await h.rt.sessions.list();
    expect(row).toMatchObject({ harnessTitle: "Ticket 411 review", titleSource: "person" });
    const listed = await h.run("threads");
    expect(listed.io.lines.join("\n")).toContain("Ticket 411 review");
  });

  it.runIf(CLOUD_ON)("fork, run, exec and wake refuse a workspace whose machine is gone, quoting the provider, with no waking line", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    await h.handle!.close();
    h.handle = undefined;
    h.backend.machines[0]!.killed = true; // deleted at the provider while no host ran
    await h.restartHost({ claude: h.claude.adapter });
    const words = (await h.rt.workspaces.get(alpha!.id)).gone!;
    expect(words).toMatch(new RegExp(`^machine ${alpha!.machineId} is gone at the provider: the record load found it gone at \\S+Z \\(404 gone\\)$`));
    withDaemonRoads(h.backend);
    const forked = await h.run("fork", "alpha");
    expect(forked.code).toBe(1);
    expect(forked.io.errors).toEqual([`wsp fork: alpha's machine is gone with its disk, so work that was not pushed is lost; rebuild it to fork, which brings back its home folder from the last saved nap (${words})`]);
    const opened = await h.run("run", "alpha", "do it");
    expect(opened.code).toBe(1);
    expect(opened.io.errors).toEqual([`wsp run: alpha's machine is gone with its disk, so work that was not pushed is lost; rebuild it to send, which brings back its home folder from the last saved nap (${words})`]);
    const ran = await h.run("exec", "alpha", "--", "echo", "hi");
    expect(ran.code).toBe(1);
    expect(ran.io.errors).toEqual([`wsp exec: alpha's machine is gone with its disk, so work that was not pushed is lost; rebuild it to exec, which brings back its home folder from the last saved nap (${words})`]);
    // The workspace is on the listing throughout: what the machine is, is the machine's trouble to say, and no verb
    // answers for a machine by calling the workspace missing.
    expect((await h.rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);
    const woken = await h.run("wake", "alpha");
    expect(woken.code).toBe(1);
    expect(woken.io.errors).toEqual([`wsp wake: alpha's machine is gone with its disk, so work that was not pushed is lost; rebuild it to wake, which brings back its home folder from the last saved nap (${words})`]);
    expect((await h.rt.workspaces.list()).map(w => [w.name, w.phase])).toEqual([["alpha", "gone"]]);
  });

  it.runIf(CLOUD_ON)("rebuild is the road out of gone: a new machine under the same workspace, its id and state printed; a machine that answers is refused in the row's own words", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    const refused = await h.run("rebuild", "alpha");
    expect(refused.code).toBe(1);
    expect(refused.io.errors).toEqual([`wsp rebuild: ${goneRoadRefusal("running", "rebuild")}`]);
    expect(h.backend.machines).toHaveLength(1);

    await h.handle!.close();
    h.handle = undefined;
    h.backend.machines[0]!.killed = true; // deleted at the provider while no host ran
    await h.restartHost({ claude: h.claude.adapter });
    expect((await h.rt.workspaces.get(alpha!.id)).phase).toBe("gone");

    const built = await h.run("rebuild", "alpha");
    expect(built.code).toBe(0);
    expect(built.io.errors).toEqual([]);
    const after = await h.rt.workspaces.get(alpha!.id);
    expect(after).toMatchObject({ id: alpha!.id, name: "alpha", phase: "running", golden: alpha!.golden });
    expect(after.machineId).not.toBe(alpha!.machineId);
    expect(built.io.lines).toEqual([`alpha running on ${after.machineId}`]);
    // The verb every other one sends a gone workspace to now answers on it.
    const woken = await h.run("wake", "alpha");
    expect(woken.code).toBe(0);
    expect(woken.io.lines).toEqual(["alpha running"]);

    const asJson = await h.run("rebuild", "alpha", "--json");
    expect(asJson.code).toBe(1);
    expect(asJson.io.lines).toEqual([]);
    expect(asJson.io.errors.map(l => JSON.parse(l) as unknown)).toEqual([{ error: goneRoadRefusal("running", "rebuild"), class: "provider", exit: EXIT_CODES.provider }]);
    const missing = await h.run("rebuild", "nope");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp rebuild: no workspace nope"]);
    const extra = await h.run("rebuild", "alpha", "beta");
    expect(extra.code).toBe(EXIT_CODES.usage);
    expect(extra.io.errors).toEqual(["wsp rebuild takes one workspace. usage: wsp rebuild <workspace>"]);
  });

  it.runIf(CLOUD_ON)("rebuild refuses a workspace whose machine stopped answering in the words the row shows, not in the words for one that answers", async () => {
    await h.run("new", "dark");
    // Every cloud machine has an edge route, and a prompt 502 on it is the edge dialling the guest and finding
    // nothing on the daemon's port: the machine runs, the record reads running, and nothing answers on it.
    const edge = createHttpServer((_req, res) => {
      res.writeHead(502).end();
    });
    await new Promise<void>(r => edge.listen(0, "127.0.0.1", r));
    try {
      const port = (edge.address() as AddressInfo).port;
      h.backend.machines[0]!.previewUrl = async () => ({ url: `http://127.0.0.1:${port}/`, token: "stub", expiresAt: Date.now() + 3_600_000 });
      const refused = await h.run("rebuild", "dark");
      expect(refused.code).toBe(1);
      expect(refused.io.errors).toEqual([`wsp rebuild: ${notAnsweringYet("rebuild")}`]);
      // The machine the provider still holds is not replaced by a refusal.
      expect(h.backend.machines).toHaveLength(1);
    } finally {
      await new Promise<void>(r => edge.close(() => r()));
    }
  });

  it("wsp image reads the record off the seeded golden's head, says no sign-ins are held, and names the copy at this host's place", async () => {
    const listed = await h.run("image");
    expect(listed.code).toBe(0);
    const lines = listed.io.lines.join("\n").split("\n");
    expect(lines[0]).toContain("default v1");
    expect(lines[0]).toContain(IMAGE_NO_VAULT);
    expect(lines[0]).not.toContain("sign-in held");
    expect(lines[1]).toMatch(/^default  v1/);
    const [view] = h.json((await h.run("image", "--json")).io) as [{ image: { version: number; vault?: unknown }; copies: { place: string }[] }];
    expect(view.image.version).toBe(1);
    expect(view.image.vault).toBeUndefined();
    expect(view.copies.map(c => c.place)).toEqual(["default"]);
  });

  it("wsp image lists what each row installed at the seal under the copies, by the catalog's name, with the checksum where a road recorded one and the latest mark in the road's words", async () => {
    const pins = [
      { id: "claude", tag: "2.1.3", latest: true as const, road: "script" },
      { id: "gh", tag: "v2.86.0", sha256: "b".repeat(64), road: "release" },
      { id: "wrangler", tag: "4.1.0", road: "npm" },
      { id: "tools/brew/zingzy/tap/diskbloom", tag: "0.1.0", latest: true as const, road: "brew" },
    ];
    await h.store.put("images", "default", { ...h.RECORD(3), pins });
    const listed = await h.run("image");
    expect(listed.code).toBe(0);
    const lines = listed.io.lines.join("\n").split("\n");
    expect(lines.slice(2)).toEqual([
      "  Claude Code  2.1.3  installs latest by its own installer",
      "  GitHub CLI  v2.86.0  checksum bbbbbbbbbbbb",
      "  Cloudflare Wrangler  4.1.0",
      "  zingzy/tap/diskbloom  0.1.0  installs latest with Homebrew",
    ]);
    const [view] = h.json((await h.run("image", "--json")).io) as [{ image: { pins: unknown } }];
    expect(view.image.pins).toEqual(pins);
  });

  it.runIf(CLOUD_ON)("wsp image build refuses in one line for a place this host has not got and a place that takes no copy; the place it forks on is a place like any other", async () => {
    // Three places over one host: the one it forks on, one more that could build, and this computer, which forks
    // nothing and copies no disk.
    const elsewhere = stubBackend();
    const here = new NoProviderBackend();
    await h.restartHost(
      {},
      h.store,
      { wired: "default", backend: p => (p === "default" ? h.backend : p === "elsewhere" ? elsewhere : p === "here" ? here : undefined), list: () => ["default", "elsewhere", "here"] },
    );

    const nowhere = await h.run("image", "build", "nowhere");
    expect(nowhere.code).toBe(1);
    expect(nowhere.io.errors.join("")).toContain("no place named nowhere");

    // The provider this host forks on takes a copy build too; this record was backfilled off its own golden and
    // carries no recipe, so the build stops at the record and boots nothing.
    const wired = await h.run("image", "build", "default");
    expect(wired.code).toBe(1);
    expect(wired.io.errors.join("")).toContain("was sealed before the image record kept the recipe");

    const cannot = await h.run("image", "build", "here");
    expect(cannot.code).toBe(1);
    expect(cannot.io.errors.join("")).toContain(placeBuildsNoImageLine((await h.rt.places!.rows()).find(p => p.id === HERE_PLACE_ID)!.name));

    // Nothing was forked at any of them, and this computer was never read for a recipe.
    expect(elsewhere.machines).toEqual([]);

    const usage = await h.run("image", "build");
    expect(usage.code).toBe(EXIT_CODES.usage);
    expect(usage.io.errors.join("")).toContain("wsp image build takes one place.");
  });

  it.runIf(CLOUD_ON)("wsp image build on a host that has sealed nothing says so, whatever place is named", async () => {
    const elsewhere = stubBackend();
    await h.restartHost({}, memoryStore(), {
      wired: "default",
      backend: p => (p === "default" ? h.backend : p === "elsewhere" ? elsewhere : undefined),
      list: () => ["default", "elsewhere"],
    });
    const none = await h.run("image", "build", "elsewhere");
    expect(none.code).toBe(1);
    expect(none.io.errors.join("")).toContain("this host owns no image named default yet");
    expect(elsewhere.machines).toEqual([]);
  });

  it.runIf(CLOUD_ON)("wsp image export refuses a record with no sign-ins to export, and says so rather than writing an empty file", async () => {
    h.env[IMAGE_PASSPHRASE_ENV] = "a-long-enough-passphrase";
    const dest = join(h.dir, "image.wsp");
    const refused = await h.run("image", "export", dest);
    expect(refused.code).not.toBe(0);
    expect(refused.io.errors.at(-1)).toContain("sealed before its sign-ins were held");
    expect(existsSync(dest)).toBe(false);
  });

  it.runIf(CLOUD_ON)("wsp image export writes one file whose header parses and whose body the passphrase opens back to the vault", async () => {
    const tar = Buffer.from("the person's sign-ins as the seal took them");
    const record = h.RECORD(tar.length);
    await h.store.put("images", "default", record);
    await h.store.putBlob("image-vaults", "default@v1", tar);
    h.env[IMAGE_PASSPHRASE_ENV] = "a-long-enough-passphrase";
    const dest = join(h.dir, "out", "image.wsp");
    const done = await h.run("image", "export", dest);
    expect(done.code).toBe(0);
    const bytes = readFileSync(dest);
    expect(JSON.parse(bytes.subarray(0, bytes.indexOf(0x0a)).toString("utf8"))).toMatchObject({ format: "wsp-vault-1", to: "passphrase" });
    // A login the copy road put on the machine counts as held, as one signed in there does.
    expect((await h.run("image")).io.lines.join("\n")).toContain("1 sign-in held, 2 paths");
    const opened = passphraseCipher.open(bytes, "a-long-enough-passphrase");
    expect(opened.plain.equals(tar)).toBe(true);
    expect(opened.image).toEqual(record);
    expect(bytes.includes(tar)).toBe(false);
    expect(done.io.lines.at(-1)).toContain(dest);
  });

  it.runIf(CLOUD_ON)("wsp image export asks the passphrase twice at a terminal, and refuses when the second does not match", async () => {
    const tar = Buffer.from("the person's sign-ins as the seal took them");
    await h.store.put("images", "default", h.RECORD(tar.length));
    await h.store.putBlob("image-vaults", "default@v1", tar);
    const asks: string[] = [];
    const typed = async (...answers: string[]): Promise<{ code: number; io: Captured }> => {
      const io = captured();
      io.isTTY = true;
      io.askSecret = async q => {
        asks.push(q.split("\n")[0]!);
        return answers[asks.length - 1] ?? "";
      };
      return { code: await cli(["image", "export", join(h.dir, `${asks.length}-out.wsp`), "--state", h.statePath], io, undefined, h.env), io };
    };
    const mismatched = await typed("a-long-enough-passphrase", "a-different-passphrase");
    expect(mismatched.code).toBe(EXIT_CODES.usage);
    expect(asks).toEqual(["A passphrase for this export", "The same passphrase again"]);
    expect(mismatched.io.errors.at(-1)).toContain("the two passphrases are not the same");

    asks.length = 0;
    const short = await typed("short", "short");
    expect(short.code).toBe(EXIT_CODES.usage);
    expect(asks).toEqual(["A passphrase for this export"]);
    expect(short.io.errors.at(-1)).toContain(`${IMAGE_PASSPHRASE_MIN} characters at least`);

    asks.length = 0;
    const done = await typed("a-long-enough-passphrase", "a-long-enough-passphrase");
    expect(done.code).toBe(0);
    expect(asks).toEqual(["A passphrase for this export", "The same passphrase again"]);
  });

  it.runIf(CLOUD_ON)("wsp image export aimed at a host on another computer is answered here, and nothing of this computer's crosses to it", async () => {
    // A host this computer really holds, so the answer is the sentence and not the refusal for a name nobody knows.
    // The aim reads the home off the run's own environment, which this file hands every verb.
    h.env["WSP_HOME"] = join(h.dir, "home");
    writeHost(join(h.dir, "home"), "box", { url: "http://box.local:4400", deviceId: "d_box", deviceToken: "tok-box", hostKey: HOST_KEY, pairedAt: "2026-09-11T10:00:00.000Z", via: { kind: "account", hostId: "hbox" } });
    const dest = join(h.dir, "elsewhere.wsp");
    const line = `${hostSideOnlyLine("image export", "box")} ${hostSideOnlyFix(HOST_SIDE_VAULT)}`;
    // Every way a line is aimed reads the same: the flag and the variable.
    const flagged = await h.run("image", "export", dest, "--host", "box");
    expect(flagged.code).toBe(EXIT_CODES.usage);
    expect(flagged.io.errors.at(-1)).toBe(line);

    h.env["WSP_HOST"] = "box";
    const named = await h.run("image", "export", dest);
    expect(named.code).toBe(EXIT_CODES.usage);
    expect(named.io.errors.at(-1)).toBe(line);
    delete h.env["WSP_HOST"];

    expect(existsSync(dest)).toBe(false);
    delete h.env["WSP_HOME"];
    // Only the export is held here: wsp image is a reading and answers against whichever host the line names.
    expect(CLI_VERBS.filter(v => "hostSide" in v && v.hostSide !== undefined).map(v => v.name)).toEqual(["agents key", "image export"]);
  });

  it.runIf(CLOUD_ON)("wsp image export with nobody at the terminal and no passphrase in the environment refuses before anything is read", async () => {
    const refused = await h.run("image", "export", join(h.dir, "image.wsp"));
    expect(refused.code).toBe(EXIT_CODES.usage);
    expect(refused.io.errors.at(-1)).toContain(IMAGE_PASSPHRASE_ENV);
  });

  it.runIf(CLOUD_ON)("wsp image export refuses a passphrase under the minimum, and a destination that already holds something", async () => {
    h.env[IMAGE_PASSPHRASE_ENV] = "short";
    const tooShort = await h.run("image", "export", join(h.dir, "image.wsp"));
    expect(tooShort.code).toBe(EXIT_CODES.usage);
    expect(tooShort.io.errors.at(-1)).toContain(`${IMAGE_PASSPHRASE_MIN} characters at least`);

    const taken = join(h.dir, "taken.wsp");
    writeFileSync(taken, "mine");
    h.env[IMAGE_PASSPHRASE_ENV] = "a-long-enough-passphrase";
    const refused = await h.run("image", "export", taken);
    expect(refused.code).not.toBe(0);
    expect(readFileSync(taken, "utf8")).toBe("mine");
  });

  it.runIf(CLOUD_ON)("image move puts the workspace on the newest version, says up front what moves, and names the files of the image's own it kept", async () => {
    const sha = (c: string): string => c.repeat(64);
    const v1 = { ...h.head(SEALED_GOLDEN), owned: [{ path: ".zshrc", sha256: sha("1") }, { path: ".gitconfig", sha256: sha("2") }] };
    await h.store.put("goldens", copyKey("default", "default"), { head: 1, versions: [v1] });
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    // The fork rewrote its own gitconfig and left the image's zshrc as it was.
    h.backend.execImpl = (m, cmd) =>
      cmd.includes("xargs -0 -r sha256sum") ? { exitCode: 0, stdout: `${sha("1")}  .zshrc\n${sha("f")}  .gitconfig\n`, stderr: "" } : guestAnswer(cmd);
    await h.store.put("goldens", copyKey("default", "default"), {
      head: 2,
      versions: [v1, { ...v1, version: 2, snapshotId: "snap_gold2", owned: [{ path: ".zshrc", sha256: sha("9") }, { path: ".gitconfig", sha256: sha("2") }] }],
    });

    const moved = await h.run("image", "move", "alpha");
    expect(moved.io.errors).toEqual([IMAGE_MOVE_CONFIRM]);
    expect(moved.code).toBe(0);
    // Said once the workspace resolved, so a name nothing here holds hears the refusal alone.
    expect((await h.run("image", "move", "nope")).io.errors).toEqual(["wsp image move: no workspace nope"]);
    const after = await h.rt.workspaces.get(alpha!.id);
    expect(after).toMatchObject({ id: alpha!.id, name: "alpha", phase: "running", golden: "snap_gold2" });
    expect(moved.io.lines).toEqual([`alpha running on ${after.machineId}; ${imageKeptLine([".gitconfig"])}`]);

    // The answer says for itself whether a machine was replaced, so an agent reading the object never has to compare
    // the image it read a moment before against the one it got back.
    const asJson = await h.run("image", "move", "alpha", "--json");
    expect(h.json(asJson.io)).toEqual([{ workspace: expect.objectContaining({ golden: "snap_gold2" }), moved: false, kept: [] }]);
    // Nothing to move to now, and the line says that rather than claiming the image's files came across.
    const again = await h.run("image", "move", "alpha");
    expect(again.code).toBe(0);
    expect(again.io.lines).toEqual([`alpha running on ${after.machineId}; ${IMAGE_ALREADY_NEWEST}`]);
    const extra = await h.run("image", "move", "alpha", "beta");
    expect(extra.code).toBe(EXIT_CODES.usage);
    expect(extra.io.errors.at(-1)).toBe("wsp image move takes one workspace. usage: wsp image move <workspace>");
  });

  it.runIf(CLOUD_ON)("fork's help says it makes a new machine from the source's image version, on the agent page and in wsp fork --help", async () => {
    const line = "a new machine from the source's image version";
    expect(agentPage()).toContain(line);
    const { code, io } = await h.run("fork", "--help");
    expect(code).toBe(0);
    expect(io.lines[0]).toContain(line);
  });

  it("wsp init --help names the screens of the wizard in order, as it draws them, with no count since a screen with nothing to pick is not shown", () => {
    const init = commandPage("init", COMMANDS_FOR_HELP["init"]!).replace(/\s+/g, " ");
    expect(init).not.toMatch(/(three|five|six) screens/);
    expect(init).toContain("one screen at a time: Agents, Tools, Also on this computer, Sign-ins, wsp for your agents on this computer, each shown when it has a row to pick, then Build");
    // The road a run that asks nothing takes is a question the screens ask a person; the flag is how the answer is given.
    expect(init).toContain("--rebuild");
    expect(init).toContain("seal the next version from a fresh machine rather than from your image plus the changes");
  });

  it("every line of wsp --help fits 100 columns", () => {
    const wide = HELP.split("\n").filter(l => l.length > 100);
    expect(wide).toEqual([]);
  });

  it("pause naps the workspace and says so in the state vocabulary", async () => {
    await h.run("new", "alpha");
    const { code, io } = await h.run("pause", "alpha");
    expect(code).toBe(0);
    expect(io.lines).toEqual(["alpha paused"]);
    expect((await h.rt.workspaces.list())[0]!.phase).toBe("napping");
    const missing = await h.run("pause", "nope");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp pause: no workspace nope"]);
  });

  it("pause on a machine the provider will not pause refuses with the sentence that says why, class provider, in one stderr line, and --json carries it", async () => {
    await h.run("new", "alpha");
    const m = h.backend.machines[0]!;
    m.pause = async () => {
      throw new NapRefusedError(m.id, "Not pausable");
    };
    const refused = await h.run("pause", "alpha");
    expect(refused.code).toBe(EXIT_CODES.provider);
    expect(refused.io.lines).toEqual([]);
    expect(refused.io.errors).toEqual([`wsp pause: ${napRefusedLine("Not pausable")}`]);
    const asJson = await h.run("pause", "alpha", "--json");
    expect(asJson.code).toBe(EXIT_CODES.provider);
    expect(asJson.io.lines).toEqual([]);
    expect(asJson.io.errors.map(l => JSON.parse(l) as unknown)).toEqual([{ error: napRefusedLine("Not pausable"), class: "provider", exit: EXIT_CODES.provider }]);
    expect((await h.rt.workspaces.list())[0]!.phase).toBe("running");
  });

  it("wake wakes a paused workspace, one line on stderr while it does, and prints its state after; on a running one the runtime is asked and the state printed is the one read", async () => {
    await h.run("new", "alpha");
    await h.run("pause", "alpha");
    const woken = await h.run("wake", "alpha");
    expect(woken.code).toBe(0);
    expect(woken.io.errors).toEqual(["waking alpha"]);
    expect(woken.io.lines).toEqual(["alpha running"]);
    expect((await h.rt.workspaces.list())[0]!.phase).toBe("running");
    expect(h.backend.machines[0]!.paused).toBe(false);
    const again = await h.run("wake", "alpha", "--json");
    expect(again.code).toBe(0);
    expect(again.io.errors).toEqual([]);
    expect(h.json(again.io)).toEqual([{ workspace: expect.objectContaining({ name: "alpha", phase: "running" }) }]);
    const plain = await h.run("wake", "alpha");
    expect(plain.io.lines).toEqual(["alpha running"]);
    const missing = await h.run("wake", "nope");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp wake: no workspace nope"]);
  });

  it("wake says a machine that came up and answers nothing is up and not answering yet", async () => {
    await h.run("new", "alpha");
    await h.run("pause", "alpha");
    const edge = createHttpServer((_req, res) => {
      res.writeHead(502).end();
    });
    await new Promise<void>(r => edge.listen(0, "127.0.0.1", r));
    try {
      const port = (edge.address() as AddressInfo).port;
      h.backend.machines[0]!.previewUrl = async () => ({ url: `http://127.0.0.1:${port}/`, token: "stub", expiresAt: Date.now() + 3_600_000 });
      const woken = await h.run("wake", "alpha");
      expect(woken.code).toBe(0);
      // The provider started it, so the phase alone would say running; nothing on it answers, so the table says
      // Unreachable, and the wake says the same thing in a sentence rather than a second word for one machine.
      expect(woken.io.lines).toEqual(["alpha is up and not answering yet"]);
    } finally {
      await new Promise<void>(r => edge.close(() => r()));
    }
  });

  it("a machine the provider paused on its own, under a record that says running, is woken by wake and by exec: the runtime's one state read settles it", async () => {
    await h.run("new", "alpha");
    h.backend.machines[0]!.paused = true;
    execGuest(h.backend, "awake-ok\n", 0);
    const ran = await h.run("exec", "alpha", "--", "echo", "awake-ok");
    expect(ran.code).toBe(0);
    expect(ran.io.lines).toEqual(["awake-ok"]);
    expect(h.backend.machines[0]!.paused).toBe(false);
    h.backend.machines[0]!.paused = true;
    const woken = await h.run("wake", "alpha");
    expect(woken.code).toBe(0);
    expect(woken.io.lines).toEqual(["alpha running"]);
    expect(woken.io.errors).toEqual([]);
    expect(h.backend.machines[0]!.paused).toBe(false);
    expect((await h.rt.workspaces.list())[0]!.phase).toBe("running");
  });

  /** The host again with this ssh door in place of the relay's, which reaches no machine the stub backend makes. */
  async function withSsh(ssh: HostSsh): Promise<void> {
    await h.handle?.close();
    h.handle = await serve(captured(), { port: 0, statePath: h.statePath, webDir: join(h.dir, "web"), runtime: h.rt, ssh });
  }
  /** wsp ssh as an ssh client runs it, with these bytes on its stdin and its stdout read whole. */
  async function sshLine(ref: string, typed: string): Promise<{ code: number; io: Captured; said: string }> {
    const io = captured();
    const input = new PassThrough();
    const output = new PassThrough();
    const got: Buffer[] = [];
    output.on("data", (d: Buffer) => got.push(d));
    io.bytes = { input, output };
    const ended = cli(["ssh", ref, "--state", h.statePath], io, undefined, h.env);
    input.end(typed);
    return { code: await ended, io, said: Buffer.concat(got).toString() };
  }

  it("ssh pipes its stdin and stdout to the workspace's ssh server through the port the host answers, the workspace named by its alias", async () => {
    await h.run("new", "Cart rounding");
    const echo = createServer(c => {
      c.on("data", d => c.write(`echo: ${String(d)}`));
      c.on("end", () => c.end());
    });
    await new Promise<void>(r => echo.listen(0, "127.0.0.1", r));
    const asked: string[] = [];
    await withSsh({ port: async w => (asked.push(w.name), (echo.address() as AddressInfo).port), include: async () => false, setInclude: async on => on });
    try {
      const { code, io, said } = await sshLine("wsp-cart-rounding", "SSH-2.0-OpenSSH_9.6\r\n");
      expect({ code, said, lines: io.lines, errors: io.errors }).toEqual({ code: 0, said: "echo: SSH-2.0-OpenSSH_9.6\r\n", lines: [], errors: [] });
      expect(asked).toEqual(["Cart rounding"]);
      // Its name works as every other verb's does.
      expect((await sshLine("Cart rounding", "again")).said).toBe("echo: again");
    } finally {
      echo.close();
    }
  });

  it("ssh refuses an alias two workspaces go by, naming both, and writes nothing on stdout", async () => {
    await h.run("new", "Cart rounding");
    await h.run("new", "cart-rounding");
    const asked: string[] = [];
    await withSsh({ port: async w => (asked.push(w.name), 1), include: async () => false, setInclude: async on => on });
    const { code, io, said } = await sshLine("wsp-cart-rounding", "SSH-2.0\r\n");
    const ids = (await h.rt.workspaces.list()).map(w => w.id);
    expect(code).toBe(EXIT_CODES.usage);
    expect(said).toBe("");
    expect(io.lines).toEqual([]);
    for (const id of ids) expect(io.errors.join("\n")).toContain(id);
    expect(asked).toEqual([]);
  });

  it("ssh with no terminal of this computer's to pipe, as on a line carried from a machine, says so and asks the host nothing", async () => {
    await h.run("new", "Cart rounding");
    const asked: string[] = [];
    await withSsh({ port: async w => (asked.push(w.name), 1), include: async () => false, setInclude: async on => on });
    const io = captured();
    expect(await cli(["ssh", "wsp-cart-rounding", "--state", h.statePath], io, undefined, h.env)).toBe(EXIT_CODES.usage);
    expect(io.errors.join("\n")).toContain(SSH_PIPES_HERE_LINE);
    expect(asked).toEqual([]);
  });

  it("writes an ssh config OpenSSH runs on the host's own state, however that state's path is spelled", async () => {
    await h.handle?.close();
    const served = join(h.dir, `it's a "quoted" 100%h state`, "state.json");
    h.handle = await serve(captured(), { port: 0, statePath: served, webDir: join(h.dir, "web"), runtime: h.rt });
    // The include goes into the person's own ~/.ssh/config, under the home this file stubs, which a person always has.
    mkdirSync(join(h.dir, "user"), { recursive: true });
    const client = await dialHost(served);
    try {
      expect(await client.request("ssh.include", { on: true })).toMatchObject({ sshInclude: true });
    } finally {
      client.close();
    }
    const config = join(h.dir, "home", "ssh_config");
    const written = readFileSync(config, "utf8");
    const wsp = `ProxyCommand ${shellLine(wspArgvOf(runningWsp())).replaceAll("%", "%%")} `;
    expect(written).toContain(wsp);
    // The words that run wsp are this test process's own; a stub that prints its arguments takes their place, so what
    // OpenSSH hands the command after them is read back as it arrived.
    const said = join(h.dir, "argv");
    const printer = writeStub(join(h.dir, "print-argv"), `#!/bin/sh\nfor a; do printf '%s\\n' "$a"; done > ${shellLine([said])}\n`);
    writeFileSync(config, written.replace(wsp, `ProxyCommand ${shellLine([printer]).replaceAll("%", "%%")} `));
    spawnSync("ssh", ["-F", config, "-o", "BatchMode=yes", "wsp-cart-rounding", "true"], { env: { ...TEST_ENV, PATH: process.env["PATH"], HOME: join(h.dir, "user") }, encoding: "utf8", timeout: 20_000 });
    expect(readFileSync(said, "utf8").split("\n").slice(0, -1)).toEqual(["--state", served, "ssh", "wsp-cart-rounding"]);
  });

  it("exec on a paused workspace wakes it first, says so on stderr, then runs the command; a running one is not woken", async () => {
    await h.run("new", "alpha");
    await h.run("pause", "alpha");
    execGuest(h.backend, "awake-ok\n", 0);
    const { code, io } = await h.run("exec", "alpha", "--", "echo", "awake-ok");
    expect(code).toBe(0);
    expect(io.errors).toEqual(["waking alpha"]);
    expect(io.lines).toEqual(["awake-ok"]);
    expect((await h.rt.workspaces.list())[0]!.phase).toBe("running");
    const again = await h.run("exec", "alpha", "--", "echo", "awake-ok");
    expect(again.code).toBe(0);
    expect(again.io.errors).toEqual([]);
  });

  it("a record that says paused while the provider runs the machine: exec goes on without a resume and the store ends running; pause pauses for real", async () => {
    await h.run("new", "alpha");
    await h.run("pause", "alpha");
    const m = h.backend.machines[0]!;
    // The nap never took at the provider, and a resume on a running machine is refused.
    const runningAtProvider = (): void => {
      m.paused = false;
      m.resume = async () => {
        throw Object.assign(new Error("Sandbox is not paused"), { kind: "conflict", status: 409 });
      };
    };
    runningAtProvider();
    execGuest(h.backend, "awake-ok\n", 0);
    const ran = await h.run("exec", "alpha", "--", "echo", "awake-ok");
    expect(ran.code).toBe(0);
    expect(ran.io.lines).toEqual(["awake-ok"]);
    const [alpha] = await h.rt.workspaces.list();
    expect(alpha!.phase).toBe("running");
    expect(await h.store.get("workspaces", alpha!.id)).toMatchObject({ phase: "running" });

    await h.run("pause", "alpha");
    expect(m.paused).toBe(true);
    runningAtProvider();
    const paused = await h.run("pause", "alpha");
    expect(paused.code).toBe(0);
    expect(paused.io.lines).toEqual(["alpha paused"]);
    expect(m.paused).toBe(true);
    expect((await h.rt.workspaces.list())[0]!.phase).toBe("napping");
  });

  it("run and send on a paused workspace wake it first, one line on stderr, then run the turn", async () => {
    await h.run("new", "alpha");
    await h.run("pause", "alpha");
    const opened = await h.run("run", "alpha", "hello");
    expect(opened.code).toBe(0);
    expect(opened.io.errors).toEqual(["waking alpha"]);
    expect(opened.io.lines[1]).toBe("re: hello");
    const [row] = await h.rt.sessions.list();
    await h.run("pause", "alpha");
    const sent = await h.run("send", row!.threadId!, "again");
    expect(sent.code).toBe(0);
    expect(sent.io.errors).toEqual(["waking alpha"]);
    expect(sent.io.lines).toEqual(["re: again"]);
    expect((await h.rt.workspaces.list())[0]!.phase).toBe("running");
  });

  it("rename names the workspace and prints both names; a name another workspace holds and a blank one are refused and nothing is renamed", async () => {
    await h.run("new", "alpha");
    await h.run("new", "beta");
    const alpha = (await h.rt.workspaces.list()).find(w => w.name === "alpha")!;

    const named = await h.run("rename", "alpha", "the name he typed");
    expect(named.code).toBe(0);
    expect(named.io.lines).toEqual([`alpha is now the name he typed ${alpha.id}`]);
    expect((await h.rt.workspaces.list()).map(w => w.name).sort()).toEqual(["beta", "the name he typed"]);
    // The name is how a workspace is addressed, so every later verb takes the one it now carries.
    expect((await h.run("pause", "the name he typed")).io.lines).toEqual(["the name he typed paused"]);

    const taken = await h.run("rename", "beta", "the name he typed");
    expect(taken.code).toBe(1);
    expect(taken.io.errors).toEqual(["wsp rename: the name he typed is already a workspace; pick another name, or delete it first"]);
    const blank = await h.run("rename", "beta", "  ");
    expect(blank.code).toBe(1);
    expect(blank.io.errors).toEqual(["wsp rename: a workspace name cannot be blank"]);
    expect((await h.rt.workspaces.list()).map(w => w.name).sort()).toEqual(["beta", "the name he typed"]);

    const asJson = await h.run("rename", "beta", "gamma", "--json");
    expect(asJson.code).toBe(0);
    expect(h.json(asJson.io)).toMatchObject([{ was: "beta", workspace: { name: "gamma" } }]);

    const missing = await h.run("rename", "nope", "a");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp rename: no workspace nope"]);
    const short = await h.run("rename", "gamma");
    expect(short.code).toBe(3);
    expect(short.io.errors).toEqual(["wsp rename takes a workspace and one name. usage: wsp rename <workspace> \"<name>\""]);
  });

  it("forget asks once, naming what goes, drops a workspace whose machine is gone, and is refused with the reason while the machine exists", async () => {
    await h.run("new", "alpha");
    await h.run("new", "beta");
    await h.run("run", "alpha", "build it");
    const alpha = (await h.rt.workspaces.list()).find(w => w.name === "alpha")!;
    const live = await h.run("forget", "alpha", "--yes");
    expect(live.code).toBe(1);
    expect(live.io.errors).toEqual(["wsp forget: alpha's machine m1 is still running; pause it or delete it at the provider first"]);
    expect((await h.rt.workspaces.list()).map(w => w.name).sort()).toEqual(["alpha", "beta"]);

    h.backend.machines[0]!.killed = true;
    const kept = await h.answer("no", "forget", "alpha");
    expect(kept.code).toBe(1);
    expect(kept.io.errors).toEqual(["alpha kept"]);
    expect(h.asked).toEqual(["Forget alpha?\nIts record and 1 thread leave this computer; the computer it ran on is already gone."]);
    expect((await h.rt.workspaces.list()).map(w => w.name).sort()).toEqual(["alpha", "beta"]);

    const forgot = await h.answer("yes", "forget", alpha.id);
    expect(forgot.code).toBe(0);
    expect(forgot.io.lines).toEqual([`forgot alpha ${alpha.id}: its record and 1 thread are gone from this computer`]);
    expect(forgot.io.errors).toEqual([]);
    expect((await h.rt.workspaces.list()).map(w => w.name)).toEqual(["beta"]);
    expect(await h.rt.sessions.list(alpha.id)).toEqual([]);
    expect(await h.store.get("workspaces", alpha.id)).toBeUndefined();
    expect(await h.store.get("transcripts", alpha.id)).toBeUndefined();

    h.backend.machines[1]!.killed = true;
    const beta = (await h.rt.workspaces.list())[0]!;
    const asJson = await h.run("forget", "beta", "--yes", "--json");
    expect(asJson.code).toBe(0);
    expect(h.json(asJson.io)).toEqual([{ workspaceId: beta.id, name: "beta", threads: 0 }]);
    expect(await h.rt.workspaces.list()).toEqual([]);

    const missing = await h.run("forget", "nope", "--yes");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp forget: no workspace nope"]);
  });

  it("the delete question and its line say what the delete does to this kind's machine", () => {
    const workspace = { id: "ws_mine", name: "box", machineId: "m_ab12", phase: "running", kind: "cloud", golden: "", createdAt: "2026-09-08T00:00:00.000Z", project: { id: "pr_1", name: "api", path: "/root/api", computer: "default" } } as const;
    // This computer took no daemon of wsp's and no line in a login file, so nothing comes off it.
    const here = { ...workspace, kind: "local", machineId: "local" } as const;
    expect(deleteQuestion({ workspace: here, threads: 1 })).toBe("Delete box?\nIts computer is left as it is; its record and 1 thread leave this computer.");
    expect(deletedLine({ workspace: here, threads: 1 })).toBe("deleted box ws_mine: its computer is left as it is, and its record and 1 thread are gone from this computer");
    // A record of a worktree wsp made takes the worktree with it; the project folder stays.
    const copied = { ...here, worktree: { path: "/Users/dev/api-fix", branch: "fix", made: true } } as const;
    expect(deleteQuestion({ workspace: copied, threads: 1 })).toBe("Delete box?\nIts worktree at /Users/dev/api-fix is removed and the project folder is left as it is; its record and 1 thread leave this computer.");
    expect(deletedLine({ workspace: copied, threads: 1 })).toBe("deleted box ws_mine: its worktree at /Users/dev/api-fix is removed and the project folder is left as it is, and its record and 1 thread are gone from this computer");
    // A fork is wsp's to take away, and its line still names the machine that goes.
    expect(deletedLine({ workspace, threads: 0 })).toBe("deleted box ws_mine: computer m_ab12 is gone in the cloud, and its record and 0 threads are gone from this computer");
  });

  it("a copy on a computer somebody joined is deleted from that computer by the names a person knows, never the cloud or the machine's id", async () => {
    const onSpoo = { id: "ws_fix", name: "fix-login", machineId: "wsp-workspace-ws_fix", phase: "running", kind: "cloud", place: "p_spoo", golden: "", createdAt: "2026-09-27T00:00:00.000Z", project: { id: "pr_1", name: "api", path: "/root/api", computer: "p_spoo" } };
    const spoo = { id: "p_spoo", kind: "computer", name: "spoo", default: false };
    const answers: Record<string, unknown> = { "workspaces.resolve": { workspace: onSpoo }, "sessions.list": { sessions: [] }, "places.list": { places: [spoo] } };
    const client = { request: async (op: string) => (answers[op] ?? Promise.reject(new Error(`no ${op}`))) as never } as unknown as HostClient;
    const d = await deleting(client, "fix-login");
    expect(deleteQuestion(d)).toBe("Delete fix-login?\nIts copy on spoo is deleted; its record and 0 threads leave this computer.");
    expect(deletedLine(d)).toBe("deleted fix-login ws_fix: fix-login is deleted from spoo, and its record and 0 threads are gone from this computer");
    // A caller that may not read the computers' names still never reads the machine's id.
    const unread = { request: async (op: string) => (op === "places.list" ? Promise.reject(new Error("not yours to read")) : answers[op]) as never } as unknown as HostClient;
    expect(deleteQuestion(await deleting(unread, "fix-login"))).toBe("Delete fix-login?\nIts copy on that computer is deleted; its record and 0 threads leave this computer.");
    // A fork at another provider's account is a cloud machine, and its delete takes the cloud's words.
    const cloudPlace = { id: "p_spoo", kind: "provider", name: "ascii", default: false };
    const atCloud = { request: async (op: string) => (op === "places.list" ? { places: [cloudPlace] } : answers[op]) as never } as unknown as HostClient;
    expect(deleteQuestion(await deleting(atCloud, "fix-login"))).not.toContain("copy on");
  });

  it("delete asks once in the words the app shows, kills the machine at the provider, and drops the record and its threads", async () => {
    await h.run("new", "alpha");
    await h.run("new", "beta");
    await h.run("run", "alpha", "build it");
    const alpha = (await h.rt.workspaces.list()).find(w => w.name === "alpha")!;

    // A thread on the machine, by a prefix of its id, goes with its machine, and the line says so.
    const threadId = (await h.rt.sessions.list(alpha.id))[0]!.threadId!;
    const byThread = await h.run("delete", threadId.slice(0, 8), "--yes");
    expect(byThread.code).toBe(EXIT_CODES.usage);
    expect(byThread.io.errors).toEqual(["wsp delete: a thread on alpha goes with its machine; wsp delete alpha takes both"]);
    expect(h.backend.machines[0]!.killed).toBe(false);

    const kept = await h.answer("no", "delete", "alpha");
    expect(kept.code).toBe(1);
    expect(kept.io.errors).toEqual(["alpha kept"]);
    expect(h.asked).toEqual([`Delete alpha?\nIts computer is deleted in the cloud; its record and 1 thread leave this computer.`]);
    expect((await h.rt.workspaces.list()).map(w => w.name).sort()).toEqual(["alpha", "beta"]);
    expect(h.backend.machines[0]!.killed).toBe(false);

    const deleted = await h.answer("yes", "delete", alpha.id);
    expect(deleted.code).toBe(0);
    expect(deleted.io.errors).toEqual([]);
    expect(deleted.io.lines).toEqual([
      `deleted alpha ${alpha.id}: computer ${alpha.machineId} is gone in the cloud, and its record and 1 thread are gone from this computer`,
    ]);
    expect(h.backend.machines[0]!.killed).toBe(true);
    expect((await h.rt.workspaces.list()).map(w => w.name)).toEqual(["beta"]);
    expect(await h.rt.sessions.list(alpha.id)).toEqual([]);
    expect(await h.store.get("workspaces", alpha.id)).toBeUndefined();

    const beta = (await h.rt.workspaces.list())[0]!;
    const asJson = await h.run("delete", "beta", "--yes", "--json");
    expect(asJson.code).toBe(0);
    expect(h.json(asJson.io)).toEqual([{ workspaceId: beta.id, name: "beta", machineId: beta.machineId, threads: 0 }]);
    expect(h.backend.machines[1]!.killed).toBe(true);
    expect(await h.rt.workspaces.list()).toEqual([]);

    const missing = await h.run("delete", "nope", "--yes");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp delete: no workspace nope"]);
  });

  it("delete by name takes away a create the provider refused, in words that name no computer going", async () => {
    h.backend.create = async () => {
      throw Object.assign(new Error("Snapshot not found"), { kind: "missing", status: 404 });
    };
    expect((await h.run("new", "fleet-check")).code).not.toBe(0);
    const kept = await h.answer("no", "delete", "fleet-check");
    expect(kept.code).toBe(1);
    expect(h.asked).toEqual(["Delete fleet-check?\nIts create failed before any computer was made, so there is none to delete; its record and 0 threads leave this computer."]);

    const deleted = await h.run("delete", "fleet-check", "--yes");
    expect(deleted.code).toBe(0);
    expect(deleted.io.lines).toEqual([expect.stringMatching(/^deleted fleet-check ws_[0-9a-f]+: its create had made no computer, and its record and 0 threads are gone from this computer$/)]);
    expect((await h.run("delete", "fleet-check", "--yes")).io.errors).toEqual(["wsp delete: no workspace fleet-check"]);
  });

  it("forget and delete named a project's folder on this computer refuse it and send the person to its threads", async () => {
    await h.macProject("mac");
    const here = (await h.rt.workspaces.list())[0]!;
    for (const verb of ["forget", "delete"]) {
      const said = await h.run(verb, "mac", "--yes");
      expect(said.code).toBe(3);
      expect(said.io.errors[0]).toContain(localFolderRefusal("mac"));
    }
    expect((await h.rt.workspaces.list()).map(w => w.id)).toEqual([here.id]);
  });

  /** The prompt the persona's turn stopped on, as the claude adapter's control channel hands one over: a command to
   * run, with allow, deny and the mode the harness offers beside them. */
  const RUN_ASK: PermissionAsk = {
    askId: "ask_1",
    toolName: "Bash",
    input: JSON.stringify({ command: "wc -l < /etc/hosts" }),
    options: [
      { id: PERMISSION_ALLOW, label: "Allow", effect: "allow" },
      { id: PERMISSION_DENY, label: "Deny", effect: "deny" },
      { id: "mode:acceptEdits", label: "the adapter's own words for this one", effect: "mode", mode: "acceptEdits" },
    ],
  };

  it("the thread id is printed the moment the thread exists, ahead of the turn's first delta", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const started = h.starting("run", "alpha", "print the number of lines in /etc/hosts");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await h.rt.sessions.list();
    // The id is on stdout while the turn has said nothing: a person watching knows what to stop and what to read.
    await vi.waitFor(() => expect(started.io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`]));
    expect(started.io.streamed).toBe("");

    held.release(0, "10");
    expect(await started.ended).toBe(0);
    expect(started.io.screen.startsWith(`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}\n10`)).toBe(true);
  });

  it("a turn stopped on a prompt says so in the terminal that is blocked, with the keys that answer it, and a typed y answers it", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const io = captured();
    io.isTTY = true;
    io.sameScreen = true;
    let type: (key: string | undefined) => void = () => {};
    const offered: string[][] = [];
    io.answerKey = (accept, until) => {
      offered.push([...accept]);
      return new Promise<string | undefined>(resolve => {
        type = resolve;
        void until.then(() => resolve(undefined));
      });
    };
    const ended = cli(["run", "alpha", "print the number of lines in /etc/hosts", "--state", h.statePath], io, undefined, h.env);
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));

    held.ask(0, RUN_ASK);
    await vi.waitFor(() => expect(io.streamed).toContain(needsYouLine(RUN_ASK)));
    // The mode road has no words of its own: the runtime lends the option the words the app's own picker shows for
    // that mode, and the line under the prompt reads them rather than guessing what the mode does.
    const lent = { ...RUN_ASK, options: RUN_ASK.options.map(o => (o.effect === "mode" ? { ...o, label: permissionModeOptionLabel("Accept edits") } : o)) };
    expect(io.streamed.split("\n").slice(-3, -1)).toEqual([needsYouLine(RUN_ASK), answerKeysLine(lent.options)]);
    expect(answerKeysLine(lent.options)).toBe("answer here: type y to run it, n to refuse it, a to allow, then Accept edits");
    expect(offered).toEqual([["y", "n", "a"]]);

    type("y");
    await vi.waitFor(() => expect(held.answers).toEqual([{ askId: "ask_1", optionId: PERMISSION_ALLOW, outcome: "allowed" }]));
    held.release(0, "10");
    expect(await ended).toBe(0);
  });

  it("a turn stopped on two prompts is waiting on the older one, and the line that answers closes the one the listing named", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const running = h.starting("run", "alpha", "count both files");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await h.rt.sessions.list();
    const thread = row!.threadId!;
    const older: PermissionAsk = { ...RUN_ASK, askId: "ask_older" };
    const newer: PermissionAsk = { ...RUN_ASK, askId: "ask_newer", input: JSON.stringify({ command: "wc -l < /etc/passwd" }) };

    held.ask(0, older);
    held.ask(0, newer);
    await vi.waitFor(async () => expect((await h.rt.sessions.list())[0]!.asking).toBe(askingLine(older)));

    const allowed = await h.run("thread", "allow", thread);
    expect(allowed.code).toBe(0);
    expect(allowed.io.lines).toEqual([answeredLine(thread, older, "allowed")]);
    expect(held.answers).toEqual([{ askId: "ask_older", optionId: PERMISSION_ALLOW, outcome: "allowed" }]);
    // The newer one leads now, and the same line answers that.
    await vi.waitFor(async () => expect((await h.rt.sessions.list())[0]!.asking).toBe(askingLine(newer)));

    held.release(0, "10");
    expect(await running.ended).toBe(0);
  });

  it("a prompt that asks the person something rather than for consent says so: no key and no verb here stands for its own answers", async () => {
    const asked: PermissionAsk = {
      askId: "ask_q",
      toolName: QUESTION_TOOL,
      input: JSON.stringify({ questions: [{ question: "Which one?", header: "Pick", options: [{ label: "the first" }, { label: "the second" }] }] }),
      options: [
        { id: "q:0", label: "the first", effect: "answer" },
        { id: "q:1", label: "the second", effect: "answer" },
      ],
    };
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const running = h.starting("run", "alpha", "ask me which one");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await h.rt.sessions.list();
    const thread = row!.threadId!;

    held.ask(0, asked);
    await vi.waitFor(() => expect(running.io.streamed).toContain(needsYouLine(asked)));
    expect(running.io.streamed.split("\n").slice(-3, -1)).toEqual([needsYouLine(asked), ANSWER_IN_THE_APP]);

    const refused = await h.run("thread", "allow", thread);
    expect(refused.code).toBe(EXIT_CODES.provider);
    expect(refused.io.errors).toEqual([`wsp thread allow: ${noSuchAnswerLine(thread, "allow")}`]);

    held.release(0, "done");
    expect(await running.ended).toBe(0);
  });

  it("--json at a terminal offers no keys and waits on none: it writes the events and no stream, so its caller answers by the verb", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const io = captured();
    io.isTTY = true;
    io.sameScreen = true;
    const offered: string[][] = [];
    io.answerKey = accept => {
      offered.push([...accept]);
      return new Promise<string | undefined>(() => {});
    };
    const ended = cli(["run", "alpha", "print the number of lines in /etc/hosts", "--json", "--state", h.statePath], io, undefined, h.env);
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await h.rt.sessions.list();

    held.ask(0, RUN_ASK);
    await vi.waitFor(() => expect(io.lines.some(l => l.includes('"session.permission"'))).toBe(true));
    expect(offered).toEqual([]);
    expect(io.streamed).toBe("");

    expect((await h.run("thread", "allow", row!.threadId!)).code).toBe(0);
    held.release(0, "10");
    expect(await ended).toBe(0);
  });

  it("a caller with no terminal gets the same words and the verbs that answer by thread id, and those verbs answer the open prompt", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const running = h.starting("run", "alpha", "print the number of lines in /etc/hosts");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await h.rt.sessions.list();
    const thread = row!.threadId!;

    held.ask(0, RUN_ASK);
    await vi.waitFor(() => expect(running.io.streamed).toContain(needsYouLine(RUN_ASK)));
    expect(running.io.streamed.split("\n").slice(-3, -1)).toEqual([needsYouLine(RUN_ASK), answerVerbsLine(thread)]);

    const allowed = await h.run("thread", "allow", thread);
    expect(allowed.code).toBe(0);
    expect(allowed.io.lines).toEqual([answeredLine(thread, RUN_ASK, "allowed")]);
    expect(held.answers).toEqual([{ askId: "ask_1", optionId: PERMISSION_ALLOW, outcome: "allowed" }]);

    // The prompt is closed, so the same line again has nothing to answer and says so rather than answering twice.
    const twice = await h.run("thread", "allow", thread);
    expect(twice.code).toBe(EXIT_CODES.provider);
    expect(twice.io.errors).toEqual([`wsp thread allow: ${noOpenAskLine(thread)}`]);

    const second: PermissionAsk = { ...RUN_ASK, askId: "ask_2" };
    held.ask(0, second);
    await vi.waitFor(async () => expect((await h.rt.sessions.list())[0]!.asking).toBe(askingLine(RUN_ASK)));
    const denied = await h.run("thread", "deny", thread);
    expect(denied.code).toBe(0);
    expect(denied.io.lines).toEqual([answeredLine(thread, second, "denied")]);
    expect(held.answers.at(-1)).toEqual({ askId: "ask_2", optionId: PERMISSION_DENY, outcome: "denied" });

    held.release(0, "10");
    expect(await running.ended).toBe(0);
  });

  it.runIf(CLOUD_ON)("a name nothing here holds is refused before anything ran, on every verb that resolves one: the usage class, never the provider's", async () => {
    await h.run("new", "alpha");
    await h.run("run", "alpha", "build it");
    const folder = join(h.dir, "here");
    mkdirSync(folder, { recursive: true });
    const workspaceLines: [string, string[]][] = [
      ["exec", ["exec", "nope", "--", "true"]],
      ["pause", ["pause", "nope"]],
      ["wake", ["wake", "nope"]],
      ["rename", ["rename", "nope", "other"]],
      ["forget", ["forget", "nope", "--yes"]],
      ["delete", ["delete", "nope", "--yes"]],
      ["rebuild", ["rebuild", "nope"]],
      ["run", ["run", "nope", "build it"]],
      ["fork", ["fork", "nope", "--name", "child"]],
      ["export", ["export", "nope", folder, "--from", "/root/work/proj"]],
      ["image move", ["image", "move", "nope"]],
    ];
    const walked = async (lines: [string, string[]][]): Promise<[string, number, string[]][]> => {
      const refused: [string, number, string[]][] = [];
      for (const [verb, argv] of lines) {
        const { code, io } = await h.run(...argv);
        refused.push([verb, code, io.errors]);
      }
      return refused;
    };
    expect(await walked(workspaceLines)).toEqual(workspaceLines.map(([verb]) => [verb, EXIT_CODES.usage, [`wsp ${verb}: ${noWorkspaceRefusal("nope")}`]]));
    const threadLines: [string, string[]][] = [
      ["thread read", ["thread", "read", "nope"]],
      ["thread rename", ["thread", "rename", "nope", "other"]],
      ["thread forget", ["thread", "forget", "nope"]],
      ["thread allow", ["thread", "allow", "nope"]],
      ["thread deny", ["thread", "deny", "nope"]],
      ["send", ["send", "nope", "hello"]],
      ["stop", ["stop", "nope"]],
    ];
    expect(await walked(threadLines)).toEqual(threadLines.map(([verb]) => [verb, EXIT_CODES.usage, [`wsp ${verb}: no thread nope`]]));
  });

  it("run opens a thread under the named agent, announces it, streams the reply and prints the last message", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    const { code, io } = await h.run("run", "alpha", "--agent", "codex", "write tests");
    expect(code).toBe(0);
    const [row] = await h.rt.sessions.list(alpha!.id);
    expect(row).toMatchObject({ harness: "codex", startedBy: "cli", prompt: "write tests", status: "completed" });
    expect(h.codex.starts.map(s => s.prompt)).toEqual(["write tests"]);
    expect(h.claude.starts).toEqual([]);
    expect(io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`, "codex: write tests"]);
    expect(io.streamed).toBe("code\n$ ls\nx: write tests\ncompleted\n");
    expect(io.errors).toEqual([]);
  });

  it("a turn watched at a terminal shows its reply once: the prose as it streamed, ended on a line of its own, and the finished line under it carries no copy of it", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const io = captured();
    io.isTTY = true;
    io.sameScreen = true;
    const ended = cli(["run", "alpha", "print the kernel version and nothing else", "--state", h.statePath], io, undefined, h.env);
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await h.rt.sessions.list();
    held.release(0, "25.4.0");
    expect(await ended).toBe(0);
    expect(io.screen).toBe(`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}\n25.4.0\ncompleted\n`);
    expect(io.screen.split("25.4.0")).toHaveLength(2);
    expect(io.screen.endsWith("\n")).toBe(true);
    expect(io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`]);
  });

  it("a turn watched at a terminal that streamed no prose prints its reply once under the work it showed, since nothing on the screen carries it yet", async () => {
    await h.restartHost({ claude: toolingAgent([{ toolName: "Bash", input: { command: "uname -r" }, output: "25.4.0" }], { status: "completed", text: "the kernel is 25.4.0" }) });
    await h.run("new", "alpha");
    const io = captured();
    io.isTTY = true;
    io.sameScreen = true;
    expect(await cli(["run", "alpha", "print the kernel version and nothing else", "--state", h.statePath], io, undefined, h.env)).toBe(0);
    const [row] = await h.rt.sessions.list();
    expect(io.screen).toBe(`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}\n$ uname -r\n25.4.0\nthe kernel is 25.4.0\ncompleted\n`);
    expect(io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`, "the kernel is 25.4.0"]);
  });

  it("wsp send at a terminal prints the reply once, the copy that streamed, and down a pipe prints it whole at the end", async () => {
    // Marco read each send's reply twice and called it noise. A terminal has the streamed prose in front of the
    // same eyes, so stdout adds no copy of it; a pipe is somebody else's reader and carries the reply whole.
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    await h.run("run", "alpha", "--detach", "build it");
    const [row] = await h.rt.sessions.list();
    held.release(0, "first turn done");

    const io = captured();
    io.isTTY = true;
    io.sameScreen = true;
    const ended = cli(["send", row!.threadId!, "and now the second", "--state", h.statePath], io, undefined, h.env);
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    held.release(1, "the answer is 42");
    expect(await ended).toBe(0);
    expect(io.screen).toBe("the answer is 42\ncompleted\n");
    expect(io.screen.split("the answer is 42")).toHaveLength(2);
    expect(io.lines).toEqual([]);

    const piped = h.starting("send", row!.threadId!, "and a third");
    await vi.waitFor(() => expect(held.starts).toHaveLength(3));
    held.release(2, "the answer is still 42");
    expect(await piped.ended).toBe(0);
    expect(piped.io.lines).toEqual(["the answer is still 42"]);
    expect(piped.io.streamed).toBe("the answer is still 42\ncompleted\n");
  });

  it("a turn whose stdout is a pipe prints the reply once, at the end, with the stream beside it the person's own view of the work", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const piped = h.starting("run", "alpha", "print the kernel version and nothing else");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await h.rt.sessions.list();
    held.release(0, "25.4.0");
    expect(await piped.ended).toBe(0);
    expect(piped.io.sameScreen).toBeUndefined();
    expect(piped.io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`, "25.4.0"]);
    expect(piped.io.streamed).toBe("25.4.0\ncompleted\n");
  });

  it("a reply printed under a stream that stopped mid-line starts its own line, so the answer is never glued to the work above it", async () => {
    await h.run("new", "alpha");
    const io = captured();
    io.isTTY = true;
    const ended = cli(["run", "alpha", "build it", "--state", h.statePath], io, undefined, h.env);
    expect(await ended).toBe(0);
    const [row] = await h.rt.sessions.list();
    expect(io.screen).toBe(`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}\nre: \n$ ls\nbuild it\nre: build it\ncompleted\n`);
    expect(io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`, "re: build it"]);
  });

  it("--json prints the turn's events and its one turn value, at a terminal as into a pipe, and writes no stream", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const io = captured();
    io.isTTY = true;
    io.sameScreen = true;
    const ended = cli(["run", "alpha", "print the kernel version and nothing else", "--json", "--state", h.statePath], io, undefined, h.env);
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await h.rt.sessions.list();
    held.release(0, "25.4.0");
    expect(await ended).toBe(0);
    const values = h.json(io) as { type?: string; kind?: string; result?: { text?: string } }[];
    expect(values.map(v => v.type)).toEqual(["thread", "session.start", "session.delta", "session.done", undefined]);
    expect(values[2]).toMatchObject({ kind: "text", text: "25.4.0" });
    expect(values[3]!.result).toMatchObject({ status: "completed", text: "25.4.0" });
    expect(values.at(-1)).toEqual({ threadId: row!.threadId, workspaceId: row!.workspaceId, harness: "claude", text: "25.4.0", outcome: "started" });
    expect(io.streamed).toBe("");
  });

  it("a turn on this computer prices its figure as the agent's list price, and a turn at a provider leaves the figure alone", async () => {
    // A turn here runs on the person's own sign-in, so nobody is billed for it and the number is the agent's own
    // table, which is the word the app's footer already gives the figure. A fork is billed and says nothing extra.
    await h.restartHost({ claude: toolingAgent([], { status: "completed", text: "had a look", durationMs: 72_000, costUsd: 0.19 }) });
    await h.macProject("mac");
    const here = captured();
    expect(await cli(["run", "mac", "look around", "--state", h.statePath], here, undefined, h.env)).toBe(0);
    expect(here.streamed).toContain(`completed  Worked for 1m 12s  $0.19 ${LIST_PRICE_WORD}`);

    await h.run("new", h.cloud.name, "alpha");
    const forked = captured();
    expect(await cli(["run", "alpha", "look around", "--state", h.statePath], forked, undefined, h.env)).toBe(0);
    expect(forked.streamed).toContain("completed  Worked for 1m 12s  $0.19\n");
    expect(forked.streamed).not.toContain(LIST_PRICE_WORD);
  });

  it("a turn's two replies stream as two paragraphs: what the agent said while its background command ran, then what it said when that command woke it", async () => {
    await h.restartHost({
      claude: sayingAgent(
        [
          { kind: "text", text: "Waiting for the 90-second hold to complete.", messageId: "msg_a" },
          { kind: "text", text: "Done. The hold completed with exit code 0.", messageId: "msg_b" },
        ],
        { status: "completed", text: "Done. The hold completed with exit code 0." },
      ),
    });
    await h.run("new", "alpha");
    const { code, io } = await h.run("run", "alpha", "hold for 90 seconds");
    expect(code).toBe(0);
    expect(io.streamed.split("\n")).toEqual([
      "Waiting for the 90-second hold to complete.",
      "",
      "Done. The hold completed with exit code 0.",
      "completed",
      "",
    ]);
  });

  it("a turn whose messages sit either side of a tool call prints no blank line: the call's own lines have parted them already", async () => {
    await h.restartHost({
      claude: sayingAgent(
        [
          { kind: "text", text: "Looking.", messageId: "msg_a" },
          { toolName: "Bash", input: { command: "ls" }, output: "a.txt" },
          { kind: "text", text: "One file.", messageId: "msg_b" },
        ],
        { status: "completed", text: "One file." },
      ),
    });
    await h.run("new", "alpha");
    const io = captured();
    io.muted = text => `~${text}~`;
    expect(await cli(["run", "alpha", "what is here", "--state", h.statePath], io, undefined, h.env)).toBe(0);
    expect(io.streamed.split("\n")).toEqual(["Looking.", "~$ ls~", "~a.txt~", "One file.", "~completed~", ""]);
  });

  it("a harness's note about itself streams muted above the reply, with no word of failure, and the turn reads completed", async () => {
    const warning = "loading hooks from both /root/.codex/hooks.json and /root/.codex/config.toml; prefer a single representation for this layer";
    await h.restartHost({ claude: sayingAgent([{ kind: "note", text: warning }, { kind: "text", text: "ready", messageId: "msg_a" }], { status: "completed", text: "ready" }) });
    await h.run("new", "alpha");
    const io = captured();
    io.muted = text => `~${text}~`;
    expect(await cli(["run", "alpha", "say ready", "--state", h.statePath], io, undefined, h.env)).toBe(0);
    expect(io.streamed.split("\n")).toEqual([`~${warning}~`, "ready", "~completed~", ""]);
    expect(io.streamed).not.toContain("failed");
  });

  it("a turn's tool calls stream one muted line each as they land, what each answered behind it, and its end reads as the app's status line", async () => {
    await h.restartHost({
      claude: toolingAgent(
        [
          { toolName: "Bash", input: { command: "git status\n--porcelain" }, output: "On branch main\nnothing to commit" },
          { toolName: "Read", input: { file_path: "packages/engine/src/golden-mcp.ts" }, output: "" },
          { toolName: "Write", input: { file_path: "kai.txt" }, output: "File created successfully at: kai.txt" },
          { toolName: "Grep", input: { pattern: "shellQuote" }, output: "packages/host/src/exec.ts:12:  shellQuote(argv)" },
          { toolName: "Wombat", input: { fur: "grey" }, output: "no tool by that name", failed: true },
        ],
        { status: "completed", text: "had a look", durationMs: 72_000, costUsd: 0.22 },
      ),
    });
    await h.run("new", "alpha");
    const io = captured();
    io.muted = text => `~${text}~`;
    expect(await cli(["run", "alpha", "look around", "--state", h.statePath], io, undefined, h.env)).toBe(0);
    // Every call opens in the present, before it has run and before any prompt it waits on is answered; a call that
    // changed a file says what it changed once its result says it did, and every other call says what came back.
    expect(io.streamed.split("\n")).toEqual([
      "~$ git status~",
      "~On branch main~",
      "~reading packages/engine/src/golden-mcp.ts~",
      "~writing kai.txt~",
      "~wrote kai.txt~",
      "~searching code for shellQuote~",
      "~packages/host/src/exec.ts:12: shellQuote(argv)~",
      "~Wombat~",
      "~failed: no tool by that name~",
      "~completed  Worked for 1m 12s  $0.22~",
      "",
    ]);
    expect(io.lines).toEqual([expect.stringMatching(/^thread /), "had a look"]);
    expect(io.errors).toEqual([]);

    // --json keeps stdout the raw deltas and writes no line of its own.
    const asJson = await h.run("run", "alpha", "again", "--json");
    expect(asJson.io.streamed).toBe("");
    const calls = (h.json(asJson.io) as { type?: string; kind?: string; toolName?: string }[]).filter(e => e.type === "session.delta");
    expect(calls.map(e => [e.kind, e.toolName])).toEqual([
      ["tool_use", "Bash"], ["tool_result", undefined],
      ["tool_use", "Read"], ["tool_result", undefined],
      ["tool_use", "Write"], ["tool_result", undefined],
      ["tool_use", "Grep"], ["tool_result", undefined],
      ["tool_use", "Wombat"], ["tool_result", undefined],
    ]);
  });

  it("run without an agent takes the runtime's default; an agent the host has no adapter for is refused naming the agents it has, before a napping machine is woken", async () => {
    await h.run("new", "alpha");
    const ok = await h.run("run", "alpha", "hello");
    expect(ok.code).toBe(0);
    expect((await h.rt.sessions.list())[0]).toMatchObject({ harness: "claude", startedBy: "cli" });
    await h.run("pause", "alpha");
    const refused = await h.run("run", "alpha", "--agent", "gemini", "hello");
    expect(refused.code).toBe(3);
    expect(refused.io.errors).toEqual(['wsp run: no adapter registered for harness "gemini"; agents on this host: claude, codex. Name one of those with --agent.']);
    expect((await h.rt.workspaces.list())[0]!.phase).toBe("napping");
    expect(await h.rt.sessions.list()).toHaveLength(1);
  });

  it("run without an agent on a project whose default agent is Codex runs Codex, and a model named alone is read against Codex's list", async () => {
    expect((await h.run("projects", "set", h.cloud.name, "--agent", "codex")).code).toBe(0);
    await h.run("new", "alpha");
    const ok = await h.run("run", "alpha", "hello");
    expect([ok.code, ok.io.lines.at(-1)]).toEqual([0, "codex: hello"]);
    const modelled = await h.run("run", "alpha", "--model", "gpt-5.6-sol", "again");
    expect([modelled.code, modelled.io.errors]).toEqual([0, []]);
    expect((await h.rt.sessions.list()).map(r => r.harness)).toEqual(["codex", "codex"]);
    expect(h.claude.starts).toEqual([]);
  });

  it.runIf(CLOUD_ON)("fork --send under an agent the host has no adapter for is refused naming the agents it has, and no machine is minted", async () => {
    await h.run("new", "alpha");
    withDaemonRoads(h.backend);
    const refused = await h.run("fork", "alpha", "--name", "worker", "--send", "build it", "--agent", "gemini");
    expect(refused.code).toBe(3);
    expect(refused.io.errors).toEqual(['wsp fork: no adapter registered for harness "gemini"; agents on this host: claude, codex. Name one of those with --agent.']);
    expect(refused.io.lines).toEqual([]);
    expect((await h.rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);
    expect(await h.rt.sessions.list()).toEqual([]);
  });

  it.runIf(CLOUD_ON)("an empty or whitespace task or message is refused in words by run, fork --send and send; no machine is minted or woken and nothing starts", async () => {
    await h.run("new", "alpha");
    await h.run("run", "alpha", "first");
    const [row] = await h.rt.sessions.list();
    await h.run("pause", "alpha");
    for (const task of ["", "  \n\t"]) {
      const opened = await h.run("run", "alpha", task);
      expect(opened.code).toBe(3);
      expect(opened.io.errors).toEqual([`wsp run: ${EMPTY_MESSAGE_LINE}. Put it in quotes after the flags.`]);
      withDaemonRoads(h.backend);
      const forked = await h.run("fork", "alpha", "--name", "worker", "--send", task);
      expect(forked.code).toBe(3);
      expect(forked.io.errors).toEqual([`wsp fork: ${EMPTY_MESSAGE_LINE}. Put it in quotes after the flags.`]);
      const sent = await h.run("send", row!.threadId!, task);
      expect(sent.code).toBe(3);
      expect(sent.io.errors).toEqual([`wsp send: ${EMPTY_MESSAGE_LINE}. Put it in quotes after the flags.`]);
    }
    expect((await h.rt.workspaces.list()).map(w => [w.name, w.phase])).toEqual([["alpha", "napping"]]);
    expect(h.claude.starts).toHaveLength(1);
    expect(await h.rt.sessions.list()).toHaveLength(1);
  });

  it("a failed turn exits 1 with the error on stderr and no last message", async () => {
    await h.run("new", "alpha");
    const { code, io } = await h.run("run", "alpha", "die");
    expect(code).toBe(1);
    expect(io.lines).toHaveLength(1);
    expect(io.lines[0]).toMatch(/^thread /);
    expect(io.errors).toEqual(["wsp run: the harness died"]);
  });

  it("a turn the agent refused for want of a sign-in reads failed, exits with the auth code and says the refusal once, on the command line and in the read alike", async () => {
    const refusal = `Not logged in · Please run /login; ${signInRefusalLine({ kind: "local" })}`;
    await h.restartHost({ claude: toolingAgent([], { status: "failed", durationMs: 88, costUsd: 0, error: refusal, refusal: "sign-in" }) });
    await h.run("new", "alpha");

    const { code, io } = await h.run("run", "alpha", "say hi");
    expect(code).toBe(EXIT_CODES.auth);
    expect(io.lines).toEqual([expect.stringMatching(/^thread /)]);
    expect(io.streamed.split("\n").filter(l => l !== "")).toEqual(["failed  Worked for 88ms  $0.00"]);
    expect(io.errors).toEqual([`wsp run: ${refusal}`]);

    const [row] = await h.rt.sessions.list();
    const read = await h.run("thread", "read", row!.threadId!);
    expect(read.code).toBe(0);
    expect(read.io.lines.join("\n")).toContain(`failed  Worked for 88ms  $0.00: ${refusal}`);
    expect(read.io.lines.join("\n").split("Not logged in")).toHaveLength(2);
  });

  it("a refusal the agent named no cause for exits the provider code, so the auth code says a sign-in and nothing else", async () => {
    await h.restartHost({ claude: toolingAgent([], { status: "failed", durationMs: 40, error: "API Error: 529 overloaded" }) });
    await h.run("new", "alpha");

    const { code, io } = await h.run("run", "alpha", "say hi");
    expect(code).toBe(EXIT_CODES.provider);
    expect(io.errors).toEqual(["wsp run: API Error: 529 overloaded"]);

    const asJson = await h.run("run", "alpha", "again", "--json");
    expect(asJson.code).toBe(EXIT_CODES.provider);
    expect(JSON.parse(asJson.io.errors.at(-1)!)).toMatchObject({ class: "provider", exit: EXIT_CODES.provider });
  });

  it("a send into a thread whose last turn was cut says so on stderr before the reply; the send after that says nothing", async () => {
    await h.run("new", "alpha");
    const cut = await h.run("run", "alpha", "cut");
    expect(cut.code).toBe(1);
    expect(cut.io.errors).toEqual([`wsp run: ${CUT_LINE}`]);
    const [row] = await h.rt.sessions.list();
    const resumed = await h.run("send", row!.threadId!, "again");
    expect(resumed.code).toBe(0);
    expect(resumed.io.errors).toEqual(["previous turn was cut; resuming"]);
    expect(resumed.io.lines).toEqual(["re: again"]);
    const next = await h.run("send", row!.threadId!, "once more");
    expect(next.code).toBe(0);
    expect(next.io.errors).toEqual([]);
    const asJson = await h.run("send", row!.threadId!, "and json", "--json");
    expect(h.json(asJson.io).filter(e => (e as { type: string }).type === "session.start")).toEqual([expect.not.objectContaining({ afterCut: true })]);
  });

  it("a send into a thread whose launch never reached the machine runs the message as that thread's first turn, on the same thread, instead of refusing", async () => {
    const agent = bornDeadAgent(prompt => `re: ${prompt}`);
    await h.restartHost({ claude: agent.adapter, codex: h.codex.adapter });
    await h.run("new", "alpha");
    const dead = await h.run("run", "alpha", "hello");
    expect(dead.code).toBe(1);
    expect(dead.io.errors).toEqual([`wsp run: ${UNREACHED_LINE}`]);
    const [row] = await h.rt.sessions.list();
    expect(row!.claudeSessionId).toBeUndefined();
    const sent = await h.run("send", row!.threadId!, "again");
    expect(sent.code).toBe(0);
    expect(sent.io.errors).toEqual([]);
    expect(sent.io.lines).toEqual(["re: again"]);
    expect(agent.starts.map(s => s.resume)).toEqual([undefined, undefined]);
    const rows = await h.rt.sessions.list();
    expect(rows.map(r => [r.prompt, r.status, r.threadId])).toEqual([
      ["hello", "failed", row!.threadId],
      ["again", "completed", row!.threadId],
    ]);
    const more = await h.run("send", row!.threadId!, "once more");
    expect(more.io.lines).toEqual(["re: once more"]);
    expect(agent.starts[2]!.resume).toBe(rows[1]!.claudeSessionId);
  });

  it("a launch that never reached the agent on a workspace it woke puts that workspace back to sleep and says so on its last line", async () => {
    const agent = bornDeadAgent(prompt => `re: ${prompt}`);
    await h.restartHost({ claude: agent.adapter });
    await h.run("new", "alpha");
    const alpha = (await h.rt.workspaces.list())[0]!;
    await h.rt.workspaces.nap(alpha.id);
    expect((await h.rt.workspaces.get(alpha.id)).phase).toBe("napping");

    const dead = await h.run("run", "alpha", "hello");
    expect(dead.code).toBe(1);
    // The machine the launch woke is back where it found it, so no idle window bills for a turn that never ran.
    expect((await h.rt.workspaces.get(alpha.id)).phase).toBe("napping");
    // The failure still stands whole; the nap is the line under it, which is the last thing the run prints.
    expect(dead.io.errors).toEqual(["waking alpha", `wsp run: ${UNREACHED_LINE}\n${workspaceAsleepAgainLine("alpha")}`]);
  });

  it("a launch that never reached the agent leaves a workspace it did not wake alone and says nothing about it", async () => {
    const agent = bornDeadAgent(prompt => `re: ${prompt}`);
    await h.restartHost({ claude: agent.adapter });
    await h.run("new", "alpha");
    const alpha = (await h.rt.workspaces.list())[0]!;

    const dead = await h.run("run", "alpha", "hello");
    expect(dead.code).toBe(1);
    expect(dead.io.errors).toEqual([`wsp run: ${UNREACHED_LINE}`]);
    expect((await h.rt.workspaces.get(alpha.id)).phase).toBe("running");
  });

  it("a launch that dies on a running machine whose daemon is dark leaves that machine up: an unreachable machine is not one this launch woke", async () => {
    const agent = bornDeadAgent(prompt => `re: ${prompt}`);
    await h.restartHost({ claude: agent.adapter });
    await h.run("new", "alpha");
    const alpha = (await h.rt.workspaces.list())[0]!;
    // The machine is up and nothing on it answers, which is the state word Unreachable and never a machine asleep.
    const edge = createHttpServer((_req, res) => {
      res.writeHead(502).end();
    });
    await new Promise<void>(r => edge.listen(0, "127.0.0.1", r));
    try {
      h.backend.machines[0]!.previewUrl = async () => ({ url: `http://127.0.0.1:${(edge.address() as AddressInfo).port}/`, token: "stub", expiresAt: Date.now() + 3_600_000 });
      const dead = await h.run("run", "alpha", "hello");
      expect(dead.code).toBe(1);
      expect(dead.io.errors).toEqual([`wsp run: ${UNREACHED_LINE}`]);
      expect((await h.rt.workspaces.get(alpha.id)).phase).toBe("running");
    } finally {
      await new Promise<void>(r => edge.close(() => r()));
    }
  });

  describe("which caller a wake belongs to", () => {
    /** A host that answers the wake with the phase given, so the transition is what each case turns on. */
    const host = (after: string): HostClient => ({ request: async () => ({ workspace: { id: "ws_1", name: "alpha", phase: after } }) }) as unknown as HostClient;
    const view = (phase: string): WorkspaceView => ({ id: "ws_1", name: "alpha", phase, kind: "cloud", golden: "", createdAt: "2026-09-13T00:00:00.000Z", machineId: "m1" }) as unknown as WorkspaceView;

    it("is the caller's only where the machine was down before it and running after: a machine already up, or one another caller is waking, was woken by neither", async () => {
      // The one this road owes a nap back to, and the one the nap the person asked for was cut short on.
      expect((await awake(host("running"), view("napping"), "send", () => {})).woke).toBe(true);
      expect((await awake(host("running"), view("pausing"), "send", () => {})).woke).toBe(true);
      // Already up is the person's own machine; waking is another caller's wake in flight, not this one's doing.
      expect((await awake(host("running"), view("running"), "send", () => {})).woke).toBe(false);
      expect((await awake(host("running"), view("waking"), "send", () => {})).woke).toBe(false);
      // A wake the provider did not finish started nothing, so there is nothing for this caller to put back.
      expect((await awake(host("napping"), view("napping"), "send", () => {})).woke).toBe(false);
    });

    it("says it is waking on every state that is not running, whoever the wake belongs to", async () => {
      const said: string[] = [];
      for (const phase of ["napping", "pausing", "waking", "running"]) await awake(host("running"), view(phase), "send", line => said.push(line));
      expect(said).toEqual(["waking alpha", "waking alpha", "waking alpha"]);
    });
  });

  describe("what a dead launch does about the machine it woke", () => {
    const woken = { workspace: { id: "ws_1", name: "alpha" } as unknown as WorkspaceOut, woke: true };
    /** A host answering only the two ops this road asks, so the road itself is what the case turns on. */
    const host = (answers: Record<string, unknown>): HostClient => ({ request: async (op: string) => (answers[op] ?? Promise.reject(new Error(`no ${op}`))) as never }) as unknown as HostClient;
    const turnOf = (status: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: "s_1", workspaceId: "ws_1", harness: "claude", status, ...extra });

    it("naps it where nothing else is running there", async () => {
      const asked: { op: string; workspaceId?: unknown }[] = [];
      const client = {
        request: async (op: string, params?: Record<string, unknown>) => {
          asked.push({ op, workspaceId: params?.["workspaceId"] });
          return (op === "sessions.list" ? { sessions: [turnOf("failed", { threadId: "t_1" })] } : {}) as never;
        },
      } as unknown as HostClient;
      expect(await napAfterDeadLaunch(client, woken, undefined)).toBe(workspaceAsleepAgainLine("alpha"));
      expect(asked).toContainEqual({ op: "workspaces.nap", workspaceId: "ws_1" });
    });

    it("leaves it up where another thread is working there, and says when the idle window takes it", async () => {
      const client = host({
        "sessions.list": { sessions: [turnOf("failed", { threadId: "t_mine" }), turnOf("running", { id: "s_2", threadId: "t_other" })] },
        // Half a minute past the window, so the whole minutes the line reads in do not turn on this test's clock.
        "status.list": { statuses: [{ id: "ws_1", idleAt: Date.now() + 20 * 60_000 + 30_000 }] },
      });
      // Nothing is napped under a turn that is still going, so the line says what the machine costs until then.
      expect(await napAfterDeadLaunch(client, woken, undefined)).toBe("alpha stays awake, naps in 20m");
    });

    it("says the machine is up with no countdown where the host answers no nap time for it", async () => {
      const client = host({
        "sessions.list": { sessions: [turnOf("running", { threadId: "t_other" })] },
        "status.list": { statuses: [{ id: "ws_1" }] },
      });
      expect(await napAfterDeadLaunch(client, woken, undefined)).toBe("alpha stays awake");
    });

    it("answers the same where the host cannot be reached at all, so the failure the run is reporting is never lost to a second one", async () => {
      const client = host({});
      expect(await napAfterDeadLaunch(client, woken, undefined)).toBe("alpha stays awake");
    });
  });

  it("thread forget drops the row a launch that never got going left, and refuses a thread whose turn did work and a row from before threads", async () => {
    const agent = bornDeadAgent(prompt => `re: ${prompt}`);
    await h.restartHost({ claude: agent.adapter });
    await h.run("new", "alpha");
    const dead = await h.run("run", "alpha", "hello");
    expect(dead.code).toBe(1);
    expect(dead.io.errors).toEqual([`wsp run: ${UNREACHED_LINE}`]);
    const junk = (await h.rt.sessions.list())[0]!.threadId!;
    expect((await h.run("threads")).io.lines[0]).toContain(junk);

    const forgot = await h.run("thread", "forget", junk.slice(0, 8));
    expect(forgot.code).toBe(0);
    expect(forgot.io.lines).toEqual([`forgot thread ${junk}: no turn ever ran on it, so nothing of its work is gone`]);
    expect((await h.run("threads")).io.lines[0]).not.toContain(junk);
    expect(await h.rt.sessions.list()).toEqual([]);

    // The next launch works, so its thread is one a turn ran on: the runtime's own sentence comes back.
    await h.run("run", "alpha", "build it");
    const ran = (await h.rt.sessions.list())[0]!.threadId!;
    const refused = await h.run("thread", "forget", ran);
    expect(refused.code).toBe(1);
    expect(refused.io.errors).toEqual([`wsp thread forget: ${threadForgetRefusal(ran)}`]);
    expect((await h.rt.sessions.list()).map(r => r.threadId)).toEqual([ran]);

    const missing = await h.run("thread", "forget", "nope");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp thread forget: no thread nope"]);
    // A turn from before threads folds under its own id and no thread here answers to it; the verb says that
    // rather than dialling for a thread nobody has, which is the guard the app's row makes.
    const alpha = (await h.rt.workspaces.list())[0]!.id;
    await h.store.put("sessions", alpha, { workspaceId: alpha, sessions: [{ id: "s_old", workspaceId: alpha, harness: "claude", status: "failed", prompt: "from before threads" }] });
    await h.restartHost({ claude: agent.adapter });
    const before = await h.run("thread", "forget", "s_old");
    expect(before.code).toBe(1);
    expect(before.io.errors).toEqual([`wsp thread forget: ${threadWithoutIdRefusal("s_old")}`]);
    const none = await h.run("thread", "forget");
    expect(none.code).toBe(3);
    expect(none.io.errors).toEqual(["wsp thread forget takes one thread. usage: wsp thread forget <thread>"]);
  });

  it("threads is the sidebar's data: one row per thread with its folder and branch, agent, state and who opened it, within one project or machine when named", async () => {
    await h.run("new", "alpha");
    await h.run("new", "beta");
    const [alpha, beta] = await h.rt.workspaces.list();
    await h.rt.projects.import({ workspaceId: alpha!.id, source: "/Users/dev/proj", dest: "/root/work/proj", bundler: projectBundler() });
    await h.run("run", "alpha", "first task");
    await (await h.rt.sessions.start(beta!.id, { prompt: "from the app", harness: "codex" })).finished;
    const { code, io } = await h.run("threads");
    expect(code).toBe(0);
    const rows = io.lines[0]!.split("\n");
    expect(rows[0]).toMatch(/^PROJECT\s+FOLDER\s+BRANCH\s+THREAD\s+TASK\s+AGENT\s+STATE\s+BY\s+COMPUTER\s+TITLE$/);
    const [a] = await h.rt.sessions.list(alpha!.id);
    const [b] = await h.rt.sessions.list(beta!.id);
    // Each row reads project, the folder the thread works in, its branch (none on a machine whose checkout the record
    // does not name, an empty cell the split folds away), thread, agent, state, who opened it, the computer and the
    // title. Both turns ended and no window has shown either, so both read Done, the word the app's tile shows.
    expect(rows.slice(1).map(r => r.split(/ {2,}/))).toEqual([
      [alpha!.project.name, alpha!.project.path, a!.threadId!, "claude", "Done", "cli", alpha!.project.computer, "first task"],
      [beta!.project.name, beta!.project.path, b!.threadId!, "codex", "Done", "person", beta!.project.computer, "from the app"],
    ]);
    // A window showing one moves its stamp on the host, and so does reading it here; both read Idle at once.
    await h.rt.sessions.read(b!.threadId!);
    const read = await h.run("threads");
    expect(read.io.lines[0]!.split("\n").slice(1).map(r => r.split(/ {2,}/)[4])).toEqual(["Done", "Idle"]);
    expect((await h.run("thread", "read", a!.threadId!)).code).toBe(0);
    const both = await h.run("threads");
    expect(both.io.lines[0]!.split("\n").slice(1).map(r => r.split(/ {2,}/)[4])).toEqual(["Idle", "Idle"]);

    const scoped = await h.run("threads", "beta", "--json");
    expect(scoped.code).toBe(0);
    const [{ threads }] = h.json(scoped.io) as [{ threads: (ThreadView & { folder: string; branch: string; projectName: string; computerName: string })[] }];
    // The rows the tool answers with: the sidebar's view plus the names the table shows beside it.
    const bare = ({ folder: _f, branch: _b, projectName: _p, computerName: _c, ...t }: (typeof threads)[number]) => t;
    expect(threads.map(t => ThreadView.parse(bare(t)))).toEqual(threads.map(bare));
    expect(threads).toEqual([
      expect.objectContaining({ id: b!.threadId, workspaceId: beta!.id, folder: beta!.project.path, branch: "", projectName: beta!.project.name, computerName: beta!.project.computer, harness: "codex", startedBy: "person", turns: 1 }),
    ]);
  });

  it("threads reads a thread stopped on a permission prompt as needing the person, and as working again once it is answered", async () => {
    const ASKED: PermissionAsk = { askId: "ask_1", toolName: "Write", detail: "out.txt", input: '{"file_path":"/root/out.txt"}', options: [{ id: PERMISSION_ALLOW, label: "Allow", effect: "allow" }] };
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const started = h.starting("run", "alpha", "write the file");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const working = await h.run("threads");
    expect(working.io.lines[0]!.split("\n")[1]).toContain("Working");

    held.ask(0, ASKED);
    await vi.waitFor(async () => expect((await h.rt.sessions.list())[0]!.asking).toBe(askingLine(ASKED)));
    const waiting = await h.run("threads");
    expect(waiting.io.lines[0]!.split("\n")[1]).toContain("Needs you");

    held.release(0, "written");
    expect(await started.ended).toBe(0);
    const after = await h.run("threads");
    expect(after.io.lines[0]!.split("\n")[1]).toContain("Done");
  });

  it("run --cwd is the folder the turn starts in, the same field the app's composer sends; without it the workspace's project folder, else none and the harness starts in its own home", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    const picked = await h.run("run", "alpha", "--agent", "codex", "--cwd", "/root/work/elsewhere", "write tests");
    expect(picked.code).toBe(0);
    expect(h.codex.starts.map(s => s.cwd)).toEqual(["/root/work/elsewhere"]);

    const bare = await h.run("run", "alpha", "--agent", "claude", "hello");
    expect(bare.code).toBe(0);
    // No folder named: the thread opens in the workspace's project, which is what the workspace is a copy for.
    expect(h.claude.starts.map(s => s.cwd)).toEqual([alpha!.project.path]);
    const rows = await h.rt.sessions.list(alpha!.id);
    expect(rows.map(r => r.cwd)).toEqual(["/root/work/elsewhere", alpha!.project.path]);
    // A line that names no agent runs the one the last thread on this project used.
    expect((await h.run("run", "alpha", "again")).code).toBe(0);
    expect(h.claude.starts).toHaveLength(2);
  });

  it("run with no folder named starts the thread in the workspace's project, and --cwd wins over it", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    const named = await h.run("run", "alpha", "build it");
    expect(named.code).toBe(0);
    expect(named.io.errors).toEqual([]);
    expect(h.claude.starts.map(s => s.cwd)).toEqual([alpha!.project.path]);
    const both = await h.run("run", "alpha", "--cwd", "/root/elsewhere", "build it");
    expect(both.code).toBe(0);
    expect(h.claude.starts.at(-1)!.cwd).toBe("/root/elsewhere");
    // The workspace is where the last thread went, which is what a run from nowhere takes.
    expect((await h.rt.preferences.get()).target).toEqual({ workspace: alpha!.id });
  });

  it("run names a project here and the thread runs in its folder, or in a worktree for --branch; from inside a project's folder it goes to that project and says so; outside every project it is refused in one line and nothing starts", async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-repo-")));
    execFileSync("git", ["init", "-q", "-b", "main", folder]);
    execFileSync("git", ["-C", folder, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
    mkdirSync(join(folder, "packages", "api"), { recursive: true });
    const project = await projectOn(h.rt, HERE_PLACE_ID, folder, { name: "spoo" });
    await h.run("new", h.cloud.name, "beta");
    const named = await h.run("run", "spoo", "hello in the folder");
    expect(named.code, named.io.errors.join("\n")).toBe(0);
    expect(h.claude.starts.at(-1)!.cwd).toBe(folder);
    expect(named.io.lines[0]!.startsWith(threadOpenedLine((await h.rt.sessions.list()).find(t => t.prompt === "hello in the folder")!.threadId!, "spoo", homeShortened(folder, homedir())))).toBe(true);
    // Another branch runs in the worktree the host makes for it, under its own folder.
    const branched = await h.run("run", "spoo", "--branch", "feat/x", "hello on a branch");
    expect(branched.code, branched.io.errors.join("\n")).toBe(0);
    expect(h.copier.worktrees.map(w => ({ from: w.from, project: w.project, branch: w.branch }))).toEqual([{ from: folder, project: project.id, branch: "feat/x" }]);
    const tree = join(dirname(h.statePath), "worktrees", project.id, "feat-x");
    expect(h.claude.starts.at(-1)!.cwd).toBe(tree);
    // The threads table names the folder and the branch each thread works in.
    const rows = await threadRows(await dialHost(h.statePath));
    expect(rows.filter(t => t.projectName === "spoo").map(t => [t.folder, t.branch])).toEqual(
      expect.arrayContaining([
        [folder, "main"],
        [tree, "feat/x"],
      ]),
    );
    const cwd = vi.spyOn(process, "cwd");
    try {
      cwd.mockReturnValue(join(folder, "packages", "api"));
      const inferred = await h.run("run", "hello from the repo");
      expect(inferred.io.errors).toEqual([]);
      expect(inferred.code).toBe(0);
      expect(h.claude.starts.at(-1)!.cwd).toBe(folder);
      // A box's machine named on the line still takes the thread.
      const boxed = await h.run("run", "beta", "--agent", "claude", "named anyway");
      expect(boxed.code, boxed.io.errors.join("\n")).toBe(0);
      expect((await h.rt.sessions.list()).find(t => t.prompt === "named anyway")!.workspaceId).toBe((await h.rt.workspaces.list()).find(w => w.name === "beta")!.id);
      const before = (await h.rt.sessions.list()).length;
      cwd.mockReturnValue(join(h.dir, "code"));
      const nowhere = await h.run("run", "nowhere to go");
      expect(nowhere.code).toBe(EXIT_CODES.usage);
      expect(nowhere.io.errors[0]).toContain(noThreadTargetLine("<project>"));
      expect((await h.rt.sessions.list()).length).toBe(before);
    } finally {
      cwd.mockRestore();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("delete names a thread first: a thread in the project folder goes alone and the folder stays, a thread in a worktree wsp made takes the worktree with it", async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-repo-")));
    execFileSync("git", ["init", "-q", "-b", "main", folder]);
    execFileSync("git", ["-C", folder, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
    await projectOn(h.rt, HERE_PLACE_ID, folder, { name: "spoo" });
    expect((await h.run("run", "spoo", "first")).code).toBe(0);
    expect((await h.run("run", "spoo", "second")).code).toBe(0);
    const listed = await h.rt.sessions.list();
    const first = listed.find(t => t.prompt === "first")!.threadId!;
    const second = listed.find(t => t.prompt === "second")!.threadId!;
    const gone = await h.run("delete", first.slice(0, 8), "--yes");
    expect(gone.code, gone.io.errors.join("\n")).toBe(0);
    expect(gone.io.lines).toEqual([`deleted thread ${first}`]);
    expect((await h.rt.sessions.list()).map(t => t.threadId)).toEqual([second]);
    expect(existsSync(join(folder, ".git"))).toBe(true);
    expect((await h.run("run", "spoo", "--branch", "feat/y", "on a branch")).code).toBe(0);
    const branched = (await h.rt.sessions.list()).find(t => t.prompt === "on a branch")!.threadId!;
    const tree = (await h.rt.workspaces.list()).find(w => w.worktree !== undefined)!.worktree!.path;
    // The stand-in copier makes a plain folder, so git is put there as the real verb's worktree would have it.
    execFileSync("git", ["init", "-q", tree]);
    // The worktree's record is never named to the person: naming it to delete points at the worktree's own roads.
    const named = await h.run("delete", "spoo@feat/y", "--yes");
    expect(named.code).toBe(3);
    expect(named.io.errors[0]).toContain(localWorktreeRefusal("spoo@feat/y"));
    const took = await h.run("delete", branched, "--yes");
    expect(took.code, took.io.errors.join("\n")).toBe(0);
    expect(took.io.lines).toEqual([threadDeletedLine(branched, { worktree: tree, threads: 1 })]);
    expect(h.copier.worktreesRemoved.map(r => r.path)).toEqual([tree]);
    rmSync(folder, { recursive: true, force: true });
  });

  it("projects lists every project this host holds, each on its computer, with how many threads each has", async () => {
    const spoo = await projectOn(h.rt, undefined, "https://github.com/dev/spoo.git");
    await h.run("new", spoo.name, "alpha");
    const listed = await h.run("projects");
    expect(listed.code).toBe(0);
    expect(listed.io.errors).toEqual([]);
    const [heading, ...rows] = listed.io.lines[0]!.split("\n");
    expect(heading!.split(/ {2,}/)).toEqual(["PROJECT", "ID", "COMPUTER", "SOURCE", "PATH", "BASE", "THREADS", "NEW THREADS"]);
    expect(rows.map(r => r.split(/ {2,}/)).find(r => r[0] === "spoo")).toEqual(["spoo", spoo.id, spoo.computer, "https://github.com/dev/spoo.git", "/root/spoo", "0", "claude claude-opus-5-5 full"]);

    // The computer's own word, never the place id: a project on the computer the host runs on reads as that
    // computer's own word, the same one the workspaces table gives its row.
    const folder = realpathSync(mkdtempSync(join(h.dir, "repo-here-")));
    execFileSync("git", ["init", "-q", folder]);
    const here = await projectOn(h.rt, HERE_PLACE_ID, folder);
    const both = await h.run("projects");
    const cell = both.io.lines[0]!.split("\n").map(r => r.split(/ {2,}/)).find(r => r[0] === here.name)!;
    // The host's own platform word: this Mac where the host runs on one, this computer on a Linux runner.
    expect(cell[2]).toBe(thisComputer(hostPlatform()));
    expect(cell[2]).not.toBe(HERE_PLACE_ID);
    const raw = await h.run("projects", "--json");
    expect((h.json(raw.io)[0] as { projects: { name: string }[] }).projects.map(p => p.name)).toContain("spoo");

    // The verb takes no positional: the projects are the host's, not a workspace's.
    const extra = await h.run("projects", "nope");
    expect(extra.code).toBe(EXIT_CODES.usage);
    expect(extra.io.errors[0]).toMatch(/^wsp projects takes no positional arguments/);
  });

  it.runIf(CLOUD_ON)("fork --send --cwd starts the first thread in that folder; without it, in the project the fork holds", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    withDaemonRoads(h.backend);
    const picked = await h.run("fork", "alpha", "--name", "worker", "--send", "build it", "--cwd", "/root/work/site");
    expect(picked.code).toBe(0);
    expect(h.claude.starts.map(s => s.cwd)).toEqual(["/root/work/site"]);

    const plain = await h.run("fork", "alpha", "--name", "other", "--send", "build it");
    expect(plain.code).toBe(0);
    // A fork is a workspace of the same project, so its first thread opens in that project's folder.
    expect(h.claude.starts.map(s => s.cwd)).toEqual(["/root/work/site", alpha!.project.path]);
    const other = (await h.rt.workspaces.list()).find(w => w.name === "other")!;
    expect(other.project.id).toBe(alpha!.project.id);
  });

  it.runIf(CLOUD_ON)("--model, --effort and --access on run, fork --send and send reach the start as the fields the composer sends; a new thread without them runs the catalog's defaults, the ones the composer shows", async () => {
    await h.run("new", "alpha");
    const picked = await h.run("run", "alpha", "--model", "claude-sonnet-5", "--effort", "low", "--access", "auto-edit", "review it");
    expect(picked.code).toBe(0);
    expect(h.claude.starts.map(s => [s.model, s.effort, s.permissionMode])).toEqual([["claude-sonnet-5", "low", "acceptEdits"]]);

    const bare = await h.run("run", "alpha", "hello");
    expect(bare.code).toBe(0);
    const shown = markedDefault(harnessCatalog("claude")!.models)!.value;
    expect(shown).toBe("claude-opus-5-5");
    const level = markedDefault(effortsFor(harnessCatalog("claude")!, markedDefault(harnessCatalog("claude")!.models) ?? null))!.value;
    expect(h.claude.starts.at(-1)).toMatchObject({ model: shown, effort: level });
    // The access is named too, and named explicitly: an unnamed one reached the adapter as nothing, which every
    // adapter here reads as its own skip-everything flag, so the picker's word and the CLI's flag could differ. It
    // is read off the workspace's own catalog, the list the composer draws, since which mode a start with no flag
    // runs at belongs to the kind of workspace the thread is on.
    const [alpha] = await h.rt.workspaces.list();
    const access = markedDefault((await h.rt.harnesses.list(alpha!.id)).find(c => c.harness === "claude")!.permissionModes)!.value;
    expect(access).toBe("bypassPermissions");
    expect(h.claude.starts.at(-1)!.permissionMode).toBe(access);
    const [, thread] = await h.rt.sessions.list();

    const same = await h.run("send", thread!.threadId!, "go on");
    expect(same.code).toBe(0);
    // A send that names nothing keeps the thread's own access, model and effort rather than the adapter's defaults.
    expect(h.claude.starts.at(-1)).toMatchObject({ resume: thread!.claudeSessionId, permissionMode: access, model: shown, effort: level });
    const changed = await h.run("send", thread!.threadId!, "--model", "claude-fable-5-1", "--effort", "max", "now think");
    expect(changed.code).toBe(0);
    // The access is not among them: the thread keeps its own, whichever door the message came through.
    expect(h.claude.starts.at(-1)).toMatchObject({ resume: thread!.claudeSessionId, model: "claude-fable-5-1", effort: "max", permissionMode: access });
    const named = await h.run("send", thread!.threadId!, "--access", "acceptEdits", "and now");
    expect(named.code).toBe(3);
    expect(named.io.errors).toEqual(['--access belongs to wsp agents set, wsp projects set, wsp fork, wsp start and wsp run; wsp send does not read it. usage: wsp send <thread> [--model, --effort <value>] [--fast] [--file <path>] [--detach] "<message>"']);

    withDaemonRoads(h.backend);
    const forked = await h.run("fork", "alpha", "--name", "worker", "--send", "build it", "--model", "claude-sonnet-5", "--access", "full");
    expect(forked.code).toBe(0);
    expect(h.claude.starts.at(-1)).toMatchObject({ model: "claude-sonnet-5", permissionMode: "bypassPermissions", effort: level });
  });

  it("a thread on this computer runs every action without asking when the line names no access, and at wsp's word when it names one", async () => {
    await h.macProject("mac");
    const bare = await h.run("run", "mac", "write the notes");
    expect(bare.code).toBe(0);
    // The owner's word for his own computer: a thread here does what a session he starts in his own terminal does.
    expect(h.claude.starts.at(-1)!.permissionMode).toBe("bypassPermissions");
    const picked = await h.run("run", "mac", "--access", "auto-edit", "edit the notes");
    expect(picked.code).toBe(0);
    expect(h.claude.starts.at(-1)!.permissionMode).toBe("acceptEdits");
    // One vocabulary on every agent: a harness's own spelling is no word of it, and a word the agent maps to none of
    // its modes is refused naming the ones it takes, never run looser.
    const slug = await h.run("run", "mac", "--access", "acceptEdits", "edit the notes");
    expect(slug.code).toBe(3);
    expect(slug.io.errors[0]).toBe("wsp run: --access takes ask, auto-edit, full or plan, and got acceptEdits. Name one of those; which of its own modes each one is, is the agent's row's to say.");
    const plan = await h.run("run", "mac", "--access", "plan", "read the notes");
    expect(plan.code).toBe(3);
    expect(plan.io.errors[0]).toBe("wsp run: Claude Code takes no plan access; it takes ask, auto-edit, full. Name one it takes, or drop --access.");
    expect(h.claude.starts.at(-1)!.permissionMode).toBe("acceptEdits");
    // The command line reads it off the same catalog the app's composer draws, so neither holds a default of its own.
    const [mac] = await h.rt.workspaces.list();
    const shown = (await h.rt.harnesses.list(mac!.id)).find(c => c.harness === "claude")!;
    expect(markedDefault(shown.permissionModes)?.value).toBe("bypassPermissions");
  });

  it("an agent's defaults and its project's override decide what a thread the line names nothing for starts at, and the line's own word wins", async () => {
    await h.macProject("mac");
    const [mac] = await h.rt.workspaces.list();
    const project = (await h.rt.projects.list()).find(p => p.id === mac!.project.id)!;
    expect((await h.run("agents", "set", "claude", "--access", "ask")).code).toBe(0);
    expect((await h.run("run", "mac", "run echo hi")).code).toBe(0);
    expect(h.claude.starts.at(-1)!.permissionMode).toBe("default");
    expect((await h.run("projects", "set", project.name, "--access", "full")).code).toBe(0);
    await h.run("run", "mac", "go on");
    expect(h.claude.starts.at(-1)!.permissionMode).toBe("bypassPermissions");
    await h.run("run", "mac", "--access", "auto-edit", "go on");
    expect(h.claude.starts.at(-1)!.permissionMode).toBe("acceptEdits");
    // A word the agent maps to none of its modes is refused at the set, as usage, and nothing is kept.
    const plan = await h.run("agents", "set", "claude", "--access", "plan");
    expect(plan.code).toBe(3);
    expect(plan.io.errors).toEqual(["wsp agents set: Claude Code takes no plan access; it takes ask, auto-edit, full"]);
    expect((await h.rt.preferences.get()).agentDefaults["claude"]).toEqual({ access: "ask" });
    const nothing = await h.run("agents", "set", "claude");
    expect(nothing.code).toBe(3);
  });

  it("the default agent runs a thread that names none, its project's agent over it, and wsp projects --json says where each value came from", async () => {
    await h.macProject("mac");
    const [mac] = await h.rt.workspaces.list();
    const project = (await h.rt.projects.list()).find(p => p.id === mac!.project.id)!;
    expect((await h.run("agents", "default", "codex")).code).toBe(0);
    const before = h.codex.starts.length;
    expect((await h.run("run", "mac", "say hi")).code).toBe(0);
    expect(h.codex.starts.length).toBe(before + 1);
    const set = await h.run("projects", "set", project.name, "--agent", "claude", "--json");
    expect(set.code).toBe(0);
    expect(h.json(set.io).at(-1)).toMatchObject({ project: { id: project.id }, defaults: { agent: { value: "claude", from: "project" } } });
    const ran = h.claude.starts.length;
    await h.run("run", "mac", "say hi");
    expect(h.claude.starts.length).toBe(ran + 1);
    const listed = h.json((await h.run("projects", "--json")).io).at(-1) as { defaults: Record<string, { agent: { value: string; from: string } }> };
    expect(listed.defaults[project.id]!.agent).toEqual({ value: "claude", from: "project" });
    await h.run("projects", "set", project.name, "--reset", "agent");
    const back = h.json((await h.run("projects", "--json")).io).at(-1) as { defaults: Record<string, { agent: { value: string; from: string } }> };
    expect(back.defaults[project.id]!.agent).toEqual({ value: "codex", from: "default" });
  });

  it("a model hidden from an agent's picker leaves the lists the composer draws, and a run still takes it by name", async () => {
    await h.macProject("mac");
    const [mac] = await h.rt.workspaces.list();
    expect((await h.run("agents", "set", "claude", "--hide", "claude-haiku-4-5-20251001")).code).toBe(0);
    const listed = (await h.rt.harnesses.list(mac!.id)).find(c => c.harness === "claude")!;
    expect(listed.models.map(m => m.value)).not.toContain("claude-haiku-4-5-20251001");
    expect((await h.run("run", "mac", "--model", "claude-haiku-4-5-20251001", "go")).code).toBe(0);
    expect(h.claude.starts.at(-1)!.model).toBe("claude-haiku-4-5-20251001");
    await h.run("agents", "set", "claude", "--show", "claude-haiku-4-5-20251001");
    expect((await h.rt.preferences.get()).agentDefaults["claude"]).toEqual({ models: {} });
  });

  it("an agent's setup takes each variable's value where nothing echoes it, and no answer or listing prints it", async () => {
    const io = captured();
    io.isTTY = true;
    const prompts: string[] = [];
    io.askSecret = async q => (prompts.push(q), "bar-s3cret");
    const code = await cli(["agents", "setup", "claude", "--env", "FOO", "--json", "--state", h.statePath], io, undefined, h.env);
    expect(code).toBe(0);
    expect(prompts).toEqual(["FOO for Claude Code"]);
    expect(h.json(io).at(-1)).toMatchObject({ agent: { id: "claude", setup: { on: true, envNames: ["FOO"] } } });
    const listed = await h.run("agents", "--json");
    for (const said of [io.screen, listed.io.screen]) expect(said).not.toContain("bar-s3cret");
    // Nobody at the terminal to type a value: refused before anything is asked or sent.
    const piped = await h.run("agents", "setup", "claude", "--env", "BAR");
    expect(piped.code).toBe(3);
    const named = await h.run("agents", "setup", "claude", "--env", "BAR=baz");
    expect(named.code).toBe(3);
    // A variable that decides how the agent's process starts is refused before its value is asked for.
    const guarded = captured();
    guarded.isTTY = true;
    guarded.askSecret = async q => (prompts.push(q), "/evil");
    expect(await cli(["agents", "setup", "claude", "--env", "LD_PRELOAD", "--state", h.statePath], guarded, undefined, h.env)).toBe(3);
    expect(guarded.errors[0]).toBe("wsp agents setup: LD_PRELOAD decides how Claude Code starts or what it loads, so an agent's setup does not set it. Name another variable; this one is the computer's to say.");
    expect(prompts).toEqual(["FOO for Claude Code"]);
  });

  it("an agent turned off on this computer leaves its lists, and a run naming it is refused naming the computer", async () => {
    await h.macProject("mac");
    expect((await h.run("agents", "setup", "codex", "--disable")).code).toBe(0);
    const [mac] = await h.rt.workspaces.list();
    expect((await h.rt.harnesses.list(mac!.id)).map(c => c.harness)).toEqual(["claude"]);
    const off = await h.run("run", "mac", "--agent", "codex", "go");
    expect(off.code).toBe(3);
    expect(off.io.errors[0]).toMatch(/^wsp run: Codex is off on /);
    expect((await h.run("agents", "setup", "codex", "--enable")).code).toBe(0);
    expect((await h.run("run", "mac", "--agent", "codex", "go")).code).toBe(0);
  });

  it.runIf(CLOUD_ON)("a model, effort or access mode the agent's catalog does not list is refused with that list, in the composer's words, and nothing starts", async () => {
    await h.run("new", "alpha");
    const model = await h.run("run", "alpha", "--model", "claude-haiku-4-5", "review it");
    expect(model.code).toBe(3);
    expect(model.io.errors).toEqual([`wsp run: model "claude-haiku-4-5" is not one claude takes; one of: Opus 5.5 (claude-opus-5-5), Fable 5.1 (claude-fable-5-1), Sonnet 5 (claude-sonnet-5), Haiku 4.5 (claude-haiku-4-5-20251001); legacy: Opus 5 (claude-opus-5), Opus 4.8 (claude-opus-4-8), Opus 4.7 (claude-opus-4-7), Opus 4.6 (claude-opus-4-6), Opus 4.5 (claude-opus-4-5), Fable 5 (claude-fable-5), Sonnet 4.6 (claude-sonnet-4-6), Sonnet 4.5 (claude-sonnet-4-5)${BUILT_IN_LIST_CLAUSE}. Drop the flag, or give it a value the agent offers.`]);
    const effort = await h.run("run", "alpha", "--effort", "ultra", "review it");
    expect(effort.code).toBe(3);
    expect(effort.io.errors).toEqual([`wsp run: effort "ultra" is not one Opus 5.5 takes; one of: Low (low), Medium (medium), High (high), Extra high (xhigh), Max (max)${BUILT_IN_LIST_CLAUSE}. Drop the flag, or give it a value the agent offers.`]);
    withDaemonRoads(h.backend);
    const access = await h.run("fork", "alpha", "--send", "build it", "--access", "yolo");
    expect(access.code).toBe(3);
    expect(access.io.errors[0]).toBe("wsp fork: --access takes ask, auto-edit, full or plan, and got yolo. Name one of those; which of its own modes each one is, is the agent's row's to say.");
    // Checked against the table before the fork is minted, for the named agent or the default one.
    const other = await h.run("fork", "alpha", "--send", "build it", "--agent", "codex", "--effort", "minimal");
    expect(other.code).toBe(3);
    expect(other.io.errors).toEqual([
      `wsp fork: effort "minimal" is not one GPT-5.6-Sol takes; one of: Low (low), Medium (medium), High (high), Extra high (xhigh), Max (max), Ultra (ultra)${BUILT_IN_LIST_CLAUSE}. Drop the flag, or give it a value the agent offers.`,
    ]);
    expect((await h.rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);
    expect(h.claude.starts).toEqual([]);
    expect(h.codex.starts).toEqual([]);
    expect(await h.rt.sessions.list()).toEqual([]);
    const dangling = await h.run("fork", "alpha", "--model", "claude-sonnet-5");
    expect(dangling.code).toBe(3);
    expect(dangling.io.errors).toEqual(['wsp fork: --model says how a thread opens, and this line opens none. Add --send "<task>", or drop --model.']);
  });

  it("a refusal off wsp's built-in list says so, and one off the machine's own answer does not", async () => {
    await h.run("new", "alpha");
    const described = { version: "0.153.0", models: [{ slug: "gpt-5.6-sol", label: "GPT-5.6-Sol", contextWindows: [], isDefault: true }], efforts: ["low", "high"], permissionModes: ["read-only"] };
    h.backend.execImpl = (_m, cmd) => (cmd === PROBE_CMD ? { exitCode: 0, stdout: JSON.stringify(described), stderr: "" } : guestAnswer(cmd));
    const [alpha] = await h.rt.workspaces.list();
    // The claude here describes nothing, so the list its refusal quotes is wsp's own table; the codex describes
    // itself, so its refusal quotes the machine's own answer.
    const listed = await h.rt.harnesses.list(alpha!.id);
    expect(listed.find(c => c.harness === "claude")!.source).toBe("table");
    expect(listed.find(c => c.harness === "codex")!.source).toBe("harness");
    const table = await h.run("run", "alpha", "--model", "claude-opus-4-1", "review it");
    expect(table.code).toBe(3);
    expect(table.io.errors[0]).toContain("that list is wsp's built-in one");
    expect(table.io.errors[0]).toContain("the agent on that computer may take more");
    expect(table.io.errors).toHaveLength(1);

    const own = await h.run("run", "alpha", "--agent", "codex", "--model", "gpt-4", "review it");
    expect(own.code).toBe(3);
    // The machine's own agent named its models, so there is nothing to warn the person about.
    expect(own.io.errors).toEqual(['wsp run: model "gpt-4" is not one codex takes; one of: GPT-5.6-Sol (gpt-5.6-sol). Drop the flag, or give it a value the agent offers.']);
    expect(h.claude.starts).toEqual([]);
    expect(h.codex.starts).toEqual([]);
  });

  it("a run on this computer checks a model against the agent's own list there, the one its start and the composer read, before a worktree is made", async () => {
    const described: HarnessCatalogAnswer = {
      version: "2.1.0",
      models: [
        { slug: "claude-sonnet-5-5", label: "Sonnet 5.5", contextWindows: [], isDefault: true },
        { slug: "claude-sonnet-5", label: "Sonnet 5", contextWindows: [], isDefault: false },
      ],
      efforts: ["low", "high"],
      permissionModes: ["default", "acceptEdits", "bypassPermissions"],
    };
    await h.restartHost({ claude: ctx => ({ ...h.claude.adapter(ctx), probeCatalog: async () => described }), codex: probing(h.codex.adapter) });
    const { folder } = await h.macProject("mac");
    execFileSync("git", ["-C", folder, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
    const [mac] = await h.rt.workspaces.list();
    expect((await h.rt.harnesses.list(mac!.id)).find(c => c.harness === "claude")!.models.map(m => m.value)).toEqual(["claude-sonnet-5-5", "claude-sonnet-5"]);

    const only = await h.run("run", "mac", "--model", "claude-sonnet-5-5", "go");
    expect(only.code, only.io.errors.join("\n")).toBe(0);
    expect(h.claude.starts.at(-1)!.model).toBe("claude-sonnet-5-5");

    const listed = 'wsp run: model "claude-opus-4-1" is not one claude takes; one of: Sonnet 5.5 (claude-sonnet-5-5), Sonnet 5 (claude-sonnet-5)';
    const gone = await h.run("run", "mac", "--model", "claude-opus-4-1", "go");
    expect(gone.code).toBe(3);
    expect(gone.io.errors).toHaveLength(1);
    expect(gone.io.errors[0]!.startsWith(listed)).toBe(true);
    expect(gone.io.errors[0]).not.toContain("built-in");
    const branched = await h.run("run", "mac", "--branch", "feat/x", "--model", "claude-opus-4-1", "go");
    expect(branched.code).toBe(3);
    expect(branched.io.errors[0]!.startsWith(listed)).toBe(true);
    expect(h.copier.worktrees).toEqual([]);
    expect(h.claude.starts).toHaveLength(1);
  });

  it("a refusal off wsp's built-in list that quotes no list says whose word it is, as one sentence", async () => {
    await h.run("new", "alpha");
    const none = await h.run("run", "alpha", "--model", "claude-haiku-4-5-20251001", "--effort", "high", "review it");
    expect(none.code).toBe(3);
    expect(none.io.errors).toEqual([`wsp run: Haiku 4.5 takes no effort${BUILT_IN_TABLE_CLAUSE}. Drop the flag, or give it a value the agent offers.`]);
    expect(BUILT_IN_TABLE_CLAUSE).toBe("; wsp's built-in table says so, since no agent there described itself");
    expect(h.claude.starts).toEqual([]);
  });

  it("runs a legacy model at an effort the binary lists for it", async () => {
    await h.run("new", "alpha");
    const older = await h.run("run", "alpha", "--model", "claude-opus-5", "--effort", "high", "review it");
    expect(older.code).toBe(0);
    expect(h.claude.starts.map(s => [s.model, s.effort])).toEqual([["claude-opus-5", "high"]]);
  });

  it.runIf(CLOUD_ON)("checks a pick against the workspace's own machine, so a model only that machine knows is taken here as the app takes it", async () => {
    await h.run("new", "alpha");
    // A machine routed to another model provider: its codex names a model no table carries, and the app's composer
    // takes it because sessions.start checks the probed catalog. The command line has to agree with the app.
    const routed = {
      version: "0.153.0",
      models: [{ slug: "anthropic/claude-sonnet-4.5", label: "anthropic/claude-sonnet-4.5", contextWindows: [], isDefault: true }],
      efforts: ["low", "high"],
      permissionModes: ["read-only"],
    };
    h.backend.execImpl = (_m, cmd) => (cmd === PROBE_CMD ? { exitCode: 0, stdout: JSON.stringify(routed), stderr: "" } : guestAnswer(cmd));
    const opened = await h.run("run", "alpha", "--agent", "codex", "--model", "anthropic/claude-sonnet-4.5", "--effort", "high", "go");
    expect(opened.code).toBe(0);
    expect(h.codex.starts.at(-1)).toMatchObject({ model: "anthropic/claude-sonnet-4.5", effort: "high" });
    // The same list refuses a table model that machine does not have, naming the machine's own, and a fork checks
    // the workspace it forks from, whose golden the new machine comes from.
    withDaemonRoads(h.backend);
    const forked = await h.run("fork", "alpha", "--send", "go", "--agent", "codex", "--model", "gpt-5.5");
    expect(forked.code).toBe(3);
    expect(forked.io.errors).toEqual(['wsp fork: model "gpt-5.5" is not one codex takes; one of: anthropic/claude-sonnet-4.5 (anthropic/claude-sonnet-4.5). Drop the flag, or give it a value the agent offers.']);
    expect((await h.rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);
  });

  it.runIf(CLOUD_ON)("a --cwd that is not absolute is refused with the usage line before anything is created, started or dialled; fork's --cwd needs --send", async () => {
    await h.run("new", "alpha");
    const relative = await h.run("run", "alpha", "--cwd", "packages/host", "look here");
    expect(relative.code).toBe(3);
    // The usage the refusal carries is the verb's own, whatever its groups are; the words before it are the rule.
    expect(relative.io.errors).toEqual([`--cwd is a path on the machine, absolute, and got "packages/host". Give a path that opens with /, since whoever reads it works in a folder this line cannot see. usage: ${CLI_VERBS.find(v => v.name === "run")!.usage}`]);
    withDaemonRoads(h.backend);
    const forked = await h.run("fork", "alpha", "--send", "build it", "--cwd", "packages/host");
    expect(forked.code).toBe(3);
    expect(forked.io.errors[0]).toMatch(/^--cwd is a path on the machine, absolute, and got "packages\/host"\..* usage: wsp fork /);
    const dangling = await h.run("fork", "alpha", "--cwd", "/root/work");
    expect(dangling.code).toBe(3);
    expect(dangling.io.errors).toEqual(['wsp fork: --cwd says how a thread opens, and this line opens none. Add --send "<task>", or drop --cwd.']);
    expect((await h.rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);
    expect(await h.rt.sessions.list()).toEqual([]);
    expect(h.claude.starts).toEqual([]);
  });

  it("projects shortens a path that would not fit its column with an ellipsis at the front, keeping the end a person recognises", async () => {
    const deep = await projectOn(h.rt, undefined, "https://github.com/dev/a-project-with-a-very-long-name-indeed-and-then-some-more.git", { name: "a-project-with-a-very-long-name-indeed-and-then-some-more-again" });
    const { io } = await h.run("projects");
    const line = io.lines[0]!.split("\n").find(r => r.startsWith(deep.name))!;
    expect(line).toContain("…");
    expect(line).toContain(deep.path.slice(-20));
    expect(line).not.toContain(deep);
    // The path is cut for the column and whole on the wire.
    const asJson = await h.run("projects", "--json");
    const [{ projects }] = h.json(asJson.io) as [{ projects: { name: string; path: string }[] }];
    expect(projects.find(p => p.name === deep.name)!.path).toBe(deep.path);
  });

  it("threads shows a multi-paragraph brief as one row, titled by the protocol's rule: its first sentence cut at a word to 48 characters, the same title the sidebar shows", async () => {
    await h.run("new", "alpha");
    const brief = "You are a builder for the wsp repo, which is at /Users/zingzy/wsp on this machine.\n\nTicket: Zingzy/wsp-map#292.\nBuild: the fix.";
    await h.run("run", "alpha", brief);
    const { io } = await h.run("threads");
    const rows = io.lines[0]!.split("\n");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatch(/  You are a builder for the wsp repo, which is at…\s*$/);
    const asJson = await h.run("threads", "--json");
    const [{ threads }] = h.json(asJson.io) as [{ threads: ThreadView[] }];
    expect(threads[0]!.title).toBe("You are a builder for the wsp repo, which is at…");
  });

  it("send resumes the thread's latest session under its own agent; the thread keeps its id and who opened it", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    await h.run("run", "alpha", "--agent", "codex", "first");
    await (await h.rt.sessions.start(alpha!.id, { prompt: "from the app", harness: "claude" })).finished;
    const [byCli, byPerson] = await h.rt.sessions.list();
    const { code, io } = await h.run("send", byCli!.threadId!, "second");
    expect(code).toBe(0);
    expect(h.codex.starts.map(s => [s.prompt, s.resume])).toEqual([["first", undefined], ["second", byCli!.claudeSessionId]]);
    expect(io.lines).toEqual(["codex: second"]);
    expect(io.streamed).toBe("code\n$ ls\nx: second\ncompleted\n");
    const followUp = await h.run("send", byPerson!.threadId!, "and this");
    expect(followUp.code).toBe(0);
    expect(h.claude.starts.map(s => [s.prompt, s.resume])).toEqual([["from the app", undefined], ["and this", byPerson!.claudeSessionId]]);

    // Every start the verbs made carries its own request id on the wire and on the recorded start, so an app view with
    // the same text in flight cannot take it for its own; the app's start through the runtime sent none.
    const requestIds = (await h.rt.sessions.history(alpha!.id)).filter(e => e.type === "session.start").map(e => e.requestId);
    expect(requestIds.map(id => typeof id)).toEqual(["string", "undefined", "string", "string"]);
    expect(new Set(requestIds).size).toBe(4);

    // A resumed turn takes over its thread's row, as the app sees it too: one row per thread, the opener kept.
    const listed = await h.run("threads", "--json");
    const [{ threads }] = h.json(listed.io) as [{ threads: ThreadView[] }];
    expect(threads.map(t => [t.id, t.harness, t.startedBy, t.title, t.turns])).toEqual([
      [byCli!.threadId, "codex", "cli", "first", 1],
      [byPerson!.threadId, "claude", "person", "from the app", 1],
    ]);

    const prefixed = await h.run("send", byCli!.threadId!.slice(0, 8), "third");
    expect(prefixed.code).toBe(0);
    const missing = await h.run("send", "nope", "x");
    expect(missing.io.errors).toEqual(["wsp send: no thread nope"]);
  });

  it("a send whose start the host never answered before it stopped is delivered by the host that comes back, once, and never reads as a turn going on", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    await h.run("run", "alpha", "first");
    const [thread] = await h.rt.sessions.list();
    for (const detach of [false, true]) {
      // This host takes the start and never answers it, and records nothing: the window between the send's dial and
      // the start's answer, which a host that stops leaves as it goes.
      let reached = 0;
      h.rt.sessions.start = (() => {
        reached++;
        return new Promise(() => {});
      }) as typeof h.rt.sessions.start;
      const message = detach ? "third" : "second";
      const send = h.starting("send", thread!.threadId!, ...(detach ? ["--detach"] : []), message);
      await vi.waitFor(() => expect(reached).toBe(1), { timeout: 5_000, interval: 10 });
      await h.restartHost({ claude: h.claude.adapter });
      expect(await send.ended).toBe(0);
      expect(send.io.errors.filter(line => line.includes(HOST_STOPPING_LINE))).toEqual([]);
      if (!detach) expect(send.io.lines).toEqual([`re: ${message}`]);
      await vi.waitFor(async () => expect((await h.rt.sessions.history(alpha!.id)).filter(e => e.type === "session.done" && e.sessionId !== undefined).length).toBe(detach ? 3 : 2), { timeout: 5_000, interval: 10 });
      // One start of the message on the thread, under the one request id the send minted.
      const starts = (await h.rt.sessions.history(alpha!.id)).filter(e => e.type === "session.start" && e.prompt === message);
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({ threadId: thread!.threadId, requestId: expect.any(String) });
    }
  });

  it("a send the host took and stopped before it answered is not sent again: the host that comes back holds it, and the send follows that turn", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    await h.run("run", "alpha", "first");
    const [thread] = await h.rt.sessions.list();
    // This host runs the start and records it, then never answers it.
    const took = h.rt.sessions.start.bind(h.rt.sessions);
    let reached = 0;
    h.rt.sessions.start = (async (...args: Parameters<typeof h.rt.sessions.start>) => {
      reached++;
      await took(...args);
      return new Promise(() => {});
    }) as typeof h.rt.sessions.start;
    const send = h.starting("send", thread!.threadId!, "second");
    await vi.waitFor(async () => expect((await h.rt.sessions.history(alpha!.id)).some(e => e.type === "session.start" && e.prompt === "second")).toBe(true), { timeout: 5_000, interval: 10 });
    await h.restartHost({ claude: h.claude.adapter });
    expect(await send.ended).toBe(0);
    expect(reached).toBe(1);
    expect(h.claude.starts.map(s => s.prompt)).toEqual(["first", "second"]);
    const [second] = (await h.rt.sessions.history(alpha!.id)).filter(e => e.type === "session.start" && e.prompt === "second") as { turnId?: string; requestId?: string }[];
    expect(send.io.errors.filter(line => line.includes(HOST_STOPPING_LINE))).toEqual([]);
    // The rule is the host's: a start under a request id its transcript holds answers with that turn and starts nothing.
    const again = await h.rt.sessions.start(alpha!.id, { prompt: "second", thread: thread!.threadId!, requestId: second!.requestId! });
    expect([again.turnId, again.outcome]).toEqual([second!.turnId, "started"]);
    expect(h.claude.starts.map(s => s.prompt)).toEqual(["first", "second"]);
  });

  it("a run whose host stops under the reads before its start fails in one line saying the task was not delivered", async () => {
    await h.run("new", "alpha");
    let reached = 0;
    h.rt.harnesses.list = (() => {
      reached++;
      return new Promise(() => {});
    }) as typeof h.rt.harnesses.list;
    const started = h.starting("run", "alpha", "build it");
    await vi.waitFor(() => expect(reached).toBeGreaterThan(0), { timeout: 5_000, interval: 10 });
    await h.handle!.close();
    h.handle = undefined;
    expect(await started.ended).toBe(1);
    expect(started.io.errors).toEqual([`wsp run: ${NOT_DELIVERED_LINE}`]);
  });

  it("a host that boots over an index file written before it kept starts by request id reads the transcript again, so a start sent again is still the one it took", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    await h.run("run", "alpha", "first");
    const [first] = (await h.rt.sessions.history(alpha!.id)).filter(e => e.type === "session.start") as { turnId?: string; requestId?: string; threadId?: string }[];
    await h.handle!.close();
    h.handle = undefined;
    // The index as a host of the build before wrote it: every map it kept then, and none by request id.
    const held = await h.store.getBlob("transcript-index", alpha!.id);
    expect(held).toBeDefined();
    const { taken: _taken, ...older } = JSON.parse(held!.toString("utf8")) as Record<string, unknown>;
    await h.store.putBlob("transcript-index", alpha!.id, Buffer.from(JSON.stringify(older)));
    await h.restartHost({ claude: h.claude.adapter });
    const again = await h.rt.sessions.start(alpha!.id, { prompt: "first", thread: first!.threadId!, requestId: first!.requestId! });
    expect(again.turnId).toBe(first!.turnId);
    expect(h.claude.starts.map(s => s.prompt)).toEqual(["first"]);
  });

  it("a send whose host stops before it sent anything fails in one line saying the message was not delivered", async () => {
    await h.run("new", "alpha");
    await h.run("run", "alpha", "first");
    const [thread] = await h.rt.sessions.list();
    let reached = 0;
    h.rt.sessions.list = (() => {
      reached++;
      return new Promise(() => {});
    }) as typeof h.rt.sessions.list;
    const send = h.starting("send", thread!.threadId!, "second");
    await vi.waitFor(() => expect(reached).toBeGreaterThan(0), { timeout: 5_000, interval: 10 });
    await h.handle!.close();
    h.handle = undefined;
    expect(await send.ended).toBe(1);
    expect(send.io.errors).toEqual([`wsp send: ${NOT_DELIVERED_LINE}`]);
  });

  it("send into a thread whose turn runs joins that turn when the agent steers: one stderr line, the running turn's reply, one session.start and one session.steer", async () => {
    const held = heldAgent(true);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const first = h.run("run", "alpha", "loop for a minute, then say done");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await h.rt.sessions.list();
    const sent = h.run("send", row!.threadId!, "--model", "claude-sonnet-5", "--effort", "low", "end your last line with STEERED");
    await vi.waitFor(() => expect(held.steered).toEqual(["end your last line with STEERED"]));
    expect(held.starts).toHaveLength(1);
    held.release(0, "done STEERED");
    const opened = await first;
    const joined = await sent;
    expect(joined.code).toBe(0);
    // The picks cannot change a turn already running; the one line says which were dropped.
    expect(joined.io.errors).toEqual(["joined the running turn; --model, --effort dropped, it keeps its own model, effort and access"]);
    expect(joined.io.lines).toEqual(["done STEERED"]);
    expect(joined.io.streamed).toBe("done STEERED\ncompleted\n");
    expect(opened.io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`, "done STEERED"]);
    const [alpha] = await h.rt.workspaces.list();
    const history = await h.rt.sessions.history(alpha!.id);
    expect(history.map(e => e.type)).toEqual(["session.start", "session.steer", "session.delta", "session.done", "session.end"]);
    expect(history[1]).toMatchObject({ type: "session.steer", prompt: "end your last line with STEERED", requestId: expect.any(String) });
    expect(await h.rt.sessions.list()).toHaveLength(1);
  });

  it("a message that joined a turn stopped on a prompt says the turn is waiting on the person, so the quiet has a reason", async () => {
    const held = heldAgent(true);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const first = h.run("run", "alpha", "write it");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    held.ask(0, { askId: "a1", toolName: "Write", input: JSON.stringify({ file_path: "kai.txt" }), options: [{ id: "allow", label: "Yes", effect: "allow" }, { id: "deny", label: "No", effect: "deny" }] });
    const [row] = await h.rt.sessions.list();
    const io = captured();
    const sent = cli(["send", row!.threadId!, "yes", "--state", h.statePath], io, undefined, h.env);
    await vi.waitFor(() => expect(io.errors).toEqual(["joined the running turn", `the turn is waiting on a permission; wsp threads shows it as ${threadStateWord("waiting")}`]));
    held.release(0, "done");
    expect(await sent).toBe(0);
    await first;
  });

  it("send into a thread whose turn runs on an agent that cannot steer waits for that turn, then starts its own: one stderr line, the second start after the first done", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const first = h.run("run", "alpha", "one");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await h.rt.sessions.list();
    const sent = h.run("send", row!.threadId!, "two");
    await new Promise(r => setTimeout(r, 50));
    expect(held.starts).toHaveLength(1);
    held.release(0, "one done");
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    expect(held.starts.map(s => [s.prompt, s.resume])).toEqual([["one", undefined], ["two", row!.claudeSessionId]]);
    expect((await first).io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`, "one done"]);
    held.release(1, "two done");
    const queued = await sent;
    expect(queued.code).toBe(0);
    expect(queued.io.errors).toEqual(["waiting behind the running turn", "queued behind the running turn; it has ended and this turn started"]);
    expect(queued.io.lines).toEqual(["two done"]);
    const [alpha] = await h.rt.workspaces.list();
    expect((await h.rt.sessions.history(alpha!.id)).map(e => e.type)).toEqual(["session.start", "session.delta", "session.done", "session.end", "session.start", "session.delta", "session.done", "session.end"]);
    expect(held.steered).toEqual([]);
  });

  it("stop ends the thread's running turn through the runtime and says so; a thread whose turn is over says not running; the machine stays up", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const first = h.run("run", "alpha", "loop forever");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await h.rt.sessions.list();
    const stopped = await h.run("stop", row!.threadId!.slice(0, 8));
    expect(stopped.code).toBe(0);
    expect(stopped.io.lines).toEqual([`thread ${row!.threadId} stopped`]);
    expect(held.interrupted).toEqual([row!.id]);
    const opened = await first;
    expect(opened.code).toBe(1);
    expect(opened.io.errors).toEqual(["wsp run: turn interrupted"]);
    expect((await h.rt.sessions.list())[0]).toMatchObject({ id: row!.id, status: "interrupted" });
    const [alpha] = await h.rt.workspaces.list();
    expect(alpha!.phase).toBe("running");
    expect(h.backend.machines[0]).toMatchObject({ paused: false, killed: false });

    const idle = await h.run("stop", row!.threadId!, "--json");
    expect(idle.code).toBe(0);
    expect(h.json(idle.io)).toEqual([{ threadId: row!.threadId, outcome: "not-running" }]);
    expect(held.interrupted).toHaveLength(1);
    const missing = await h.run("stop", "nope");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp stop: no thread nope"]);
  });

  it("an agent's own subagents list under their thread with their task ids, and stop --task stops one of them alone", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    void h.run("run", "alpha", "fan out");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    await vi.waitFor(async () => expect((await h.rt.sessions.list())[0]?.claudeSessionId).toBeDefined());
    held.spawn(0, "a1", "count alpha");
    held.spawn(0, "b2", "count beta");
    const [row] = await h.rt.sessions.list();
    const thread = row!.threadId!;
    const listed = await h.run("threads");
    const cells = listed.io.lines[0]!.split("\n").slice(1).map(r => r.trim().split(/ {2,}/));
    // A child's THREAD and TASK cells are the two words a stop of it takes; its state is its own, and its agent started it.
    expect(cells.map(c => c.slice(2))).toEqual([
      [thread, "claude", "Working", "cli", expect.any(String), "fan out"],
      [thread, "a1", "claude", "Working", "agent", expect.any(String), "count alpha"],
      [thread, "b2", "claude", "Working", "agent", expect.any(String), "count beta"],
    ]);

    const stopped = await h.run("stop", thread.slice(0, 8), "--task", "a1");
    expect(stopped.code).toBe(0);
    expect(stopped.io.lines).toEqual([`thread ${thread} task a1 stopped`]);
    expect(held.tasksStopped).toEqual(["a1"]);
    expect(held.interrupted).toEqual([]);
    await vi.waitFor(async () => expect((await h.rt.sessions.list())[0]!.subagents?.map(c => c.state)).toEqual(["stopped", "running"]));
    const json = await h.run("threads", "--json");
    expect((JSON.parse(json.io.lines.at(-1)!) as { threads: ThreadView[] }).threads[0]!.subagents?.map(c => [c.id, c.state])).toEqual([["a1", "stopped"], ["b2", "running"]]);
    expect((await h.rt.sessions.list())[0]!.status).toBe("running");
    held.release(0, "done");
  });

  it("thread rename names the thread in the agent's own store and says so; an agent that keeps no name, one whose store has no such session, and an unknown thread each say why", async () => {
    const named = scriptedAgent(prompt => `re: ${prompt}`, title => (title === "nowhere" ? { kind: "no-session" } : title === "locked" ? { kind: "failed", error: "database is locked" } : { kind: "written" }));
    await h.restartHost({ claude: named.adapter, codex: h.codex.adapter });
    await h.run("new", "alpha");
    await h.run("run", "alpha", "build it");
    const [row] = await h.rt.sessions.list();

    const renamed = await h.run("thread", "rename", row!.threadId!.slice(0, 8), "the name he typed");
    expect(renamed.code).toBe(0);
    expect(renamed.io.lines).toEqual([`thread ${row!.threadId} named the name he typed, in Claude Code too`]);
    expect(named.renames).toEqual([{ sessionId: row!.claudeSessionId, title: "the name he typed" }]);
    expect(ThreadView.parse((await threadRows(await dialHost(h.statePath)))[0]).title).toBe("the name he typed");

    const nowhere = await h.run("thread", "rename", row!.threadId!, "nowhere", "--json");
    expect(nowhere.code).toBe(0);
    expect(h.json(nowhere.io)).toEqual([{ threadId: row!.threadId, title: "nowhere", harness: "claude", outcome: "no-session" }]);

    // A store that refused the write says nothing about its sessions, so its own line is the answer, not "no such session".
    const locked = await h.run("thread", "rename", row!.threadId!, "locked");
    expect(locked.code).toBe(0);
    expect(locked.io.lines).toEqual([`thread ${row!.threadId} not named: database is locked`]);
    expect(h.json((await h.run("thread", "rename", row!.threadId!, "locked", "--json")).io)).toEqual([
      { threadId: row!.threadId, title: "locked", harness: "claude", outcome: "failed", error: "database is locked" },
    ]);

    await h.run("run", "alpha", "--agent", "codex", "build it there");
    const codexRow = (await h.rt.sessions.list()).find(v => v.harness === "codex")!;
    const unsupported = await h.run("thread", "rename", codexRow.threadId!, "the name");
    expect(unsupported.code).toBe(0);
    expect(unsupported.io.lines).toEqual([`thread ${codexRow.threadId} not named: Codex keeps no name of a person's for a session`]);

    const missing = await h.run("thread", "rename", "nope", "the name");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp thread rename: no thread nope"]);
    const short = await h.run("thread", "rename", row!.threadId!);
    expect(short.code).toBe(3);
    expect(short.io.errors).toEqual(["wsp thread rename takes a thread and one name. usage: wsp thread rename <thread> \"<title>\""]);
  });

  it("thread rename wakes a napping workspace first, since the name goes into a store on its machine", async () => {
    const named = scriptedAgent(prompt => `re: ${prompt}`, () => ({ kind: "written" }));
    await h.restartHost({ claude: named.adapter });
    await h.run("new", "alpha");
    await h.run("run", "alpha", "build it");
    const [row] = await h.rt.sessions.list();
    await h.run("pause", "alpha");
    const renamed = await h.run("thread", "rename", row!.threadId!, "the name");
    expect(renamed.code).toBe(0);
    expect(renamed.io.errors).toEqual(["waking alpha"]);
    expect(named.renames).toEqual([{ sessionId: row!.claudeSessionId, title: "the name" }]);
    const [alpha] = await h.rt.workspaces.list();
    expect(alpha!.phase).toBe("running");
  });

  it("run --notify me prints the thread's end once on stderr, after the reply, and records it in the thread", async () => {
    await h.run("new", "alpha");
    const { code, io } = await h.run("run", "alpha", "--notify", "me", "build it");
    expect(code).toBe(0);
    const [row] = await h.rt.sessions.list();
    const line = `thread ${row!.threadId!.slice(0, 8)} finished (completed): re: build it`;
    expect(io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`, "re: build it"]);
    expect(io.errors).toEqual([line]);
    const [alpha] = await h.rt.workspaces.list();
    const history = await h.rt.sessions.history(alpha!.id);
    expect(history.map(e => e.type)).toEqual(["session.start", "session.delta", "session.delta", "session.delta", "session.notify", "session.done", "session.end"]);
    expect(history[4]).toMatchObject({ type: "session.notify", notify: "me", text: line, threadId: row!.threadId });

    const later = await h.run("send", row!.threadId!, "and the docs");
    expect(later.io.errors).toEqual([`thread ${row!.threadId!.slice(0, 8)} finished (completed): re: and the docs`]);
    expect(later.io.lines).toEqual(["re: and the docs"]);
  });

  it("run --notify <thread> tells that thread, by a prefix of its id, when the child ends: the running parent takes the line as a steer and the child's command prints no notice", async () => {
    const held = heldAgent(true);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const parent = h.run("run", "alpha", "orchestrate the builders");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [parentRow] = await h.rt.sessions.list();
    const kid = h.run("run", "alpha", "--notify", parentRow!.threadId!.slice(0, 8), "build it");
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    const kidRow = (await h.rt.sessions.list()).find(r => r.threadId !== parentRow!.threadId)!;
    held.release(1, "all green");
    const line = `thread ${kidRow.threadId!.slice(0, 8)} finished (completed): all green`;
    await vi.waitFor(() => expect(held.steered).toEqual([line]));
    const built = await kid;
    expect(built.code).toBe(0);
    expect(built.io.lines).toEqual([`thread ${kidRow.threadId}  ${THREAD_PREFIX_WORD}`, "all green"]);
    expect(built.io.errors).toEqual([]);
    held.release(0, "read the report");
    expect((await parent).io.lines).toEqual([`thread ${parentRow!.threadId}  ${THREAD_PREFIX_WORD}`, "read the report"]);
    expect(held.starts).toHaveLength(2);
    const [alpha] = await h.rt.workspaces.list();
    const history = await h.rt.sessions.history(alpha!.id);
    expect(history.filter(e => e.threadId === parentRow!.threadId).map(e => e.type)).toEqual(["session.start", "session.steer", "session.delta", "session.done", "session.end"]);
    expect(history.find(e => e.type === "session.steer")).toMatchObject({ prompt: line });
    expect(history.find(e => e.type === "session.notify")).toMatchObject({ threadId: kidRow.threadId, notify: parentRow!.threadId, text: line });

    const missing = await h.run("run", "alpha", "--notify", "nope", "x");
    expect(missing.io.errors).toEqual(["wsp run: no thread nope"]);
    expect(held.starts).toHaveLength(2);
  });

  it("--notify me run inside a turn names that turn's thread: the command line reads the token off the environment it runs with, and the parent is steered the child's report whole", async () => {
    const held = heldAgent(true);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const parent = h.run("run", "alpha", "orchestrate the builders");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [parentRow] = await h.rt.sessions.list();
    // The environment the host launched that turn under is the one a wsp inside it would run with.
    const token = held.envs[0]![TURN_TOKEN_ENV]!;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    h.env[TURN_TOKEN_ENV] = token;
    const kid = h.run("run", "alpha", "--notify", "me", "build it");
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    const kidRow = (await h.rt.sessions.list()).find(r => r.threadId !== parentRow!.threadId)!;
    held.release(1, "Ran the gate.\nAll 12 tests green.");
    const line = `thread ${kidRow.threadId!.slice(0, 8)} finished (completed): Ran the gate.\nAll 12 tests green.`;
    await vi.waitFor(() => expect(held.steered).toEqual([line]));
    const built = await kid;
    expect(built.code).toBe(0);
    // The child's own command prints no notice: the line went to the thread that asked for it, not to the person.
    expect(built.io.errors).toEqual([]);
    const [alpha] = await h.rt.workspaces.list();
    expect((await h.rt.sessions.history(alpha!.id)).find(e => e.type === "session.notify")).toMatchObject({ threadId: kidRow.threadId, notify: parentRow!.threadId, text: line });
    held.release(0, "read the report");
    await parent;
  });

  // The one command line that reads the process's own environment is the one a person runs: every case here hands
  // its environment in, so without this case a refactor could take TURN_TOKEN_ENV away from the real command line and
  // nothing would say so. It sets the variable it reads, in its own process, which is what the environment law asks.
  it("cli called with no environment of its own reads this process's, which is what a shell gives it", async () => {
    const held = heldAgent(true);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const parent = h.run("run", "alpha", "orchestrate the builders");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [parentRow] = await h.rt.sessions.list();
    vi.stubEnv(TURN_TOKEN_ENV, held.envs[0]![TURN_TOKEN_ENV]!);
    // No fourth argument: the default, which is this process's environment and nothing the case handed in.
    const io = captured();
    const kid = cli(["run", "alpha", "--notify", "me", "build it", "--state", h.statePath], io);
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    const kidRow = (await h.rt.sessions.list()).find(r => r.threadId !== parentRow!.threadId)!;
    held.release(1, "all green");
    const line = `thread ${kidRow.threadId!.slice(0, 8)} finished (completed): all green`;
    // The token arrived: the runtime resolved NOTIFY_ME to the turn it named and steered that thread.
    await vi.waitFor(() => expect(held.steered).toEqual([line]));
    expect(await kid).toBe(0);
    held.release(0, "read the report");
    await parent;
  });

  it("--notify repeats: a builder's end reaches the orchestrator that started it and a reviewer thread, each once", async () => {
    const held = heldAgent(true);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const orchestrator = h.run("run", "alpha", "orchestrate the builders");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const reviewer = h.run("run", "alpha", "review what lands");
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    const rows = await h.rt.sessions.list();
    const [leadRow, reviewRow] = rows;
    h.env[TURN_TOKEN_ENV] = held.envs[0]![TURN_TOKEN_ENV]!;
    const kid = h.run("run", "alpha", "--notify", "me", "--notify", reviewRow!.threadId!.slice(0, 8), "build it");
    await vi.waitFor(() => expect(held.starts).toHaveLength(3));
    const kidRow = (await h.rt.sessions.list()).find(r => r.threadId !== leadRow!.threadId && r.threadId !== reviewRow!.threadId)!;
    held.release(2, "all green");
    const line = `thread ${kidRow.threadId!.slice(0, 8)} finished (completed): all green`;
    await vi.waitFor(() => expect(held.steered).toEqual([line, line]));
    expect((await kid).code).toBe(0);
    const [alpha] = await h.rt.workspaces.list();
    const told = (await h.rt.sessions.history(alpha!.id)).filter(e => e.type === "session.notify");
    expect(told.map(e => e.notify)).toEqual([leadRow!.threadId, reviewRow!.threadId]);
    expect(told.map(e => e.text)).toEqual([line, line]);
    held.release(0, "read the report");
    held.release(1, "reviewed");
    await orchestrator;
    await reviewer;
  });

  it("--notify me with no token in the environment is still the person's, so a person's own shell and the app are unchanged", async () => {
    await h.run("new", "alpha");
    expect(h.env[TURN_TOKEN_ENV]).toBeUndefined();
    const { code, io } = await h.run("run", "alpha", "--notify", "me", "build it");
    expect(code).toBe(0);
    const [row] = await h.rt.sessions.list();
    expect(io.errors).toEqual([`thread ${row!.threadId!.slice(0, 8)} finished (completed): re: build it`]);
    const [alpha] = await h.rt.workspaces.list();
    expect((await h.rt.sessions.history(alpha!.id)).find(e => e.type === "session.notify")).toMatchObject({ notify: "me" });
  });

  it("a token no turn on this host carries is refused, and nothing starts", async () => {
    await h.run("new", "alpha");
    h.env[TURN_TOKEN_ENV] = "f".repeat(32);
    const { code, io } = await h.run("run", "alpha", "--notify", "me", "build it");
    expect(code).toBe(EXIT_CODES.provider);
    expect(io.errors).toEqual([`wsp run: ${NO_SUCH_TURN}`]);
    expect(io.lines).toEqual([]);
    expect(await h.rt.sessions.list()).toEqual([]);
  });

  it.runIf(CLOUD_ON)("fork --send --notify me prints the first turn's end on stderr as run does; a bad --notify fails before any machine is minted", async () => {
    await h.run("new", "alpha");
    withDaemonRoads(h.backend);
    const { code, io } = await h.run("fork", "alpha", "--name", "worker", "--send", "build it", "--notify", "me");
    expect(code).toBe(0);
    const worker = (await h.rt.workspaces.list()).find(w => w.name === "worker")!;
    const [row] = await h.rt.sessions.list(worker.id);
    expect(io.lines).toEqual([`created worker ${worker.id}, a copy of ${worker.project.name} at ${worker.project.path}\n${childStartedLine("worker", "work")}`, `thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`, "re: build it"]);
    expect(io.errors).toEqual([`thread ${row!.threadId!.slice(0, 8)} finished (completed): re: build it`]);

    const bad = await h.run("fork", "alpha", "--name", "never", "--send", "build it", "--notify", "nope");
    expect(bad.code).toBe(EXIT_CODES.usage);
    expect(bad.io.lines).toEqual([]);
    expect(bad.io.errors).toEqual(["wsp fork: no thread nope"]);
    expect((await h.rt.workspaces.list()).map(w => w.name).sort()).toEqual(["alpha", "worker"]);
  });

  it("send --json prints the turn's raw events and nothing else", async () => {
    await h.run("new", "alpha");
    await h.run("run", "alpha", "first");
    const [first] = await h.rt.sessions.list();
    const { code, io } = await h.run("send", first!.threadId!, "second", "--json");
    expect(code).toBe(0);
    const events = h.json(io) as { type: string; threadId?: string; kind?: string; text?: string }[];
    expect(events.map(e => e.type)).toEqual(["session.start", "session.delta", "session.delta", "session.delta", "session.done", undefined]);
    expect(events.at(-1)).toEqual({ threadId: first!.threadId, workspaceId: first!.workspaceId, harness: "claude", text: "re: second", outcome: "started" });
    expect(new Set(events.map(e => e.threadId))).toEqual(new Set([first!.threadId]));
    expect(events[1]).toMatchObject({ kind: "text", text: "re: " });
    expect(io.streamed).toBe("");
  });

  it("run --detach and send --detach print the thread id and return the moment the turn is started, before it ends; nothing streams", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const opened = await h.run("run", "alpha", "--detach", "build it");
    expect(held.starts).toHaveLength(1);
    const [row] = await h.rt.sessions.list();
    expect(row).toMatchObject({ status: "running", startedBy: "cli", prompt: "build it" });
    expect(opened.code).toBe(0);
    expect(opened.io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`]);
    expect(opened.io.errors).toEqual([]);
    expect(opened.io.streamed).toBe("");
    held.release(0, "first done");
    expect((await h.rt.sessions.list())[0]!.status).toBe("completed");
    const sent = await h.run("send", row!.threadId!.slice(0, 8), "--detach", "--json", "more");
    expect(held.starts.map(s => s.prompt)).toEqual(["build it", "more"]);
    expect(sent.code).toBe(0);
    expect(h.json(sent.io)).toEqual([{ threadId: row!.threadId, workspaceId: row!.workspaceId, harness: "claude", outcome: "started" }]);
    expect((await h.rt.sessions.list())[0]!.status).toBe("running");
    held.release(1, "second done");
    // A detached send that meets a running turn on an agent that cannot steer waits for its own start, as a followed one does, and says so.
    const third = await h.run("send", row!.threadId!, "--detach", "third");
    expect(third.io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`]);
    expect(held.starts).toHaveLength(3);
    const fourth = h.starting("send", row!.threadId!, "--detach", "fourth");
    // The waiting line is the runtime's answer that this start is behind the running turn: releasing that turn before
    // the line lands leaves the fourth start nothing to queue behind, so the fact is waited on and not a sleep.
    await vi.waitFor(() => expect(fourth.io.errors).toEqual(["waiting behind the running turn"]), { timeout: 10_000, interval: 10 });
    expect(held.starts).toHaveLength(3);
    held.release(2, "third done");
    await fourth.ended;
    expect(fourth.io.errors).toEqual(["waiting behind the running turn", "queued behind the running turn; it has ended and this turn started"]);
    expect(fourth.io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`]);
    expect(held.starts.map(s => s.prompt)).toEqual(["build it", "more", "third", "fourth"]);
    held.release(3, "fourth done");
  });

  it("threads wait returns the first of two threads to finish, in the notify line's words, then the second; a thread already over comes back at once from its transcript; a timeout prints nothing on stdout and says so on stderr", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    await h.run("run", "alpha", "--detach", "--notify", "me", "build a");
    await h.run("run", "alpha", "--detach", "build b");
    const [a, b] = await h.rt.sessions.list();
    const timedOut = await h.run("threads", "wait", a!.threadId!, b!.threadId!.slice(0, 8), "--timeout", "0.05");
    expect(timedOut.code).toBe(0);
    expect(timedOut.io.lines).toEqual([]);
    expect(timedOut.io.errors).toEqual(["2 threads still running after 50ms"]);
    const asJson = await h.run("threads", "wait", a!.threadId!, "--timeout", "0.05", "--json");
    expect(h.json(asJson.io)).toEqual([{ timedOut: true }]);
    expect(asJson.io.errors).toEqual([`thread ${a!.threadId!.slice(0, 8)} still running after 50ms`]);
    const now = Date.now;
    let skew = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + (skew += 5));
    const late = await h.run("threads", "wait", a!.threadId!, "--timeout", "0.05").finally(() => clock.mockRestore());
    expect(late.io.errors).toEqual([`thread ${a!.threadId!.slice(0, 8)} still running after 50ms`]);

    const waiting = h.run("threads", "wait", a!.threadId!, b!.threadId!);
    await new Promise(r => setTimeout(r, 30));
    held.release(1, "b is green\nall done for b");
    const first = await waiting;
    expect(first.code).toBe(0);
    // The whole reply under the finished line, not its last line: Marco waited on two threads and read a closing
    // remark off one and a code fence off the other, with the answers he was waiting for nowhere on his screen.
    expect(first.io.lines).toEqual([`thread ${b!.threadId!.slice(0, 8)} finished (completed): b is green\nall done for b`]);
    expect(first.io.lines[0]).toBe(notifyLine(b!.threadId!, { status: "completed", text: "b is green\nall done for b" }, "whole"));
    expect(first.io.errors).toEqual([]);
    // --tail is the last line alone, the line a notify sends; b is over, so it comes back at once.
    const tail = await h.run("threads", "wait", b!.threadId!, "--tail");
    expect(tail.code).toBe(0);
    expect(tail.io.lines).toEqual([`thread ${b!.threadId!.slice(0, 8)} finished (completed): all done for b`]);
    // b is over, so a wait naming both comes back with b at once, read off the transcript; the JSON is the tool's object.
    const again = await h.run("threads", "wait", a!.threadId!, b!.threadId!, "--json");
    expect(again.code).toBe(0);
    expect(h.json(again.io)).toEqual([{ finished: { threadId: b!.threadId, status: "completed", reply: "all done for b" } }]);

    const onlyA = h.run("threads", "wait", a!.threadId!);
    await new Promise(r => setTimeout(r, 30));
    held.release(0, "a done");
    const second = await onlyA;
    expect(second.io.lines).toEqual([`thread ${a!.threadId!.slice(0, 8)} finished (completed): a done`]);
    // The words are the one formatter's: the line the runtime recorded for a's --notify me is the line the wait printed.
    const history = await h.rt.sessions.history(a!.workspaceId);
    expect(history.find(e => e.type === "session.notify" && e.threadId === a!.threadId)).toMatchObject({ text: second.io.lines[0] });
    expect(second.io.lines[0]).toBe(notifyLine(a!.threadId!, { status: "completed", text: "a done" }));
    expect(held.starts).toHaveLength(2);

    const none = await h.run("threads", "wait");
    expect(none.code).toBe(3);
    expect(none.io.errors[0]).toContain("wsp threads wait takes one thread or more");
    const soon = await h.run("threads", "wait", a!.threadId!, "--timeout", "soon");
    expect(soon.code).toBe(3);
    expect(soon.io.errors[0]).toContain('--timeout takes seconds, a number above zero, and got "soon".');
    const missing = await h.run("threads", "wait", a!.threadId!, "nope");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp threads wait: no thread nope"]);
    // One word is the workspace it lists; two is more than the line takes.
    const stray = await h.run("threads", "nope", "also");
    expect(stray.code).toBe(3);
    expect(stray.io.errors[0]).toContain("wsp threads takes at most one project; wsp threads wait is its one subcommand");
    // Marco typed wsp threads read <thread> and this refusal was where he learned there was no such line; it names
    // the one there is.
    expect(stray.io.errors[0]).toContain("wsp thread read <thread> prints what one said");
  });

  it("threads wait on a thread whose first turn has not reached the machine blocks for that turn; the same thread once its turn is over comes back at once with its finished line", async () => {
    const held = heldAgent(false);
    let letProbe!: () => void;
    const probed = new Promise<void>(r => (letProbe = r));
    // The harness's own lists come off the machine before the turn is launched: seconds on a real machine, and the
    // window this case is about.
    await h.restartHost({ claude: ctx => ({ ...held.adapter(ctx), probeCatalog: async () => (await probed, null) }) });
    await h.run("new", "alpha");
    const [ws] = await h.rt.workspaces.list();
    const starting = h.rt.sessions.start(ws!.id, { prompt: "build it", startedBy: "cli" });
    await vi.waitFor(async () => expect(await h.rt.sessions.list()).toHaveLength(1), { timeout: 10_000, interval: 10 });
    const thread = (await h.rt.sessions.list())[0]!.threadId!;
    expect(held.starts).toHaveLength(0);

    let answered = false;
    const waiting = h.run("threads", "wait", thread, "--timeout", "3600").then(r => ((answered = true), r));
    await new Promise(r => setTimeout(r, 50));
    expect(answered).toBe(false);
    letProbe();
    await starting;
    expect(held.starts.map(s => s.prompt)).toEqual(["build it"]);
    // Still nothing: the turn the wait was told to wait for is only now running.
    await new Promise(r => setTimeout(r, 50));
    expect(answered).toBe(false);
    held.release(0, "all green");
    const finished = await waiting;
    expect(finished.code).toBe(0);
    expect(finished.io.lines).toEqual([`thread ${thread.slice(0, 8)} finished (completed): all green`]);

    const again = await h.run("threads", "wait", thread);
    expect(again.io.lines).toEqual([`thread ${thread.slice(0, 8)} finished (completed): all green`]);

    // A thread whose launch never reached the machine has no turn and never will; the wait answers at once for it too.
    await h.restartHost({ claude: bornDeadAgent(prompt => `re: ${prompt}`).adapter });
    await h.run("run", "alpha", "--detach", "never lands");
    const stillborn = (await h.rt.sessions.list()).find(r => r.prompt === "never lands")!;
    const atOnce = await h.run("threads", "wait", stillborn.threadId!);
    expect(atOnce.code).toBe(0);
    expect(atOnce.io.lines).toEqual([`thread ${stillborn.threadId!.slice(0, 8)} finished (failed): ${UNREACHED_LINE}`]);
  });

  it("a wait in flight on a thread whose launch gives up gets that thread's finished line, with the reason the start failed with", async () => {
    let letProbe!: () => void;
    const probed = new Promise<void>(r => (letProbe = r));
    const WOULD_NOT_LAUNCH = "the agent binary is not on this machine";
    await h.restartHost({
      claude: () => ({
        steers: false,
        probeCatalog: async () => (await probed, null),
        start: () => {
          throw new Error(WOULD_NOT_LAUNCH);
        },
      }),
    });
    await h.run("new", "alpha");
    const [ws] = await h.rt.workspaces.list();
    const giving = h.rt.sessions.start(ws!.id, { prompt: "build it", startedBy: "cli" });
    await vi.waitFor(async () => expect(await h.rt.sessions.list()).toHaveLength(1), { timeout: 10_000, interval: 10 });
    const thread = (await h.rt.sessions.list())[0]!.threadId!;

    let answered = false;
    const waiting = h.run("threads", "wait", thread, "--timeout", "3600").then(r => ((answered = true), r));
    await new Promise(r => setTimeout(r, 50));
    expect(answered).toBe(false);
    letProbe();
    await expect(giving).rejects.toThrow(WOULD_NOT_LAUNCH);
    // The turn will never run, so the wait is answered rather than left holding a thread that went away under it.
    const finished = await waiting;
    expect(finished.code).toBe(0);
    expect(finished.io.lines).toEqual([`thread ${thread.slice(0, 8)} finished (failed): ${WOULD_NOT_LAUNCH}`]);
    expect(finished.io.errors).toEqual([]);
    // No turn ran under it, so the thread is not one the sidebar lists or a later wait can name.
    expect(await threadRows(await dialHost(h.statePath))).toEqual([]);
    const later = await h.run("threads", "wait", thread);
    expect(later.code).toBe(EXIT_CODES.usage);
    expect(later.io.errors).toEqual([`wsp threads wait: no thread ${thread}`]);
  });

  it("a wait whose thread gives up between naming it and subscribing to it answers finished (failed) at once: a named thread with no row on the second read is over", async () => {
    let letProbe!: () => void;
    const probed = new Promise<void>(r => (letProbe = r));
    await h.restartHost({
      claude: () => ({
        steers: false,
        probeCatalog: async () => (await probed, null),
        start: () => {
          throw new Error("the agent binary is not on this machine");
        },
      }),
    });
    await h.run("new", "alpha");
    const [ws] = await h.rt.workspaces.list();
    const giving = h.rt.sessions.start(ws!.id, { prompt: "build it", startedBy: "cli" });
    await vi.waitFor(async () => expect(await h.rt.sessions.list()).toHaveLength(1), { timeout: 10_000, interval: 10 });
    const thread = (await h.rt.sessions.list())[0]!.threadId!;
    const client = await dialHost(h.statePath);
    try {
      // The verb's two steps, with the give-up between them: the thread is named off one listing, and by the time
      // the wait subscribes and lists again, the row and the end that answered for it are both gone.
      const named = await threadsOf(client, [thread]);
      expect(named.map(t => t.status)).toEqual(["running"]);
      letProbe();
      await expect(giving).rejects.toThrow("the agent binary is not on this machine");
      expect(await firstEnded(client, named, 1_000)).toEqual({ ended: { threadId: thread, result: { status: "failed" } } });
    } finally {
      client.close();
    }
  });

  it("a send that never launches on a thread that has worked leaves every reading of its last turn alone: the table, the read, the reply and the wait all say what that turn came to", async () => {
    const held = heldAgent(false);
    let launches = 0;
    await h.restartHost({
      claude: ctx => {
        const inner = held.adapter(ctx);
        return {
          ...inner,
          start: o => {
            if (++launches > 1) throw new Error("the harness would not launch");
            return inner.start(o);
          },
        };
      },
    });
    await h.run("new", "alpha");
    await h.run("run", "alpha", "--detach", "build it");
    const thread = (await h.rt.sessions.list())[0]!.threadId!;
    held.release(0, "the build is green\nall green");
    await vi.waitFor(async () => expect((await h.rt.sessions.list())[0]!.status).toBe("completed"), { timeout: 10_000, interval: 10 });

    const [ws] = await h.rt.workspaces.list();
    await expect(h.rt.sessions.start(ws!.id, { prompt: "and then this", thread })).rejects.toThrow("the harness would not launch");

    // One fact, how the thread's last turn went, and every door still gives the same answer.
    const listed = await threadRows(await dialHost(h.statePath));
    expect(listed.map(t => [t.id, t.status, t.turns])).toEqual([[thread, "completed", 1]]);
    expect((await h.run("thread", "read", thread, "--last")).io.lines[0]).toContain("the build is green\nall green");
    expect((await h.run("thread", "read", thread)).io.lines[0]).toContain("the build is green\nall green");
    expect((await h.run("threads", "wait", thread)).io.lines).toEqual([`thread ${thread.slice(0, 8)} finished (completed): the build is green\nall green`]);
    expect((await h.run("threads", "wait", thread, "--tail")).io.lines).toEqual([`thread ${thread.slice(0, 8)} finished (completed): all green`]);
  });

  it("threads wait on a turn the runtime ended says failed with the runtime's reason, as the notify line would; a turn the transport cut says the cut line", async () => {
    await h.restartHost({ claude: stuckAgent() });
    await h.run("new", "alpha");
    await h.run("run", "alpha", "--detach", "loop forever");
    const [row] = await h.rt.sessions.list();
    const waiting = h.run("threads", "wait", row!.threadId!);
    await new Promise(r => setTimeout(r, 30));
    await h.run("pause", "alpha");
    const paused = await waiting;
    expect(paused.code).toBe(0);
    expect(paused.io.lines).toEqual([`thread ${row!.threadId!.slice(0, 8)} finished (failed): machine paused while the agent was working`]);
    const later = await h.run("threads", "wait", row!.threadId!, "--json");
    expect(h.json(later.io)).toEqual([{ finished: { threadId: row!.threadId, status: "failed", reply: "machine paused while the agent was working" } }]);

    await h.restartHost({ claude: h.claude.adapter });
    await h.run("run", "alpha", "--detach", "cut");
    const cut = (await h.rt.sessions.list()).find(r => r.prompt === "cut")!;
    const cutWait = await h.run("threads", "wait", cut.threadId!);
    expect(cutWait.io.lines).toEqual([`thread ${cut.threadId!.slice(0, 8)} finished (failed): ${CUT_LINE}`]);
  });

  it("thread read prints the thread's messages as the app lists them, one line per tool call, --last the whole final message alone, and a thread that has not replied says so", async () => {
    await h.run("new", "alpha");
    await h.run("run", "alpha", "build it");
    const [row] = await h.rt.sessions.list();
    const id = row!.threadId!;
    const read = await h.run("thread", "read", id.slice(0, 8));
    expect(read.code).toBe(0);
    expect(read.io.errors).toEqual([]);
    const blocks = read.io.lines[0]!.split("\n\n").map(block => block.split("\n"));
    // Who spoke and the clock head each block; the text of the block is what was said.
    expect(blocks.map(block => block[0])).toEqual(["person", "agent", "tool", "agent", "turn"].map(who => expect.stringMatching(new RegExp(`^${who} \\d\\d:\\d\\d:\\d\\d$`))));
    expect(blocks.map(block => block.slice(1).join("\n"))).toEqual(["build it", "re: ", "$ ls", "build it", "completed"]);
    // The events the app reads are the events this read folded: nothing on the machine was asked for it.
    expect(launchedScripts(h.backend).filter(script => script.includes("sessions"))).toEqual([]);

    const last = await h.run("thread", "read", id, "--last", "--json");
    expect(h.json(last.io)).toEqual([{ threadId: id, messages: [{ who: "agent", at: expect.any(Number), text: "re: build it" }] }]);
    // The whole final message is the one the finished line carries, so a read of the reply and a wait on it agree.
    expect(notifyLine(id, { status: "completed", text: "re: build it" }, "whole")).toContain("re: build it");

    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("run", "alpha", "--detach", "hold on");
    const pending = (await h.rt.sessions.list()).find(session => session.prompt === "hold on")!;
    const nothing = await h.run("thread", "read", pending.threadId!, "--last");
    expect(nothing.code).toBe(0);
    expect(nothing.io.lines).toEqual([noReplyLine(pending.threadId!)]);
    const running = await h.run("thread", "read", pending.threadId!, "--json");
    expect(h.json(running.io)).toEqual([{ threadId: pending.threadId, messages: [{ who: "person", at: expect.any(Number), text: "hold on" }] }]);
    held.release(0, "held no longer");

    const none = await h.run("thread", "read");
    expect(none.code).toBe(3);
    expect(none.io.errors[0]).toContain("wsp thread read takes one thread");
    const missing = await h.run("thread", "read", "nope");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp thread read: no thread nope"]);
  });

  it("takes --state wherever it sits: before the verb's words, between them and after them", async () => {
    await h.run("new", "alpha");
    await h.run("run", "alpha", "build it");
    const id = (await h.rt.sessions.list())[0]!.threadId!;

    const before = await h.typed("--state", h.statePath, "thread", "read", id);
    const between = await h.typed("thread", "--state", h.statePath, "read", id);
    const after = await h.typed("thread", "read", id, "--state", h.statePath);
    expect([before.code, between.code, after.code]).toEqual([0, 0, 0]);
    expect([before.io.errors, between.io.errors, after.io.errors]).toEqual([[], [], []]);
    expect(before.io.lines).toEqual(after.io.lines);
    expect(between.io.lines).toEqual(after.io.lines);
    expect(after.io.lines[0]).toContain("build it");
  });

  it("takes --json wherever it sits, so a line that asks for JSON before the verb's words prints JSON", async () => {
    await h.run("new", "alpha");
    await h.run("run", "alpha", "build it");
    const id = (await h.rt.sessions.list())[0]!.threadId!;
    const answer = [{ threadId: id, messages: [{ who: "agent", at: expect.any(Number), text: "re: build it" }] }];

    const before = await h.typed("--json", "thread", "read", id, "--last", "--state", h.statePath);
    const between = await h.typed("thread", "--json", "read", id, "--last", "--state", h.statePath);
    const after = await h.typed("thread", "read", id, "--last", "--json", "--state", h.statePath);
    expect([before.code, between.code, after.code]).toEqual([0, 0, 0]);
    expect(h.json(before.io)).toEqual(answer);
    expect(h.json(between.io)).toEqual(answer);
    expect(h.json(after.io)).toEqual(answer);
  });

  it("hands the verb the rest of the line in the order it was typed, so its own flags are read beside a shared one", async () => {
    await h.run("new", "alpha");
    await h.run("run", "alpha", "build it");
    const id = (await h.rt.sessions.list())[0]!.threadId!;

    // The shared flag between the verb's words, the verb's own flag at the end.
    const { code, io } = await h.typed("thread", "--state", h.statePath, "read", id, "--last");
    expect(code).toBe(0);
    expect(io.errors).toEqual([]);
    expect(io.lines).toEqual([expect.stringContaining("re: build it")]);
  });

  it("refuses a shared flag left at the end of the line by its own name, never reading the verb's word as its value", async () => {
    for (const name of ["--state", "--host"]) {
      const { code, io } = await h.typed("thread", "read", "th_one", name);
      const refusal = io.errors.join("\n");
      expect(code, name).toBe(EXIT_CODES.usage);
      expect(refusal, name).toContain(`Option '${name} <value>' argument missing`);
      // The word the verb was given is its own, so nothing about it is read back as the flag's value.
      expect(refusal, name).not.toContain("th_one");
    }
  });

  it("refuses a misspelt shared flag by the word that was typed, in two halves, wherever it sits", async () => {
    const threads = CLI_VERBS.find(v => v.name === "threads")!;
    for (const [argv, fix] of [
      [["--stat", h.statePath, "threads"], runForTheList("wsp --help")],
      [["thread", "--stat", h.statePath, "read", "th_one"], runForTheList("wsp --help")],
      [["threads", "--stat", h.statePath], `usage: ${threads.usage}`],
    ] as [string[], string][]) {
      const { code, io } = await h.typed(...argv);
      const refusal = io.errors.join("\n");
      expect(code, argv.join(" ")).toBe(EXIT_CODES.usage);
      // Two halves: the word as it was typed, then what to do about it after it.
      expect(refusal, argv.join(" ")).toContain("--stat'");
      expect(refusal.indexOf(fix), argv.join(" ")).toBeGreaterThan(refusal.indexOf("--stat'"));
    }
  });

  it.runIf(CLOUD_ON)("run, send and fork --send return with the reply on the turn's session.done; a session.end that never comes is not waited for", async () => {
    const agent = doneOnlyAgent(prompt => `re: ${prompt}`);
    await h.restartHost({ claude: agent.adapter });
    await h.run("new", "alpha");
    const opened = await h.run("run", "alpha", "first");
    const [row] = await h.rt.sessions.list();
    expect(opened.code).toBe(0);
    expect(opened.io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`, "re: first"]);
    expect(opened.io.errors).toEqual([]);
    const sent = await h.run("send", row!.threadId!, "second", "--json");
    expect(sent.code).toBe(0);
    expect((h.json(sent.io) as { type: string }[]).map(e => e.type)).toEqual(["session.start", "session.delta", "session.done", undefined]);
    withDaemonRoads(h.backend);
    const forked = await h.run("fork", "alpha", "--name", "worker", "--send", "third");
    expect(forked.code).toBe(0);
    expect(forked.io.lines.slice(1)).toEqual([expect.stringMatching(/^thread /), "re: third"]);
    expect(agent.starts.map(s => s.prompt)).toEqual(["first", "second", "third"]);
    expect((await h.rt.sessions.history(row!.workspaceId)).map(e => e.type)).not.toContain("session.end");
  });

  it("exec runs the command on the workspace's machine, streams its output and exits with its code", async () => {
    await h.run("new", "alpha");
    execGuest(h.backend, "one\ntwo\n", 3);
    const { code, io } = await h.run("exec", "alpha", "--", "sh", "-c", "printf 'one\\ntwo\\n'; exit 3");
    expect(code).toBe(3);
    expect(io.lines).toEqual(["one", "two"]);
    expect(launchedScript(h.backend)).toContain("'sh' '-c' 'printf '\\''one\\ntwo\\n'\\''; exit 3'\n");

    const raw = await h.run("exec", "alpha", "--json", "--", "true");
    expect(raw.code).toBe(3);
    expect(h.json(raw.io)).toEqual([
      { type: "exec.output", execId: expect.any(String), text: "one" },
      { type: "exec.output", execId: expect.any(String), text: "two" },
      // The command ran in the workspace's project, and the reply says where rather than restating the rule.
      { exitCode: 3, cwd: (await h.rt.workspaces.list())[0]!.project.path },
    ]);
    const bare = await h.run("exec", "alpha");
    expect(bare.code).toBe(3);
    expect(bare.io.errors).toEqual(["wsp exec takes a workspace, then -- and the command. usage: wsp exec <workspace> [--cwd <dir>] -- <command...>"]);
  });

  describe("one list behind every verb", () => {
    /** The workspace a thread of this host's runs on, its agents allowed to spawn. */
    async function leadWorkspace(): Promise<WorkspaceView> {
      await h.run("new", "alpha", "--spawn", "on");
      return (await h.rt.workspaces.list()).find(w => w.name === "alpha")!;
    }
    /** What a turn's launch hands the thread running on that workspace: the address of this host and a token scoped
     * to the thread, which is the pair a wsp line inside a turn dials with. Every line after this runs as that thread. */
    async function asThread(workspace: WorkspaceView, threadId: string): Promise<void> {
      const scoped = await h.rt.devices.mint(`thread ${threadId}`, { kind: "thread", threadId, workspaceId: workspace.id, rootThreadId: threadId }, Date.now());
      h.env[HOST_URL_ENV] = `ws://127.0.0.1:${h.handle!.port}`;
      h.env[HOST_TOKEN_ENV] = scoped.deviceToken;
      // The fingerprint of the key this host proves rides the launch beside them, and the line holds the host to
      // it before the token crosses: a turn on a machine reaches this host over a road somebody else carries.
      h.env[HOST_KEY_ENV] = hostKeyHere(h.statePath);
    }
    /** A line as that thread types it: no --state, since the pair in its environment says which host it runs against. */
    async function line(...argv: string[]): Promise<{ code: number; io: Captured }> {
      const io = captured();
      return { code: await cli(argv, io, undefined, h.env), io };
    }

    it("every verb takes the workspaces the caller's own listing prints, by name and by id", async () => {
      const alpha = await leadWorkspace();
      await h.run("run", "alpha", "hello");
      const [row] = await h.rt.sessions.list();
      await asThread(alpha, "t_lead");
      execGuest(h.backend, "Linux\n", 0);
      expect((await line("exec", "alpha", "--", "uname")).io.lines).toEqual(["Linux"]);
      expect((await line("exec", alpha.id, "--", "uname")).io.lines).toEqual(["Linux"]);
      const listedThreads = await line("threads", "alpha", "--json");
      expect(listedThreads.code, listedThreads.io.errors.join("\n")).toBe(0);
      // The person's own thread is another tree on the same workspace: the caller's listing leaves it out and its
      // id reads as no thread at all, so a thread cannot send into one it did not open.
      expect(h.json(listedThreads.io)).toEqual([{ threads: [] }]);
      expect((await line("send", row!.threadId!, "and the rest")).io.errors).toEqual([`wsp send: no thread ${row!.threadId}`]);
      // The thread it opened for itself is the one it drives, on the same ids the same listing prints.
      const opened = await line("run", "alpha", "kid");
      expect(opened.code, opened.io.errors.join("\n")).toBe(0);
      const kid = (await h.rt.sessions.list()).find(r => r.threadId !== row!.threadId)!;
      expect(h.json(await line("threads", "alpha", "--json").then(r => r.io))).toEqual([{ threads: [expect.objectContaining({ threadId: kid.threadId })] }]);
      expect((await line("send", kid.threadId!, "and the rest")).code).toBe(0);
    });

    it("a workspace the caller's reach hides reads to a thread exactly as one that does not exist", async () => {
      const alpha = await leadWorkspace();
      await h.run("new", "beta");
      const beta = (await h.rt.workspaces.list()).find(w => w.name === "beta")!;
      await asThread(alpha, "t_lead");
      // Every word for beta reads as absent: the name, the whole id and the start of one alike, so walking this
      // host's ids tells a thread nothing about what stands outside its tree.
      expect((await line("exec", "beta", "--", "uname")).io.errors).toEqual([`wsp exec: ${noWorkspaceRefusal("beta")}`]);
      expect((await line("exec", beta.id, "--", "uname")).io.errors).toEqual([`wsp exec: ${noWorkspaceRefusal(beta.id)}`]);
      // The start has to miss alpha's id too, which a random pair shares for several characters now and then.
      let n = 6;
      while (alpha.id.startsWith(beta.id.slice(0, n))) n++;
      const start = beta.id.slice(0, n);
      expect((await line("exec", start, "--", "uname")).io.errors).toEqual([`wsp exec: ${noWorkspaceRefusal(start)}`]);
      expect(h.json((await line("threads", "beta", "--json")).io)).toEqual([{ threads: [] }]);
      // A name nothing here carries reads the same, which is the whole of what the two have to say to a thread.
      expect((await line("exec", "gamma", "--", "uname")).io.errors).toEqual([`wsp exec: ${noWorkspaceRefusal("gamma")}`]);
    });
  });

  it("exec hands the machine each argument as it was given: a quoted word stays one word", async () => {
    await h.run("new", "alpha");
    execGuest(h.backend, "", 0);
    const { code } = await h.run("exec", "alpha", "--", "grep", "a b", "file.txt");
    expect(code).toBe(0);
    const held = (await h.rt.workspaces.list())[0]!.project.path;
    expect(launchedScript(h.backend)).toContain(`\ncd '${held}' && 'grep' 'a b' 'file.txt'\n`);
  });

  it("exec runs in --cwd when given, else in the workspace's project folder; a failing command says on stderr where it ran", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    const held = alpha!.project.path;
    execGuest(h.backend, "", 0);
    const inProject = await h.run("exec", "alpha", "--", "git", "status");
    expect(inProject.code).toBe(0);
    expect(inProject.io.errors).toEqual([]);
    expect(launchedScripts(h.backend).at(-1)).toContain(`\ncd '${held}' && 'git' 'status'\n`);

    const named = await h.run("exec", "alpha", "--cwd", "/root/work/else where", "--", "git", "status");
    expect(named.code).toBe(0);
    expect(launchedScripts(h.backend).at(-1)).toContain("\ncd '/root/work/else where' && 'git' 'status'\n");

    execGuest(h.backend, "fatal: not a git repository\n", 128);
    const failing = await h.run("exec", "alpha", "--", "git", "status");
    expect(failing.code).toBe(128);
    expect(failing.io.lines).toEqual(["fatal: not a git repository"]);
    expect(failing.io.errors).toEqual([`ran in ${held}`]);

    const overridden = await h.run("exec", "alpha", "--cwd", "/root", "--", "git", "status");
    expect(overridden.code).toBe(128);
    expect(launchedScripts(h.backend).at(-1)).toContain("\ncd '/root' && 'git' 'status'\n");
    expect(overridden.io.errors).toEqual(["ran in /root"]);

    const relative = await h.run("exec", "alpha", "--cwd", "packages/host", "--", "git", "status");
    expect(relative.code).toBe(3);
    expect(relative.io.errors).toEqual(['--cwd is a path on the machine, absolute, and got "packages/host". Give a path that opens with /, since whoever reads it works in a folder this line cannot see. usage: wsp exec <workspace> [--cwd <dir>] -- <command...>']);
  });

  it("a failing exec says the folder the host ran it in, which on this computer is the project's folder", async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-exec-")));
    execFileSync("git", ["init", "-q", folder]);
    const here = await projectOn(h.rt, HERE_PLACE_ID, folder, { name: "mac" });
    await h.run("new", here.name, "mac");
    const local = await h.run("exec", "mac", "--", "false");
    expect(local.code).toBe(1);
    expect(local.io.errors).toEqual([`ran in ${folder}`]);
    const raw = await h.run("exec", "mac", "--json", "--", "false");
    expect(h.json(raw.io).at(-1)).toEqual({ exitCode: 1, cwd: folder });
    rmSync(folder, { recursive: true, force: true });
  });

  it("a host that stops under an exec says so and that the turn goes on, in one line with exit 1 instead of hanging", async () => {
    await h.run("new", "alpha");
    execGuest(h.backend, "", undefined);
    const command = h.run("exec", "alpha", "--", "sleep", "600");
    await new Promise(r => setTimeout(r, 300));
    await h.handle!.close();
    h.handle = undefined;
    const c = await command;
    expect(c.code).toBe(1);
    expect(c.io.errors).toEqual([`wsp exec: ${HOST_STOPPING_LINE}`]);
  });

  it("a run and a threads wait whose host restarts under them wait for it to come back, and the run prints the reply whole though its stream was cut", async () => {
    const lasting = lastingAgent();
    await h.restartHost({ claude: lasting.adapter });
    await h.run("new", "alpha");
    const turn = h.starting("run", "alpha", "build it");
    turn.io.sameScreen = true;
    await vi.waitFor(() => expect(lasting.started()).toBe(1), { timeout: 5_000, interval: 10 });
    const [row] = await h.rt.sessions.list();
    await vi.waitFor(() => expect(turn.io.lines).toHaveLength(1), { timeout: 5_000, interval: 10 });
    const waited = h.run("threads", "wait", row!.threadId!);
    await new Promise(r => setTimeout(r, 300));
    await h.restartHost({ claude: lasting.adapter });
    // The host that came back has re-opened the run before its lines are sent, so they reach the host now serving.
    await h.rt.sessions.list();
    expect(lasting.attached()).toBe(1);
    lasting.finish("built it");
    const [code, w] = await Promise.all([turn.ended, waited]);
    expect(code).toBe(0);
    // On a person's own screen the streamed copy is the reply, but this one was cut when the host stopped, so the
    // reply is printed whole under the thread's line.
    expect(turn.io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`, "built it"]);
    expect(turn.io.errors).toEqual([HOST_RESTARTING_LINE]);
    expect(w.code).toBe(0);
    expect(w.io.lines).toEqual([`thread ${row!.threadId!.slice(0, 8)} finished (completed): built it`]);
    expect(w.io.errors).toEqual([HOST_RESTARTING_LINE]);
  });

  it("restart has the host restart on the road it came up on and answers once the host that replaced it serves, with the threads running on it; a host wsp up holds in a terminal refuses in that road's words", async () => {
    const lasting = lastingAgent();
    // The verb's road as the host takes it: the host closes, and the one that replaces it serves the same state file.
    const road: RestartRoad = { shape: "verb", restart: () => h.restartHost({ claude: lasting.adapter }, h.store, undefined, h.backend, road) };
    await h.restartHost({ claude: lasting.adapter }, h.store, undefined, h.backend, road);
    await h.run("new", "alpha");
    await h.run("run", "alpha", "--detach", "build it");
    const [row] = await h.rt.sessions.list();
    const before = h.handle;
    const restarted = await h.run("restart");
    expect(restarted.code).toBe(0);
    expect(h.handle).not.toBe(before);
    expect(restarted.io.lines).toEqual([hostRestartedLine([row!.threadId!])]);
    expect(lasting.attached()).toBe(1);

    const asJson = await h.run("restart", "--json");
    expect(asJson.code).toBe(0);
    expect(h.json(asJson.io)).toEqual([{ running: [row!.threadId] }]);
    lasting.finish("built it");
    await vi.waitFor(async () => expect((await h.rt.sessions.list())[0]!.status).toBe("completed"), { timeout: 5_000, interval: 10 });
    expect((await h.run("restart")).io.lines).toEqual([hostRestartedLine([])]);

    await h.restartHost({ claude: lasting.adapter }, h.store, undefined, h.backend, restartRoads({ exit: () => {}, respawn: async () => {}, log: () => {} }).up);
    const refused = await h.run("restart");
    expect(refused.code).toBe(EXIT_CODES.provider);
    expect(refused.io.errors).toEqual([`wsp restart: ${UP_RESTART_LINE}`]);
    const extra = await h.run("restart", "now");
    expect(extra.code).toBe(EXIT_CODES.usage);
    expect(extra.io.errors).toEqual(["wsp restart takes no arguments. usage: wsp restart"]);
  });

  it("a wait whose host does not come back gives up once its window runs out, with the dial's own refusal, and a dial that hangs is held to what is left", async () => {
    const gone = new Error(noHostServingLine(h.statePath));
    const within: number[] = [];
    let started = Date.now();
    await expect(hostAgain(async left => {
      within.push(left);
      throw gone;
    }, 300)).rejects.toBe(gone);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(within.length).toBeGreaterThan(1);
    expect(within.every(left => left > 0 && left <= 300)).toBe(true);
    // A port that accepts and never answers: each dial waits out the deadline it was handed, and the wait still ends
    // at its window rather than a whole dial window past it.
    started = Date.now();
    await expect(hostAgain(left => new Promise<HostClient>((_, fail) => setTimeout(() => fail(gone), left)), 300)).rejects.toBe(gone);
    expect(Date.now() - started).toBeLessThan(600);
  });

  it("the workspace being deleted under a running exec fails the verb with the reason and exit 1", async () => {
    await h.run("new", "alpha");
    execGuest(h.backend, "", undefined);
    const command = h.run("exec", "alpha", "--", "sleep", "600");
    await new Promise(r => setTimeout(r, 300));
    const [alpha] = await h.rt.workspaces.list();
    await h.rt.workspaces.delete(alpha!.id);
    const c = await command;
    expect(c.code).toBe(1);
    expect(c.io.errors).toEqual(["wsp exec: machine deleted while the agent was working"]);
  });

  it("a host whose sessions.start reply has no turn id or outcome is refused in one line before the follow, never printed as undefined", async () => {
    await h.handle!.close();
    h.handle = undefined;
    const old = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>(r => old.once("listening", r));
    const port = (old.address() as AddressInfo).port;
    writeFileSync(hostTokenPath(h.statePath), "tok\n");
    writeFileSync(lockPathFor(h.statePath), JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
    const workspace = { id: "ws_1", name: "alpha", machineId: "m1", phase: "running", golden: "snap_gold", createdAt: "2026-09-06T00:00:00.000Z" };
    const session = { id: "s_1", workspaceId: "ws_1", harness: "claude", status: "running", threadId: "t_1" };
    old.on("connection", socket => {
      socket.on("message", raw => {
        const { id, op } = JSON.parse(String(raw)) as { id: number; op: string };
        const reply =
          op === "workspaces.list"
            ? { workspaces: [workspace] }
            : op === "workspaces.resolve" || op === "workspaces.wake"
              ? { workspace }
              : op === "harnesses.list"
                ? { harnesses: [] }
                : op === "sessions.start"
                  ? { session }
                  : {};
        socket.send(JSON.stringify({ id, ok: true, ...reply }));
      });
    });
    try {
      const { code, io } = await h.run("run", "alpha", "first");
      expect(code).toBe(1);
      expect(io.lines).toEqual([]);
      expect(io.streamed).toBe("");
      expect(io.errors).toEqual(["wsp run: the host answered workspaces.resolve in a shape this wsp does not read; it runs another version of wsp, restart it with wsp up"]);
    } finally {
      for (const client of old.clients) client.terminate();
      await new Promise(r => old.close(r));
    }
  });

  it("a request the host's own validator refuses reads as one line naming what it would not take and the form the verb takes, never the wire's schema", async () => {
    await h.handle!.close();
    h.handle = undefined;
    const old = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>(r => old.once("listening", r));
    const port = (old.address() as AddressInfo).port;
    writeFileSync(hostTokenPath(h.statePath), "tok\n");
    writeFileSync(lockPathFor(h.statePath), JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
    const workspace = { id: "ws_1", name: "alpha", machineId: "m1", phase: "running", golden: "snap_gold", createdAt: "2026-09-06T00:00:00.000Z", project: { id: "pr_1", name: "api", path: "/root/api", computer: "default" } };
    // The validator's own words, off the very schema the host parses a request with.
    let refusal = RuntimeRequest.safeParse({ id: 1, op: "workspaces.exec" }).error!.message;
    old.on("connection", socket => {
      socket.on("message", raw => {
        const { id, op } = JSON.parse(String(raw)) as { id: number; op: string };
        if (op === "workspaces.exec") return void socket.send(JSON.stringify({ id, ok: false, error: refusal }));
        const reply = op === "workspaces.resolve" || op === "workspaces.wake" ? { workspace } : {};
        socket.send(JSON.stringify({ id, ok: true, ...reply }));
      });
    });
    try {
      const ran = await h.run("exec", "alpha", "--", "ls");
      expect(ran.code).toBe(EXIT_CODES.usage);
      expect(ran.io.errors).toEqual(["wsp exec: the host would not read the workspace and the command on this line. usage: wsp exec <workspace> [--cwd <dir>] -- <command...>"]);
      // None of the wire's own words reach the person: not a field name, not a code, not one of the ops it listed.
      expect(ran.io.errors[0]).not.toContain("workspaceId");
      expect(ran.io.errors[0]).not.toContain("invalid_type");

      // An op the host does not know is the two builds differing, which no argument of the line can fix.
      refusal = RuntimeRequest.safeParse({ id: 1, op: "a.verb.this.host.has.never.served" }).error!.message;
      const skewed = await h.run("exec", "alpha", "--", "ls");
      expect(skewed.code).toBe(EXIT_CODES.usage);
      expect(skewed.io.errors).toEqual(["wsp exec: the host does not serve this line; it runs another version of wsp, restart it with wsp up. usage: wsp exec <workspace> [--cwd <dir>] -- <command...>"]);
      expect(skewed.io.errors[0]).not.toContain("discriminator");
      expect(skewed.io.errors[0]).not.toContain("workspaces.createLocal");
    } finally {
      for (const client of old.clients) client.terminate();
      await new Promise(r => old.close(r));
    }
  });

  it("a port that accepts but never answers fails the dial within its deadline, before and after the handshake", async () => {
    await h.handle!.close();
    h.handle = undefined;
    const accepted: Socket[] = [];
    const silent = createServer(socket => accepted.push(socket));
    await new Promise<void>(r => silent.listen(0, "127.0.0.1", r));
    const mute = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>(r => mute.once("listening", r));
    writeFileSync(hostTokenPath(h.statePath), "tok\n");
    try {
      for (const server of [silent, mute]) {
        const port = (server.address() as AddressInfo).port;
        writeFileSync(lockPathFor(h.statePath), JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
        await expect(dialHost(h.statePath, { deadlineMs: 200 })).rejects.toThrow(`the host at 127.0.0.1:${port} did not answer: nothing came back within 200 ms`);
      }
    } finally {
      for (const client of mute.clients) client.terminate();
      for (const socket of accepted) socket.destroy();
      await new Promise(r => mute.close(r));
      await new Promise(r => silent.close(r));
    }
  });

  it.runIf(CLOUD_ON)("snapshot takes a project golden of the workspace it names and says how to fork it; a workspace that was resumed is refused in one line", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    const { code, io } = await h.run("snapshot", "alpha");
    expect(code, io.errors.join("\n")).toBe(0);
    const [golden] = await h.rt.golden.projects();
    expect(golden).toMatchObject({ projects: [{ name: alpha!.project.name, dest: alpha!.project.path }], golden: "snap_gold", version: 1, workspaceId: alpha!.id, workspaceName: "alpha" });
    expect(io.lines).toEqual([
      `project image ${golden!.snapshotId}: image v1 plus ${alpha!.project.name} imported ${golden!.projects[0]!.importedAt.slice(0, 10)}, taken from alpha`,
    ]);
    expect(io.errors).toEqual([]);

    const asJson = await h.run("snapshot", alpha!.id, "--json");
    expect(asJson.code).toBe(0);
    expect(h.json(asJson.io)).toEqual([{ projectGolden: expect.objectContaining({ projects: golden!.projects, golden: "snap_gold" }) }]);

    await h.rt.workspaces.nap(alpha!.id);
    await h.rt.workspaces.wake(alpha!.id);
    const resumed = await h.run("snapshot", "alpha");
    expect(resumed.code).toBe(1);
    expect(resumed.io.errors).toHaveLength(1);
    expect(resumed.io.errors[0]).toMatch(/^wsp snapshot: snapshot \S+ refused: machine m\d+ is not first-life/);
    expect(await h.rt.golden.projects()).toHaveLength(2);
  });

  it.runIf(CLOUD_ON)("wsp image lists every project image by its id, project, size and date; image remove asks once, deletes the snapshot at the provider and drops the record, and is refused while a workspace stands on it", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    const taken = await h.rt.workspaces.snapshot(alpha!.id);
    const listed = await h.run("image");
    expect(listed.io.lines.join("\n").split("\n")).toContain(`${taken.snapshotId}  project alpha  ${alpha!.project.name}  7.5 GB  ${taken.createdAt}`);

    expect((await h.run("new", h.cloud.name, "task-a", "--from", taken.snapshotId)).code).toBe(0);
    const standing = await h.run("image", "remove", taken.snapshotId, "--yes");
    expect(standing.code).toBe(1);
    expect(standing.io.errors).toEqual([`wsp image remove: ${projectImageInUseRefusal(taken.snapshotId, ["task-a"])}`]);
    expect(h.backend.snapshots.map(s => s.id)).toContain(taken.snapshotId);
    expect((await h.run("delete", "task-a", "--yes")).code).toBe(0);

    const kept = await h.answer("no", "image", "remove", taken.snapshotId);
    const asJson = await h.run("image", "remove", taken.snapshotId, "--json");
    expect(asJson.code).toBe(EXIT_CODES.usage);
    expect(kept.code).toBe(1);
    expect(kept.io.errors).toEqual([`${taken.snapshotId} kept`]);
    expect(h.asked.at(-1)).toBe(`Remove project image ${taken.snapshotId}?\n${projectImageRemoveNotice(taken)}`);
    expect(h.backend.snapshots.map(s => s.id)).toContain(taken.snapshotId);

    const removed = await h.answer("yes", "image", "remove", taken.snapshotId);
    expect(removed.code).toBe(0);
    expect(removed.io.lines).toEqual([projectImageRemovedLine(taken.snapshotId, false)]);
    expect(h.backend.snapshots.map(s => s.id)).not.toContain(taken.snapshotId);
    expect(await h.rt.golden.projects()).toEqual([]);

    const missing = await h.run("image", "remove", taken.snapshotId, "--yes");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual([`wsp image remove: ${noProjectImageLine(taken.snapshotId)}`]);
    // A project's name is no id: a remove never picks one of several images by the newest.
    const named = await h.run("image", "remove", h.cloud.name, "--yes");
    expect(named.code).toBe(EXIT_CODES.usage);
    expect(named.io.errors).toEqual([`wsp image remove: ${noProjectImageLine(h.cloud.name)}`]);
    expect((await h.run("image", "remove")).code).toBe(EXIT_CODES.usage);
  });

  /** A folder on this computer with one source file and one secret-shaped file, not a repository. */
  function projectFolder(): string {
    const proj = join(h.dir, "proj");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "index.ts"), "export const a = 1;\n");
    writeFileSync(join(proj, ".env"), "API_TOKEN=sk-ant-x\n");
    return proj;
  }
  const landings = (): string[] => h.backend.machines[0]!.runLog.filter(s => s.includes("mv "));

  it("folders lists one level of this computer's folders with the repository marked and the hidden ones counted, and refuses a path outside the roots", async () => {
    const home = join(h.dir, "user");
    mkdirSync(join(home, "code", "spoo", ".git"), { recursive: true });
    mkdirSync(join(home, "code", "notes"), { recursive: true });
    mkdirSync(join(home, "code", ".cache"), { recursive: true });
    const { code, io } = await h.run("folders", join(home, "code"));
    expect(code).toBe(0);
    const lines = io.lines[0]!.split("\n");
    const cells = (line: string): string[] => line.split(/ {2,}/);
    expect(cells(lines[0]!)).toEqual(["FOLDER", "GIT"]);
    expect(lines.slice(1, 3).map(cells)).toEqual([[join(home, "code", "notes")], [join(home, "code", "spoo"), "git"]]);
    expect(lines.at(-1)).toBe(`2 folders in ${join(home, "code")}, 1 hidden. Browsable: ${home}.`);
    // The dot-named folder is a row only when it is asked for, and --json is the listing the app's picker reads.
    const shown = await h.run("folders", join(home, "code"), "--hidden", "--json");
    expect(h.json(shown.io)).toEqual([{ dir: join(home, "code"), roots: [home], folders: [{ path: join(home, "code", ".cache"), repo: false }, { path: join(home, "code", "notes"), repo: false }, { path: join(home, "code", "spoo"), repo: true }], hidden: 1 }]);
    const outside = await h.run("folders", "/etc");
    expect(outside.code).toBe(1);
    expect(outside.io.errors.join("\n")).toBe(`wsp folders: /etc is outside the folders wsp browses on this computer: ${home}`);
    const many = await h.run("folders", join(home, "code"), join(home, "Applications"));
    // A line refused before anything was dialled is a usage refusal, which is the code an agent branches on.
    expect(many.code).toBe(3);
    expect(many.io.errors.join("\n")).toContain("takes one folder on this computer at most");
  });

  it("folders --on reads the computer it names, this computer by its own name, and refuses a name nobody holds with the computers there are", async () => {
    const home = join(h.dir, "user");
    mkdirSync(join(home, "code"), { recursive: true });
    const client = await dialHost(h.statePath);
    let places: PlaceView[];
    try {
      places = (await client.request<{ places: PlaceView[] }>("places.list")).places;
    } finally {
      client.close();
    }
    const here = places.find(p => p.id === HERE_PLACE_ID)!;
    const mine = await h.run("folders", "--on", here.name, "--json");
    expect(mine.code).toBe(0);
    expect(h.json(mine.io)[0]).toMatchObject({ dir: home, roots: [home] });
    const nobody = await h.run("folders", "--on", "nowhere");
    expect(nobody.code).toBe(EXIT_CODES.usage);
    expect(nobody.io.errors.join("\n")).toContain(noSuchPlaceRefusal("nowhere", places.map(p => p.name)));
  });

  it("terminal config reads this computer's Ghostty config with its theme, prints it as Ghostty lines or one object, resolves the scheme asked for, and refuses a word outside light and dark", async () => {
    const home = join(h.dir, "user");
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
    mkdirSync(join(home, ".config", "ghostty", "themes"), { recursive: true });
    writeFileSync(join(home, ".config", "ghostty", "config"), "theme = light:Day,dark:Night\nfont-family = Berkeley Mono\nfont-size = 13\nbackground-opacity = 0.9\n");
    writeFileSync(join(home, ".config", "ghostty", "themes", "Night"), "background = #1e1e2e\nforeground = #cdd6f4\npalette = 1=#f38ba8\n");
    writeFileSync(join(home, ".config", "ghostty", "themes", "Day"), "background = #fafafa\n");
    const { code, io } = await h.run("terminal", "config");
    expect(code).toBe(0);
    expect(io.lines[0]!.split("\n")).toEqual([
      `Read ${join(home, ".config", "ghostty", "config")}, ${join(home, ".config", "ghostty", "themes", "Night")}`,
      "font-family = Berkeley Mono",
      "font-size = 13",
      "theme = Night",
      "background = #1e1e2e",
      "foreground = #cdd6f4",
      "palette = 1 of 16 colors",
      "background-opacity = 0.9",
    ]);
    const light = await h.run("terminal", "config", "--scheme", "light", "--json");
    expect(light.code).toBe(0);
    expect(h.json(light.io)).toEqual([
      expect.objectContaining({ files: [join(home, ".config", "ghostty", "config"), join(home, ".config", "ghostty", "themes", "Day")], theme: "Day", background: { r: 250, g: 250, b: 250 }, fontFamily: ["Berkeley Mono"], fontSize: 13, backgroundOpacity: 0.9 }),
    ]);
    // The same answer the app gets over the host's socket, so the line and the pane never disagree.
    const client = await dialHost(h.statePath);
    try {
      expect(await client.request("host.terminalConfig", { scheme: "light" })).toMatchObject({ config: h.json(light.io)[0] });
    } finally {
      client.close();
    }
    const sepia = await h.run("terminal", "config", "--scheme", "sepia");
    expect(sepia.code).toBe(3);
    expect(sepia.io.errors).toEqual(['wsp terminal config: --scheme takes one of light, dark, and got "sepia". Name one of those.']);
    const extra = await h.run("terminal", "config", "now");
    expect(extra.code).toBe(3);
    // No config at all is not a failure: the empty object says the pane keeps its defaults.
    rmSync(join(home, ".config", "ghostty"), { recursive: true });
    const none = await h.run("terminal", "config", "--json");
    expect(none.code).toBe(0);
    expect(h.json(none.io)).toEqual([{ files: [], fontFamily: [], palette: Array<null>(16).fill(null) }]);
  });

  it("a folder inside the roots this Mac will not let the host read comes back as one stderr line at the provider's code, not a usage refusal", async () => {
    const home = join(h.dir, "user");
    const shut = join(home, "Documents");
    mkdirSync(shut, { recursive: true });
    const words = `EACCES: permission denied, scandir '${shut}'`;
    const refused = await withRefused(shut, () => h.run("folders", shut));
    expect(refused.code).toBe(1);
    expect(refused.io.errors).toEqual([`wsp folders: ${words}`]);
    // The machine said no, so the class is the provider's on the JSON door too, where stdout stays empty.
    const asJson = await withRefused(shut, () => h.run("folders", shut, "--json"));
    expect(asJson.io.lines).toEqual([]);
    expect(asJson.io.errors).toHaveLength(1);
    expect(JSON.parse(asJson.io.errors[0]!)).toEqual({ error: words, class: "provider", exit: 1 });
  });







  it("export brings the folder home to the path given, streams the stages, prints the done line, and keys the sessions to the folder in the homes here", async () => {
    const guest = exportGuest(h.backend);
    await h.run("new", "alpha");
    const dest = join(h.dir, "out", "proj");
    const { code, io } = await h.run("export", "alpha", dest, "--from", EXPORT_SOURCE);
    expect(io.errors).toEqual([]);
    expect(code).toBe(0);
    expect(readFileSync(join(dest, "src", "index.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(readFileSync(join(dest, ".env"), "utf8")).toBe("TOKEN=x\n");
    const real = realpathSync(dest);
    const key = real.replace(/[^A-Za-z0-9]/g, "-");
    expect(readFileSync(join(h.dir, "user", ".claude", "projects", key, "S1.jsonl"), "utf8")).toBe(EXPORT_SESSION(real));
    expect(io.lines).toEqual([`2 files, 28 B, landed at ${dest}; 1 cache left behind; sessions: Claude Code (1 session) moved.`]);
    expect(io.streamed.split("\n").filter(l => l !== "")).toEqual(expect.arrayContaining([`Packing ${EXPORT_SOURCE} on the machine.`, "Packing the agents' state for it on the machine.", `Landing at ${dest}.`]));
    expect(io.streamed).not.toContain("landed at");
    expect(guest.sources).toEqual([EXPORT_SOURCE]);
  });

  it("export refuses an existing folder in two lines, the second naming --replace, and replaces it when asked; --from defaults to the folder's own path; --agents narrows; --json prints the result", async () => {
    const guest = exportGuest(h.backend);
    await h.run("new", "alpha");
    const dest = join(h.dir, "out", "proj");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "old.txt"), "old");
    const refused = await h.run("export", "alpha", dest);
    expect(refused.code).toBe(1);
    expect(refused.io.lines).toEqual([]);
    expect(refused.io.errors).toEqual([`wsp export: ${dest} already exists on this computer with 1 file; export with replace to overwrite it\nRun again with --replace to overwrite it.`]);
    expect(guest.sources).toEqual([]);
    const replaced = await h.run("export", "alpha", dest, "--replace", "--agents", "codex,pi", "--json");
    expect(replaced.code).toBe(0);
    expect(replaced.io.errors).toEqual([]);
    expect(h.json(replaced.io)).toEqual([{ dest, files: 2, bytes: 28, excluded: ["node_modules"], agents: [] }]);
    expect(replaced.io.streamed).toBe("");
    expect(existsSync(join(dest, "old.txt"))).toBe(false);
    expect(guest.sources).toEqual([dest]);
    expect(existsSync(join(h.dir, "user", ".claude"))).toBe(false);
  });

  it("export refuses an --agents id the catalog does not know before anything reaches the machine, naming it and the ids it knows", async () => {
    const guest = exportGuest(h.backend);
    await h.run("new", "alpha");
    const typo = await h.run("export", "alpha", join(h.dir, "out", "proj"), "--agents", "claude,codx");
    expect(typo.code).toBe(3);
    expect(typo.io.lines).toEqual([]);
    expect(typo.io.errors).toEqual([`wsp export: ${unknownAgentLine("codx", CATALOG_AGENTS.map(a => a.id))}. Name one of those, or drop the flag.`]);
    expect(guest.sources).toEqual([]);
    expect(existsSync(join(h.dir, "out"))).toBe(false);
  });

  it.runIf(CLOUD_ON)("every verb takes --json and --help; a bad flag prints the usage", async () => {
    for (const verb of [["fork"], ["snapshot"], ["pause"], ["wake"], ["forget"], ["delete"], ["threads"], ["threads", "wait"], ["run"], ["send"], ["stop"], ["exec"], ["projects"], ["export"]]) {
      const help = await h.run(...verb, "--help");
      expect(help.code).toBe(0);
      expect(help.io.lines[0]).toMatch(new RegExp(`^usage: wsp ${verb.join(" ")}`));
      expect(help.io.lines[0]).toContain("--json");
    }
    const bad = await h.run("threads", "--nope");
    expect(bad.code).toBe(3);
    expect(bad.io.errors[0]).toContain("Unknown option '--nope'");
    expect(bad.io.errors[0]).toContain("usage: wsp threads");
    // A flag another verb reads is refused naming that verb, so the caller is told where it lives: run's --agent on send, threads' --tree on stop.
    const foreign = await h.run("send", "row_1", "--agent", "claude", "hello");
    expect(foreign.code).toBe(3);
    expect(foreign.io.errors).toEqual(['--agent belongs to wsp skills add, wsp servers signin, wsp servers tools, wsp servers add, wsp servers remove, wsp servers disable, wsp servers enable, wsp projects set, wsp fork, wsp start, wsp review and wsp run; wsp send does not read it. usage: wsp send <thread> [--model, --effort <value>] [--fast] [--file <path>] [--detach] "<message>"']);
    const within = await h.run("stop", "row_1", "--tree");
    expect(within.io.errors[0]).toContain("--tree belongs to wsp threads; wsp stop does not read it");
    // A flag wsp used to read is nobody's now: the parser's own line, with the verb's usage under it.
    const old = await h.run("threads", "--in", "alpha");
    expect(old.code).toBe(3);
    expect(old.io.errors[0]).toContain("Unknown option '--in'");
    expect(old.io.errors[0]).toContain("usage: wsp threads");
    // A flag spelled like a prototype member is nobody's: the tables are read as own keys, so it gets the parser's line.
    const proto = await h.run("threads", "--constructor");
    expect(proto.code).toBe(3);
    expect(proto.io.errors[0]).toContain("Unknown option '--constructor'");
    expect(proto.io.errors[0]).not.toContain("belongs to");
    const half = await h.run("thread");
    expect(half.code).toBe(3);
    expect(half.io.errors).toEqual([
      'wsp thread opens a line rather than being one. usage: wsp thread read <thread> [--last]\nusage: wsp thread head <thread>\nusage: wsp thread rename <thread> "<title>"\nusage: wsp thread forget <thread>\nusage: wsp thread allow <thread>\nusage: wsp thread deny <thread> [--reason "<words>"]',
    ]);
  });

  it("without a host serving the state file, and with nothing to start one, every verb refuses in one line before dialling anything", async () => {
    await h.handle!.close();
    h.handle = undefined;
    const io = captured();
    expect(await cli(["threads", "--state", h.statePath], io, undefined, h.env, false)).toBe(1);
    expect(io.errors).toEqual([`wsp threads: ${noHostServingLine(h.statePath)}`]);
  });

  it("a wrong token is refused by the host, under the auth class", async () => {
    writeFileSync(join(h.dir, "state", "host-token"), "not-the-token\n");
    const { code, io } = await h.run("threads");
    expect(code).toBe(2);
    expect(io.errors).toEqual(["wsp threads: unauthorized"]);
  });

  describe("what a person sets on one of their computers", () => {
    it("sets threads at once on a computer by its name or id, answers the row with its default beside it, and a reset takes it back", async () => {
      const here = (await h.rt.places!.rows()).find(p => p.id === HERE_PLACE_ID)!;
      const fallback = (here.capDefault as { threads: number }).threads;
      const set = await h.run("computers", "set", HERE_PLACE_ID, "--threads", "2");
      expect(set.code, set.io.errors.join("\n")).toBe(0);
      expect(set.io.lines).toEqual([`${here.name}: 2 threads at once (${fallback} by default), no turn limit (the default), agents may spawn: up to 3 workspaces (the default), 2 levels deep (the default)`]);
      expect((await h.rt.places!.rows()).find(p => p.id === HERE_PLACE_ID)).toMatchObject({ cap: { threads: 2 }, settings: { threads: 2 } });
      const asJson = await h.run("computers", "set", here.name, "--threads", "1", "--json");
      expect(h.json(asJson.io).at(-1)).toMatchObject({ computer: { id: HERE_PLACE_ID, cap: { threads: 1 }, capDefault: { threads: fallback } } });
      const back = await h.run("computers", "set", HERE_PLACE_ID, "--reset", "threads");
      expect(back.io.lines).toEqual([`${here.name}: ${fallback} ${fallback === 1 ? "thread" : "threads"} at once (the default), no turn limit (the default), agents may spawn: up to 3 workspaces (the default), 2 levels deep (the default)`]);
      expect((await h.rt.places!.rows()).find(p => p.id === HERE_PLACE_ID)!.settings).toBeUndefined();
    });

    it("sets the nap after on a computer that forks in minutes or off, and refuses it on this one and past three hours", async () => {
      // The host again with its provider wired as a place, which is a row whose workspaces nap.
      await h.handle?.close();
      h.rt = createRuntime({ statePath: h.statePath, backend: h.backend, store: h.store, adapters: { claude: h.claude.adapter }, local: localWiring(join(h.dir, "user"), process.env, fakeDaemonStart, h.statePath, h.copier), placeLinks: { ...placeWiring(h.statePath), provider: () => ({ id: "default", rateUsdPerHour: 0.1 }) }, daemonChannel: h.daemon.open });
      h.handle = await serve(captured(), { port: 0, statePath: h.statePath, webDir: join(h.dir, "web"), runtime: h.rt });
      const forks = (await h.rt.places!.rows()).find(p => p.takesForks === true)!;
      const set = await h.run("computers", "set", forks.id, "--nap", "5");
      expect(set.code, set.io.errors.join("\n")).toBe(0);
      expect(set.io.lines[0]).toContain("naps after 5m (20m by default)");
      const off = await h.run("computers", "set", forks.id, "--nap", "off", "--json");
      expect(h.json(off.io).at(-1)).toMatchObject({ computer: { napMs: null, settings: { napMs: null } } });
      const here = await h.run("computers", "set", HERE_PLACE_ID, "--nap", "5");
      expect(here.code).toBe(EXIT_CODES.usage);
      expect(here.io.errors[0]).toContain("not nap after");
      const long = await h.run("computers", "set", forks.id, "--nap", "181");
      expect(long.code).toBe(EXIT_CODES.usage);
      expect(long.io.errors[0]).toBe(`wsp computers set: --nap for ${forks.id} takes whole minutes from 1 to 180, or off, and got "181". Write it as --nap 20 or --nap off.`);
    });

    it("sets the turn limit in whole hours or off, on this computer and on a cloud, and a reset takes it back", async () => {
      await h.handle?.close();
      h.rt = createRuntime({ statePath: h.statePath, backend: h.backend, store: h.store, adapters: { claude: h.claude.adapter }, local: localWiring(join(h.dir, "user"), process.env, fakeDaemonStart, h.statePath, h.copier), placeLinks: { ...placeWiring(h.statePath), provider: () => ({ id: "default", rateUsdPerHour: 0.1 }) }, daemonChannel: h.daemon.open });
      h.handle = await serve(captured(), { port: 0, statePath: h.statePath, webDir: join(h.dir, "web"), runtime: h.rt });
      const set = await h.run("computers", "set", HERE_PLACE_ID, "--turn-limit", "8");
      expect(set.code, set.io.errors.join("\n")).toBe(0);
      expect(set.io.lines[0]).toContain("stops a turn at 8h (off by default)");
      const cloud = (await h.rt.places!.rows()).find(p => p.kind === "provider")!;
      expect(cloud).toMatchObject({ turnLimitMs: 6 * 3_600_000, turnLimitDefault: 6 * 3_600_000 });
      const off = await h.run("computers", "set", cloud.id, "--turn-limit", "off", "--json");
      expect(h.json(off.io).at(-1)).toMatchObject({ computer: { turnLimitMs: null, turnLimitDefault: 6 * 3_600_000, settings: { turnLimitMs: null } } });
      const back = await h.run("computers", "set", cloud.id, "--reset", "turn-limit");
      expect(back.io.lines[0]).toContain("stops a turn at 6h (the default)");
      for (const word of ["0", "25", "1.5", "six"]) {
        const wrong = await h.run("computers", "set", HERE_PLACE_ID, "--turn-limit", word);
        expect(wrong.code).toBe(EXIT_CODES.usage);
        expect(wrong.io.errors[0]).toBe(`wsp computers set: --turn-limit for ${HERE_PLACE_ID} takes whole hours from 1 to 24, or off, and got ${JSON.stringify(word)}. Write it as --turn-limit 6 or --turn-limit off.`);
      }
      expect((await h.rt.places!.rows()).find(p => p.id === HERE_PLACE_ID)).toMatchObject({ turnLimitMs: 8 * 3_600_000 });
    });

    it("sets whether agents there may start agents for every workspace that says nothing of its own, and a workspace reads it", async () => {
      await h.run("new", "alpha");
      const off = await h.run("computers", "set", HERE_PLACE_ID, "--spawn", "off");
      expect(off.code, off.io.errors.join("\n")).toBe(0);
      expect(off.io.lines[0]).toContain("agents may not spawn (on, up to 3 by default)");
      const capped = await h.run("computers", "set", HERE_PLACE_ID, "--spawn", "on", "--max-machines", "1", "--json");
      expect(h.json(capped.io).at(-1)).toMatchObject({ computer: { spawn: { spawn: true, maxMachines: 1, maxDepth: 2 } } });
      const mac = await h.macProject("mine");
      expect(mac.code, mac.io.errors.join("\n")).toBe(0);
      expect((await h.rt.workspaces.list()).find(w => w.name === "mine")!.agents).toEqual({ spawn: true, maxMachines: 1, maxDepth: 2 });
      const wrong = await h.run("computers", "set", HERE_PLACE_ID, "--spawn", "yes");
      expect(wrong.code).toBe(EXIT_CODES.usage);
      expect(wrong.io.errors[0]).toContain("--spawn for here takes on or off");
      expect((await h.run("computers", "set", HERE_PLACE_ID, "--reset", "spawn")).code).toBe(0);
      expect((await h.rt.workspaces.list()).find(w => w.name === "mine")!.agents).toEqual(AGENTS_ON);
    });

    it("refuses a count that is not a whole number of one or more, a word reset does not take, and a line that sets nothing, as usage", async () => {
      const zero = await h.run("computers", "set", HERE_PLACE_ID, "--threads", "0");
      expect(zero.code).toBe(EXIT_CODES.usage);
      expect(zero.io.errors[0]).toBe('wsp computers set: --threads for here takes a whole number of one or more, and got "0". Write it as --threads <n>.');
      // Every refusal of a flag's shape names the computer, as the host's own refusals on this verb do.
      const depth = await h.run("computers", "set", HERE_PLACE_ID, "--max-depth", "0");
      expect(depth.io.errors[0]).toContain('--max-depth for here takes a whole number of one or more, and got "0"');
      const wrong = await h.run("computers", "set", HERE_PLACE_ID, "--reset", "everything");
      expect(wrong.code).toBe(EXIT_CODES.usage);
      expect(wrong.io.errors[0]).toContain("--reset for here takes one of threads");
      const nothing = await h.run("computers", "set", HERE_PLACE_ID);
      expect(nothing.code).toBe(EXIT_CODES.usage);
      expect(nothing.io.errors[0]).toContain("nothing to set on");
      const none = await h.run("computers", "set");
      expect(none.code).toBe(EXIT_CODES.usage);
    });
  });

  describe("what the agents on a workspace may do", () => {
    it("the switch is on under the default caps until a person turns it off, and the record carries it", async () => {
      await h.run("new", "alpha");
      expect((await h.rt.workspaces.list())[0]!.agents).toEqual(AGENTS_ON);
      const on = await h.run("workspaces", "agents", "alpha", "--spawn", "on", "--max-machines", "2");
      expect(on.code).toBe(0);
      expect(on.io.lines).toEqual(["alpha: agents may spawn: up to 2 workspaces"]);
      expect((await h.rt.workspaces.list())[0]!.agents).toEqual({ spawn: true, maxMachines: 2, maxDepth: 2 });
      const back = await h.run("workspaces", "agents", "alpha", "--spawn", "off");
      expect(back.io.lines).toEqual(["alpha: agents may not spawn"]);
      // Off keeps the numbers it was given rather than throwing them away, so turning it on again is one word.
      expect((await h.rt.workspaces.list())[0]!.agents).toEqual({ spawn: false, maxMachines: 2, maxDepth: 2 });
    });

    it("a cap alone tightens the switch it finds and leaves it on or off, and a word that is neither on nor off, or no word at all, is refused", async () => {
      await h.run("new", "alpha");
      const tightened = await h.run("workspaces", "agents", "alpha", "--max-machines", "2");
      expect(tightened.code, tightened.io.errors.join("\n")).toBe(0);
      expect((await h.rt.workspaces.list())[0]!.agents).toEqual({ ...AGENTS_ON, maxMachines: 2 });
      expect((await h.run("workspaces", "agents", "alpha", "--spawn", "off")).code).toBe(0);
      expect((await h.run("workspaces", "agents", "alpha", "--max-depth", "2")).code).toBe(0);
      expect((await h.rt.workspaces.list())[0]!.agents).toEqual({ spawn: false, maxMachines: 2, maxDepth: 2 });
      expect((await h.run("workspaces", "agents", "alpha", "--spawn", "on")).code).toBe(0);
      const wrong = await h.run("workspaces", "agents", "alpha", "--spawn", "yes");
      expect(wrong.code).toBe(EXIT_CODES.usage);
      expect(wrong.io.errors[0]).toContain("--spawn takes on or off");
      const none = await h.run("workspaces", "agents", "alpha");
      expect(none.code).toBe(EXIT_CODES.usage);
      expect(none.io.errors[0]).toContain("--max-machines");
      expect((await h.rt.workspaces.list())[0]!.agents).toEqual({ spawn: true, maxMachines: 2, maxDepth: 2 });
      // A new workspace takes a cap alone the same way, on the default switch.
      expect((await h.run("new", "beta", "--max-machines", "1")).code).toBe(0);
      expect((await h.rt.workspaces.list()).find(w => w.name === "beta")!.agents).toEqual({ ...AGENTS_ON, maxMachines: 1 });
    });

    it("--max-depth 0 is a usage sentence, not a shape the wire refuses", async () => {
      await h.run("new", "alpha");
      const zero = await h.run("workspaces", "agents", "alpha", "--spawn", "on", "--max-depth", "0");
      expect(zero.code).toBe(EXIT_CODES.usage);
      expect(zero.io.errors[0]).toBe('wsp workspaces agents: --max-depth takes a whole number of one or more, and got "0". Write it as --max-depth <n>.');
      // Zero machines is a switch that is on and forks nothing, which is a thing a person may mean.
      const none = await h.run("workspaces", "agents", "alpha", "--spawn", "on", "--max-machines", "0");
      expect(none.code).toBe(0);
      expect((await h.rt.workspaces.list())[0]!.agents).toEqual({ spawn: true, maxMachines: 0, maxDepth: 2 });
    });

    it("a project folder on this computer takes the switch, by the project's name, since its agents reach the host as themselves", async () => {
      const folder = realpathSync(mkdtempSync(join(h.dir, "repo-mine-")));
      execFileSync("git", ["init", "-q", folder]);
      await projectOn(h.rt, HERE_PLACE_ID, folder, { name: "mine" });
      const made = await h.run("new", "mine", "mine", "--spawn", "on");
      expect(made.io.errors).toEqual([]);
      expect(made.code).toBe(0);
      expect((await h.rt.workspaces.list())[0]!.agents).toEqual({ spawn: true, maxMachines: 3, maxDepth: 2 });
      const set = await h.run("workspaces", "agents", "mine", "--spawn", "off");
      expect(set.code, set.io.errors.join("\n")).toBe(0);
      expect((await h.rt.workspaces.list()).find(w => w.name === "mine")!.agents?.spawn).toBe(false);
    });

    it("a create with --spawn on turns the switch on", async () => {
      const made = await h.run("new", "alpha", "--spawn", "on", "--max-machines", "1");
      expect(made.code).toBe(0);
      expect((await h.rt.workspaces.list())[0]!.agents).toEqual({ spawn: true, maxMachines: 1, maxDepth: 2 });
    });

    it("--tree draws a thread an agent spawned under the thread that spawned it, and stop ends the tree as one", async () => {
      const held = heldAgent(false);
      await h.restartHost({ claude: held.adapter });
      await h.run("new", "alpha", "--spawn", "on");
      const alpha = (await h.rt.workspaces.list())[0]!;
      const lead = await h.rt.sessions.start(alpha.id, { prompt: "lead" });
      const leadThread = lead.view().threadId!;
      const child = await h.rt.sessions.start(alpha.id, { prompt: "builder" }, { origin: "relayed", by: { kind: "thread", threadId: leadThread, workspaceId: alpha.id, rootThreadId: leadThread } });
      const childThread = child.view().threadId!;
      // The thread's own cell is the third: a tree indents that cell and leaves the project and the workspace alone.
      const rows = (io: Captured): string[] => io.lines[0]!.split("\n").slice(1);
      expect(rows((await h.run("threads")).io).some(r => r.split(/ {2,}/)[2]!.startsWith(" "))).toBe(false);
      const drawn = rows((await h.run("threads", "--tree")).io);
      const at = drawn.findIndex(r => r.includes(leadThread));
      expect(drawn[at + 1]).toContain(`  ${childThread}`);
      // Two rows naming each other are under no top row; the listing prints every row it was given all the same.
      expect(threadTree([
        { id: "a", parentThreadId: "b" },
        { id: "b", parentThreadId: "a" },
      ] as unknown as Parameters<typeof threadTree>[0]).map(t => t.row.id).sort()).toEqual(["a", "b"]);
      const stopped = await h.run("stop", leadThread);
      expect(stopped.io.lines[0]).toBe(`thread ${leadThread} stopped, and with it 1 thread its agents spawned: ${childThread.slice(0, 8)}`);
      expect((await h.rt.sessions.list(alpha.id)).every(v => v.status !== "running")).toBe(true);
    });
  });

  describe("a file on a message from the command line", () => {
    /** A real PNG head, so the type is read off the bytes as the verbs read it; the rest is filler of a known weight. */
    const pngFile = (dirPath: string, name: string, bytes: number): string => {
      const path = join(dirPath, name);
      writeFileSync(path, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(bytes - 8, 7)]));
      return path;
    };

    it("wsp send --file reads the file here and sends its bytes, so the machine never reaches back for this computer's files", async () => {
      await h.run("new", "alpha");
      await h.run("run", "alpha", "hello");
      const [row] = await h.rt.sessions.list();
      const path = pngFile(h.dir, "shot.png", 2048);
      const sent = await h.run("send", row!.threadId!, "--file", path, "what does this show?");
      expect(sent.code).toBe(0);
      const start = h.claude.starts.at(-1)!;
      expect(start.images).toEqual([{ mediaType: "image/png", bytes: readFileSync(path).toString("base64") }]);
      // The path itself never travels: the agent is handed the bytes, not somewhere on this computer to look.
      expect(JSON.stringify(start)).not.toContain(path);
    });

    it("the flag repeats, and the images reach the agent in the order they were named", async () => {
      await h.run("new", "alpha");
      await h.run("run", "alpha", "hello");
      const [row] = await h.rt.sessions.list();
      const one = pngFile(h.dir, "one.png", 512);
      const two = pngFile(h.dir, "two.png", 1024);
      const sent = await h.run("send", row!.threadId!, "--file", one, "--file", two, "these two");
      expect(sent.code).toBe(0);
      expect(h.claude.starts.at(-1)!.images?.map(i => i.bytes)).toEqual([readFileSync(one).toString("base64"), readFileSync(two).toString("base64")]);
    });

    it("run --file opens the thread with the image on its first turn", async () => {
      await h.run("new", "alpha");
      const path = pngFile(h.dir, "opening.png", 256);
      const opened = await h.run("run", "alpha", "--file", path, "what is this?");
      expect(opened.code).toBe(0);
      expect(h.claude.starts.at(-1)!.images).toEqual([{ mediaType: "image/png", bytes: readFileSync(path).toString("base64") }]);
    });

    it("the person's turn prints one bracket per image on stderr, since a terminal draws no pixels", async () => {
      await h.run("new", "alpha");
      const path = pngFile(h.dir, "big.png", 1_258_291);
      const opened = await h.run("run", "alpha", "--file", path, "what is this?");
      expect(opened.io.streamed).toContain("[image 1 MB png]");
    });

    it("a path this computer has no file at answers in a sentence, not in the reader's own error", async () => {
      await h.run("new", "alpha");
      const missing = join(h.dir, "not-here.png");
      const refused = await h.run("send", "--file", missing, "x", "y");
      expect(refused.io.errors[0]).not.toContain("ENOENT");
      const opening = await h.run("run", "alpha", "--file", missing, "look");
      expect(opening.code).toBe(EXIT_CODES.usage);
      expect(opening.io.errors).toEqual([`wsp run: there is no file at ${missing} on this computer. Name a file that is already here.`]);
      expect(h.claude.starts).toHaveLength(0);
    });

    it("a folder named where an image should be is refused the same way, rather than failing on the read", async () => {
      await h.run("new", "alpha");
      const refused = await h.run("run", "alpha", "--file", h.dir, "look");
      expect(refused.code).toBe(EXIT_CODES.usage);
      expect(refused.io.errors).toEqual([`wsp run: there is no file at ${h.dir} on this computer. Name a file that is already here.`]);
    });

    it("a file that is not an image travels under its own name, and the agent is told where it landed", async () => {
      await h.run("new", "alpha");
      const path = join(h.dir, "notes.pdf");
      writeFileSync(path, "%PDF-1.7 not an image at all");
      const opened = await h.run("run", "alpha", "--file", path, "look");
      expect(opened.code).toBe(0);
      const start = h.claude.starts.at(-1)!;
      expect(start.images).toBeUndefined();
      expect(start.prompt).toMatch(/^look\n\nAttached files:\n- \S+\/\.wsp-files\/[^/]+\/[^/]+\/notes\.pdf$/);
      expect(opened.io.streamed).toContain("[file 28 B notes.pdf]");
    });

    it("a 12 MB image is refused with the cap in the sentence, and the file is never read whole", async () => {
      await h.run("new", "alpha");
      const path = pngFile(h.dir, "huge.png", 12 * 1024 * 1024);
      const refused = await h.run("run", "alpha", "--file", path, "look");
      expect(refused.code).toBe(EXIT_CODES.usage);
      expect(refused.io.errors).toEqual(["wsp run: huge.png is 12 MB, over the 10 MB an image may be. Drop that one and send the rest."]);
      expect(h.claude.starts).toHaveLength(0);
    });

    it("six files are refused with both counts", async () => {
      await h.run("new", "alpha");
      const paths = Array.from({ length: 6 }, (_, i) => pngFile(h.dir, `n${i}.png`, 64));
      const refused = await h.run("run", "alpha", ...paths.flatMap(p => ["--file", p]), "look");
      expect(refused.code).toBe(EXIT_CODES.usage);
      expect(refused.io.errors).toEqual(["wsp run: only 5 files fit one message; this one carries 6. Drop that one and send the rest."]);
    });

    it("--fast runs the turn in the agent's fast mode on a model that offers one, and is refused by the model's name on one that does not", async () => {
      await h.run("new", "alpha");
      const opened = await h.run("run", "alpha", "--fast", "hello");
      expect(opened.code).toBe(0);
      expect(h.claude.starts.at(-1)!.fast).toBe(true);
      const refused = await h.run("run", "alpha", "--model", "claude-haiku-4-5-20251001", "--fast", "hello");
      expect(refused.code).toBe(EXIT_CODES.usage);
      expect(refused.io.errors[0]).toContain(noFastLine("Haiku 4.5"));
      const [row] = await h.rt.sessions.list();
      expect((await h.run("send", row!.threadId!, "--fast", "again")).code).toBe(0);
      expect(h.claude.starts.at(-1)!.fast).toBe(true);
    });

    it("--fast on a send that names no model is checked against the model the thread runs on", async () => {
      await h.run("new", "alpha");
      expect((await h.run("run", "alpha", "--model", "claude-haiku-4-5-20251001", "hello")).code).toBe(0);
      const haiku = (await h.rt.sessions.list()).at(-1)!;
      const starts = h.claude.starts.length;
      const refused = await h.run("send", haiku.threadId!, "--fast", "again");
      expect(refused.code).toBe(EXIT_CODES.usage);
      expect(refused.io.errors[0]).toContain(noFastLine("Haiku 4.5"));
      expect(h.claude.starts).toHaveLength(starts);
    });
  });
});

describe("messageTo", () => {
  const row: ThreadView = { id: "row_1", workspaceId: "ws_1", harness: "claude", startedBy: "person", status: "failed", title: "hello", sessionId: "row_1", turns: 1, ran: false };
  it("names the thread by its runtime id, and a row with none by its own id, which is the fold key the listing gave it", () => {
    expect(messageTo({ ...row, threadId: "thr_1", claudeSessionId: "sess_1" }, "again")).toEqual({ workspaceId: "ws_1", prompt: "again", harness: "claude", thread: "thr_1" });
    expect(messageTo({ ...row, threadId: "thr_1" }, "again")).toEqual({ workspaceId: "ws_1", prompt: "again", harness: "claude", thread: "thr_1" });
    expect(messageTo({ ...row, claudeSessionId: "sess_1" }, "again")).toEqual({ workspaceId: "ws_1", prompt: "again", harness: "claude", thread: "row_1" });
  });
});

describe("the verbs never talk to the provider", () => {
  it("import the protocol, the catalog, the collector for the recipe verbs and the host's lock file only: no runtime, engine, backend or key loading", () => {
    const source = readFileSync(new URL("../src/verbs.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/ from "([^"]+)";$/gm)].map(m => m[1]!);
    // The catalog is rows and ids alone (the agents a thread can take), so the agent argument's list reaches no
    // provider; the keys package is node crypto and nothing else, which is what a dial holds a host to its key with.
    expect(imports.filter(i => i.startsWith("@wsp/"))).toEqual(["@wsp/catalog", "@wsp/collect", "@wsp/keys", "@wsp/protocol"]);
    expect(imports).not.toContain("@wsp/runtime");
    expect(imports).not.toContain("@wsp/engine");
    expect(source).not.toMatch(/SOLARI|ANTHROPIC|loadKeys|SolariBackend|getsolari/);
  });
});

describe("what the projects remove tool says", () => {
  it("reads the same memory clause the sentence a remove answers with reads, rather than the opposite of it", () => {
    const remove = VERBS.filter(hasTool).find(v => v.name === "projects remove");
    const description = remove?.tool.description ?? "";
    expect(description).toContain(MEMORY_KEPT_CLAUSE);
    expect(description).not.toContain("the memory its threads kept");
    // The words the remove itself answers with carry that same clause, so the two cannot drift apart.
    expect(projectRemovedOnComputerLine("spoo-landing", "spoo", "/wsp/projects/pr_1", true)).toContain(MEMORY_KEPT_CLAUSE);
  });
});

describe("wsp ssh with no host serving its state", () => {
  it("refuses in one line and starts no host, so no second lock appears for a state no host serves", async () => {
    const home = mkdtempSync(join(tmpdir(), "wsp-ssh-no-host-"));
    try {
      const statePath = join(home, ".wsp", "state.json");
      const io = captured();
      io.bytes = { input: new PassThrough(), output: new PassThrough() };
      const started: string[] = [];
      const code = await cli(["ssh", "wsp-cart-rounding", "--state", statePath], io, undefined, { ...TEST_ENV, HOME: home }, async state => {
        started.push(state);
        throw new Error("this test starts no host");
      }, { cwd: home });
      expect(started).toEqual([]);
      expect(io.errors).toEqual([`wsp ssh: ${noHostServingLine(statePath)}`]);
      expect(code).toBe(EXIT_CODES.provider);
      // Under --json the same refusal is the one failure object, carrying its class.
      const json = captured();
      json.bytes = { input: new PassThrough(), output: new PassThrough() };
      expect(await cli(["ssh", "wsp-cart-rounding", "--state", statePath, "--json"], json, undefined, { ...TEST_ENV, HOME: home }, async state => {
        started.push(state);
        throw new Error("this test starts no host");
      }, { cwd: home })).toBe(EXIT_CODES.provider);
      expect(json.errors.map(line => JSON.parse(line) as unknown)).toEqual([{ error: noHostServingLine(statePath), class: "provider", exit: EXIT_CODES.provider }]);
      expect(started).toEqual([]);
      expect(existsSync(lockPathFor(statePath))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
