// SPDX-License-Identifier: AGPL-3.0-only
// A login signed in once on a computer you own: which agents take that road,
// what runs on that computer and with which store, and what the tool's own
// status is read as afterwards. The pty is scripted here; nothing dials a box.
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { SIGN_IN_ROWS, sharedLoginOf } from "@wsp/catalog";
import { BOX_SIGN_IN_MS, placeLink, sharedAgentsOn, sharedOn, signInOnBox } from "../src/place-signin.js";
import type { RelayTerminal } from "../src/signin-relay.js";
import { fakePtyLink, type FakePty } from "./fake-pty-link.js";
import type { HostClient } from "../src/verbs.js";

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 5));

function terminal(): RelayTerminal & { text(): string } {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  const output = new PassThrough() as PassThrough & { columns?: number; rows?: number };
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  output.columns = 100;
  output.rows = 30;
  return { input, output, text: () => chunks.join("") };
}

describe("which logins live on the computer that runs the workspaces", () => {
  it("is what the catalog row declares and nothing else", () => {
    expect(sharedOn("codex")).toEqual(sharedLoginOf(SIGN_IN_ROWS.codex));
    expect(sharedOn("claude")).toBeUndefined();
    expect(sharedOn("nonsense")).toBeUndefined();
    // Read off what one computer reported it holds, in the order it named them.
    expect(sharedAgentsOn(["claude", "codex", "gemini"])).toEqual(["codex"]);
    expect(sharedAgentsOn([])).toEqual([]);
  });
});

describe("the sign-in on a computer you own", () => {
  const signIn = async (script: (link: ReturnType<typeof fakePtyLink>, pty: FakePty, line: string) => void) => {
    const link = fakePtyLink();
    link.script = (pty, line) => script(link, pty, line);
    const term = terminal();
    const answer = await signInOnBox({
      link,
      agent: "codex",
      logins: "/var/lib/wsp/logins",
      terminal: term,
      open: async () => true,
      timeoutMs: 2_000,
    });
    return { answer, link, term };
  };

  it("makes the tool's own store on that computer, runs the flow that needs no browser there, and names the store in the pty's environment", async () => {
    const { answer, link } = await signIn((l, pty, line) => {
      if (line.includes("WSP_STATUS")) {
        l.data(pty, "Logged in using ChatGPT\r\nWSP_STATUS 0\r\n");
        l.exit(pty, 0);
        return;
      }
      l.data(pty, "Open https://auth.openai.com/device and enter CODE-1234\r\n");
      l.exit(pty, 0);
    });
    // The directory above it is the daemon's; this one is the tool's own store, made before it runs.
    expect(link.ops.filter(o => o.op === "exec").map(o => o.extra["cmd"])).toEqual(["mkdir -p '/var/lib/wsp/logins/codex'"]);
    // The no-browser variant off the row, and the store named in the environment rather than quoted into the line.
    const [flow, status] = link.ptys;
    expect(flow!.created["env"]).toEqual({ CODEX_HOME: "/var/lib/wsp/logins/codex" });
    expect(flow!.writes[0]).toBe("exec codex login --device-auth || exit\r");
    // Then the tool's own status, with the same store, which is what says it landed.
    expect(status!.created["env"]).toMatchObject({ CODEX_HOME: "/var/lib/wsp/logins/codex" });
    expect(status!.writes[0]).toContain("codex login status");
    expect(answer).toEqual({ signedIn: true });
  });

  it("reads a status that says nothing of a login as not signed in, and carries what the tool said", async () => {
    const { answer } = await signIn((l, pty, line) => {
      if (line.includes("WSP_STATUS")) {
        l.data(pty, "Not logged in\r\nWSP_STATUS 1\r\n");
        l.exit(pty, 0);
        return;
      }
      l.exit(pty, 1);
    });
    expect(answer.signedIn).toBe(false);
    expect(answer.said).toBe("Not logged in");
  });

  it("refuses an agent whose login sits in the image instead", async () => {
    await expect(
      signInOnBox({ link: fakePtyLink(), agent: "claude", logins: "/var/lib/wsp/logins", terminal: terminal(), open: async () => true }),
    ).rejects.toThrow(/no login that lives on the computer/);
    expect(BOX_SIGN_IN_MS).toBeGreaterThan(60_000);
  });
});

describe("the pty road to a computer you own", () => {
  /** A host client whose daemon channel is scripted: frames are recorded and the events it pushes are this test's. */
  function client(): HostClient & { sent: { op: string; params: Record<string, unknown> }[]; push(frame: Record<string, unknown>): void } {
    const frames = new Set<(f: Record<string, unknown>) => void>();
    const sent: { op: string; params: Record<string, unknown> }[] = [];
    return {
      sent,
      push: frame => {
        for (const read of frames) read(frame);
      },
      request: async (op, params = {}) => {
        sent.push({ op, params });
        if (op === "daemon.open") return { channel: "ch1" } as never;
        if (op === "daemon.send") return { reply: { ok: true, ptyId: "pty_1" } } as never;
        return {} as never;
      },
      events: async () => undefined,
      onFrame: fn => {
        frames.add(fn);
        return () => frames.delete(fn);
      },
      closed: new Promise<void>(() => undefined),
      closeWords: () => "",
      close: () => undefined,
      terminate: () => undefined,
    };
  }

  it("opens one channel to that computer's daemon, sends the pty's frames on it and hands back only its own events", async () => {
    const c = client();
    const road = await placeLink(c, "p1");
    expect(c.sent).toEqual([{ op: "daemon.open", params: { placeId: "p1" } }]);
    const seen: Record<string, unknown>[] = [];
    road.link.onEvent(e => seen.push(e));
    expect(await road.link.op("pty.create", { cols: 80, rows: 24 })).toEqual({ ok: true, ptyId: "pty_1" });
    expect(c.sent.at(-1)).toEqual({ op: "daemon.send", params: { channel: "ch1", frame: { op: "pty.create", cols: 80, rows: 24 } } });
    // Another road's channel on the same socket is not this link's to read.
    c.push({ type: "daemon.event", channel: "ch2", event: { type: "pty.data", data: "not mine" } });
    c.push({ type: "daemon.event", channel: "ch1", event: { type: "pty.data", data: "mine" } });
    expect(seen).toEqual([{ type: "pty.data", data: "mine" }]);
    // The link going away under it settles closed, which is what a relay waiting on a pty ends on.
    let ended = false;
    void road.link.closed?.then(() => (ended = true));
    c.push({ type: "daemon.closed", channel: "ch1", code: 1006, reason: "the computer went" });
    await tick();
    expect(ended).toBe(true);
    await road.close();
    expect(c.sent.at(-1)).toEqual({ op: "daemon.close", params: { channel: "ch1" } });
  });
});
