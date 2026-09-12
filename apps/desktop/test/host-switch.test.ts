// SPDX-License-Identifier: AGPL-3.0-only
// The window moves between hosts: the session it holds changes, the origin
// gate every bridge call reads follows it, the app's own host is left running,
// and the hosts file the command line reads is the one list.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listHosts, readHost, writeHost, type HostRecord } from "@wsp/host";
import { HOST_WORDS, hostsMenuItems } from "@wsp/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSession } from "../src/host-lifecycle.js";
import { hostSwitcher, parseConnectAsk, type SwitcherDeps } from "../src/host-switch.js";
import { fromAppPage } from "../src/origin.js";
import type { SshRoad } from "../src/ssh-road.js";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-switch-"));
  dirs.push(dir);
  return dir;
}

function local(): HostSession & { closes: number } {
  const session = {
    url: "http://127.0.0.1:41000",
    port: 41000,
    owned: true,
    remote: false,
    label: "This Mac",
    closes: 0,
    close: async () => {
      session.closes += 1;
    },
  };
  return session;
}

const record = (url: string, over: Partial<HostRecord> = {}): HostRecord => ({ url, deviceId: "d_1", deviceToken: "tok-1", pairedAt: "2026-09-11T10:00:00.000Z", ...over });

type Deps = Omit<SwitcherDeps, "local"> & { local: ReturnType<typeof local>; loaded: HostSession[] };

function deps(over: Partial<Omit<SwitcherDeps, "local">> = {}): Deps {
  const loaded: HostSession[] = [];
  return {
    local: local(),
    home: home(),
    statePath: "/nowhere/state.json",
    here: "This Mac",
    load: async session => {
      loaded.push(session);
    },
    log: () => {},
    loaded,
    ...over,
  };
}

describe("hostSwitcher", () => {
  it("starts on this computer, and the view lists every saved host with none marked", () => {
    const d = deps();
    writeHost(d.home, "box", record("http://127.0.0.1:14400", { label: "127.0.0.1:14400", road: "direct" }));
    const switcher = hostSwitcher(d);
    expect(switcher.current()).toBe(d.local);
    expect(switcher.view()).toEqual({ here: "This Mac", current: null, hosts: [{ alias: "box", label: "127.0.0.1:14400", url: "http://127.0.0.1:14400", road: "direct" }] });
    expect(switcher.token()).toBeUndefined();
  });

  it("says what this computer is to another wsp, so the menu built off the view grows the leave and the awake rows", () => {
    const d = deps({ place: () => ({ hostName: "zingzy-mbp", awake: true }) });
    const view = hostSwitcher(d).view();
    expect(view.place).toEqual({ hostName: "zingzy-mbp", awake: true });
    expect(hostsMenuItems(view).map(row => row.label)).toContain(HOST_WORDS.place.leaveRow("zingzy-mbp"));
    // A Mac that joined nothing carries no such key at all, so the rows are never drawn for it.
    expect(hostSwitcher(deps()).view().place).toBeUndefined();
  });

  it("the page of the host here is answered that host's own token, read beside the state it serves", () => {
    const dir = home();
    writeFileSync(join(dir, "host-token"), "host-tok\n");
    const switcher = hostSwitcher(deps({ statePath: join(dir, "state.json") }));
    expect(switcher.token()).toBe("host-tok");
  });

  it("on a host somewhere else the answer is that host's device token, and this computer's own comes back on return", async () => {
    const dir = home();
    writeFileSync(join(dir, "host-token"), "host-tok\n");
    const d = deps({ statePath: join(dir, "state.json") });
    writeHost(d.home, "box", record("http://127.0.0.1:14400"));
    const switcher = hostSwitcher(d);
    expect(await switcher.to("box")).toEqual({ ok: true });
    expect(switcher.token()).toBe("tok-1");
    expect(await switcher.to(null)).toEqual({ ok: true });
    expect(switcher.token()).toBe("host-tok");
  });

  it("switching reassigns the session, the origin gate follows it, and the app's own host keeps running", async () => {
    const d = deps();
    writeHost(d.home, "box", record("http://127.0.0.1:14400"));
    const switcher = hostSwitcher(d);
    // The gate every bridge call reads is the origin of the host the window is on, read at call time.
    const gate = (frame: string): boolean => fromAppPage(frame, switcher.current().url);
    expect(gate("http://127.0.0.1:41000/")).toBe(true);
    expect(await switcher.to("box")).toEqual({ ok: true });
    expect(switcher.current()).toMatchObject({ url: "http://127.0.0.1:14400", remote: true, alias: "box", label: "box", deviceToken: "tok-1" });
    expect(switcher.token()).toBe("tok-1");
    expect(gate("http://127.0.0.1:14400/workspaces/w1")).toBe(true);
    expect(gate("http://127.0.0.1:41000/")).toBe(false);
    expect(switcher.view().current).toBe("box");
    expect(d.loaded.map(s => s.url)).toEqual(["http://127.0.0.1:14400"]);
    expect(await switcher.to(null)).toEqual({ ok: true });
    expect(switcher.current()).toBe(d.local);
    expect(gate("http://127.0.0.1:41000/")).toBe(true);
    expect(d.local.closes).toBe(0);
  });

  it("a switch to a host this computer never paired with is refused in one sentence and moves nothing", async () => {
    const d = deps();
    const switcher = hostSwitcher(d);
    const answer = await switcher.to("attic");
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.error).toMatch(/no host named attic/);
    expect(switcher.current()).toBe(d.local);
    expect(d.loaded).toEqual([]);
  });

  it("connecting by address runs the same road wsp connect does, labels the record, and opens the window on it", async () => {
    const d = deps();
    const connect = vi.fn(async (_io, opts: { home: string }, values: { name?: string }, args: readonly string[]) => {
      writeHost(opts.home, values.name ?? "host", record(args[0]!));
      return 0;
    });
    const switcher = hostSwitcher({ ...d, connect });
    expect(await switcher.connect({ road: "direct", url: "http://127.0.0.1:14400", code: "ABCDEFGH" })).toEqual({ ok: true });
    expect(connect).toHaveBeenCalledOnce();
    expect(connect.mock.calls[0]![2]).toEqual({ code: "ABCDEFGH", name: "127.0.0.1" });
    expect(readHost(d.home, "127.0.0.1")).toMatchObject({ url: "http://127.0.0.1:14400", label: "127.0.0.1:14400", road: "direct" });
    expect(switcher.current()).toMatchObject({ url: "http://127.0.0.1:14400", alias: "127.0.0.1", label: "127.0.0.1:14400" });
  });

  it("a refused code lands under the code, an address nothing answered at under the address, in the host's own words", async () => {
    const d = deps();
    const code = hostSwitcher({ ...d, connect: async () => { throw Object.assign(new Error("that pairing code is not one this host is waiting for"), { kind: "auth" }); } });
    expect(await code.connect({ road: "direct", url: "http://127.0.0.1:14400", code: "AAAAAAAA" })).toEqual({ ok: false, at: "code", error: "that pairing code is not one this host is waiting for" });
    const dead = hostSwitcher({ ...d, connect: async () => { throw new Error("the host at http://127.0.0.1:1 did not answer: connect ECONNREFUSED"); } });
    expect(await dead.connect({ road: "direct", url: "http://127.0.0.1:1", code: "AAAAAAAA" })).toEqual({ ok: false, at: "url", error: "the host at http://127.0.0.1:1 did not answer: connect ECONNREFUSED" });
    expect(await dead.connect({ road: "direct", url: "box", code: "AAAAAAAA" })).toMatchObject({ ok: false, at: "url" });
    expect(await dead.connect({ road: "direct", url: "http://127.0.0.1:1", code: "AB" })).toMatchObject({ ok: false, at: "code" });
    expect(d.loaded).toEqual([]);
  });

  it("disconnecting the host the window is on hands the token back, drops the record and returns to this computer", async () => {
    const d = deps();
    writeHost(d.home, "box", record("http://127.0.0.1:14400"));
    const disconnect = vi.fn(async (_io, opts: { home: string }, args: readonly string[]) => {
      rmSync(join(opts.home, "hosts", `${args[0]!}.json`));
      return 0;
    });
    const switcher = hostSwitcher({ ...d, disconnect });
    await switcher.to("box");
    expect(await switcher.disconnect("box")).toEqual({ ok: true });
    expect(disconnect).toHaveBeenCalledOnce();
    expect(listHosts(d.home)).toEqual([]);
    expect(switcher.current()).toBe(d.local);
    expect(d.loaded.map(s => s.url)).toEqual(["http://127.0.0.1:14400", "http://127.0.0.1:41000"]);
  });

  it("over ssh the road opens the forward and pairs, the record keeps the login, and a switch back reaches the host through the lock again", async () => {
    const d = deps();
    const reached: string[] = [];
    const ssh: SshRoad = {
      open: async () => ({ url: "http://127.0.0.1:52001", code: "ABCDEFGH" }),
      reach: async (login, preferLocal) => {
        reached.push(`${login.address}:${login.port ?? 22} at ${preferLocal ?? "any"}`);
        return "http://127.0.0.1:52002";
      },
      closeForward: () => {},
      closeAll: () => {},
      pids: () => [],
    };
    const connect = vi.fn(async (_io, opts: { home: string }, values: { name?: string; code?: string }, args: readonly string[]) => {
      writeHost(opts.home, values.name!, record(args[0]!));
      return 0;
    });
    const switcher = hostSwitcher({ ...d, ssh, connect });
    expect(await switcher.connect({ road: "ssh", address: "maya@box", port: 2222 })).toEqual({ ok: true });
    expect(connect.mock.calls[0]![2]).toEqual({ code: "ABCDEFGH", name: "maya-box" });
    expect(readHost(d.home, "maya-box")).toEqual({ ...record("http://127.0.0.1:52001"), label: "maya@box", road: "ssh", ssh: { address: "maya@box", port: 2222 } });
    expect(switcher.current()).toMatchObject({ url: "http://127.0.0.1:52001", label: "maya@box" });
    // A later launch holds the record and no forward: the switch reads the box's lock again and forwards to what it
    // names, at the local port the record names when it can, and the record follows the forward.
    const later = hostSwitcher({ ...deps({ home: d.home }), ssh });
    expect(await later.to("maya-box")).toEqual({ ok: true });
    expect(reached).toEqual(["maya@box:2222 at 52001"]);
    expect(later.current().url).toBe("http://127.0.0.1:52002");
    expect(readHost(d.home, "maya-box")?.url).toBe("http://127.0.0.1:52002");
  });

  it("an ssh road that fails says so under the address, and nothing is written", async () => {
    const d = deps();
    const open = vi.fn(async () => { throw new Error("wsp is not installed on maya@box: run npm i -g @zingzy/wsp there, then connect again."); });
    const ssh: SshRoad = { open, reach: async () => "", closeForward: () => {}, closeAll: () => {}, pids: () => [] };
    const switcher = hostSwitcher({ ...d, ssh });
    expect(await switcher.connect({ road: "ssh", address: "maya@box" })).toEqual({ ok: false, at: "address", error: "wsp is not installed on maya@box: run npm i -g @zingzy/wsp there, then connect again." });
    expect(open).toHaveBeenCalledOnce();
    // A word ssh could read as one of its own options, or a shell as a second command, never reaches ssh: the
    // refusal is the login line and the road is not opened.
    const loginLine = `the login is ${HOST_WORDS.sheet.loginPlaceholder}, as ssh takes it`;
    for (const bad of ["", "-oProxyCommand=touch /tmp/x", "maya@box; rm -rf ~", "maya@box -p 2222", "maya@"]) {
      expect(await switcher.connect({ road: "ssh", address: bad })).toEqual({ ok: false, at: "address", error: loginLine });
    }
    expect(open).toHaveBeenCalledOnce();
    expect(listHosts(d.home)).toEqual([]);
  });
});

describe("parseConnectAsk", () => {
  it("takes the sheet's two shapes and nothing else", () => {
    expect(parseConnectAsk({ road: "direct", url: "http://box:4400", code: "ABCDEFGH" })).toEqual({ road: "direct", url: "http://box:4400", code: "ABCDEFGH" });
    expect(parseConnectAsk({ road: "ssh", address: "maya@box" })).toEqual({ road: "ssh", address: "maya@box" });
    expect(parseConnectAsk({ road: "ssh", address: "maya@box", port: 2222 })).toEqual({ road: "ssh", address: "maya@box", port: 2222 });
    for (const bad of [undefined, null, "direct", { road: "relay", url: "x" }, { road: "direct", url: 1, code: "A" }, { road: "ssh", address: "a", port: "2222" }, { road: "ssh", address: "a", port: 70000 }, { road: "ssh", port: 22 }]) {
      expect(parseConnectAsk(bad)).toBeUndefined();
    }
  });
});
