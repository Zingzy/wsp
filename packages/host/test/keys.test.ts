// SPDX-License-Identifier: AGPL-3.0-only
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { S_RADIO_ACTIVE, S_RADIO_INACTIVE } from "@clack/prompts";
import { exitClassOf } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { HELP, cli, forkCommandFor, jsonCliIO, loadKeys, saveQuestion, terminalIO, upCommandFor, type CliIO } from "../src/cli.js";

const SOLARI = "slr_live_fake_solari_key";

describe("help", () => {
  it("--yes says a browser or device login, or one held in the Keychain, signs in on the machine, so macOS has nothing to ask either", () => {
    setup();
    expect(HELP.replace(/\s+/g, " ")).toContain("--yes init: take every default and ask nothing (required off a terminal); a login with a browser or device sign-in, or one held in the Keychain, defaults to sign in on the machine unless a saved recipe answered copy, so macOS has nothing to ask either and the sign-ins wait for the app's terminal");
  });
});

describe("the wsp up an init names", () => {
  it("carries the state and port flags the init was given, resolved and quoted, and none it was not", () => {
    const opts = { port: 4500, wsPort: 4510, statePath: "/tmp/wsp test/state.json" };
    expect(upCommandFor(opts, {})).toBe("wsp up");
    expect(upCommandFor(opts, { state: "state.json" })).toBe("wsp up --state '/tmp/wsp test/state.json'");
    expect(upCommandFor(opts, { port: "4500", "ws-port": "4510" })).toBe("wsp up --port 4500 --ws-port 4510");
    // The fork runs against the host wsp up started, so it needs the state and not the ports.
    expect(forkCommandFor(opts, {})).toBe("wsp new first");
    expect(forkCommandFor(opts, { state: "state.json" })).toBe("wsp new first --state '/tmp/wsp test/state.json'");
  });
});

describe("--json keeps stdout to the objects", () => {
  it("every line the run says, and every question it cannot ask, goes to the stream beside stdout", async () => {
    const err = new PassThrough();
    const said: string[] = [];
    err.on("data", (c: Buffer) => said.push(c.toString()));
    const io = jsonCliIO(err);
    io.log("app         http://127.0.0.1:4400");
    io.error("reap: sweep failed");
    io.stream?.("half a line");
    await expect(io.askSecret("Solari API key\nNo Solari key found.")).rejects.toThrow(
      "Solari API key: --json asks nothing; set it in the environment, ./.env, or ~/.wsp/.env.",
    );
    // A secret nobody can type is the contract's auth class; a yes-or-no nobody can answer is not.
    await expect(io.askSecret("Solari API key").then(() => "provider", exitClassOf)).resolves.toBe("auth");
    await expect(io.ask("Save the key so wsp stops asking?")).rejects.toThrow("--json asks nothing");
    await expect(io.ask("Save the key so wsp stops asking?").then(() => "ok", exitClassOf)).resolves.toBe("provider");
    expect(said.join("")).toBe("app         http://127.0.0.1:4400\nreap: sweep failed\nhalf a line");
  });

  it("wsp init --yes --json is refused in one line, since --yes skips the sign-ins --json is there to print", async () => {
    const said: string[] = [];
    const io: CliIO = { log: l => said.push(`out ${l}`), error: l => said.push(`err ${l}`), ask: async () => "no", askSecret: async () => "" };
    expect(await cli(["init", "--yes", "--json"], io)).toBe(3);
    // A --json line's refusal is the failure object, the one shape an agent parses on every verb and command.
    expect(said).toEqual([`err ${JSON.stringify({ error: "wsp init: --json prints the sign-ins as they are handed to you, and --yes skips the sign-ins, so there would be nothing to print. Drop one of them.", class: "usage", exit: 3 })}`]);
  });
});

const ANTHROPIC = "sk-ant-x-fake-anthropic-key";

interface FakeIO extends CliIO {
  output: string[];
}

function fakeIO(answers: string[]): FakeIO {
  const queue = [...answers];
  const output: string[] = [];
  const next = (question: string): Promise<string> => {
    output.push(question);
    const answer = queue.shift();
    if (answer === undefined) throw new Error(`unexpected prompt: ${question}`);
    return Promise.resolve(answer);
  };
  return {
    output,
    log: l => output.push(l),
    error: l => output.push(l),
    ask: next,
    askSecret: next,
  };
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

let dir: string;
let cwd: string;
let home: string;
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
function setup(): void {
  dir = mkdtempSync(join(tmpdir(), "wsp-keys-"));
  cwd = join(dir, "cwd");
  home = join(dir, "home");
  mkdirSync(cwd);
}

describe("loadKeys", () => {
  it("prompts for both keys and persists them to <home>/.env with mode 600", async () => {
    setup();
    const io = fakeIO([SOLARI, ANTHROPIC, "yes"]);
    const keys = await loadKeys(io, { env: {}, cwd, home });
    expect(keys).toEqual({ solari: SOLARI, anthropic: ANTHROPIC });
    const envPath = join(home, ".env");
    expect(mode(envPath)).toBe(0o600);
    expect(readFileSync(envPath, "utf8").split("\n")).toEqual(
      expect.arrayContaining([`SOLARI_API_KEY=${SOLARI}`, `ANTHROPIC_API_KEY=${ANTHROPIC}`]),
    );
    // Prompt strings, log lines, and questions never carry key material.
    expect(io.output.join("\n")).not.toContain(SOLARI);
    expect(io.output.join("\n")).not.toContain(ANTHROPIC);
  });

  it("says no key was found, where to get one, and names the file only because this home is not the default", async () => {
    setup();
    const io = fakeIO([SOLARI, ANTHROPIC, "yes"]);
    await loadKeys(io, { env: {}, cwd, home });
    const [key, anthropic, save] = io.output.map(stripVTControlCharacters);
    expect(key).toBe("Solari API key\nNo Solari key found.\nconsole.getsolari.com");
    expect(anthropic).toMatch(/^Anthropic API key\noptional, enter skips\n/);
    expect(save).toBe(`Save the keys to ${join(home, ".env")} so wsp stops asking?`);
    expect(io.output.join("\n")).not.toMatch(/—|!|SOLARI_API_KEY/);
  });

  it("rewrites an existing 644 file down to 600 and keeps lines it did not set", async () => {
    setup();
    mkdirSync(home);
    const envPath = join(home, ".env");
    writeFileSync(envPath, "OTHER=keep me\n# a comment\n");
    chmodSync(envPath, 0o644);
    expect(mode(envPath)).toBe(0o644);

    await loadKeys(fakeIO([SOLARI, "", "yes"]), { env: {}, cwd, home });

    expect(mode(envPath)).toBe(0o600);
    const lines = readFileSync(envPath, "utf8").split("\n");
    expect(lines).toContain("OTHER=keep me");
    expect(lines).toContain("# a comment");
    expect(lines).toContain(`SOLARI_API_KEY=${SOLARI}`);
  });

  it("resolves each key on its own: env, then ./.env, then <home>/.env", async () => {
    setup();
    mkdirSync(home);
    writeFileSync(join(cwd, ".env"), "SOLARI_API_KEY=from-cwd\nANTHROPIC_API_KEY=anth-from-cwd\n");
    writeFileSync(join(home, ".env"), "SOLARI_API_KEY=from-home\nANTHROPIC_API_KEY=anth-from-home\n");

    const io = fakeIO([]);
    expect(await loadKeys(io, { env: { SOLARI_API_KEY: "from-env" }, cwd, home })).toEqual({
      solari: "from-env",
      anthropic: "anth-from-cwd",
    });
    expect(io.output).toEqual([]);

    writeFileSync(join(cwd, ".env"), "SOLARI_API_KEY=from-cwd\n");
    expect(await loadKeys(fakeIO([]), { env: {}, cwd, home })).toEqual({
      solari: "from-cwd",
      anthropic: "anth-from-home",
    });

    rmSync(join(cwd, ".env"));
    expect(await loadKeys(fakeIO([]), { env: {}, cwd, home })).toEqual({
      solari: "from-home",
      anthropic: "anth-from-home",
    });
  });

  it("enter skips the Anthropic key, the save question says key not keys, and the saved file has no ANTHROPIC line", async () => {
    setup();
    const io = fakeIO([SOLARI, "", "yes"]);
    const keys = await loadKeys(io, { env: {}, cwd, home });
    expect(keys).toEqual({ solari: SOLARI });
    expect(io.output[2]).toMatch(/^Save the key to /);
    const text = readFileSync(join(home, ".env"), "utf8");
    expect(text).not.toContain("ANTHROPIC");
    expect(text).toContain(`SOLARI_API_KEY=${SOLARI}`);
  });

  it("does not persist by default (no means no)", async () => {
    setup();
    const io = fakeIO([SOLARI, ANTHROPIC, "no"]);
    const keys = await loadKeys(io, { env: {}, cwd, home });
    expect(keys).toEqual({ solari: SOLARI, anthropic: ANTHROPIC });
    expect(existsSync(join(home, ".env"))).toBe(false);
    expect(io.output.join("\n")).not.toContain(SOLARI);
    expect(io.output.join("\n")).not.toContain(ANTHROPIC);
  });

  it("mentions subscriptions in the Anthropic prompt but never in the Solari one", async () => {
    setup();
    const io = fakeIO([SOLARI, "", "no"]);
    await loadKeys(io, { env: {}, cwd, home });
    expect(io.output[0]).not.toContain("/login");
    expect(io.output[1]).toContain("/login");
    expect(io.output.join("\n")).not.toContain("—");
  });

  it("refuses to start on an empty Solari key without leaking anything", async () => {
    setup();
    await expect(loadKeys(fakeIO(["   "]), { env: {}, cwd, home })).rejects.toThrow(/Solari API key/);
    expect(existsSync(join(home, ".env"))).toBe(false);
  });

  it("the save question names the file only when WSP_HOME is not the default", () => {
    expect(saveQuestion(join(homedir(), ".wsp"), 1)).toBe("Save the key so wsp stops asking?");
    expect(saveQuestion(join(homedir(), ".wsp"), 2)).toBe("Save the keys so wsp stops asking?");
    expect(saveQuestion("/srv/wsp", 1)).toBe("Save the key to /srv/wsp/.env so wsp stops asking?");
  });
});

interface Screen {
  io: CliIO;
  input: PassThrough;
  text(): string;
  type(keys: string): Promise<void>;
}

function screen(tty: boolean): Screen {
  const input = Object.assign(new PassThrough(), { isTTY: tty, setRawMode: () => input });
  const output = Object.assign(new PassThrough(), { isTTY: tty, columns: 160 });
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  return {
    io: terminalIO(input, output),
    input,
    text: () => stripVTControlCharacters(chunks.join("")),
    type: async keys => {
      await new Promise(r => setTimeout(r, 20));
      input.write(keys);
      await new Promise(r => setTimeout(r, 20));
    },
  };
}

describe("terminalIO", () => {
  it("on a terminal the key is a masked prompt with its hint lines under the question, and the save is a confirm that defaults to No", async () => {
    setup();
    const s = screen(true);
    const run = loadKeys(s.io, { env: {}, cwd, home }, { anthropic: false });
    await s.type(`${SOLARI}\r`);
    await s.type("\r");
    expect(await run).toEqual({ solari: SOLARI });
    const out = s.text();
    expect(out).toContain("◆  Solari API key\n┃  No Solari key found.\n┃  console.getsolari.com\n┃  _\n┗  enter next • esc cancel");
    // The question is wrapped at the frame's width, so the path may push "so wsp stops asking?" under the bar.
    expect(out).toContain(`◆  Save the key to ${join(home, ".env")} so wsp`);
    expect(out).toMatch(/◆  Save the key to [^\n]*\n(┃    [^\n]*\n)?┃  ○ Yes \/ ● No\n┗  ← → change • y n answer • enter choose • esc cancel/);
    expect(out).toMatch(/◇  Save the key to [^\n]*\n(│    [^\n]*\n)?│  No\n/);
    expect(out).not.toContain(SOLARI);
    expect(existsSync(join(home, ".env"))).toBe(false);
  });

  it("yes at the confirm writes <home>/.env at mode 600", async () => {
    setup();
    const s = screen(true);
    const run = loadKeys(s.io, { env: {}, cwd, home }, { anthropic: false });
    await s.type(`${SOLARI}\r`);
    await s.type("y");
    expect(await run).toEqual({ solari: SOLARI });
    expect(mode(join(home, ".env"))).toBe(0o600);
    expect(readFileSync(join(home, ".env"), "utf8")).toBe(`SOLARI_API_KEY=${SOLARI}\n`);
    expect(s.text()).not.toContain(SOLARI);
  });

  it("the quiet lines a turn streams are plain when stderr is no terminal and dim when the environment forces colour", () => {
    setup();
    const io = screen(false).io;
    expect(io.muted?.("$ git status")).toBe("$ git status");
    const was = process.env["FORCE_COLOR"];
    process.env["FORCE_COLOR"] = "1";
    try {
      expect(io.muted?.("$ git status")).toBe("\x1b[2m$ git status\x1b[22m");
    } finally {
      if (was === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = was;
    }
  });

  it("ctrl-c at the key prompt stops with nothing written", async () => {
    setup();
    const s = screen(true);
    const stopped = expect(loadKeys(s.io, { env: {}, cwd, home })).rejects.toThrow("Nothing was changed.");
    await s.type("\x03");
    await stopped;
    expect(existsSync(join(home, ".env"))).toBe(false);
  });

  it("off a terminal there is nobody to ask: a plain error names the key and where it is read from, and nothing is drawn", async () => {
    setup();
    const s = screen(false);
    await expect(loadKeys(s.io, { env: {}, cwd, home })).rejects.toThrow(
      "Solari API key: no terminal to ask on; set it in the environment, ./.env, or ~/.wsp/.env.",
    );
    await expect(loadKeys(s.io, { env: {}, cwd, home }).then(() => "ok", exitClassOf)).resolves.toBe("auth");
    await expect(s.io.ask("Save the key so wsp stops asking?").then(() => "ok", exitClassOf)).resolves.toBe("provider");
    expect(s.text()).toBe("");
  });
});
