// SPDX-License-Identifier: AGPL-3.0-only
// A turn stopped while its agent ignores SIGTERM, driven end to end: the runtime,
// the Claude adapter and a real process on this computer, with a stand-in for the
// CLI that says one more thing on the TERM and then waits for the KILL.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClaudeAdapter } from "@wsp/adapter-claude";
import { LocalBackend } from "@wsp/engine";
import { HERE_PLACE_ID } from "@wsp/protocol";
import { writeStub } from "../../protocol/test/stub-script.js";
import { createRuntime, type LocalWiring, type Runtime } from "../src/runtime.js";
import { groupExists, localExecStream } from "../src/local-exec.js";
import { memoryStore } from "../src/store.js";
import { copyingFake, createOn, stubBackend, testPlatform } from "./stub-backend.js";
import { until } from "./until.js";

const GRACE_MS = 300;
/** Slower than the grace, so no poll falls between the TERM and the KILL. */
const POLL_MS = 1_500;

/** The stand-in `claude`: says one line, writes its process group to `mark`, then works until a KILL, saying one
 * more line on the TERM. Any other call (the catalog probe, a title) answers nothing. */
function standIn(mark: string): string {
  return `#!/bin/sh
for a; do [ "$prev" = --session-id ] && sid=$a; prev=$a; done
[ -n "$sid" ] || exit 0
last() {
cat <<EOF
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_2","type":"message","role":"assistant","content":[{"type":"text","text":"Stopped with src/a.ts half written."}]},"parent_tool_use_id":null,"session_id":"$sid"}
EOF
}
trap last TERM
read -r _
cat <<EOF
{"type":"system","subtype":"init","cwd":"$PWD","session_id":"$sid","tools":["Bash"],"model":"claude-opus-5-5"}
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"Editing src/a.ts."}]},"parent_tool_use_id":null,"session_id":"$sid"}
EOF
ps -o pgid= -p $$ > '${mark}.tmp' && mv '${mark}.tmp' '${mark}'
while :; do sleep 0.05; done
`;
}

describe("a turn stopped while its agent ignores SIGTERM", () => {
  let root: string;
  let rt: Runtime | undefined;
  /** The turn's process group, which outlives the runtime: a red run leaves it waiting on a KILL that never came. */
  let group: number | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-stopgrace-"));
  });
  afterEach(async () => {
    await rt?.close();
    rt = undefined;
    if (group !== undefined && groupExists(group)) process.kill(-group, "SIGKILL");
    group = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps in its transcript the line the agent printed after the last poll, before the KILL", async () => {
    const mark = join(root, "working");
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeStub(join(bin, "claude"), standIn(mark));
    const wiring: LocalWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o, pollMs: POLL_MS }),
      home: () => join(root, ".claude"),
      homeDir: root,
      rootsPath: join(root, "roots"),
      env: () => ({ PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}` }),
      platform: testPlatform(),
      copier: copyingFake(),
    };
    rt = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: { claude: ctx => createClaudeAdapter({ exec: ctx.execStream, configDir: ctx.home("claude"), baseEnv: ctx.env, interruptGraceMs: GRACE_MS }) },
      local: wiring,
    });
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const handle = await rt.sessions.start(ws.id, { prompt: "edit src/a.ts" });
    const said = async (): Promise<string> => JSON.stringify(await rt!.sessions.history(ws.id));

    await until(() => existsSync(mark), 5_000);
    group = Number(readFileSync(mark, "utf8").trim());
    await until(async () => (await said()).includes("Editing src/a.ts."), 5_000);
    expect(await rt.sessions.interrupt(handle.id)).toEqual({ outcome: "accepted" });
    await handle.finished;
    expect(await said()).toContain("Stopped with src/a.ts half written.");
  }, 15_000);
});
