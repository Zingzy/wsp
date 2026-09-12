// SPDX-License-Identifier: AGPL-3.0-only
// The exec op, which is the whole of what a host driving a place needs: every
// script the runtime already sends a machine rides one of these.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { EXEC_DEADLINE_EXIT, NOT_ON_THIS_ROAD } from "@wsp/protocol";
import { runExec } from "../src/exec.js";
import { daemonUnderTest, type DaemonUnderTest } from "./harness.js";

const TOKEN = "exec-token";
const root = mkdtempSync(join(tmpdir(), "wsp-exec-root-"));
const inboxDir = mkdtempSync(join(tmpdir(), "wsp-exec-inbox-"));
let handle: DaemonUnderTest | undefined;

afterAll(async () => {
  await handle?.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(inboxDir, { recursive: true, force: true });
});

interface Frame {
  id?: number | null;
  ok?: boolean;
  [k: string]: unknown;
}

async function connect(port: number, auth: Record<string, unknown>): Promise<{ request: (op: string, params?: Record<string, unknown>) => Promise<Frame>; close: () => void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const pending = new Map<number, (f: Frame) => void>();
  let next = 1;
  ws.on("message", raw => {
    const f = JSON.parse(String(raw)) as Frame;
    if (typeof f.id === "number" && pending.has(f.id)) {
      pending.get(f.id)!(f);
      pending.delete(f.id);
    }
  });
  const request = (op: string, params: Record<string, unknown> = {}): Promise<Frame> => {
    const id = next++;
    return new Promise(resolve => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, op, ...params }));
    });
  };
  ws.send(JSON.stringify({ id: 0, op: "auth", token: TOKEN, ...auth }));
  return { request, close: () => ws.close() };
}

describe("one command on this machine", () => {
  it("runs under bash in the daemon's root with its environment, and answers both streams and the code", async () => {
    // HOME is in the environment because every caller's is: the daemon hands its own, and a bash 3.2 given none
    // reads the passwd home's .bashrc and prints whatever that file says on stderr (measured on macOS).
    const res = await runExec(root, { HOME: root, WSP_TEST_WORD: "kept" }, 'pwd; printf "%s\\n" "$WSP_TEST_WORD"; echo bad >&2; exit 3', { timeoutMs: 5_000 });
    expect(res.exitCode).toBe(3);
    expect(res.stdout).toContain("kept");
    expect(res.stderr.trim()).toBe("bad");
    expect(res.truncated).toBe(false);
    // The root, not the process's cwd: a place's daemon is rooted at the person's home.
    expect(res.stdout.split("\n")[0]).toContain(root.split("/").at(-1)!);
  });

  it("kills the whole process group at the deadline and answers 124 with nothing said after the kill", async () => {
    const pidFile = join(root, "child.pid");
    const res = await runExec(root, process.env, `(sleep 30 & echo $! > ${pidFile}); sleep 5; echo late`, { timeoutMs: 300 });
    expect(res.exitCode).toBe(EXEC_DEADLINE_EXIT);
    expect(res.stdout).not.toContain("late");
    // The child the script started is gone with the group, not left behind for the life of the machine.
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await new Promise(done => setTimeout(done, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("lands the bytes a caller sends on stdin", async () => {
    const target = join(root, "landed.txt");
    const res = await runExec(root, process.env, `cat > ${target}`, { timeoutMs: 5_000, stdin: Buffer.from("bytes on the wire\n") });
    expect(res.exitCode).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("bytes on the wire\n");
  });

  it("closes stdin when the caller sends none, so a command that reads it is not left waiting", async () => {
    const res = await runExec(root, process.env, "cat; echo done", { timeoutMs: 3_000 });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("done");
  });

  it("cuts the output at the cap and says it did", async () => {
    const res = await runExec(root, process.env, "printf 'x%.0s' $(seq 1 5000)", { timeoutMs: 5_000, outputMax: 100 });
    expect(res.truncated).toBe(true);
    expect(res.stdout.length + res.stderr.length).toBeLessThanOrEqual(100);
  });
});

describe("the exec op over the wire", () => {
  it("answers a command on an authed socket", async () => {
    handle ??= await daemonUnderTest({ host: "127.0.0.1", port: 0, token: TOKEN, kind: "place", root, inbox: inboxDir, rootsPath: join(root, "roots") });
    const client = await connect(handle.port, {});
    try {
      const res = await client.request("exec", { cmd: "echo hello", timeoutMs: 5_000 });
      expect(res).toMatchObject({ ok: true, exitCode: 0, truncated: false });
      expect(String(res["stdout"])).toContain("hello");
    } finally {
      client.close();
    }
  });

  it("is refused on a socket scoped to one guest port, like every op but tunnel and ping", async () => {
    handle ??= await daemonUnderTest({ host: "127.0.0.1", port: 0, token: TOKEN, kind: "place", root, inbox: inboxDir, rootsPath: join(root, "roots") });
    const client = await connect(handle.port, { port: 8123 });
    try {
      const res = await client.request("exec", { cmd: "echo hello" });
      expect(res.ok).toBe(false);
      expect(res["code"]).toBe("forbidden");
    } finally {
      client.close();
    }
  });

  it("refuses place.leave on an inbound socket: only the link this computer opened may take it out of a wsp", async () => {
    handle ??= await daemonUnderTest({ host: "127.0.0.1", port: 0, token: TOKEN, kind: "place", root, inbox: inboxDir, rootsPath: join(root, "roots") });
    const client = await connect(handle.port, {});
    try {
      const res = await client.request("place.leave");
      expect(res.ok).toBe(false);
      expect(res["code"]).toBe("forbidden");
      // One sentence for one rule: the leave op and the machine ops are the link's, and no other socket takes them.
      expect(res["error"]).toBe(NOT_ON_THIS_ROAD);
    } finally {
      client.close();
    }
  });

  it("refuses a frame whose cmd is not a string, and one whose timeout is not a positive integer", async () => {
    handle ??= await daemonUnderTest({ host: "127.0.0.1", port: 0, token: TOKEN, kind: "place", root, inbox: inboxDir, rootsPath: join(root, "roots") });
    const client = await connect(handle.port, {});
    try {
      expect((await client.request("exec", { cmd: 3 })).ok).toBe(false);
      expect((await client.request("exec", { cmd: "echo x", timeoutMs: -1 })).ok).toBe(false);
      expect((await client.request("exec", { cmd: "echo x", stdin: 3 })).ok).toBe(false);
    } finally {
      client.close();
    }
  });
});

describe("the byte road the runtime already writes with", () => {
  it("carries a file's bytes under the same script the ssh road uses, and a short count leaves the target alone", async () => {
    const target = join(root, "over-the-wire.bin");
    const bytes = Buffer.from("a token, as it happens\n");
    // The one script both roads write with, spelled here rather than imported: the daemon package does not reach
    // the engine, and what this proves is that the op carries the bytes the script expects on stdin.
    const tmp = `${target}.in`;
    const script = ["set -e", "umask 077", `cat > ${tmp}`, `[ "$(wc -c < ${tmp} | tr -d ' ')" = ${bytes.length} ] || { rm -f ${tmp}; echo WSP_BYTES_SHORT; exit 1; }`, `mv -f ${tmp} ${target}`, "echo WSP_BYTES_OK"].join("\n");
    const ok = await runExec(root, process.env, script, { timeoutMs: 5_000, stdin: bytes });
    expect(ok.stdout).toContain("WSP_BYTES_OK");
    expect(readFileSync(target, "utf8")).toBe(bytes.toString());

    writeFileSync(target, "the old one\n");
    const short = await runExec(root, process.env, script.replace(`= ${bytes.length}`, `= ${bytes.length + 1}`), { timeoutMs: 5_000, stdin: bytes });
    expect(short.stdout).toContain("WSP_BYTES_SHORT");
    expect(readFileSync(target, "utf8")).toBe("the old one\n");
    expect(existsSync(tmp)).toBe(false);
  });
});
