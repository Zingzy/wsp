// SPDX-License-Identifier: AGPL-3.0-only
// The tool server a guest session on this host is answered by: the daemon
// binary's own, run as the thread's scoped server with the guest's rules, where
// this computer's binary carries one; the TypeScript server where it has none.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOUD_ENV, HOST_TOKEN_ENV, HOST_URL_ENV, TURN_TOKEN_ENV } from "@wsp/protocol";
import type { GuestSession } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guestTools } from "../src/guest-tools.js";
import { writeStub } from "../../protocol/test/stub-script.js";

const LAUNCH = { [HOST_URL_ENV]: "http://127.0.0.1:9", [HOST_TOKEN_ENV]: "thread-token", [TURN_TOKEN_ENV]: "turn-1" };
const SHELL_OWN = ["PWD", "OLDPWD", "SHLVL", "_"];

describe("the tool server a guest session is answered by", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-mcp-guest-"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A binary that writes down its words, its environment and its pid, drops a line that is no message, then answers
   * each line it reads with a result carrying that line, until its input ends. */
  function binary(): string {
    return writeStub(
      join(dir, "wsp-daemon"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/argv'\n/usr/bin/env > '${dir}/env'\necho $$ > '${dir}/pid'\necho 'not a message'\nwhile IFS= read -r line; do printf '{"jsonrpc":"2.0","id":1,"result":{"heard":%s}}\\n' "$line"; done\n`,
    );
  }

  function opened(module: ReturnType<typeof guestTools>, statePath: string): { session: GuestSession; replies: unknown[]; closed: Promise<string | undefined> } {
    const replies: unknown[] = [];
    let ended: (error: string | undefined) => void = () => {};
    const closed = new Promise<string | undefined>(done => (ended = done));
    const session = module.open({ argv: ["mcp"], cwd: "/root/api", env: LAUNCH, reply: message => replies.push(message), close: error => ended(error) });
    return { session, replies, closed };
  }

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("runs the binary as the thread's scoped server with the guest's rules, on the launch pair and nothing else of this host's", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-this-hosts-own");
    vi.stubEnv(CLOUD_ENV, "1");
    vi.stubEnv("TZ", "UTC");
    const statePath = join(dir, "state.json");
    const { session, replies } = opened(guestTools(statePath, binary()), statePath);
    const asked = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    session.message(asked);
    await vi.waitFor(() => expect(replies).toEqual([{ jsonrpc: "2.0", id: 1, result: { heard: asked } }]), { timeout: 5_000 });
    expect(readFileSync(join(dir, "argv"), "utf8").trim().split("\n")).toEqual(["mcp", "--state", statePath, "--scoped", "--guest"]);
    const env = Object.fromEntries(
      readFileSync(join(dir, "env"), "utf8")
        .trim()
        .split("\n")
        .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    for (const own of SHELL_OWN) delete env[own];
    // The cloud's state and the zone are this host's, as the TypeScript server reads them off the host's own.
    expect(env).toEqual({ ...LAUNCH, [CLOUD_ENV]: "1", TZ: "UTC" });
    session.close();
  });

  it("stops the binary when the guest's session ends", async () => {
    const statePath = join(dir, "state.json");
    const { session } = opened(guestTools(statePath, binary()), statePath);
    await vi.waitFor(() => expect(existsSync(join(dir, "pid"))).toBe(true), { timeout: 5_000 });
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    expect(alive(pid)).toBe(true);
    session.close();
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5_000 });
  });

  it("ends the session with the binary's own sentence when the binary ends first", async () => {
    const refusing = writeStub(join(dir, "refusing"), "#!/bin/sh\necho 'the thread token was refused' >&2\nexit 2\n");
    const statePath = join(dir, "state.json");
    const { closed } = opened(guestTools(statePath, refusing), statePath);
    expect(await closed).toBe("the thread token was refused");
  });

  it("is the TypeScript server where this computer's binary has no tool server", async () => {
    const statePath = join(dir, "state.json");
    const { session, replies } = opened(guestTools(statePath, false), statePath);
    session.message({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "guest", version: "0" } } });
    await vi.waitFor(() => expect(replies).toHaveLength(1), { timeout: 10_000 });
    expect(replies[0]).toMatchObject({ id: 1, result: { serverInfo: { name: "wsp" } } });
    session.close();
  });
});
