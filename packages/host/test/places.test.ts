// SPDX-License-Identifier: AGPL-3.0-only
// The four words about where a person's agents run. The join here dials a
// real ws server holding a real ed25519 pair, so the handshake typed on a
// computer is the one a host answers; the service manager is a fake runner,
// since installing a launchd agent is not this test's business.
import { execFile, execFileSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { promisify } from "node:util";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, statfsSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { macKindOf, ALREADY_JOINED_LINE, DAEMON_VERSION, configHardLinkRefusal, backUrl, PLACE_LOGIN_REFUSED_KIND, PLACE_HOST_KEY_KIND, PLACE_SUDO_KIND, hostKeyAsk, hostKeyMismatchRefusal, hostKeyUnconfirmedRefusal, hostKeyUnscannableRefusal, PLACE_ROOT_SHELLS, placeRootShellRefusal, addedProjectLine, addedProjectOn, agentsCell, placeCurrentLine, placeNoPicksLine, placeProvisioningLine, setupWord, RecipeFile, type PlaceProvisionRow, type PendingComputer, type PlaceSetup, JOIN_NO_KEY_REFUSAL, PLACE_LEAVE_LINE, PLACE_LEAVE_VERB, PLACE_ADD_WORDS, PLACE_CODE_REFUSAL, PLACE_DOOR_UNSERVED, PLACE_NEEDS_ROOT_LINE, PlaceReport, doorPortHeldLine, joinKeyRefusal, joinToken, placeFileText, MCP_ID_PREFIX, placeDaemonBehind, placeDaemonPaths, placeKeptForLinkLine, placeLinkTranscript, placeNoChipLine, placeOwnedPaths, placeProvisionPaths, placeUpdateLine, shellQuote, workFolderIn, wsUrlOf, type PlaceBack, type PlaceDoorView, type PlaceView, type SignInLine } from "@wsp/protocol";
import { CATALOG_AGENTS, CODEX_TOML } from "@wsp/catalog";
import { PlaceAddTakenBackError, PlaceLoginRefusedError, freshEphemeral, makeSeal, sealKeys, sharedSecret, type PlaceBackHolder, type PlaceLogin, type PlaceStaging, type PlaceUpdateRequest, type Seal } from "@wsp/runtime";
import { MissingKnownHostsError, missingKnownHostsLine, OWN_MARK, outsideAfterScript, outsideBeforeScript, SshBackend, SSH_LINE_CAP, SSH_READ_SCRIPT, SSH_SUDO_READ, SSH_WORD_REFUSAL, keyFingerprint, sshWordReach, type SshLocalRun, type SshReach, type SshRiding, type SshSudo, type SshSudoRoad, type SshTransport } from "@wsp/engine";
import { daemonBinaryHere } from "../src/assets.js";
import { daemonBinaryIn, GUEST_DAEMON_TARGETS, noGuestDaemonLine, noPlaceSystemLine } from "../src/daemon-binary.js";
import { ADD_FOUND_END, ADD_TAKEN_LINE, DAEMON_GONE_LINE, addFound, addFoundScript, addUndoScript, apparmorStep, apparmorStoodLine, daemonFlags, joinedAddWrites, joinedLine, joinedPlace, loginFilesStep, PLACE_JOINED_LINE, placeFoundSkippedLine, placeFoundStep, profileSourceLine, sshDaemonPlace, WSP_READY_LINE } from "../src/doctor.js";
import { BoxBackend, type KeyCheck, type MachineBackend } from "@wsp/engine";
import { computerLines, hostPlatform, placeLines, placeNames } from "../src/verbs.js";
import { namesPlace, PLACE_FOUND_END, placeOutsideLeftLine, placeOwnersUnknownLine, placeStoodBeforeLine, TOOL_PREFIX, WSP_WORKSPACE_APPARMOR_PATH } from "@wsp/protocol";
import { pinnedDroppingPort, refusedPort } from "../../runtime/test/held-port.js";
import {
  ADD_FLAGS_REFUSAL,
  NOTHING_TO_LEAVE_LINE,
  brokenJoinLine,
  brokenPlaceLeftLine,
  joinCutByLeaveLine,
  addCommand,
  addFlags,
  addLines,
  addRefusal,
  deviceLeftLine,
  hostPlaceKey,
  hostPlaceKeyPath,
  joinCommand,
  placeDaemonFlags,
  placeInstaller,
  addLineWords,
  backRefusedLine,
  dialsBackOverSshNote,
  placeHeldRefusal,
  reachScript,
  reachedUrls,
  unreachedLine,
  placeDialler,
  placeLogReader,
  PLACE_LOG_TAIL,
  preparePlaceHome,
  joinPlace,
  addableProviders,
  leaveCommand as leaveCommandHere,
  leavePlace,
  placeHere,
  productNameOf,
  placeNameHere,
  placeStanding,
  removeCommand,
  removeLines,
  twoPlacesLine,
  UNSAID_CHIP_REFUSAL,
  ADD_LOOPBACK_REFUSAL,
  advertisedLoopbackRefusal,
  hostKeyHere,
  UPDATE_FLAGS_REFUSAL,
  placeNoUpdateRoadLine,
  placeUnit,
  PLACE_NO_KEEP_LINE,
  PLACE_UPDATED_LINE,
  placeLoginFilesFailedLine,
  placeUpdateFailedLine,
  placeUpdateScript,
  placeUpdater,
  placeLeaver,
  placeRunner,
  placeLeaveFailedLine,
  updatedLines,
  SIGN_IN_FLAGS_REFUSAL,
  placeNoLoginsLine,
  boxSignedInLine,
  boxReplacesLine,
  joinUnansweredLine,
  addUndoneLine,
  addTakenLine,
  placeRootHomeRefusal,
  PLACE_CHECK_SCRIPT,
  placeNoRootLine,
  placeNoKeyForSudoLine,
  placeSudoReader,
  placeUndoer,
  placeUndoNeedsSudoLine,
  sudoPasswordAsk,
} from "../src/places.js";
import { BackCutError, backBindLine, heldPlaceScript } from "../src/place-back.js";
import { placeFilePath, placeKeyPath, placeLogPath, placeReport, placeService, readPlaceFile, sweepPlace as sweepPlaceHere, sweptLine, sweptSaid, writePlaceFile, type PlaceSweepOptions } from "../src/place-report.js";
import { captured } from "./verbs-fixture.js";
import { SERVICE_MANAGERS, type RunResult, type ServiceAddress, type ServiceManager, type ServiceRunner, type ServiceUnit } from "../src/service.js";
import { addedBy, addedProviders } from "../src/providers.js";
import { sha256sumBin } from "../../engine/test/sha256sum-bin.js";
import { runsFromItsOwnFolder } from "./own-folder.js";
import { writeStub } from "../../protocol/test/stub-script.js";
import { CLOUD_ON } from "../src/cloud.js";
import { addFoundNothing, codeFor, dirs, fakeHost, fakeRunner, homeWithLandedFiles, joinDepsFor, leaveCommand, noBoxSignIn, NOWHERE_CODE, opts, shWithSha256sum, spooConfig, sweepPlace, systemPlaceDeps, tmp, toolsUnder, unitsUnder } from "./places-fixture.js";

describe("a join the host never answered", () => {
  it("names the address and the wait, then what to do, and reads whole behind the app's install sentence", () => {
    const line = joinUnansweredLine("http://100.129.166.28:4640");
    expect(line).toBe("the host at http://100.129.166.28:4640 did not answer in 20 s; put both computers on one network, or link that host to your relay, and try again");
    // The app reads it as the box's last stderr line behind "<name> took wsp but could not connect back: ", cut at 300.
    expect(`spoo took wsp but could not connect back: ${line}`.length).toBeLessThanOrEqual(300);
  });
});

describe("what wsp add prints with no argument", () => {
  it("names the line to type on that computer at every address this host answers on, and the other two roads", () => {
    const token = joinToken("7QK3M2VD", `SHA256:${"b".repeat(43)}`);
    const lines = addLines(token, 600_000, 0, ["http://192.168.1.20:4400"], "p_ab12cd34.singhi.me").join("\n");
    // One word beside --code on every address: the code the host will spend and the key it will prove.
    expect(lines).toContain(`wsp join http://192.168.1.20:4400 --code ${token}`);
    expect(lines).toContain(`wsp join https://p_ab12cd34.singhi.me --code ${token}`);
    expect(lines).toContain("spent by the first join");
    expect(lines).toContain("wsp add user@host");
    for (const id of addableProviders()) expect(lines).toContain(`wsp add ${id}`);
  });

  it("leaves the relay line out when the host is on no relay", () => {
    expect(addLines(joinToken("X", `SHA256:${"b".repeat(43)}`), 1, 0, ["http://10.0.0.2:4400"], undefined).join("\n")).not.toContain("relay");
  });

  it.runIf(CLOUD_ON)("takes every provider the table says how to add, and nothing it names no way of adding", () => {
    // Read off the table, never off an id: the row that holds no machine is no place to add at all.
    expect(addableProviders()).toEqual(["box", "solari"]);
    // How a row is added is read off the row's own facts: a row that declares the variable it reads a key from is
    // opened by that key, and is not asked to say so twice.
    expect(addedProviders().map(m => addedBy(m))).toEqual(["key", "key"]);
    expect(addedProviders().map(m => [m.id, m.keyEnv !== undefined])).toEqual([["box", true], ["solari", true]]);
    expect(addableProviders()).not.toContain("none");
    expect(addRefusal("nonsense")).toContain("box, solari");
    expect(addRefusal("nonsense")).toContain("user@host");
    expect(addRefusal("nonsense")).toContain("wsp add with no argument");
    expect(addRefusal("nonsense")).toContain("an alias your ssh config gives a HostName");
    expect(addRefusal("nonsense")).not.toMatch(/\.\s+\S/);
  });
});

describe("a provider as a place", () => {
  it.runIf(CLOUD_ON)("puts the key to a provider that is opened by one, and writes nothing when it is refused", async () => {
    const home = tmp("add-provider-key");
    const put: MachineBackend[] = [];
    const refusing = { ...systemPlaceDeps, checkKey: async (b: MachineBackend): Promise<KeyCheck> => (put.push(b), { state: "refused", said: "box said 401 invalid token" }) };
    const io = captured();
    expect(await addCommand(io, opts(home, { BOAT_API_KEY: "sk-ant-x" }), ["box"], {}, refusing)).toBe(1);
    expect(io.errors.join("\n")).toContain("401");
    expect(existsSync(join(home, ".env"))).toBe(false);
    // The key is put to the provider being added, built out of the environment that carries every row's key under
    // the variable that row declares.
    expect(put).toHaveLength(1);
    expect(put[0]).toBeInstanceOf(BoxBackend);
    // A key the provider took sets this computer up for it and nothing of the key is written or printed.
    const taking = { ...systemPlaceDeps, checkKey: async () => ({ state: "taken" }) as const };
    const good = captured();
    expect(await addCommand(good, opts(home, { BOAT_API_KEY: "sk-ant-x" }), ["box"], {}, taking)).toBe(0);
    expect(good.lines.join("\n")).toContain("place box");
    expect(readFileSync(join(home, ".env"), "utf8")).toBe("WSP_PROVIDER=box\n");
    expect(good.lines.join("\n") + good.errors.join("\n")).not.toContain("sk-ant-x");
  });

  it.runIf(CLOUD_ON)("writes the pick beside the state file it was run against, which is what the host serving it reads", async () => {
    const home = tmp("add-provider-beside");
    const folder = join(home, "elsewhere");
    mkdirSync(folder, { recursive: true });
    const beside = { ...opts(home, { BOAT_API_KEY: "sk-ant-x" }), statePath: join(folder, "state.json") };
    const io = captured();
    expect(await addCommand(io, beside, ["box"], {}, systemPlaceDeps)).toBe(0);
    expect(readFileSync(join(folder, ".env"), "utf8")).toBe("WSP_PROVIDER=box\n");
    // The wsp home's own file is another host's, and this add never touched it.
    expect(existsSync(join(home, ".env"))).toBe(false);
  });

  it("refuses the ssh road's own flags when no computer was named beside them", async () => {
    const home = tmp("add-name");
    const io = captured();
    expect(await addCommand(io, opts(home, {}), [], { name: "box" }, systemPlaceDeps)).toBe(1);
    expect(io.errors).toEqual([ADD_FLAGS_REFUSAL]);
    expect(io.errors[0]).toContain("wsp join");
  });
});

describe("the table wsp places prints", () => {
  const rows: PlaceView[] = [
    { id: "here", kind: "computer", name: "zingzys-mac", default: false, shape: { cpu: 8, memMb: 16384 }, engine: "docker", present: true, takesForks: false },
    { id: "p_1", kind: "computer", name: "box", default: true, shape: { cpu: 4, memMb: 4096 }, diskFreeBytes: 831 * 1024 ** 3, engine: "none", present: true, lastSeenAt: "2026-09-12T00:00:00.000Z", takesForks: true },
    { id: "solari", kind: "provider", name: "solari", default: false, rateUsdPerHour: 0.018, takesForks: true },
  ];

  it("carries the cores, the memory, the free disk, its engine and the presence, with the default marked once, and no column for whether it runs workspaces", () => {
    const printed = placeLines(rows);
    expect(printed[0]).toContain("PLACE");
    expect(printed[0]).toContain("DISK FREE");
    // Every place on this list forks, so the column that said yes or no said one word forever.
    expect(printed[0]).not.toContain("WORKSPACES");
    expect(printed[0]).toContain("ENGINE");
    expect(printed[1]).toContain("zingzys-mac");
    expect(printed[2]).toContain("box");
    expect(printed[2]).toContain("default");
    expect(printed[3]).toContain("$0.018/hr");
    expect(printed.filter(l => l.includes("default"))).toHaveLength(1);
  });

  it("says beside the engine how a workspace's copy of a project is made there, and nothing for a place that has not said", () => {
    const printed = placeLines([{ ...rows[1]!, copies: "reflink" }, rows[0]!, rows[2]!]);
    // Beside the engine: both are what that computer brings to a workspace rather than what one asked for.
    const header = printed[0]!;
    expect(header).toContain("COPIES");
    expect(header.indexOf("COPIES")).toBeGreaterThan(header.indexOf("ENGINE"));
    expect(printed[1]).toContain("reflink");
    // The columns line up: the word sits under its own heading rather than in the one beside it.
    const column = (line: string): string => line.slice(header.indexOf("COPIES"), header.indexOf("PRESENT")).trim();
    expect(column(printed[1]!)).toBe("reflink");
    expect(column(printed[2]!)).toBe("");
    expect(column(printed[3]!)).toBe("");
  });

  it("says how to get one when the host holds none", () => {
    expect(placeLines([]).join("")).toContain("wsp add prints the join line");
  });

  it("names a cloud by the name the app gives it, Boat and Solari, never the id stored state holds, and takes either after --on in any case", async () => {
    const boat: PlaceView = { id: "box", kind: "provider", name: "box", default: false, rateUsdPerHour: 0.16, takesForks: true };
    const first = (line: string): string => line.split(/\s{2,}/)[0]!;
    expect(computerLines([rows[1]!, boat, rows[2]!], "darwin").slice(1).map(first)).toEqual(["box", "Boat", "Solari"]);
    // The computer column of workspaces, threads and projects reads the same names.
    const names = await placeNames({ request: async () => ({ places: [...rows, boat] }) } as unknown as Parameters<typeof placeNames>[0]);
    expect([names.get("p_1"), names.get("box"), names.get("solari")]).toEqual(["box", "Boat", "Solari"]);
    for (const word of ["Boat", "boat", "BOAT", "box", "BOX"]) expect(namesPlace(boat, word), word).toBe(true);
    expect(namesPlace(boat, "solari")).toBe(false);
    // A joined computer is named by the word its owner gave it, exactly.
    expect(namesPlace(rows[1]!, "box")).toBe(true);
    expect(namesPlace(rows[1]!, "Box")).toBe(false);
  });

  it("says on the row what a copy of the image there is doing, and nothing where the copy stands", () => {
    const printed = placeLines([{ ...rows[1]!, build: "building your image · creating the machine" }, rows[2]!]);
    expect(printed[0]).toContain("IMAGE");
    expect(printed[1]).toContain("building your image · creating the machine");
    expect(printed[2]).not.toContain("building");
  });

  it("says on the row that a computer runs an older daemon than this wsp deploys, in one word naming both versions", () => {
    const printed = placeLines([
      { ...rows[1]!, daemonVersion: DAEMON_VERSION - 5 },
      { ...rows[0]!, id: "p_2", name: "laptop", daemonVersion: DAEMON_VERSION },
    ]);
    expect(printed[0]).toContain("BEHIND");
    expect(printed[1]).toContain(`daemon ${DAEMON_VERSION - 5}, host ${DAEMON_VERSION}`);
    // The word is the protocol's own, so this row and the app's table cannot say it two ways.
    expect(printed[1]).toContain(placeDaemonBehind({ daemonVersion: DAEMON_VERSION - 5 })!);
    // A computer on this wsp's own daemon says nothing in that column, and neither does one that never reported.
    expect(printed[2]).not.toContain("daemon");
    expect(placeLines([rows[2]!])[1]).not.toContain("daemon");
  });

  it("says on the computers table what the setup on that computer is doing, and nothing for a cloud or this Mac", () => {
    const job: PlaceSetup = { state: "running", addId: "a_1", startedAt: "2026-10-03T10:01:00.000Z", steps: [{ step: "agents", state: "running" }], waiting: [] };
    const printed = computerLines([{ ...rows[1]!, setup: job }, rows[0]!, rows[2]!], "darwin");
    const header = printed[0]!;
    expect(header).toContain("TOOLS");
    const column = (line: string): string => line.slice(header.indexOf("TOOLS"), header.indexOf("AGENTS")).trim();
    // The word is the protocol's own, so this table and the app's row cannot say it two ways.
    expect(column(printed[1]!)).toBe(setupWord(job));
    expect(column(printed[1]!)).toBe("setting up the agents");
    expect(printed[1]).toContain("Setting up");
    expect(column(printed[2]!)).toBe("");
    expect(column(printed[3]!)).toBe("");
    // Once it is over the same column says what stands.
    const over = computerLines([{ ...rows[1]!, setup: { ...job, state: "done", steps: [] }, applied: { hash: "h", at: "x", rows: [{ id: "agents/codex", label: "Codex", outcome: "installed" }] } }], "darwin");
    expect(over[1]!.slice(over[0]!.indexOf("TOOLS"), over[0]!.indexOf("AGENTS")).trim()).toBe("1 tool ready");
  });

  it("lists every add that has not reached Set up below the computers, Pending with how far it got or Setup failed with why", () => {
    const choices = RecipeFile.parse({ name: "spoo" });
    const pending: PendingComputer[] = [
      { id: "a_1", address: "root@10.0.0.9", name: "spoo", step: "choosing", choices, startedAt: "x", placeId: "p_9" },
      { id: "a_2", address: "root@10.0.0.7", step: "check", choices, startedAt: "x", failed: { said: "root@10.0.0.7 runs no systemd" } },
    ];
    const printed = computerLines([rows[0]!], "darwin", [], pending);
    const header = printed[0]!;
    const state = (line: string): string => line.slice(header.indexOf("STATE"), header.indexOf("LAST SEEN")).trim();
    expect(printed.slice(2).map(l => [l.split(/\s+/)[0], state(l)])).toEqual([
      ["spoo", "Pending"],
      ["root@10.0.0.7", "Setup failed"],
    ]);
    expect(printed[2]).toContain("joined; waiting on what goes on it");
  });

  it("reads a computer that joined and is still choosing as Pending on its own row, its TOOLS cell saying how far it got", () => {
    const choices = RecipeFile.parse({ name: "spoo" });
    const joined = { ...rows[1]!, setup: undefined, applied: undefined };
    const printed = computerLines([joined], "darwin", [], [{ id: "a_1", address: "root@10.0.0.9", step: "floor", choices, startedAt: "x", placeId: joined.id }]);
    const header = printed[0]!;
    expect(printed).toHaveLength(2);
    expect(printed[1]!.slice(header.indexOf("STATE"), header.indexOf("LAST SEEN")).trim()).toBe("Pending");
    expect(printed[1]!.slice(header.indexOf("TOOLS"), header.indexOf("AGENTS")).trim()).toBe("joined; the base tools are going on while you choose");
  });

  it("says on the computers table which agents stand on a computer, at which version and signed in how", () => {
    const spoo = { ...rows[1]!, agents: ["claude", "codex"], agentVersions: { claude: "2.1.270 (Claude Code)", codex: "codex-cli 0.153.0" }, signIns: { claude: "vault-key" as const, codex: "none" as const } };
    const printed = computerLines([spoo, rows[0]!, rows[2]!], "darwin");
    const header = printed[0]!;
    expect(header).toContain("AGENTS");
    const column = (line: string): string => line.slice(header.indexOf("AGENTS")).trim();
    // The cell is the protocol's own, so this table and the app's row cannot say it two ways.
    expect(column(printed[1]!)).toBe(agentsCell(spoo));
    expect(column(printed[1]!)).toBe("claude 2.1.270 your key, codex 0.153.0 not signed in");
    // This computer reports no agent of its own on this row, and neither does a cloud account.
    expect(column(printed[2]!)).toBe("");
    expect(column(printed[3]!)).toBe("");
  });

  it("says nothing in the image column across the states of the setup, while the tools column beside it says what is happening", () => {
    const job: PlaceSetup = { state: "running", addId: "a_1", startedAt: "2026-10-03T10:01:00.000Z", steps: [{ step: "skills", state: "running" }], waiting: [] };
    const done = { setup: { ...job, state: "done" as const, steps: [] }, applied: { hash: "h", at: "x", rows: [{ id: "agents/codex", label: "Codex", outcome: "installed" as const }] } };
    const of = (place: PlaceView): { image: string; tools: string } => {
      const printed = computerLines([place], "darwin");
      const header = printed[0]!;
      const line = printed[1]!;
      return { image: line.slice(header.indexOf("IMAGE"), header.indexOf("TOOLS")).trim(), tools: line.slice(header.indexOf("TOOLS"), header.indexOf("AGENTS")).trim() };
    };
    // A computer that keeps no image says nothing in that column in any state of the job, and the refusal a fork
    // there meets while the job runs is never one of them.
    expect(of(rows[1]!)).toEqual({ image: "", tools: "" });
    expect(of({ ...rows[1]!, setup: job })).toEqual({ image: "", tools: "setting up the skills" });
    expect(of({ ...rows[1]!, ...done })).toEqual({ image: "", tools: "1 tool ready" });
  });

  it("says on the computers table how many threads run on a computer and machines on a cloud against its cap, and Full once the count meets it", () => {
    const printed = computerLines(
      [
        { ...rows[0]!, cap: { threads: 6 }, running: 1 },
        { ...rows[1]!, cap: { threads: 2 }, running: 2 },
        { ...rows[2]!, cap: { machines: 3, spendPerDayUsd: 10 }, running: 2 },
        { ...rows[1]!, id: "p_2", name: "fresh", present: false },
      ],
      "darwin",
    );
    const header = printed[0]!;
    const column = (line: string, name: string, next: string): string => line.slice(header.indexOf(name), header.indexOf(next)).trim();
    expect(header).toContain("THREADS");
    expect(printed.slice(1).map(line => column(line, "THREADS", "MACHINES"))).toEqual(["1/6", "2/2", "", ""]);
    expect(printed.slice(1).map(line => column(line, "MACHINES", "STATE"))).toEqual(["", "", "2/3", ""]);
    // The word is the protocol's own, so this table and the app's row cannot say it two ways.
    expect(printed.slice(1).map(line => column(line, "STATE", "LAST SEEN"))).toEqual(["Ready", "Full", "Ready", "no answer"]);
  });

  it("says on the computers table what a cloud spent today against its spend per day, nothing on a computer, and At limit once it reaches it", () => {
    const places: PlaceView[] = [
      { ...rows[0]!, cap: { threads: 6 }, running: 0 },
      { ...rows[1]!, cap: { threads: 2 }, running: 0 },
      { ...rows[2]!, cap: { machines: 3, spendPerDayUsd: 10 }, running: 1 },
    ];
    const spend = (todayUsd: number) => [{ place: rows[2]!.id, todayUsd, monthUsd: 40, rateUsdPerHour: 0.11 }];
    const cells = (printed: string[], name: string, next: string): string[] => printed.slice(1).map(line => line.slice(printed[0]!.indexOf(name), printed[0]!.indexOf(next)).trim());
    const under = computerLines(places, "darwin", spend(2.314));
    expect(cells(under, "SPEND", "STATE")).toEqual(["", "", "$2.31/$10"]);
    expect(cells(under, "STATE", "LAST SEEN")).toEqual(["Ready", "Ready", "Ready"]);
    const at = computerLines(places, "darwin", spend(10));
    expect(cells(at, "SPEND", "STATE")).toEqual(["", "", "$10.00/$10"]);
    expect(cells(at, "STATE", "LAST SEEN")).toEqual(["Ready", "Ready", "At limit"]);
    // With no spend read the cell is left empty rather than guessed at zero.
    expect(cells(computerLines(places, "darwin"), "SPEND", "STATE")).toEqual(["", "", ""]);
  });

  it("says how many forks a place holds of how many it takes, and nothing there for one that has not said yet", () => {
    const printed = placeLines([
      { ...rows[1]!, forks: { running: 1, room: 2 } },
      { ...rows[0]!, id: "p_2", name: "laptop", engine: "none" },
    ]);
    expect(printed[0]).toContain("FORKS");
    expect(printed[1]).toContain("1 of 3");
    expect(printed[2]).not.toContain("of");
  });
});

describe("what a remove prints", () => {
  it("names what came off the computer and the note for a place that was off, and says nothing about workspaces, since a remove is refused while forks stand", () => {
    const lines = removeLines("box", { swept: ["the systemd user unit", "/home/maya/.wsp/place.json"], note: "box is off this host" }).join("\n");
    expect(lines).toContain("removed from box:");
    expect(lines).toContain("  the systemd user unit");
    expect(lines).toContain("box is off this host");
    expect(lines).toContain("box is no longer a place in this wsp.");
  });

  it("names the ids when two places share a name, since ids tell them apart and names are the person's", () => {
    expect(twoPlacesLine("box", ["p_1", "p_2"])).toContain("p_1, p_2");
  });
});

describe("the host's own key", () => {
  it("is made once beside the state file, at the person's own mode, and read back after", () => {
    const dir = tmp("host-key");
    const statePath = join(dir, "state.json");
    const first = hostPlaceKey(statePath);
    expect(first.publicKey).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(hostPlaceKey(statePath)).toEqual(first);
    expect(statSync(hostPlaceKeyPath(statePath)).mode & 0o777).toBe(0o600);
  });

  it("writes a fresh pair over a file that is not one, since a place that pinned the old key says so on its next dial", () => {
    const dir = tmp("host-key-bad");
    const statePath = join(dir, "state.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(hostPlaceKeyPath(statePath), "not a key");
    expect(hostPlaceKey(statePath).privateKeyPem).toContain("PRIVATE KEY");
  });
});

describe("what this computer says about itself", () => {
  it("names itself by its own name lowercased, reads its own shape, and says which line runs wsp here", async () => {
    const home = tmp("report-home");
    const report = await placeReport({ name: placeNameHere(), home, env: { PATH: "/usr/bin", HOME: home } });
    expect(report.name).toBe(report.name.toLowerCase());
    expect(report.shape.cpu).toBeGreaterThan(0);
    expect(report.login["HOME"]).toBe(home);
    expect(report.wsp.length).toBeGreaterThan(0);
    expect(["darwin", "linux"]).toContain(report.platform);
    // How long it has been up rides the report, so a row for a computer that stopped answering says what it last
    // was rather than standing at pending for a fact nothing is coming back with.
    expect(report.uptimeMs).toBeGreaterThan(0);
  });

  it("reads the PATH a login shell here gives, not the one the shell that typed the join happened to hold", async () => {
    const home = tmp("report-path");
    // A login file of the person's own, which a service's bare environment would never have read: without HOME a
    // login shell reads none of their files and answers the service's own PATH.
    writeFileSync(join(home, ".profile"), `export PATH=${home}/bin:$PATH\n`);
    // A service starts with almost no environment: what the agent reports has to be the person's own login PATH,
    // or every tool they installed under their home is unfindable to a turn.
    const report = await placeReport({ name: "x", home, env: { PATH: "/only/this", HOME: home } });
    expect(report.login["PATH"]).not.toBe("/only/this");
    expect(report.login["PATH"]).toContain(`${home}/bin`);
  });

  it("reads the login PATH once the shell answers when a login file leaves a job holding its output open, and the job ends with it", async () => {
    const home = tmp("report-held");
    const pids = join(home, "pids");
    writeFileSync(join(home, ".profile"), `sleep 300 & echo $! >> ${pids}\nexport PATH=${home}/bin:$PATH\n`);
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const pidsIn = (): number[] => (existsSync(pids) ? readFileSync(pids, "utf8").split("\n").filter(l => l !== "").map(Number) : []);
    const started = Date.now();
    try {
      const report = await placeReport({ name: "x", home, env: { PATH: "/only/this", HOME: home } });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(report.login["PATH"]).toContain(`${home}/bin`);
      expect(pidsIn().length).toBe(1);
      await vi.waitFor(() => expect(pidsIn().filter(alive)).toEqual([]));
    } finally {
      for (const pid of pidsIn()) if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  }, 30_000);

  it("reads which Mac this is off its product name, or off its model identifier where the registry names none", () => {
    expect(macKindOf("MacBook Pro (14-inch, M5)")).toBe("macbook");
    expect(macKindOf("MacBook Air (13-inch, M4)")).toBe("macbook");
    expect(macKindOf("iMac (24-inch, 2024)")).toBe("imac");
    expect(macKindOf("Mac mini (2024)")).toBe("mac-mini");
    expect(macKindOf("Mac Studio (2025)")).toBe("mac-studio");
    expect(macKindOf("Mac Pro (2023)")).toBe("mac-pro");
    expect(macKindOf("MacBookPro16,1")).toBe("macbook");
    expect(macKindOf("MacBookAir10,1")).toBe("macbook");
    expect(macKindOf("iMacPro1,1")).toBe("imac");
    expect(macKindOf("Macmini9,1")).toBe("mac-mini");
    expect(macKindOf("MacPro7,1")).toBe("mac-pro");
    // Apple silicon's identifiers since 2022 name no family, so the product name is what says it.
    expect(macKindOf("Mac17,2")).toBeUndefined();
    expect(macKindOf("")).toBeUndefined();
    const said = Buffer.from("MacBook Pro (14-inch, M5)\0").toString("base64");
    const ioreg = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<array>\n\t<dict>\n\t\t<key>compatible</key>\n\t\t<data>\n\t\tTWFjMTcsMgA=\n\t\t</data>\n\t\t<key>product-name</key>\n\t\t<data>\n\t\t${said}\n\t\t</data>\n\t</dict>\n</array>\n</plist>\n`;
    expect(productNameOf(ioreg)).toBe("MacBook Pro (14-inch, M5)");
    expect(productNameOf("<plist><array/></plist>")).toBeUndefined();
  });

  it("draws this computer's own row without starting a login shell, which the report alone reads", async () => {
    const home = tmp("report-row");
    const read = join(home, "login-read");
    writeFileSync(join(home, ".profile"), `echo read >> ${read}\n`);
    vi.stubEnv("HOME", home);
    onTestFinished(() => void vi.unstubAllEnvs());
    // Nearly every verb lists places, and a login file can take seconds: the row has no use for the login it reads.
    placeHere("x");
    expect(existsSync(read)).toBe(false);
    await placeReport({ name: "x", home, env: { PATH: "/usr/bin", HOME: home } });
    expect(readFileSync(read, "utf8")).toBe("read\n");
  });

  it("reads its disk off the volume wsp installs onto, not the one its home sits on", async ctx => {
    // Two volumes: the home on the disk the temp folder sits on, the computer's /opt on a tmpfs.
    const home = tmp("report-volume-home");
    const system = existsSync("/dev/shm") ? mkdtempSync("/dev/shm/wsp-report-volume-") : undefined;
    if (system !== undefined) dirs.push(system);
    const sizeOf = (path: string): number => {
      const fs = statfsSync(path);
      return Number(fs.blocks) * Number(fs.bsize);
    };
    if (system === undefined || sizeOf(system) === sizeOf(home)) return ctx.skip();
    // wsp's install folder is not there before its first install, so the read is the folder it would be made in.
    const report = await placeReport({ name: "x", home, env: { PATH: "/usr/bin", HOME: home }, systemRoot: system });
    expect(report.diskSizeBytes).toBe(sizeOf(system));
    mkdirSync(join(system, TOOL_PREFIX), { recursive: true });
    expect((await placeReport({ name: "x", home, env: { PATH: "/usr/bin", HOME: home }, systemRoot: system })).diskSizeBytes).toBe(sizeOf(system));
  });

  it("leaves a store folder that is not a plain path out of the login, since what is there lands in a command", async () => {
    const home = tmp("report-store");
    const report = await placeReport({ name: "x", home, env: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/tmp/a; rm -rf /" } });
    expect(report.login["CLAUDE_CONFIG_DIR"]).toBeUndefined();
  });
});
