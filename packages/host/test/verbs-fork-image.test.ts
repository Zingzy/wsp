// SPDX-License-Identifier: AGPL-3.0-only
// The wsp verbs against a host over the fake runtime: each one a client of
// the protocol on localhost, authenticated with the token the host wrote,
// reading the same session index the sidebar reads.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo } from "node:net";
import { join } from "node:path";
import { NoProviderBackend, passphraseCipher } from "@wsp/engine";
import { childStartedLine, HERE_PLACE_ID, goneRoadRefusal, notAnsweringYet, EXIT_CODES, IMAGE_NO_VAULT, IMAGE_PASSPHRASE_ENV, IMAGE_PASSPHRASE_MIN, IMAGE_ALREADY_NEWEST, IMAGE_MOVE_CONFIRM, imageKeptLine, placeBuildsNoImageLine } from "@wsp/protocol";
import { copyKey, memoryStore } from "@wsp/runtime";
import { describe, expect, it, vi } from "vitest";
import { HELP, agentPage, cli, commandPage, COMMANDS_FOR_HELP } from "../src/cli.js";
import { CLI_VERBS, runVerb, dialHost } from "../src/verbs.js";
import { HOST_SIDE_VAULT, THREAD_PREFIX_WORD } from "../src/verbs.js";
import { hostSideOnlyFix, hostSideOnlyLine } from "../src/hosts.js";
import type { WatchSignals } from "../src/watch.js";
import { writeHost } from "../src/hosts.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { guestAnswer, stubBackend, withDaemonRoads } from "./stub-backend.js";
import { captured, type Captured } from "./verbs-fixture.js";
import { runsFromItsOwnFolder } from "./own-folder.js";
import { CLOUD_ON } from "../src/cloud.js";
import { HOST_KEY, verbsHost } from "./verbs-host.js";

runsFromItsOwnFolder();

// A path the process may not read is refused here and not by chmod: these tests run as root, which reads anything.
vi.mock("node:fs", async importOriginal => (await import("../../runtime/test/fs-refusal.js")).refusingFs(await importOriginal<typeof import("node:fs")>()));

describe("wsp verbs over the host: fork, new and the image", () => {
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
});
