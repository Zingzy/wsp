// SPDX-License-Identifier: AGPL-3.0-only
// The computer itself as a machine: the frames it sends over the link its
// daemon holds, and the calls that belong to a workspace and are refused here.
import { describe, expect, it } from "vitest";
import { EXEC_TIMEOUT_MAX_MS, placeProvisionPaths } from "@wsp/protocol";
import { INLINE_EXEC_MS } from "../src/exec-detached.js";
import { LINK_MARGIN_MS } from "../src/link-backend.js";
import { NOT_A_WORKSPACE, PlaceMachine } from "../src/place-machine.js";

const HOME = "/root";

/** The link a computer holds, answering the exec frame the way its daemon does: the launch and the polls of a
 * detached run, and exit 0 for everything else. */
function link(answer: (cmd: string) => { exitCode: number; stdout: string; stderr: string } | undefined = () => undefined) {
  const frames: { op: string; params: Record<string, unknown>; opts: Record<string, unknown> }[] = [];
  return {
    frames,
    request: async (op: string, params: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) => {
      frames.push({ op, params, opts });
      const cmd = String(params["cmd"] ?? "");
      const said = answer(cmd);
      if (said !== undefined) return { ...said, truncated: false };
      if (cmd.includes("echo WSP_LAUNCHED")) return { exitCode: 0, stdout: "WSP_LAUNCHED\n", stderr: "", truncated: false };
      if (cmd.includes("echo WSP_POLL")) return { exitCode: 0, stdout: "WSP_POLL\n0\n\n\ndown\nWSP_POLL_END\n", stderr: "", truncated: false };
      return { exitCode: 0, stdout: "", stderr: "", truncated: false };
    },
  };
}

const machineOn = (l: ReturnType<typeof link>): PlaceMachine => new PlaceMachine(l, { id: "spoo", home: HOME });

describe("a command on the computer itself", () => {
  it("rides the daemon's own exec frame, with the wait it asked for and the margin the link takes on top", async () => {
    const l = link(cmd => (cmd === "echo hi" ? { exitCode: 3, stdout: "hi\n", stderr: "oops\n" } : undefined));
    const res = await machineOn(l).exec("echo hi");
    expect(res).toEqual({ exitCode: 3, stdout: "hi\n", stderr: "oops\n" });
    expect(l.frames).toEqual([{ op: "exec", params: { cmd: "echo hi", timeoutMs: INLINE_EXEC_MS }, opts: { timeoutMs: INLINE_EXEC_MS + LINK_MARGIN_MS } }]);
  });

  it("holds the wait under the cap the daemon holds its own timer to, and carries a key the caller said may be asked twice", async () => {
    const l = link();
    await machineOn(l).exec("sleep 1", { timeoutMs: EXEC_TIMEOUT_MAX_MS * 2, idempotencyKey: "upload/1" });
    expect(l.frames[0]!.params["timeoutMs"]).toBe(EXEC_TIMEOUT_MAX_MS);
    expect(l.frames[0]!.opts).toEqual({ timeoutMs: EXEC_TIMEOUT_MAX_MS + LINK_MARGIN_MS, idempotencyKey: "upload/1" });
  });

  it("carries the bytes a caller gave it for the command's own stdin on the frame, as base64, and nothing of them in the command", async () => {
    const l = link();
    const stdin = Buffer.from([0, 1, 2, 250, 251]);
    await machineOn(l).exec("cat > /root/x", { stdin });
    expect(l.frames).toEqual([{ op: "exec", params: { cmd: "cat > /root/x", timeoutMs: INLINE_EXEC_MS, stdin: stdin.toString("base64") }, opts: { timeoutMs: INLINE_EXEC_MS + LINK_MARGIN_MS } }]);
  });
});

describe("a step that may run for minutes", () => {
  it("is launched under wsp's own folder on that computer, not one every login there shares", async () => {
    const l = link();
    const res = await machineOn(l).run("apt-get install -y -qq jq", { deadlineMs: 60_000, pollMs: 1 });
    expect(res.exitCode).toBe(0);
    const launch = l.frames.find(f => String(f.params["cmd"]).includes("echo WSP_LAUNCHED"))!;
    expect(String(launch.params["cmd"])).toContain(`b=${placeProvisionPaths(HOME).runDir}/`);
    expect(placeProvisionPaths(HOME).runDir).toBe("/root/.wsp/provision/run");
  });
});

describe("bytes onto the computer itself", () => {
  it("land as base64 beside the file, decoded in place by the same exec, with nothing of the write left behind", async () => {
    const l = link();
    await machineOn(l).putBytes("/etc/wsp/machine-context.md", Buffer.from("what this computer is\n"));
    const cmd = String(l.frames.at(-1)!.params["cmd"]);
    // The text the exec lands is the file's own base64, so what the shell writes is plain text however the bytes
    // read, and the line after it decodes that text into the file and takes the text away again.
    const landed = /printf %s '([A-Za-z0-9+/=]*)' \| base64 -d > '\/etc\/wsp\/machine-context\.md\.b64'/.exec(cmd);
    expect(landed).not.toBeNull();
    expect(Buffer.from(Buffer.from(landed![1]!, "base64").toString("utf8"), "base64").toString("utf8")).toBe("what this computer is\n");
    expect(cmd).toContain("base64 -d < '/etc/wsp/machine-context.md'.b64 > '/etc/wsp/machine-context.md' && rm -f '/etc/wsp/machine-context.md'.b64");
  });

  it("answers the pieces the base64 was cut into, each an exec frame of its own over the link", async () => {
    const piecewise = (cmd: string): { exitCode: number; stdout: string; stderr: string } | undefined =>
      cmd.endsWith("echo WSP_PIECE") ? { exitCode: 0, stdout: "WSP_PIECE\n", stderr: "" } : undefined;
    const one = link(piecewise);
    expect(await machineOn(one).putBytes("/etc/wsp/machine-context.md", Buffer.from("what this computer is\n"))).toEqual({ pieces: 0 });
    const many = link(piecewise);
    const big = await machineOn(many).putBytes("/etc/wsp/big", Buffer.alloc(64 * 1024, 7));
    expect(big.pieces).toBe(many.frames.filter(f => String(f.params["cmd"]).endsWith("echo WSP_PIECE")).length);
    expect(big.pieces).toBeGreaterThan(1);
  });
});

describe("the calls that belong to a workspace", () => {
  it("are refused in one sentence rather than sent as a frame nothing on the far side takes", async () => {
    const l = link();
    const machine = machineOn(l);
    for (const call of [machine.snapshot(), machine.pause(), machine.resume(), machine.kill(), machine.downloadUrl(), machine.uploadUrl()]) {
      await expect(call).rejects.toThrow(NOT_A_WORKSPACE);
    }
    expect(l.frames).toEqual([]);
    // It is the computer, so it is running: nothing is asked and nothing waits on an answer.
    expect(await machine.state()).toBe("running");
    expect(l.frames).toEqual([]);
  });
});
