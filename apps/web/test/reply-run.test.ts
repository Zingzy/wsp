// SPDX-License-Identifier: AGPL-3.0-only
// A reply's shell block run in a pty of its own on a real daemon: the command
// runs and exits with its code, the person's keys reach it (a password read with
// the terminal's echo off included), a reply's pty is never adopted as a tab
// until it is moved to one, and a full-screen program says so.
import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { terminalText } from "@wsp/protocol";
import { WorkspaceTerminals, type TerminalWire } from "../src/terminal/link.js";
import { boot, teardown } from "./terminal-harness.js";

afterEach(async () => {
  await teardown();
});

describe("a reply's block run in its own pty", () => {
  it("runs the command, exits with its code, keeps its output, and is no tab", async () => {
    const { wt, ptys } = await boot();
    const ptyId = await wt.run({ command: "printf 'hi\\n'; exit 3", shell: "/bin/sh" });
    expect(await wt.runExit(ptyId)).toMatchObject({ code: 3 });
    expect(terminalText(wt.mirrorText(ptyId))).toBe("hi");
    expect(wt.tabs()).toEqual([]);
    expect((await ptys()).find(p => p.id === ptyId)).toMatchObject({ reply: true, exited: true });
    await wt.forgetRun(ptyId);
    expect((await ptys()).find(p => p.id === ptyId)).toBeUndefined();
  });

  it("takes the person's keys while it runs, a password read with echo off included", async () => {
    const { wt } = await boot();
    const ptyId = await wt.run({ command: "/bin/stty -echo; printf 'Password: '; read pw; /bin/stty echo; printf '\\ngot %s\\n' \"$pw\"", shell: "/bin/sh" });
    await waitFor(() => expect(wt.mirrorText(ptyId)).toContain("Password: "));
    wt.io(ptyId).write("hunter2\r");
    expect(await wt.runExit(ptyId)).toMatchObject({ code: 0 });
    const text = terminalText(wt.mirrorText(ptyId));
    expect(text).toContain("got hunter2");
    expect(text).not.toContain("Password: hunter2");
  });

  it("moved to a terminal tab, it keeps running there and every pane may adopt it", async () => {
    const { wt, ptys } = await boot();
    const ptyId = await wt.run({ command: "printf 'serving\\n'; sleep 30", shell: "/bin/sh" });
    await waitFor(() => expect(wt.mirrorText(ptyId)).toContain("serving"));
    await wt.moveToTab(ptyId);
    expect(wt.tabs().map(t => t.ptyId)).toEqual([ptyId]);
    expect(wt.activeId()).toBe(ptyId);
    const listed = (await ptys()).find(p => p.id === ptyId)!;
    expect(listed.reply).toBeUndefined();
    expect(listed.exited).toBe(false);
    await wt.close(ptyId);
  });

  it("says when the program takes the whole screen, so the block can hand it to a tab", async () => {
    const { wt } = await boot();
    const ptyId = await wt.run({ command: "printf '\\033[?1049h'; sleep 30", shell: "/bin/sh" });
    let full = false;
    wt.onAltScreen(ptyId, () => (full = true));
    await waitFor(() => expect(full).toBe(true));
    await wt.forgetRun(ptyId);
  });
});

describe("a pane coming live on a daemon holding a reply's pty", () => {
  it("adopts every pty but a reply's", async () => {
    const asked: string[] = [];
    const wire: TerminalWire = {
      request: async op => {
        asked.push(op);
        if (op === "pty.list") return { ptys: [{ id: "pty_1", pid: 1, cols: 80, rows: 24, exited: false }, { id: "pty_2", pid: 2, cols: 80, rows: 24, exited: false, reply: true }] };
        return { ok: true };
      },
    };
    const wt = new WorkspaceTerminals(wire);
    wt.feedStatus("live");
    await waitFor(() => expect(wt.status()).toBe("live"));
    expect(wt.tabs().map(t => t.ptyId)).toEqual(["pty_1"]);
    // A reload finds its run again by the record, and takes that pty back without making it a tab.
    expect(await wt.resumeRun("pty_2")).toBe(true);
    expect(wt.tabs().map(t => t.ptyId)).toEqual(["pty_1"]);
    expect(asked.filter(op => op === "pty.attach")).toHaveLength(2);
  });
});

describe("a full-screen switch", () => {
  it("is heard when the daemon's frames split its sequence in two", async () => {
    const wire: TerminalWire = { request: async op => (op === "pty.create" ? { ptyId: "pty_9" } : { ok: true }) };
    const wt = new WorkspaceTerminals(wire);
    const ptyId = await wt.run({ command: "vim" });
    let full = false;
    wt.onAltScreen(ptyId, () => (full = true));
    wt.feedEvent({ type: "pty.data", ptyId, data: "loading\x1b[?10" });
    expect(full).toBe(false);
    wt.feedEvent({ type: "pty.data", ptyId, data: "49h\x1b[H" });
    expect(full).toBe(true);
  });
});
