// SPDX-License-Identifier: AGPL-3.0-only
// `wsp add <user@host> --recipe <name>` and the add tool: the install's
// steps and the setup's steps as frames, a sign-in that waits on the person
// as a frame of its own, the result last, and the tool that never waits on
// the person. The host is a fake that plays one add; the box's own checks
// and the plan off a computer's picks are read here too.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Manifest } from "@wsp/collect";
import { RecipeFile, SETUP_STEP_WORDS, type AddLine, type PlaceSetup, type PlaceView, type PlaceWait } from "@wsp/protocol";
import { sshWordReach, type SshLocalRun } from "@wsp/engine";
import { PassThrough } from "node:stream";
import { gunzipSync } from "node:zlib";
import { addCommand, addFlags, choosingLine, followSetup, parsePlaceCheck, placeCheckRefusal, PLACE_CHECK_SPARE_BYTES, RESUME_FLAGS_REFUSAL, SETUP_FLAGS_REFUSAL } from "../src/places.js";
import { picksRows, placeProvisioner } from "../src/place-provision.js";
import { addComputer, ADD_TOOL_FIX, watchSetup } from "../src/setup-follow.js";
import { captured } from "./verbs-fixture.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `wsp-${name}-`));
  dirs.push(dir);
  return dir;
};

const WAIT: PlaceWait = { row: "signins/codex", label: "Codex", url: "https://auth.openai.com/codex/device", code: "ABCD-EFGH", expiresAt: "2026-10-03T10:15:00.000Z", state: "waiting" };
const PLACE: PlaceView = { id: "p_1", kind: "computer", name: "spoo", default: true, present: true, takesForks: true };
const RUNNING: PlaceSetup = { state: "running", addId: "a_x", startedAt: "2026-10-03T10:01:00.000Z", steps: [], waiting: [] };

/** A host that plays one add: the install's steps, the setup's, a sign-in that waits and its landing when the test
 * says, and the end. The row it lists moves with what it said. */
function fakeHost(o: { end?: "ready" | "failed"; signIn?: boolean; pending?: boolean; running?: string } = {}) {
  const asked: { op: string; params?: Record<string, unknown> }[] = [];
  const frames: ((frame: Record<string, unknown>) => void)[] = [];
  let row: PlaceView = PLACE;
  let addId = "";
  const say = (frame: Record<string, unknown>): void => {
    for (const fn of [...frames]) fn(frame);
  };
  /** The person signs in: the wait goes from the row and the setup says it is ready. */
  const land = (): void => {
    row = { ...row, setup: { ...row.setup!, waiting: [] } };
    say({ type: "place.setup", addId, placeId: PLACE.id, end: "ready" });
  };
  const play = (): void => {
    say({ type: "place.stage", addId, step: "connect", state: "done", note: "Ubuntu 24.04" });
    say({ type: "place.stage", addId, step: "check", state: "done", note: "root, systemd, cgroup v2" });
    say({ type: "place.stage", addId, step: "join", state: "done", placeId: PLACE.id });
    say({ type: "place.setup", addId, placeId: PLACE.id, line: { step: "floor", state: "done", ms: 41_000 } });
    if (o.signIn === true) say({ type: "place.setup", addId, placeId: PLACE.id, wait: WAIT });
    say({ type: "place.setup", addId, placeId: PLACE.id, line: { step: "clis", state: "done", ms: 9_000 } });
    const state = o.end === "failed" ? "failed" : "done";
    row = { ...row, setup: { ...RUNNING, addId, state, finishedAt: "x", steps: [{ step: "floor", state: "done", ms: 41_000 }, { step: "clis", state: "done", ms: 9_000 }], waiting: o.signIn === true ? [WAIT] : [], ...(state === "failed" ? { said: "no agent installed: Codex" } : {}) }, applied: { hash: "h", at: "x", rows: [{ id: "tools/brew/gh", label: "GitHub CLI", outcome: "installed" }] } };
    say({ type: "place.setup", addId, placeId: PLACE.id, end: o.end ?? (o.signIn === true ? "needs-you" : "ready") });
  };
  const client = {
    request: async (op: string, params?: Record<string, unknown>) => {
      asked.push({ op, ...(params === undefined ? {} : { params }) });
      if (op === "places.list") return { places: [row] };
      if (op !== "places.add" && op !== "places.setup") throw new Error(`unexpected op ${op}`);
      // A setup already under way answers its own stream, not the one the caller minted.
      addId = o.running ?? String(params!["addId"] ?? "a_tool");
      if (o.pending === true) {
        say({ type: "place.stage", addId, step: "join", state: "done", placeId: PLACE.id });
        return { addId, place: PLACE, pending: { id: addId, address: "root@10.0.0.9", step: "floor", choices: RecipeFile.parse({ name: "spoo" }), startedAt: "x", placeId: PLACE.id } };
      }
      row = { ...PLACE, setup: { ...RUNNING, addId } };
      const answer = { addId, place: row };
      // The frames land after the reply, as the setup runs on behind the add.
      setTimeout(play, 5);
      return answer;
    },
    events: async () => {},
    onFrame: (fn: (frame: Record<string, unknown>) => void) => {
      frames.push(fn);
      return () => frames.splice(frames.indexOf(fn), 1);
    },
    closeWords: () => "",
    closed: new Promise(() => {}),
    close: () => {},
    terminate: () => {},
  };
  return { client, asked, land };
}

/** The ssh config a dial reads: every word comes back as its own host. */
const plainConfig: SshLocalRun = async (_file, args) => ({ exitCode: 0, stdout: `user root\nhostname ${args.at(-1)}\nport 22\n`, stderr: "" });

function deps(client: unknown, opened: string[] = []): Parameters<typeof addCommand>[4] {
  return {
    dial: async () => client as never,
    now: () => 0,
    run: (async () => ({ exitCode: 0, stdout: "", stderr: "" })) as never,
    platform: "linux",
    checkKey: async () => ({ state: "taken" }),
    terminal: { input: new PassThrough() as never, output: new PassThrough() as never },
    open: async url => (opened.push(url), true),
    placeLink: async () => ({ link: { op: async () => ({ ok: true }), onEvent: () => () => {} }, close: async () => undefined }),
    signIn: async () => ({ signedIn: false }),
    sshWord: (word, o) => sshWordReach(word, o, plainConfig),
    heldHostKey: async () => "ssh-ed25519 SHA256:held",
    offeredHostKey: async () => ({ key: "ssh-ed25519 SHA256:offered" }),
  };
}

const opts = (home: string): Parameters<typeof addCommand>[1] => ({ statePath: join(home, "state.json"), home, env: { HOME: home, WSP_HOME: home } });

describe("wsp add <user@host> --recipe", () => {
  it("prints the install's steps and the setup's as setup frames, a sign-in that waits as a waiting frame, and the computer last", async () => {
    const io = captured();
    const host = fakeHost({ signIn: true });
    const code = await addCommand(io, opts(tmp("add-json")), ["root@10.0.0.9"], addFlags(undefined, undefined, undefined, undefined, undefined, undefined, undefined, {}, undefined, undefined, { recipe: "laptop", later: true, json: true }), deps(host.client));
    expect(code).toBe(0);
    expect(io.errors).toEqual([]);
    const objects = io.lines.map(l => JSON.parse(l) as Record<string, unknown>);
    // JSON alone on stdout, each frame one field of the tool's output, the result the output less those fields.
    expect(objects.map(o => Object.keys(o))).toEqual([["setup"], ["setup"], ["setup"], ["setup"], ["waiting"], ["setup"], ["computer"]]);
    expect(objects.slice(0, 4).map(o => (o["setup"] as AddLine).step)).toEqual(["connect", "check", "join", "floor"]);
    expect(objects[4]!["waiting"]).toEqual(WAIT);
    expect((objects.at(-1)!["computer"] as PlaceView).setup?.waiting).toEqual([WAIT]);
    // The recipe rides the add itself: the host reads it before it dials, and sets the computer up from it.
    expect(host.asked.find(a => a.op === "places.add")?.params).toMatchObject({ address: "root@10.0.0.9", recipe: "laptop" });
  });

  it("at a terminal prints the page and the code, opens the page here, and waits on the person until the sign-in lands", async () => {
    const io = { ...captured(), isTTY: true };
    const host = fakeHost({ signIn: true });
    const opened: string[] = [];
    let done = false;
    const running = addCommand(io, opts(tmp("add-wait")), ["root@10.0.0.9"], { recipe: "laptop" }, deps(host.client, opened)).then(code => ((done = true), code));
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(done).toBe(false);
    expect(io.lines).toContain("  ? Codex waits on you to sign in at https://auth.openai.com/codex/device with code ABCD-EFGH");
    expect(opened).toEqual([WAIT.url]);
    host.land();
    expect(await running).toBe(0);
    // The steps as a terminal reads them, each with what it took, and the tally at the end.
    expect(io.lines).toContain("  · the base tools (41s)");
    expect(io.lines).toContain("spoo: 1 installed: GitHub CLI");
  });

  it("with --later leaves the sign-in waiting, says so at the end and exits 0", async () => {
    const io = captured();
    const host = fakeHost({ signIn: true });
    expect(await addCommand(io, opts(tmp("add-later")), ["root@10.0.0.9"], { recipe: "laptop", later: true }, deps(host.client))).toBe(0);
    expect(io.lines.at(-1)).toBe("  ? Codex waits on you to sign in at https://auth.openai.com/codex/device with code ABCD-EFGH");
  });

  it("exits 1 where a step that blocks stopped the setup, with why", async () => {
    const io = captured();
    const host = fakeHost({ end: "failed" });
    expect(await addCommand(io, opts(tmp("add-failed")), ["root@10.0.0.9"], { recipe: "laptop" }, deps(host.client))).toBe(1);
    expect(io.lines.at(-1)).toBe("spoo: no agent installed: Codex");
  });

  it("without a recipe says the computer waits on its picks and how to give them, and follows nothing", async () => {
    const io = captured();
    const host = fakeHost({ pending: true });
    expect(await addCommand(io, opts(tmp("add-pending")), ["root@10.0.0.9"], {}, deps(host.client))).toBe(0);
    expect(io.lines.at(-1)).toBe(choosingLine("spoo"));
    expect(host.asked.map(a => a.op)).toEqual(["places.add"]);
  });

  it("with --resume sets up the computer named from the recipe given, and refuses the flags of a join beside it", async () => {
    const io = captured();
    const host = fakeHost();
    expect(await addCommand(io, opts(tmp("add-resume")), ["spoo"], { resume: true, recipe: "laptop" }, deps(host.client))).toBe(0);
    expect(host.asked.find(a => a.op === "places.setup")?.params).toMatchObject({ ref: "spoo", recipe: "laptop" });
    await expect(addCommand(captured(), opts(tmp("add-resume-name")), ["spoo"], { resume: true, name: "box" }, deps(host.client))).rejects.toThrow(RESUME_FLAGS_REFUSAL);
  });

  it("with --resume on a setup already running follows that run on its own stream to the end", async () => {
    const io = captured();
    const host = fakeHost({ running: "a_running" });
    const followed = addCommand(io, opts(tmp("add-follow")), ["spoo"], { resume: true }, deps(host.client));
    expect(await Promise.race([followed, new Promise<"stuck">(r => setTimeout(() => r("stuck"), 1_000))])).toBe(0);
    expect(io.lines.some(l => l.includes(SETUP_STEP_WORDS.clis))).toBe(true);
  });

  it("refuses a recipe, --later and --json on an add that is not a computer's", async () => {
    const host = fakeHost();
    for (const flags of [{ recipe: "laptop" }, { later: true }, { json: true }]) {
      await expect(addCommand(captured(), opts(tmp("add-folder")), ["/Users/dev/code/app"], flags, deps(host.client))).rejects.toThrow(SETUP_FLAGS_REFUSAL);
      await expect(addCommand(captured(), opts(tmp("add-bare")), [], flags, deps(host.client))).rejects.toThrow(SETUP_FLAGS_REFUSAL);
    }
    expect(host.asked).toEqual([]);
  });
});

describe("following a setup from the command line", () => {
  it("hears the end that lands while it reads the row, rather than waiting on a frame that never comes", async () => {
    const listeners: ((frame: Record<string, unknown>) => void)[] = [];
    let reads = 0;
    const client = {
      request: async (op: string) => {
        if (op !== "places.list") throw new Error(`unexpected op ${op}`);
        reads += 1;
        if (reads > 1) return { places: [{ ...PLACE, setup: { ...RUNNING, state: "done" } }] };
        for (const fn of [...listeners]) fn({ type: "place.setup", addId: "a_x", placeId: PLACE.id, end: "ready" });
        return { places: [{ ...PLACE, setup: RUNNING }] };
      },
      onFrame: (fn: (frame: Record<string, unknown>) => void) => {
        listeners.push(fn);
        return () => listeners.splice(listeners.indexOf(fn), 1);
      },
      closed: new Promise(() => {}),
      closeWords: () => "",
    };
    const watch = watchSetup(client as never, "a_x");
    const followed = await Promise.race([followSetup(client as never, PLACE.id, watch), new Promise<"stuck">(r => setTimeout(() => r("stuck"), 500))]);
    expect(followed).not.toBe("stuck");
    expect(reads).toBe(2);
  });
});

describe("the add tool", () => {
  it("answers at the first sign-in waiting on the person, with its page, and never waits on them", async () => {
    const host = fakeHost({ signIn: true });
    const answer = await addComputer(host.client as never, { address: "root@10.0.0.9", recipe: "laptop" });
    expect(answer.waiting).toEqual([WAIT]);
    expect(answer.setup.map(l => l.step)).toEqual(["floor", "clis"]);
    expect(answer.computer.id).toBe(PLACE.id);
    expect(host.asked.filter(a => a.op !== "places.list")).toEqual([{ op: "places.add", params: { address: "root@10.0.0.9", recipe: "laptop" } }]);
  });

  it("answers at the end once nothing waits, and goes on past a sign-in it was told to leave waiting", async () => {
    const ready = await addComputer(fakeHost().client as never, { address: "spoo", recipe: "laptop" });
    expect([ready.computer.setup?.state, ready.waiting]).toEqual(["done", []]);
    const later = await addComputer(fakeHost({ signIn: true }).client as never, { address: "spoo", recipe: "laptop", later: true });
    expect([later.computer.setup?.state, later.waiting]).toEqual(["done", [WAIT]]);
  });

  it("refuses a project's source and a provider in the words that send them elsewhere, asking the host nothing", async () => {
    const host = fakeHost();
    await expect(addComputer(host.client as never, { address: "/Users/dev/code/app" })).rejects.toThrow(ADD_TOOL_FIX);
    await expect(addComputer(host.client as never, { address: "https://github.com/dev/app.git" })).rejects.toMatchObject({ kind: "usage" });
    await expect(addComputer(host.client as never, { address: "box" })).rejects.toThrow("box is not one");
    expect(host.asked).toEqual([]);
  });

  it("called again with resume while the setup runs, answers that run's next wait rather than a refusal", async () => {
    const answer = await addComputer(fakeHost({ running: "a_running", signIn: true }).client as never, { address: "spoo", resume: true });
    expect(answer.waiting).toEqual([WAIT]);
  });

  it("answers at its ceiling with how far the add got", async () => {
    const host = fakeHost({ signIn: true });
    const answer = await addComputer(host.client as never, { address: "root@10.0.0.9", recipe: "laptop", later: true }, { ceilingMs: 0 });
    expect(answer.computer.setup?.state).toBeDefined();
  });
});

describe("the checks a box passes before anything of wsp's goes on it", () => {
  const read = (lines: string[]): ReturnType<typeof parsePlaceCheck> => parsePlaceCheck(lines.map(l => `wsp-check ${l}`).join("\n"));
  const need = 400 * 1024 ** 2 + PLACE_CHECK_SPARE_BYTES;

  it("passes root on systemd with cgroup v2 and the room, and refuses each that is missing in a sentence naming the fix", () => {
    expect(placeCheckRefusal("spoo", "/root", read(["uid 0", "systemd yes", "cgroup2 yes", `free ${10 * 1024 ** 3}`]), need)).toBeUndefined();
    expect(placeCheckRefusal("spoo", "/home/dev", read(["uid 1000", "systemd yes"]), need)).toContain("not root");
    expect(placeCheckRefusal("spoo", "/root", read(["uid 0", "systemd no"]), need)).toContain("runs no systemd");
    expect(placeCheckRefusal("spoo", "/root", read(["uid 0", "systemd yes", "cgroup2 no"]), need)).toContain("no cgroup v2");
    expect(placeCheckRefusal("spoo", "/root", read(["uid 0", "systemd yes", "cgroup2 yes", `free ${1024 ** 3}`]), need)).toContain("1 GB free under /root");
  });

  it("refuses nothing a box would not say, and reads no line that is not its own", () => {
    expect(placeCheckRefusal("spoo", "/root", read([]), need)).toBeUndefined();
    expect(parsePlaceCheck("uid 1000\nwsp-check systemd yes\n")).toEqual({ systemd: true });
  });
});

describe("the plan off a computer's picks", () => {
  /** A Mac with two agents, a server each and the same one under both, two CLIs and a crate. */
  const manifest: Manifest = {
    entries: [
      { rung: "agents", id: "agents/claude", label: "Claude Code", paths: ["~/.claude/settings.json", "~/.claude/skills", "~/.claude/plugins/installed_plugins.json"], bytes: 1, default: "bring" },
      { rung: "agents", id: "agents/codex", label: "Codex", paths: ["~/.codex/config.toml"], bytes: 1, default: "bring" },
      { rung: "agents", id: "agents/mcp/claude/linear", label: "linear", group: "Claude Code MCP servers", paths: [], bytes: 0, default: "bring" },
      { rung: "agents", id: "agents/mcp/codex/linear", label: "linear", group: "Codex MCP servers", paths: [], bytes: 0, default: "bring" },
      { rung: "agents", id: "agents/mcp/claude/notion", label: "notion", group: "Claude Code MCP servers", paths: [], bytes: 0, default: "bring" },
      { rung: "tools", id: "tools/brew/jq", label: "jq", paths: [], bytes: 0, default: "bring", linux: "yes" },
      { rung: "tools", id: "tools/brew/bat", label: "bat", paths: [], bytes: 0, default: "bring", linux: "yes" },
      { rung: "tools", id: "tools/cargo/cargo-nextest", label: "cargo-nextest", paths: [], bytes: 0, default: "bring", linux: "yes", version: "0.9.100" },
      { rung: "shell", id: "shell/zshrc", label: "~/.zshrc", paths: ["~/.zshrc"], bytes: 1, default: "bring", login: "zsh" },
    ],
  };
  const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, mcp: { linear: { agents: ["claude"] } }, clis: { bat: { via: "brew" } } });

  it("ticks the picks and nothing else: the agent with its own files less its skills and plugins, the server for its agent, the CLI by its manager", () => {
    const rows = picksRows(manifest, picks, { home: "/Users/dev", brew: new Map() });
    const ticked = rows.filter(e => e.bring === true).map(e => e.id);
    expect(ticked).toEqual(expect.arrayContaining(["agents/claude", "agents/mcp/claude/linear", "tools/brew/bat"]));
    for (const id of ["agents/codex", "agents/mcp/codex/linear", "agents/mcp/claude/notion", "tools/brew/jq", "tools/cargo/cargo-nextest", "shell/zshrc"]) expect(ticked).not.toContain(id);
    expect(rows.find(e => e.id === "agents/claude")?.paths).toEqual(["~/.claude/settings.json"]);
  });

  it("asks for the C toolchain only where a picked row needs it, lands skills at their real path and never a bash file", async () => {
    const home = tmp("plan-picks");
    const real = join(home, "checkout", "unslop");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "SKILL.md"), "---\nname: unslop\n---\n");
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    symlinkSync(real, join(home, ".claude", "skills", "unslop"));
    writeFileSync(join(home, ".zshrc"), "export GITHUB_TOKEN=ghp_x\nalias g=git\n");
    writeFileSync(join(home, ".bashrc"), "alias g=git\n");
    const provision = placeProvisioner({ statePath: join(home, "state.json"), home, platform: "darwin", collect: async () => manifest, brew: async () => new Map() });
    const plain = await provision.setup(picks, { home: "/root" });
    expect(plain.compiler).toBe(false);
    const building = await provision.setup({ ...picks, clis: { "cargo-nextest": { via: "cargo", needs: ["build-essential"] } } }, { home: "/root" });
    expect(building.compiler).toBe(true);
    const full = await provision.setup({ ...picks, skills: { unslop: { from: "~/.claude/skills" }, gone: { from: "~/.claude/skills" } }, configs: { shell: {} } }, { home: "/root" });
    expect(full.skills?.lands.map(l => l.dest)).toEqual([".claude/skills/unslop"]);
    const packed = await full.skills!.pack();
    expect(packed.files).toBe(1);
    expect(full.skipped).toEqual([expect.objectContaining({ id: "skills/gone" })]);
    expect(full.configs?.lands.map(l => l.dest)).toEqual([".zshrc"]);
    const configs = await full.configs!.pack();
    const landed = gunzipSync(configs.tar).toString("utf8");
    expect(landed).toContain("alias g=git");
    expect(landed).not.toContain("ghp_x");
    expect(full.configTools?.map(t => t.label)).toEqual(["zsh"]);
  });

  it("sends a skill only as a folder holding SKILL.md under its own name, never another folder of this computer", async () => {
    const home = tmp("plan-skills");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE");
    mkdirSync(join(home, ".claude", "skills", "notes"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "notes", "todo.md"), "x");
    const provision = placeProvisioner({ statePath: join(home, "state.json"), home, platform: "darwin", collect: async () => manifest, brew: async () => new Map() });
    const plan = await provision.setup({ ...picks, skills: { ".ssh": { from: "~" }, "../../.ssh": { from: "~/.claude/skills" }, notes: { from: "~/.claude/skills" } } }, { home: "/root" });
    expect(plan.skills).toBeUndefined();
    expect(plan.skipped.map(s => s.id).sort()).toEqual(["skills/../../.ssh", "skills/.ssh", "skills/notes"]);
  });

  it("follows a link inside a skill only to a file, and names a linked folder rather than sending what it holds", async () => {
    const home = tmp("plan-links");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE KEY BYTES");
    writeFileSync(join(home, "notes.md"), "shared notes");
    const good = join(home, ".claude", "skills", "good");
    mkdirSync(good, { recursive: true });
    writeFileSync(join(good, "SKILL.md"), "---\nname: good\n---\n");
    symlinkSync(join(home, ".ssh"), join(good, "keys"));
    symlinkSync(join(home, "notes.md"), join(good, "notes.md"));
    const provision = placeProvisioner({ statePath: join(home, "state.json"), home, platform: "darwin", collect: async () => manifest, brew: async () => new Map() });
    const plan = await provision.setup({ ...picks, skills: { good: { from: "~/.claude/skills" } } }, { home: "/root" });
    const packed = await plan.skills!.pack();
    const tar = gunzipSync(packed.tar).toString("utf8");
    expect(tar).not.toContain("PRIVATE KEY BYTES");
    expect(tar).not.toContain("keys/id_ed25519");
    expect(tar).toContain("shared notes");
    expect(packed.files).toBe(2);
    expect(packed.skipped).toEqual([expect.objectContaining({ path: ".claude/skills/good/keys", note: expect.stringContaining("links to a folder") })]);
  });
});
