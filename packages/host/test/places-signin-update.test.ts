// SPDX-License-Identifier: AGPL-3.0-only
// The four words about where a person's agents run. The join here dials a
// real ws server holding a real ed25519 pair, so the handshake typed on a
// computer is the one a host answers; the service manager is a fake runner,
// since installing a launchd agent is not this test's business.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AT_ITS_TERMINAL, CODE_FROM_ROW, DAEMON_VERSION, waitsForInstallLine, placeCurrentLine, placeProvisioningLine, type PlaceProvisionRow, type PlaceSetup, PlaceReport, placeDaemonPaths, placeNoChipLine, placeOwnedPaths, placeUpdateLine, shellQuote, type PlaceView, type SignInLine } from "@wsp/protocol";
import { type PlaceUpdateRequest } from "@wsp/runtime";
import { type SshRiding } from "@wsp/engine";
import { daemonBinaryIn, GUEST_DAEMON_TARGETS, noPlaceSystemLine } from "../src/daemon-binary.js";
import { loginFilesStep, profileSourceLine, sshDaemonPlace } from "../src/doctor.js";
import { addCommand, UPDATE_FLAGS_REFUSAL, placeNoUpdateRoadLine, placeUnit, PLACE_NO_KEEP_LINE, PLACE_UPDATED_LINE, placeLoginFilesFailedLine, placeUpdateFailedLine, placeUpdateScript, placeUpdater, updatedLines, SIGN_IN_FLAGS_REFUSAL, placeNoLoginsLine, boxReplacesLine } from "../src/places.js";
import { signInAgentRefusal, signInRowCommand } from "../src/places/add-words.js";
import { placeService } from "../src/place-report.js";
import { captured } from "./verbs-fixture.js";
import { SERVICE_MANAGERS } from "../src/service.js";
import { fakeRunner, noBoxSignIn, opts, systemPlaceDeps, tmp } from "./places-fixture.js";

describe("wsp add <place> --sign-in <agent>", () => {
  const spoo: PlaceView = {
    id: "p_1",
    kind: "computer",
    name: "spoo",
    default: true,
    joinedAt: new Date(0).toISOString(),
    agents: ["claude", "codex"],
    logins: "/wsp/logins",
  };

  /** A host holding one joined computer, answering the listing and planning each line: the sign-in itself is handed in. */
  const planned: { target: unknown; agent: unknown }[] = [];
  const landed: Record<string, unknown>[] = [];
  const listing = (places: PlaceView[] = [spoo]): NonNullable<Parameters<typeof addCommand>[4]>["dial"] => () =>
    Promise.resolve({
      request: (op: string, params: Record<string, unknown> = {}) =>
        op === "places.list"
          ? Promise.resolve({ places } as never)
          : op === "agents.signInLine"
            ? (planned.push({ target: params["target"], agent: params["agent"] }), Promise.resolve({ line: { command: `${String(params["agent"])} login` } } as never))
            : op === "places.loginLanded"
              ? (landed.push(params), Promise.resolve({} as never))
              : Promise.reject(new Error(`unexpected op ${op}`)),
      events: () => Promise.resolve(),
      onFrame: () => () => {},
      closed: Promise.resolve(),
      closeWords: () => "",
      close: () => {},
    } as never);

  const signingIn = (answer: Awaited<ReturnType<NonNullable<Parameters<typeof addCommand>[4]>["signIn"]>>, places?: PlaceView[]) => {
    const asked: { agent?: string; line: SignInLine }[] = [];
    return {
      asked,
      deps: {
        ...systemPlaceDeps,
        dial: listing(places),
        signIn: async (o: { agent?: string; line: SignInLine }) => {
          asked.push({ agent: o.agent, line: o.line });
          return answer;
        },
      } as Parameters<typeof addCommand>[4],
    };
  };

  it("signs the agent in on the computer named by the line the host plans for it there", async () => {
    const io = captured();
    const run = signingIn({ signedIn: true, detail: "ChatGPT" });
    planned.length = 0;
    landed.length = 0;
    expect(await addCommand(io, opts(tmp("signin-place")), ["spoo"], { signIn: "codex" }, run.deps)).toBe(0);
    expect(planned).toEqual([{ target: { placeId: "p_1" }, agent: "codex" }]);
    // That computer lists its logins only when it dials, so the host is told the one the tool's status said landed.
    expect(landed).toEqual([{ placeId: "p_1", agent: "codex" }]);
    expect(run.asked).toEqual([{ agent: "codex", line: { command: "codex login" } }]);
    expect(io.lines.join("\n")).toContain("Codex is signed in on spoo (ChatGPT); every workspace there shares that login.");
    // A row that says where that computer keeps its logins is never turned away: the host asks its backend again
    // whenever a computer dials back on another daemon, so a box that has just taken this one is ready here.
    expect(io.errors.join("\n")).not.toContain(placeNoLoginsLine("spoo"));
  });

  it("says the sign-in replaces the login standing there before it starts, and says nothing of it where none stands", async () => {
    const io = captured();
    const run = signingIn({ signedIn: true }, [{ ...spoo, signIns: { claude: "vault-key", codex: "signed-in" } }]);
    expect(await addCommand(io, opts(tmp("signin-replaces")), ["spoo"], { signIn: "codex" }, run.deps)).toBe(0);
    expect(io.lines[0]).toBe(boxReplacesLine("spoo", "codex"));
    expect(boxReplacesLine("spoo", "codex")).toBe("Codex is signed in on spoo; this sign-in replaces that login.");
    expect(run.asked).toHaveLength(1);
    const fresh = captured();
    expect(await addCommand(fresh, opts(tmp("signin-fresh")), ["spoo"], { signIn: "codex" }, signingIn({ signedIn: true }, [{ ...spoo, signIns: { codex: "none" } }]).deps)).toBe(0);
    expect(fresh.lines.join("\n")).not.toContain("replaces that login");
  });

  it("signs in an agent whose login is not shared too, as the host plans it, and says so without a shared login", async () => {
    const io = captured();
    const run = signingIn({ signedIn: true });
    expect(await addCommand(io, opts(tmp("signin-gemini")), ["spoo"], { signIn: "gemini" }, run.deps)).toBe(0);
    expect(run.asked).toEqual([{ agent: "gemini", line: { command: "gemini login" } }]);
    expect(io.lines.join("\n")).toContain("Gemini CLI is signed in on spoo.");
    expect(io.lines.join("\n")).not.toContain("shares that login");
  });

  it("signs gh in on the computer too, which a setup's GitHub row names as the line that signs it in there", async () => {
    const io = captured();
    const run = signingIn({ signedIn: true });
    landed.length = 0;
    expect(await addCommand(io, opts(tmp("signin-gh")), ["spoo"], { signIn: "gh" }, run.deps)).toBe(0);
    expect(run.asked).toEqual([{ agent: "gh", line: { command: "gh login" } }]);
    expect(landed).toEqual([{ placeId: "p_1", agent: "gh" }]);
    expect(signInRowCommand("spoo", { id: "github", label: "GitHub" })).toBe("wsp add spoo --sign-in gh");
    expect(signInRowCommand("spoo", { id: "signins/codex", label: "Codex" })).toBe("wsp add spoo --sign-in codex");
    expect(signInRowCommand("spoo", { id: "signins/opencode", label: "OpenCode", note: AT_ITS_TERMINAL })).toBe("wsp add spoo --sign-in opencode");
    // Claude Code has no login to run there: its token goes in this host's vault, which every turn there reads.
    expect(signInRowCommand("spoo", { id: "signins/claude", label: "Claude Code" })).toBe("wsp agents key claude");
    // Picked to sign in on that computer, its row was set aside for that sign-in, which the vault's token would bill over.
    expect(signInRowCommand("spoo", { id: "signins/claude", label: "Claude Code", note: CODE_FROM_ROW })).toBe("wsp add spoo --sign-in claude");
    expect(signInRowCommand("spoo", { id: "tools/brew/jq", label: "jq" })).toBeUndefined();
    // Codex did not install there, so no login runs until a Retry puts it on.
    expect(signInRowCommand("spoo", { id: "signins/codex", label: "Codex", note: waitsForInstallLine("Codex") })).toBeUndefined();
    // gh is a tool and not an agent, and the refusal says so.
    expect(signInAgentRefusal("jq")).toMatch(/^wsp add --sign-in takes an agent with a sign-in to run on a computer, or gh for GitHub, and jq is neither: name .*codex.* or gh\.$/);
  });

  it("answers a sign-in that did not land with what the tool said and the line that runs it again", async () => {
    const io = captured();
    const run = signingIn({ signedIn: false, said: "Not logged in" });
    landed.length = 0;
    expect(await addCommand(io, opts(tmp("signin-not")), ["spoo"], { signIn: "codex" }, run.deps)).toBe(1);
    expect(landed).toEqual([]);
    expect(io.lines.join("\n")).toContain("Not logged in");
    expect(io.lines.join("\n")).toContain("wsp add spoo --sign-in codex");
  });

  it("refuses a name with no sign-in to run on a computer, a computer no place answers to, and the flags of a join", async () => {
    const io = captured();
    const run = signingIn({ signedIn: true });
    expect(await addCommand(io, opts(tmp("signin-jq")), ["spoo"], { signIn: "jq" }, run.deps)).toBe(1);
    expect(io.errors.join("\n")).toContain("claude, codex");
    expect(run.asked).toEqual([]);
    // Claude Code's token is made on this computer, and its own login runs on a box as the third way.
    expect(await addCommand(captured(), opts(tmp("signin-claude")), ["spoo"], { signIn: "claude" }, run.deps)).toBe(0);
    expect(run.asked.map(a => a.agent)).toEqual(["claude"]);
    const gone = captured();
    expect(await addCommand(gone, opts(tmp("signin-none")), ["laptop"], { signIn: "codex" }, run.deps)).toBe(1);
    expect(gone.errors[0]).toContain("It holds spoo.");
    const named = captured();
    expect(await addCommand(named, opts(tmp("signin-flags")), ["spoo"], { signIn: "codex", name: "box" }, run.deps)).toBe(1);
    expect(named.errors[0]).toBe(SIGN_IN_FLAGS_REFUSAL);
    // And a computer that has not said where it keeps them has nowhere to put one.
    const quiet = signingIn({ signedIn: true }, [{ ...spoo, logins: undefined }]);
    const unsaid = captured();
    expect(await addCommand(unsaid, opts(tmp("signin-unsaid")), ["spoo"], { signIn: "codex" }, quiet.deps)).toBe(1);
    expect(unsaid.errors[0]).toBe(placeNoLoginsLine("spoo"));
    expect(quiet.asked).toEqual([]);
  });
});

describe("wsp add <place> --update", () => {
  /** A host holding one joined computer, answering the two ops the flag sends and keeping what it was asked. */
  const updateClient = (
    answer: Record<string, unknown> | Error,
    places: PlaceView[] = [{ id: "p_1", kind: "computer", name: "spoo", default: true, joinedAt: new Date(0).toISOString(), daemonVersion: DAEMON_VERSION - 1 }],
  ): { dial: NonNullable<Parameters<typeof addCommand>[4]>["dial"]; asked: { op: string; params?: Record<string, unknown> }[] } => {
    const asked: { op: string; params?: Record<string, unknown> }[] = [];
    return {
      asked,
      dial: () =>
        Promise.resolve({
          request: (op: string, params?: Record<string, unknown>) => {
            asked.push({ op, ...(params === undefined ? {} : { params }) });
            if (op === "places.list") return Promise.resolve({ places } as never);
            if (op === "places.update") return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer as never);
            return Promise.reject(new Error(`unexpected op ${op}`));
          },
          events: () => Promise.resolve(),
          onFrame: () => () => {},
          closed: Promise.resolve(),
          closeWords: () => "",
          close: () => {},
          drop: () => {},
        } as never),
    };
  };

  const updateDeps = (dial: NonNullable<Parameters<typeof addCommand>[4]>["dial"]): Parameters<typeof addCommand>[4] => ({
    dial,
    now: () => 0,
    run: fakeRunner().run,
    platform: "linux",
    checkKey: async () => ({ state: "taken" }),
    ...noBoxSignIn,
  });

  it("names the place by the word wsp places prints and asks the host to move it, then says both versions and the road", async () => {
    const home = tmp("update-place");
    const io = captured();
    const fake = updateClient({ name: "spoo", daemon: { from: 27, to: DAEMON_VERSION, road: "link", at: "/home/maya/.wsp/daemon/wsp-daemon", kept: "/home/maya/.wsp/daemon/wsp-daemon.old" } });
    expect(await addCommand(io, opts(home), ["spoo"], { update: true }, updateDeps(fake.dial))).toBe(0);
    expect(fake.asked.map(a => a.op)).toEqual(["places.list", "places.update"]);
    // The id off the listing, never the word the person typed: two computers may share a name and the host keys by id.
    expect(fake.asked[1]!.params).toEqual({ placeId: "p_1" });
    expect(io.lines.join("\n")).toContain(`spoo: daemon 27 to ${DAEMON_VERSION}, over the link`);
    expect(io.lines.join("\n")).toContain("/home/maya/.wsp/daemon/wsp-daemon");
    // Where the one it replaced was kept, which is the first thing to look at on a box that will not come up.
    expect(io.lines.join("\n")).toContain("the old one     /home/maya/.wsp/daemon/wsp-daemon.old");
    // A daemon that answered no kept path simply says nothing of it rather than an empty row.
    expect(updatedLines({ name: "spoo", daemon: { from: 27, to: 34, road: "link", at: "/x" } }).some(line => line.includes("the old one"))).toBe(false);
  });

  it("says the note when the computer took the daemon and had not dialled back on it yet", async () => {
    const io = captured();
    const fake = updateClient({ name: "spoo", daemon: { from: 27, to: 27, road: "ssh", at: "/home/maya/.wsp/daemon/wsp-daemon", note: "spoo took the daemon and had not dialled back on it within 60s; its row reads the new version once it does" } });
    expect(await addCommand(io, opts(tmp("update-slow")), ["spoo"], { update: true }, updateDeps(fake.dial))).toBe(0);
    expect(io.lines.join("\n")).toContain("over the ssh road");
    expect(io.lines.join("\n")).toContain("had not dialled back on it within 60s");
  });

  /** A host whose update answers `reply` and, while it does, pushes the recipe's own rows back on the stream the
   * line minted. The listing it answers with carries the job as it stands once the rows have landed. */
  const recipeClient = (reply: Record<string, unknown> | Error, listed: Pick<PlaceView, "setup" | "applied">) => {
    const asked: { op: string; params?: Record<string, unknown> }[] = [];
    const frames: ((frame: Record<string, unknown>) => void)[] = [];
    const rows: PlaceView[] = [{ id: "p_1", kind: "computer", name: "spoo", default: true, joinedAt: new Date(0).toISOString(), daemonVersion: DAEMON_VERSION }];
    return {
      asked,
      dial: (): Promise<never> =>
        Promise.resolve({
          request: (op: string, params?: Record<string, unknown>) => {
            asked.push({ op, ...(params === undefined ? {} : { params }) });
            // The row carries the setup from the moment the first line started it, which is before this line asks.
            if (op === "places.list") return Promise.resolve({ places: rows.map(r => (reply instanceof Error || asked.some(a => a.op === "places.update") ? { ...r, ...listed } : r)) } as never);
            if (op !== "places.update") return Promise.reject(new Error(`unexpected op ${op}`));
            if (reply instanceof Error) return Promise.reject(reply);
            const addId = String(params!["addId"]);
            for (const fn of frames) {
              for (const line of listed.setup?.steps ?? []) fn({ type: "place.setup", addId, placeId: "p_1", line });
              fn({ type: "place.setup", addId, placeId: "p_1", end: listed.setup?.state === "failed" ? "failed" : "ready" });
              // Another computer's setup on the same host is another stream, and this line prints none of it.
              fn({ type: "place.setup", addId: "a_other", placeId: "p_2", line: { step: "clis", state: "failed", note: "somebody else's row" } });
            }
            return Promise.resolve(reply as never);
          },
          events: () => Promise.resolve(),
          onFrame: (fn: (frame: Record<string, unknown>) => void) => {
            frames.push(fn);
            return () => frames.splice(frames.indexOf(fn), 1);
          },
          closed: new Promise(() => {}),
          closeWords: () => "",
          close: () => {},
          drop: () => {},
        } as never),
    };
  };

  const setupOf = (rows: PlaceProvisionRow[], state: PlaceSetup["state"] = "done", said?: string): Pick<PlaceView, "setup" | "applied"> => ({
    setup: { state, addId: "a_1", startedAt: "2026-10-03T10:01:00.000Z", steps: [{ step: "agents", state: "done", ms: 12_000 }], waiting: [], ...(said !== undefined ? { said } : {}) },
    applied: { hash: "h", at: "2026-10-03T10:05:00.000Z", rows },
  });
  const running = (listed: Pick<PlaceView, "setup">): PlaceSetup => ({ ...listed.setup!, state: "running" });

  it("never runs a setup on a computer already running this daemon: says it is current and exits 0, reading nothing again", async () => {
    const io = captured();
    const fake = updateClient({ name: "spoo" });
    expect(await addCommand(io, opts(tmp("update-current")), ["spoo"], { update: true }, updateDeps(fake.dial))).toBe(0);
    expect(io.lines.join("\n")).toContain(placeCurrentLine("spoo", DAEMON_VERSION));
    expect(fake.asked.map(a => a.op)).toEqual(["places.list", "places.update"]);
  });

  it("returns on a computer whose setup is already going on, in the one sentence, rather than waiting on a job it did not start", async () => {
    const io = captured();
    // What the host answers a second update: the op's own refusal, while the listing's row still carries the job
    // the first line started. A line that followed that row would wait on a stream nothing of its own ends.
    const job = setupOf([{ id: "agents/codex", label: "Codex", outcome: "installed" }], "running");
    const busy = placeProvisioningLine("spoo", "agents");
    const fake = recipeClient(Object.assign(new Error(busy), { kind: "conflict" }), job);
    const code = await Promise.race([
      addCommand(io, opts(tmp("update-busy")), ["spoo"], { update: true }, updateDeps(fake.dial)),
      new Promise<string>(resolve => setTimeout(() => resolve("still waiting"), 1000)),
    ]);
    expect(code).toBe(1);
    expect(io.errors.join("\n")).toContain(busy);
    // Nothing of the running job's tally is printed: those rows are not this line's to say.
    expect(io.lines.join("\n")).not.toContain("installed: Codex");
    expect(fake.asked.map(a => a.op)).toEqual(["places.list", "places.update"]);
  });

  it("refuses a word no place answers to in the line the person typed, never in the remove's", async () => {
    const io = captured();
    const fake = updateClient(new Error("never asked"));
    expect(await addCommand(io, opts(tmp("update-none")), ["laptop"], { update: true }, updateDeps(fake.dial))).toBe(1);
    expect(fake.asked.map(a => a.op)).toEqual(["places.list"]);
    expect(io.errors[0]).toContain(placeUpdateLine("laptop"));
    expect(io.errors[0]).toContain("It holds spoo.");
    expect(io.errors[0]).not.toContain("wsp remove");
  });

  it("names the ids when two computers share the word, since ids tell them apart", async () => {
    const io = captured();
    const two: PlaceView[] = [
      { id: "p_1", kind: "computer", name: "spoo", default: true, joinedAt: new Date(0).toISOString() },
      { id: "p_2", kind: "computer", name: "spoo", default: false, joinedAt: new Date(0).toISOString() },
    ];
    const fake = updateClient(new Error("never asked"), two);
    expect(await addCommand(io, opts(tmp("update-two")), ["spoo"], { update: true }, updateDeps(fake.dial))).toBe(1);
    expect(io.errors[0]).toContain("p_1, p_2");
    expect(io.errors[0]).toContain(placeUpdateLine("spoo"));
  });

  it("refuses the flag with no place named, and beside the flags a join takes", async () => {
    const io = captured();
    const fake = updateClient(new Error("never asked"));
    await expect(addCommand(io, opts(tmp("update-bare")), [], { update: true }, updateDeps(fake.dial))).rejects.toThrow(/takes the place/);
    const beside = captured();
    expect(await addCommand(beside, opts(tmp("update-flags")), ["spoo"], { update: true, name: "other" }, updateDeps(fake.dial))).toBe(1);
    expect(beside.errors).toEqual([UPDATE_FLAGS_REFUSAL]);
    // Nothing was dialled for either: both are read off the line before a socket is opened.
    expect(fake.asked).toEqual([]);
  });
});

describe("which binary an update carries and how it travels", () => {
  /** A daemon asset holding one binary per target, each with its own bytes, as a release stages it. */
  const daemonDir = (): string => {
    const dir = tmp("update-asset");
    for (const target of GUEST_DAEMON_TARGETS) {
      const at = daemonBinaryIn(dir, target.triple);
      mkdirSync(join(at, ".."), { recursive: true });
      writeFileSync(at, `a daemon for ${target.uname}`);
    }
    return dir;
  };

  /** A link that keeps every frame it was sent and answers the last part with where the binary landed. */
  const fakeLink = (): { link: NonNullable<PlaceUpdateRequest["link"]>; frames: Record<string, unknown>[] } => {
    const frames: Record<string, unknown>[] = [];
    return {
      frames,
      link: {
        request: (op: string, params?: Record<string, unknown>) => {
          frames.push({ op, ...params });
          if (op === "exec") return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", truncated: false });
          return Promise.resolve(params?.["last"] === true ? { at: "/home/maya/.wsp/daemon/wsp-daemon", kept: "/home/maya/.wsp/daemon/wsp-daemon.old" } : {});
        },
      } as never,
    };
  };

  const reportOf = (over: Partial<PlaceReport> = {}): PlaceReport => ({
    name: "spoo",
    platform: "linux",
    arch: "x64",
    os: "Ubuntu 24.04",
    shape: { cpu: 2, memMb: 7747 },
    login: { HOME: "/home/maya", USER: "maya", PATH: "/usr/bin" },
    runsWorkspaces: true,
    engine: "none",
    daemonVersion: 27,
    agents: [],
    wsp: ["/home/maya/.wsp/daemon/wsp/dist/bin.js"],
    dialed: "http://192.168.1.20:4400",
    ...over,
  });

  it("picks the binary by the chip that computer said it is, never this one's, and sends it as bytes under one upload id", async () => {
    const dir = daemonDir();
    const { link, frames } = fakeLink();
    const landed = await placeUpdater({ daemonDir: dir })({ placeId: "p_1", name: "spoo", report: reportOf({ arch: "arm64" }), daemon: true, link });
    // Both paths come off the last part's own reply, so the line names what that computer actually did.
    expect(landed).toEqual({ road: "link", at: "/home/maya/.wsp/daemon/wsp-daemon", kept: "/home/maya/.wsp/daemon/wsp-daemon.old" });
    // The chip the box said, so a host on x64 deploys to an arm64 box the binary that box can run.
    const wanted = readFileSync(daemonBinaryIn(dir, "aarch64-unknown-linux-musl"));
    // The bytes are the parts alone: ahead of them rides the one exec that writes wsp's login files there, which
    // the cases below read.
    const parts = frames.filter(f => f["op"] === "place.update");
    expect(frames.map(f => f["op"])).toEqual(["exec", ...parts.map(() => "place.update")]);
    expect(Buffer.concat(parts.map(f => Buffer.from(String(f["data"]), "base64")))).toEqual(wanted);
    expect(new Set(parts.map(f => f["uploadId"]))).toHaveProperty("size", 1);
    // Every part carries the sha256 of the whole, which is what the last part is checked against before anything
    // is moved over the binary the unit starts.
    expect(new Set(parts.map(f => f["sha256"]))).toEqual(new Set([createHash("sha256").update(wanted).digest("hex")]));
    expect(parts.map(f => f["seq"])).toEqual([...parts.keys()]);
    expect(parts.at(-1)!["last"]).toBe(true);
    // Never a command line: a command sits in a world readable /proc/<pid>/cmdline while it runs.
    expect(parts.some(f => typeof f["cmd"] === "string")).toBe(false);
  });

  it("refuses a chip this wsp builds no daemon for, and a computer with no link and no login, before a byte moves", async () => {
    const dir = daemonDir();
    const { link, frames } = fakeLink();
    await expect(placeUpdater({ daemonDir: dir })({ placeId: "p_1", name: "spoo", report: reportOf({ arch: "riscv64" }), daemon: true, link })).rejects.toThrow(
      placeNoChipLine("spoo", "linux", "riscv64"),
    );
    await expect(placeUpdater({ daemonDir: dir })({ placeId: "p_1", name: "spoo", report: reportOf(), daemon: true })).rejects.toThrow(placeNoUpdateRoadLine("spoo"));
    expect(frames).toEqual([]);
  });

  it("says which file is missing where this command carries no daemon for that chip at all", async () => {
    const { link } = fakeLink();
    const empty = tmp("update-no-asset");
    await expect(placeUpdater({ daemonDir: empty })({ placeId: "p_1", name: "spoo", report: reportOf(), daemon: true, link })).rejects.toThrow(/wsp-daemon binary missing/);
  });
});

describe("wsp's own login files on a computer already joined, written by every update", () => {
  const HOME = "/home/maya";
  /** The lines this host spells for that box, off the place its login names: the one home of the text, which the
   * deploy at the join reads too. */
  const FILES = loginFilesStep(sshDaemonPlace({ home: HOME, path: "/usr/bin" })).join("\n");

  const reportOf = (over: Partial<PlaceReport> = {}): PlaceReport => ({
    name: "spoo",
    platform: "linux",
    arch: "x64",
    os: "Ubuntu 24.04",
    shape: { cpu: 2, memMb: 7747 },
    login: { HOME, USER: "maya", PATH: "/usr/bin" },
    runsWorkspaces: true,
    engine: "none",
    daemonVersion: 27,
    agents: [],
    wsp: [`${HOME}/.wsp/daemon/wsp/dist/bin.js`],
    dialed: "http://192.168.1.20:4400",
    ...over,
  });

  /** A daemon asset with one binary per target, as the update's own cases stage it. */
  const daemonDir = (): string => {
    const dir = tmp("login-files-asset");
    for (const target of GUEST_DAEMON_TARGETS) {
      const at = daemonBinaryIn(dir, target.triple);
      mkdirSync(join(at, ".."), { recursive: true });
      writeFileSync(at, `a daemon for ${target.uname}`);
    }
    return dir;
  };

  const fakeLink = (): { link: NonNullable<PlaceUpdateRequest["link"]>; frames: Record<string, unknown>[] } => {
    const frames: Record<string, unknown>[] = [];
    return {
      frames,
      link: {
        request: (op: string, params?: Record<string, unknown>) => {
          frames.push({ op, ...params });
          if (op === "exec") return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", truncated: false });
          return Promise.resolve(params?.["last"] === true ? { at: `${HOME}/.wsp/daemon/wsp-daemon` } : {});
        },
      } as never,
    };
  };

  /** One box over ssh, as the update's road sees it: what it was asked to run and what landed on it. */
  const fakeBox = (answer = { exitCode: 0, stdout: `${PLACE_UPDATED_LINE} /usr/local/bin/wsp-daemon\n`, stderr: "" }, home = HOME, system = "Linux") => {
    const ran: string[] = [];
    const landed: string[] = [];
    const machine = {
      id: "ssh://maya@box:22",
      kind: "sandbox",
      putBytes: async (path: string) => {
        landed.push(path);
      },
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      facts: async () => ({ os: "Ubuntu 24.04" }),
      run: async (script: string) => {
        ran.push(script);
        return answer;
      },
    };
    const ridden: SshRiding[] = [];
    const backend = {
      adopt: async () => ({ machine, login: { HOME: home, PATH: "/usr/bin", USER: "maya" }, shape: { cpu: 2, memMb: 2048 }, system, arch: "x86_64" }),
      riding: (riding: SshRiding) => (ridden.push(riding), backend),
    };
    return { ran, landed, ridden, backend };
  };

  it("rides the password the login's sudo took for an update over ssh, and none where none came with it", async () => {
    const box = fakeBox();
    await placeUpdater({ daemonDir: daemonDir(), backend: box.backend as never })({ placeId: "p_1", name: "spoo", report: reportOf(), daemon: true, ssh: { ssh: "maya@box" }, sudoPassword: "Tq-not-a-real-pw" });
    expect(box.ridden).toEqual([{ sudoPassword: "Tq-not-a-real-pw" }]);
    expect(box.ran.join("\n")).not.toContain("Tq-not-a-real-pw");
    const plain = fakeBox();
    await placeUpdater({ daemonDir: daemonDir(), backend: plain.backend as never })({ placeId: "p_1", name: "spoo", report: reportOf(), daemon: true, ssh: { ssh: "maya@box" } });
    expect(plain.ridden).toEqual([]);
  });

  it("sends them over the link as one exec ahead of the first frame of the swap, in the text the deploy writes", async () => {
    const { link, frames } = fakeLink();
    const landed = await placeUpdater({ daemonDir: daemonDir() })({ placeId: "p_1", name: "spoo", report: reportOf(), daemon: true, link });
    expect(landed).toMatchObject({ road: "link" });
    // One exec, and it carries the one home of the text: wsp's own profile file and the guarded line for the
    // person's login file, with every older line naming that file taken out first.
    const execs = frames.filter(f => f["op"] === "exec");
    expect(execs).toHaveLength(1);
    expect(execs[0]!["cmd"]).toBe(FILES);
    expect(String(execs[0]!["cmd"])).toContain(profileSourceLine(placeDaemonPaths(HOME).profileFile));
    expect(String(execs[0]!["cmd"])).toContain(`grep -vF '${placeDaemonPaths(HOME).profileFile}' '${HOME}/.profile'`);
    // Ahead of the bytes: the swap restarts that daemon and drops this link, so an exec sent after it reaches
    // nothing.
    expect(frames.findIndex(f => f["op"] === "exec")).toBeLessThan(frames.findIndex(f => f["op"] === "place.update"));
  });

  it("writes them on an update that carries no binary, and answers no landing", async () => {
    const { link, frames } = fakeLink();
    // No daemon asset at all: an update that carries no binary reads none, so nothing here can land one.
    const answer = await placeUpdater({ daemonDir: tmp("login-files-no-asset") })({ placeId: "p_1", name: "spoo", report: reportOf(), daemon: false, link });
    expect(answer).toBeUndefined();
    expect(frames.map(f => f["op"])).toEqual(["exec"]);
    expect(frames[0]!["cmd"]).toBe(FILES);
  });

  it("refuses a computer it holds no road to, on an update that carries no binary as on one that does", async () => {
    // A computer joined by a code holds no ssh login, so a link that is down leaves this nothing to run the
    // lines over: an update of a computer that cannot be reached is refused rather than passed over quietly.
    await expect(
      placeUpdater({ daemonDir: daemonDir() })({ placeId: "p_1", name: "spoo", report: reportOf(), daemon: false }),
    ).rejects.toThrow(placeNoUpdateRoadLine("spoo"));
  });

  it("passes over a computer whose report records no home, on either kind of update", async () => {
    const bare = reportOf({ login: { USER: "maya", PATH: "/usr/bin" } });
    const none = fakeLink();
    expect(await placeUpdater({ daemonDir: tmp("login-files-bare") })({ placeId: "p_1", name: "spoo", report: bare, daemon: false, link: none.link })).toBeUndefined();
    expect(none.frames).toEqual([]);
    // And where a binary goes all the same: every path the lines build comes off that home and there is none.
    const moving = fakeLink();
    await placeUpdater({ daemonDir: daemonDir() })({ placeId: "p_1", name: "spoo", report: bare, daemon: true, link: moving.link });
    expect(moving.frames.every(f => f["op"] === "place.update")).toBe(true);
  });

  it("puts them ahead of the swap in the one script over ssh, off the login that road just read", async () => {
    const box = fakeBox();
    const landed = await placeUpdater({ daemonDir: daemonDir(), backend: box.backend as never })({
      placeId: "p_1",
      name: "spoo",
      report: reportOf(),
      daemon: true,
      ssh: { ssh: "maya@box" },
    });
    expect(landed).toEqual({ road: "ssh", at: "/usr/local/bin/wsp-daemon", kept: "/usr/local/bin/wsp-daemon.old" });
    expect(box.ran).toHaveLength(1);
    expect(box.ran[0]).toContain(FILES);
    expect(box.ran[0]!.indexOf(FILES)).toBeLessThan(box.ran[0]!.indexOf("systemctl restart"));
  });

  it("refuses a box that now says it is a Mac before a byte lands, though its chip matches a Linux row", async () => {
    const box = fakeBox(undefined, HOME, "Darwin");
    await expect(
      placeUpdater({ daemonDir: daemonDir(), backend: box.backend as never })({ placeId: "p_1", name: "spoo", report: reportOf(), daemon: true, ssh: { ssh: "maya@box" } }),
    ).rejects.toThrow(noPlaceSystemLine("Darwin", "that computer", true));
    expect(box.landed).toEqual([]);
    expect(box.ran).toEqual([]);
  });

  it("runs them alone over ssh where no binary goes, and lands nothing", async () => {
    const box = fakeBox({ exitCode: 0, stdout: "", stderr: "" });
    expect(
      await placeUpdater({ daemonDir: daemonDir(), backend: box.backend as never })({ placeId: "p_1", name: "spoo", report: reportOf(), daemon: false, ssh: { ssh: "maya@box" } }),
    ).toBeUndefined();
    expect(box.ran).toEqual([FILES]);
    expect(box.landed).toEqual([]);
  });

  it("stops the update on the box's own words where the lines could not be written", async () => {
    const box = fakeBox({ exitCode: 1, stdout: "", stderr: "/home/maya/.profile: Permission denied" });
    await expect(
      placeUpdater({ daemonDir: daemonDir(), backend: box.backend as never })({ placeId: "p_1", name: "spoo", report: reportOf(), daemon: false, ssh: { ssh: "maya@box" } }),
    ).rejects.toThrow(placeLoginFilesFailedLine("spoo", "/home/maya/.profile: Permission denied"));
  });

  /** The text each road sends, run for real under bash on a home of this test's own: what a person's login file
   * holds afterwards is the whole of what these lines promise. Both roads run them under a plain `bash -c`, the
   * daemon's exec on the link road and the transport's on the ssh road, and neither sets `set -e`. */
  const ranOn = (body: string): void => {
    execFileSync("bash", ["-c", body], { encoding: "utf8" });
  };

  it("leaves a login file holding the old unguarded line with exactly one guarded line and the rest byte for byte", async () => {
    const home = tmp("login-files-live");
    const at = placeDaemonPaths(home);
    // What the correction read on that computer: the line the deploy wrote before the guard, with the person's
    // own lines around it.
    writeFileSync(join(home, ".profile"), `# theirs\n. ${at.profileFile}\n# after\n`);
    const { link, frames } = fakeLink();
    await placeUpdater({ daemonDir: tmp("login-files-live-asset") })({
      placeId: "p_1",
      name: "spoo",
      report: reportOf({ login: { HOME: home, USER: "maya", PATH: "/usr/bin" } }),
      daemon: false,
      link,
    });
    ranOn(String(frames[0]!["cmd"]));
    expect(readFileSync(join(home, ".profile"), "utf8")).toBe(`# theirs\n# after\n${profileSourceLine(at.profileFile)}\n`);
    expect(readFileSync(at.profileFile, "utf8")).toBe(`export BROWSER=${at.binDir}/wsp-open\nunset DISPLAY\n`);
    // The copy the take-out writes is its own and goes with it: nothing of wsp's is left beside their file.
    expect(existsSync(`${join(home, ".profile")}.wsp-out`)).toBe(false);
  });

  it("makes the one line over ssh where the login has no file of its own, and says it once however often it runs", async () => {
    const home = tmp("login-files-fresh");
    const at = placeDaemonPaths(home);
    const box = fakeBox({ exitCode: 0, stdout: "", stderr: "" }, home);
    await placeUpdater({ daemonDir: tmp("login-files-fresh-asset"), backend: box.backend as never })({
      placeId: "p_1",
      name: "spoo",
      report: reportOf(),
      daemon: false,
      ssh: { ssh: "maya@box" },
    });
    // The script that road sent, off the login the adopt read: no restart in it, since this update carries no
    // binary.
    ranOn(box.ran[0]!);
    expect(readFileSync(join(home, ".profile"), "utf8")).toBe(`${profileSourceLine(at.profileFile)}\n`);
    // Run again, as the next update runs it: one line, not two.
    ranOn(box.ran[0]!);
    expect(readFileSync(join(home, ".profile"), "utf8")).toBe(`${profileSourceLine(at.profileFile)}\n`);
  });
});

describe("the update over the ssh road, where the link is down", () => {
  const HOME = "/home/maya";
  const UNIT = placeUnit(HOME);

  it("names the unit and its scope through the manager that writes them, never by spelling either here", () => {
    const at = placeService(HOME, 0);
    const manager = SERVICE_MANAGERS.systemd;
    expect(UNIT.name).toBe(manager.unit(at).name);
    // A place's unit is the machine's since #750's ruling, so it is driven with no --user and read the same way.
    expect(manager.needsRoot?.(at)).toBe(true);
    expect(UNIT.systemctl).toEqual(["systemctl"]);
    expect(UNIT.journalctl).toEqual(["journalctl"]);
  });

  it("moves the landed binary over the path the unit itself names, keeps the old one and restarts, sweeping nothing", () => {
    const landed = `${placeDaemonPaths(HOME).putDir}/wsp-daemon`;
    const script = placeUpdateScript(HOME, landed);
    // The path is read back out of systemd rather than worked out here: the join wrote that unit with whatever
    // path the wsp on that computer resolved.
    expect(script).toContain(`systemctl show -p ExecStart --value ${shellQuote(UNIT.name)}`);
    expect(script).toContain("PLACE_NO_UNIT");
    // A keep that failed ends the update, as the link road's own install does: a box is never left on the new
    // daemon with no way back to the one it ran.
    expect(script).toContain(`cp -f "$exe" "$exe.old" || { echo ${PLACE_NO_KEEP_LINE}; exit 1; }`);
    expect(script).not.toContain(`"$exe.old" 2>/dev/null || true`);
    // A move, never a write into a running executable.
    expect(script).toContain(`mv -f ${shellQuote(landed)} "$exe"`);
    expect(script).not.toMatch(/cat > "\$exe"|> "\$exe"/);
    expect(script).toContain(`systemctl restart ${shellQuote(UNIT.name)}`);
    // The old port file goes before the restart, never after: a Type=simple restart returns as the process forks,
    // so a daemon that binds quickly would have its own fresh port file removed and the wait below would read a
    // daemon that is up as one that never came.
    expect(script.indexOf(`rm -f ${shellQuote(placeDaemonPaths(HOME).portFile)}`)).toBeLessThan(script.indexOf("restart"));
    expect(script).toContain("PLACE_UPDATED");
    expect(script).toContain("PLACE_UPDATE_DOWN");
    // Nothing of the person's and nothing of the workspaces is touched: an update is not a leave.
    for (const path of placeOwnedPaths(HOME).filter(at => at !== placeDaemonPaths(HOME).portFile)) expect(script).not.toContain(`rm -rf ${path}`);
    expect(script).not.toContain("place.json");
  });

  it("says what the box printed when its agent did not come back up", () => {
    expect(placeUpdateFailedLine("spoo", "Job for wsp-place-1234abcd.service failed")).toContain("spoo took the daemon and its agent did not come back up");
    expect(placeNoUpdateRoadLine("spoo")).toContain("switch it on and run the line again");
  });
});
