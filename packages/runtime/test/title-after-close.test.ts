// SPDX-License-Identifier: AGPL-3.0-only
// What the host asks an agent's own CLI on its own, the catalog probe and the
// title question a thread's first turn starts, runs after the turn and by the
// word on the PATH. A close that let it go on had it run after the host let the
// machine go, and in a test, once the teardown took the case's stub away, run
// whatever `claude` came next on that PATH: the person's own, billed, writing
// ~/.claude.json into the run's home. So a close waits for each ask still
// going, and once closing the host starts none: no question, and no probe of a
// catalog past its time.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@wsp/engine";
import { HERE_PLACE_ID, type TurnResult } from "@wsp/protocol";
import { HARNESS_ADAPTERS } from "../src/adapters.js";
import type { Clock } from "../src/clock.js";
import { localExecStream } from "../src/local-exec.js";
import { createRuntime, type HarnessAdapterFactory, type Runtime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { CATALOG_TTL_MS } from "../src/types/events.js";
import { fakeClock } from "./fake-clock.js";
import { copyingFake, createOn, stubBackend, testPlatform } from "./stub-backend.js";
import { until } from "./until.js";
import { writeStub } from "../../protocol/test/stub-script.js";

const SESSION = "55555555-5555-4555-8555-555555555555";

/** Where the store read the title road starts with stops until the case opens it, so the close can come first:
 * `read` is the store read itself, `reached` says it was asked. */
interface Gate {
  read: () => Promise<null>;
  reached: Promise<void>;
  open: () => void;
}
function gate(): Gate {
  let reach = (): void => {};
  let open = (): void => {};
  const reached = new Promise<void>(r => (reach = r));
  const opened = new Promise<void>(r => (open = r));
  return { read: () => (reach(), opened.then(() => null)), reached, open: () => open() };
}

/** The shipped Claude Code adapter with a scripted turn, so the turn is over at once and the asks the host makes on its
 * own, which are the adapter's, are all that is left running; with a gate, its store read waits on it. */
const scriptedTurn =
  (held?: Gate): HarnessAdapterFactory =>
  ctx => ({
    ...HARNESS_ADAPTERS.claude(ctx),
    start: ({ onEvent }) => {
      const result: TurnResult = { status: "completed", text: "ok" };
      const finished = (async () => {
        onEvent({ type: "session.start", sessionId: SESSION });
        onEvent({ type: "turn.done", sessionId: SESSION, result });
        onEvent({ type: "session.end", sessionId: SESSION, exitCode: 0, sawResult: true });
        return result;
      })();
      return { localId: SESSION, finished, interrupt: async () => {} };
    },
    ...(held !== undefined ? { sessionTitle: held.read } : {}),
  });

describe("a runtime that closes while it is asking an agent's CLI on its own", () => {
  let root: string;
  let bin: string;
  /** Every call the case's own claude took, its arguments one line each, with the case's own marks between. */
  let calls: string;
  const runtimes: Runtime[] = [];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-title-close-"));
    bin = join(root, "bin");
    calls = join(root, "calls");
    mkdirSync(bin);
    writeFileSync(calls, "");
    // The question writes when it is asked and when it answers, and the probe's version answer when it is done, each
    // after its pause; nothing reads stdin, which the shell launching it holds open.
    writeStub(
      join(bin, "claude"),
      [
        "#!/bin/sh",
        `echo "$*" >> ${JSON.stringify(calls)}`,
        `case "$*" in *--safe-mode*) echo asked > ${JSON.stringify(join(root, "asked"))}; sleep "\${STUB_ANSWER_S:-0}"; echo answered > ${JSON.stringify(join(root, "answered"))}; printf '%s' '{"type":"result","is_error":false,"result":"Reading the reconnect path"}';; --version) sleep "\${STUB_PROBE_S:-0}"; echo probed >> ${JSON.stringify(calls)}; echo "2.1.292 (Claude Code)";; esac`,
        "exit 0",
        "",
      ].join("\n"),
    );
  });
  afterEach(async () => {
    for (const rt of runtimes.splice(0)) await rt.close();
    rmSync(root, { recursive: true, force: true });
  });

  const here = async (o: { held?: Gate; clock?: Clock; answerS?: number; probeS?: number; path?: string } = {}) => {
    const rt = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: { claude: scriptedTurn(o.held) },
      ...(o.clock !== undefined ? { clock: o.clock } : {}),
      local: {
        backend: new LocalBackend({ root }),
        execStream: x => localExecStream({ root, runDir: join(root, "runs"), ...x }),
        home: () => join(root, ".claude"),
        homeDir: root,
        rootsPath: join(root, "roots"),
        env: () => ({ PATH: o.path ?? `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`, STUB_ANSWER_S: String(o.answerS ?? 0), STUB_PROBE_S: String(o.probeS ?? 0) }),
        platform: testPlatform(),
        copier: copyingFake(),
      },
    });
    runtimes.push(rt);
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    await (await rt.sessions.start(ws.id, { prompt: "read the daemon's reconnect path" })).finished;
    return rt;
  };
  const said = (): string[] => readFileSync(calls, "utf8").split("\n").filter(l => l !== "");

  it("waits for a question already asked, so its close is back only once the answer is in", async () => {
    const rt = await here({ answerS: 0.7 });
    await until(() => existsSync(join(root, "asked")), 10_000);
    await rt.close();
    expect(existsSync(join(root, "answered"))).toBe(true);
  }, 20_000);

  it("waits for a probe of a catalog past its time already going, so its close is back only once the probe is done", async () => {
    const held = gate();
    const { clock, advance } = fakeClock();
    const rt = await here({ held, clock, probeS: 0.7 });
    await held.reached;
    advance(CATALOG_TTL_MS + 1);
    held.open();
    await until(() => said().filter(l => l === "--version").length === 2, 10_000);
    await rt.close();
    expect(said().filter(l => l === "probed")).toHaveLength(2);
  }, 20_000);

  it("asks no question once it is closing", async () => {
    const held = gate();
    const rt = await here({ held });
    await held.reached;
    const closed = rt.close();
    held.open();
    await closed;
    expect(said().filter(l => l.includes("--safe-mode"))).toEqual([]);
  }, 20_000);

  it("asks no probe of a catalog past its time once it is closing, and the held lists answer", async () => {
    const held = gate();
    const { clock, advance } = fakeClock();
    const rt = await here({ held, clock });
    await held.reached;
    advance(CATALOG_TTL_MS + 1);
    writeFileSync(calls, "closing\n", { flag: "a" });
    const closed = rt.close();
    held.open();
    await closed;
    // A probe set going past the snapshot the close waited on has its time to run.
    await new Promise(r => setTimeout(r, 1_000));
    expect(said().slice(said().indexOf("closing") + 1).filter(l => l.includes("--version"))).toEqual([]);
  }, 20_000);

  it("leaves nothing to run the person's own claude when the case's stub goes the moment its close is back", async () => {
    // The person's own claude next on the PATH, as the real one leaves its state in the home it runs under.
    const theirs = join(root, "their-bin");
    const ran = join(root, "ran-theirs");
    mkdirSync(theirs);
    writeStub(join(theirs, "claude"), `#!/bin/sh\necho "$*" >> ${JSON.stringify(ran)}\necho '{}' > "$HOME/.claude.json"\nexit 1\n`);
    writeFileSync(ran, "");
    const rt = await here({ path: `${bin}:${theirs}:${process.env["PATH"] ?? "/usr/bin:/bin"}` });
    await rt.close();
    rmSync(bin, { recursive: true, force: true });
    // What a close let go on has its time to reach the PATH.
    await new Promise(r => setTimeout(r, 1_500));
    expect(readFileSync(ran, "utf8")).toBe("");
    expect(said().filter(l => l.includes("--safe-mode"))).toEqual([]);
  }, 20_000);
});
