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
import { homeShortened, localFolderRefusal, localWorktreeRefusal, threadDeletedLine, AGENTS_ON, type AgentRow, childStartedLine, type ProjectView, type DaemonErrorCode, noProjectImageLine, projectImageInUseRefusal, projectImageRemoveNotice, projectImageRemovedLine, napRefusedLine, HERE_PLACE_ID, LIST_PRICE_WORD, goneRoadRefusal, notAnsweringYet, runForTheList, askingLine, needsYouLine, QUESTION_TOOL, permissionModeOptionLabel, PERMISSION_DENY, type PermissionAsk, DEFAULT_PREFERENCES, PERMISSION_ALLOW, effortsFor, HOST_KEY_ENV, HOST_TOKEN_ENV, HOST_URL_ENV, noWorkspaceRefusal, EMPTY_MESSAGE_LINE, EXIT_CODES, IMAGE_NO_VAULT, IMAGE_PASSPHRASE_ENV, IMAGE_PASSPHRASE_MIN, HOST_STOPPING_LINE, UP_RESTART_LINE, markedDefault, NO_SUCH_TURN, noReplyLine, noThreadTargetLine, notifyLine, RuntimeRequest, threadStateWord, placeBuildsNoImageLine, registeredLine, REGISTERING_LINE, registerTakesNoConsentLine, signInRefusalLine, threadForgetRefusal, threadOpenedLine, threadWithoutIdRefusal, ThreadView, TURN_TOKEN_ENV, unknownAgentLine, workspaceAsleepAgainLine, thisComputer, type WorkspaceOut, WorkspaceView, forgetUndrivenRefusal, THIS_COMPUTER, noSuchPlaceRefusal, type PlaceView, localRunsOneFix, localRunsOneLine, MEMORY_KEPT_CLAUSE, type HarnessCatalogAnswer, noFastLine, shellLine, NOT_DELIVERED_LINE, BUILT_IN_LIST_CLAUSE, BUILT_IN_TABLE_CLAUSE } from "@wsp/protocol";
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
  });
});

describe("wsp ssh with no host serving its state", () => {
  it.runIf(CLOUD_ON)("refuses in one line and starts no host, so no second lock appears for a state no host serves", async () => {
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
