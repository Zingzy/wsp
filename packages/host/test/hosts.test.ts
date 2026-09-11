// SPDX-License-Identifier: AGPL-3.0-only
// The hosts file and the one rule that decides which host a line runs
// against: a record round trips at mode 0600, a flag beats the environment
// beats the default alias beats the lock on this computer, and a URL typed
// where an alias goes is a host nothing is stored for.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WS_PATH } from "@wsp/protocol";
import { aimedHost, aliasFrom, checkedAlias, defaultHost, dialWindowMs, hostsDir, listHosts, noSuchHostLine, readHost, removeHost, setDefaultHost, wsUrlOf, wspHome, writeHost, type HostRecord } from "../src/hosts.js";
import { homeNamed } from "../src/serving-home.js";
import { hostAddress } from "../src/verbs.js";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `wsp-${tag}-`));
  dirs.push(dir);
  return dir;
}

const record = (url: string, id = "d_1a2b3c4d"): HostRecord => ({ url, deviceId: id, deviceToken: `tok-${id}`, pairedAt: "2026-09-11T10:00:00.000Z" });

/** A state folder whose lock names this process, which is a host serving it as far as every reader is concerned. */
function servedState(port = 4400): string {
  const dir = tempDir("hosts-state");
  writeFileSync(join(dir, "host.lock"), JSON.stringify({ pid: process.pid, port, wsPort: port + 10, startedAt: "2026-09-11T10:00:00.000Z" }));
  writeFileSync(join(dir, "host-token"), "host-token\n");
  return join(dir, "state.json");
}

describe("the hosts file", () => {
  it("writes a record only this user can read and reads it back whole", () => {
    const home = tempDir("hosts-home");
    writeHost(home, "box", record("http://box.local:4400"));
    expect(readHost(home, "box")).toEqual(record("http://box.local:4400"));
    expect(statSync(join(hostsDir(home), "box.json")).mode & 0o777).toBe(0o600);
    expect(statSync(hostsDir(home)).mode & 0o777).toBe(0o700);
  });

  it("lists every alias with its url and marks the default, and answers nothing for a home with no hosts folder", () => {
    const home = tempDir("hosts-home");
    expect(listHosts(home)).toEqual([]);
    writeHost(home, "box", record("http://box.local:4400", "d_1"));
    writeHost(home, "attic", record("https://attic.example", "d_2"));
    setDefaultHost(home, "box");
    expect(listHosts(home)).toEqual([
      { alias: "attic", url: "https://attic.example", deviceId: "d_2", default: false },
      { alias: "box", url: "http://box.local:4400", deviceId: "d_1", default: true },
    ]);
  });

  it("removes the file and clears the default when it named the one removed", () => {
    const home = tempDir("hosts-home");
    writeHost(home, "box", record("http://box.local:4400"));
    setDefaultHost(home, "box");
    expect(removeHost(home, "box")).toBe(true);
    expect(readHost(home, "box")).toBeUndefined();
    expect(defaultHost(home)).toBeUndefined();
    // The mark itself goes, not only its reading: a pointer left behind makes the next connect under that name
    // read as already marked and say the wrong thing about where lines go.
    expect(existsSync(join(hostsDir(home), "default"))).toBe(false);
    expect(removeHost(home, "box")).toBe(false);
  });

  it("leaves the default alone when another host is removed", () => {
    const home = tempDir("hosts-home");
    writeHost(home, "box", record("http://box.local:4400"));
    writeHost(home, "attic", record("https://attic.example"));
    setDefaultHost(home, "box");
    removeHost(home, "attic");
    expect(defaultHost(home)).toBe("box");
  });

  it("refuses an alias that is a path rather than a name, so nothing writes outside the hosts folder", () => {
    const home = tempDir("hosts-home");
    expect(() => writeHost(home, "../evil", record("http://x"))).toThrow(/alias/);
    expect(() => writeHost(home, "a/b", record("http://x"))).toThrow(/alias/);
    expect(() => setDefaultHost(home, "../evil")).toThrow(/alias/);
    expect(readHost(home, "../evil")).toBeUndefined();
  });

  it("folds a name nobody typed through the same rule a typed one is held to", () => {
    expect(aliasFrom("box.local")).toBe("box.local");
    expect(aliasFrom("192.168.1.9")).toBe("192.168.1.9");
    expect(aliasFrom("[::1]")).toBe("1-");
    expect(aliasFrom("///")).toBe("host");
    expect(aliasFrom("a".repeat(200))).toHaveLength(64);
    // A dot is in the alias class and the checker refuses a dot-dot, so a run of dots is the one fold that could
    // hand back a word the checker would not take: new URL("http://a..b:4400").hostname is a..b, and a person who
    // typed no --name would have died on a name they never chose.
    expect(aliasFrom(new URL("http://a..b:4400").hostname)).toBe("a.b");
    expect(aliasFrom("a....b")).toBe("a.b");
    expect(aliasFrom("..")).toBe("host");
    for (const folded of ["box.local", "[::1]", "///", "a..b", "a....b", "..", "a..", ".", "-.-", "a".repeat(200)].map(aliasFrom)) expect(checkedAlias(folded)).toBe(folded);
  });

  it("refuses a word that could never be a file under the hosts folder, in one sentence", () => {
    expect(() => checkedAlias("../evil")).toThrow(/not a host alias/);
    expect(() => checkedAlias("a/b")).toThrow(/not a host alias/);
    expect(() => checkedAlias("")).toThrow(/not a host alias/);
    expect(() => checkedAlias("-box")).toThrow(/not a host alias/);
    expect(() => checkedAlias("a".repeat(65))).toThrow(/not a host alias/);
    expect(checkedAlias("box")).toBe("box");
  });

  it("reads WSP_HOME for the home the hosts folder sits in, and an empty one names no home at all", () => {
    expect(wspHome({ WSP_HOME: "/tmp/elsewhere" })).toBe("/tmp/elsewhere");
    expect(wspHome({})).toMatch(/\.wsp$/);
    // WSP_HOME= with nothing after it is what a launcher leaves when it carries the name and not the value; read as
    // a home it is the folder the run happens to sit in, and the hosts, the keys and the state land beside it.
    expect(wspHome({ WSP_HOME: "" })).toBe(wspHome({}));
    expect(homeNamed("")).toBeUndefined();
  });
});

describe("the ws url of a host's address", () => {
  it("keeps the address and puts the runtime's path on it, over ws for http and wss for https", () => {
    expect(wsUrlOf("http://box.local:4400")).toBe(`ws://box.local:4400${WS_PATH}`);
    expect(wsUrlOf("https://attic.example")).toBe(`wss://attic.example${WS_PATH}`);
    expect(wsUrlOf("http://box.local:4400/")).toBe(`ws://box.local:4400${WS_PATH}`);
    expect(wsUrlOf("ws://box.local:4400")).toBe(`ws://box.local:4400${WS_PATH}`);
    expect(wsUrlOf("https://relay.example/mine")).toBe(`wss://relay.example/mine${WS_PATH}`);
  });
});

describe("how long a dial waits, by the road", () => {
  it("gives a host on this computer a loopback's window and one at an address off it the road's", () => {
    const near = dialWindowMs({ kind: "here" });
    const far = dialWindowMs({ kind: "alias", alias: "box", record: record("https://h5aab7a97cd80893f.singhi.me") });
    expect(near).toBe(5_000);
    // Longer than the 5.8 s a content delivery edge was measured holding a request while its tunnel came up, which
    // is the road a relayed box is reached over.
    expect(far).toBeGreaterThan(6_000);
    for (const url of ["http://127.0.0.1:4400", "http://127.0.0.2:4400", "http://localhost:4400", "http://[::1]:4400"]) {
      expect(dialWindowMs({ kind: "alias", alias: "box", record: record(url) }), url).toBe(near);
      expect(dialWindowMs({ kind: "url", url }), url).toBe(near);
    }
    // A hand-edited record can hold any word, and the window is no place to throw over one.
    for (const url of ["https://h5aab7a97cd80893f.singhi.me", "http://box.local:4400", "http://10.0.0.4:4400", "wss://attic.example/ws", "not-an-address", "http://"]) {
      expect(dialWindowMs({ kind: "alias", alias: "box", record: record(url) }), url).toBe(far);
      expect(dialWindowMs({ kind: "url", url }), url).toBe(far);
    }
  });
});

describe("which host a line runs against", () => {
  it("takes the flag over the environment, the environment over the default alias, and the default only when no host serves the state file", () => {
    const home = tempDir("hosts-home");
    writeHost(home, "box", record("http://box.local:4400", "d_box"));
    writeHost(home, "attic", record("https://attic.example", "d_attic"));
    setDefaultHost(home, "attic");
    const served = servedState();
    const gone = join(tempDir("hosts-empty"), "state.json");

    expect(aimedHost(served, { host: "box", env: { WSP_HOST: "attic" }, home })).toMatchObject({ kind: "alias", alias: "box" });
    expect(aimedHost(served, { env: { WSP_HOST: "attic" }, home })).toMatchObject({ kind: "alias", alias: "attic" });
    expect(aimedHost(served, { env: {}, home })).toEqual({ kind: "here" });
    expect(aimedHost(gone, { env: {}, home })).toMatchObject({ kind: "alias", alias: "attic" });
    expect(aimedHost(gone, { env: {}, home: tempDir("hosts-none") })).toEqual({ kind: "here" });
  });

  it("takes a url typed where an alias goes as a host nothing is stored for", () => {
    const home = tempDir("hosts-home");
    expect(aimedHost("/nowhere/state.json", { host: "http://127.0.0.1:14400", env: {}, home })).toEqual({ kind: "url", url: "http://127.0.0.1:14400" });
    expect(aimedHost("/nowhere/state.json", { env: { WSP_HOST: "https://attic.example" }, home })).toEqual({ kind: "url", url: "https://attic.example" });
  });

  it("takes the pair a turn's launch left in the environment over any state file or alias on this computer, under the flag and WSP_HOST", () => {
    const home = tempDir("hosts-home");
    const carried = { WSP_HOST_URL: "http://10.0.0.2:4700", WSP_HOST_TOKEN: "scoped-token" };
    const aimed = { kind: "url", url: "http://10.0.0.2:4700", token: "scoped-token" };
    const gone = join(tempDir("hosts-empty"), "state.json");
    // On a machine there is no hosts folder and no host of its own, so the pair is the only road there is.
    expect(aimedHost(gone, { env: carried, home })).toEqual(aimed);
    // The pair is the identity the launch handed this turn: a host serving the state file the line names and a
    // default alias are both this computer's roads, and neither is what the turn was given.
    expect(aimedHost(servedState(4600), { env: carried, home })).toEqual(aimed);
    writeHost(home, "attic", record("https://attic.example", "d_attic"));
    setDefaultHost(home, "attic");
    expect(aimedHost(gone, { env: carried, home })).toEqual(aimed);
    // What a person names on the line, or with WSP_HOST, still wins: those are typed, the pair is inherited.
    expect(aimedHost(gone, { host: "attic", env: carried, home })).toMatchObject({ kind: "alias", alias: "attic" });
    expect(aimedHost(gone, { env: { ...carried, WSP_HOST: "attic" }, home })).toMatchObject({ kind: "alias", alias: "attic" });
    // An address with no token beside it opens nothing, so the pair reads as absent.
    expect(aimedHost(gone, { env: { WSP_HOST_URL: "http://10.0.0.2:4700" }, home: tempDir("hosts-none") })).toEqual({ kind: "here" });
    expect(aimedHost(servedState(4600), { env: { WSP_HOST_URL: "http://10.0.0.2:4700" }, home })).toEqual({ kind: "here" });
  });

  it("gives a --host address the token the environment carries for that same address, and nothing for another", () => {
    const home = tempDir("hosts-none");
    const carried = { WSP_HOST_URL: "http://10.0.0.2:4700", WSP_HOST_TOKEN: "scoped-token" };
    expect(aimedHost("/nowhere/state.json", { host: "http://10.0.0.2:4700", env: carried, home })).toEqual({ kind: "url", url: "http://10.0.0.2:4700", token: "scoped-token" });
    expect(aimedHost("/nowhere/state.json", { host: "http://other.example:4700", env: carried, home })).toEqual({ kind: "url", url: "http://other.example:4700" });
    expect(hostAddress("/nowhere/state.json", { host: "http://10.0.0.2:4700", env: carried, home })).toEqual({ url: `ws://10.0.0.2:4700${WS_PATH}`, token: "scoped-token" });
  });

  it("refuses an alias nothing is stored for in one sentence naming the ones that are", () => {
    const home = tempDir("hosts-home");
    writeHost(home, "box", record("http://box.local:4400"));
    expect(() => aimedHost("/nowhere/state.json", { host: "attic", env: {}, home })).toThrow(noSuchHostLine("attic", home));
    expect(noSuchHostLine("attic", home)).toContain("box");
    expect(noSuchHostLine("attic", home).split("\n")).toHaveLength(1);
  });
});

describe("where a verb dials", () => {
  it("gives the loopback address and the host's own token for a host on this computer", () => {
    const statePath = servedState(4500);
    expect(hostAddress(statePath, { env: {}, home: tempDir("hosts-none") })).toEqual({ url: "ws://127.0.0.1:4510", token: "host-token" });
  });

  it("gives the alias's address with the runtime's path and the device token it was paired with", () => {
    const home = tempDir("hosts-home");
    writeHost(home, "box", record("http://box.local:4400", "d_box"));
    expect(hostAddress("/nowhere/state.json", { host: "box", env: {}, home })).toEqual({ url: `ws://box.local:4400${WS_PATH}`, token: "tok-d_box" });
  });

  it("gives a url typed on the line no token, which is the road wsp connect takes and nothing else", () => {
    expect(hostAddress("/nowhere/state.json", { host: "http://127.0.0.1:14400", env: {}, home: tempDir("hosts-none") })).toEqual({
      url: `ws://127.0.0.1:14400${WS_PATH}`,
      token: "",
    });
  });

  it("refuses a state file no host serves in one sentence", () => {
    const gone = join(tempDir("hosts-empty"), "state.json");
    expect(() => hostAddress(gone, { env: {}, home: tempDir("hosts-none") })).toThrow(`no wsp host is serving ${gone}; run wsp up first`);
  });
});

describe("a hosts folder somebody hand-edited", () => {
  it("skips a file that is not a record rather than refusing every listing", () => {
    const home = tempDir("hosts-home");
    writeHost(home, "box", record("http://box.local:4400"));
    mkdirSync(hostsDir(home), { recursive: true });
    writeFileSync(join(hostsDir(home), "broken.json"), "{ not json");
    writeFileSync(join(hostsDir(home), "notes.txt"), "hello");
    expect(listHosts(home).map(h => h.alias)).toEqual(["box"]);
    expect(readHost(home, "broken")).toBeUndefined();
  });

  it("answers no default when the file names an alias that is gone", () => {
    const home = tempDir("hosts-home");
    writeHost(home, "box", record("http://box.local:4400"));
    setDefaultHost(home, "box");
    rmSync(join(hostsDir(home), "box.json"));
    expect(defaultHost(home)).toBeUndefined();
    expect(readFileSync(join(hostsDir(home), "default"), "utf8").trim()).toBe("box");
  });
});

describe("what the desktop adds to a record", () => {
  it("round trips the label, the road and the ssh login, and the listing carries the label and the road", () => {
    const home = tempDir("hosts-home");
    const ssh: HostRecord = { ...record("http://127.0.0.1:52001", "d_3"), label: "maya@box", road: "ssh", ssh: { address: "maya@box", port: 2222 } };
    writeHost(home, "maya-box", ssh);
    writeHost(home, "attic", record("https://attic.example", "d_2"));
    expect(readHost(home, "maya-box")).toEqual(ssh);
    expect(listHosts(home)).toEqual([
      { alias: "attic", url: "https://attic.example", deviceId: "d_2", default: false },
      { alias: "maya-box", url: "http://127.0.0.1:52001", deviceId: "d_3", default: false, label: "maya@box", road: "ssh" },
    ]);
  });
});
