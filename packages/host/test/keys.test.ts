// SPDX-License-Identifier: AGPL-3.0-only
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { S_RADIO_ACTIVE, S_RADIO_INACTIVE } from "@clack/prompts";
import { exitClassOf, keyRefusedLine, LOOPBACK, savedKeyRefusedLine } from "@wsp/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HELP, SERVE_FLAGS, cli, forkCommandFor, jsonCliIO, keySources, loadKeys, saveQuestion, terminalIO, upCommandFor, type CliIO, type KeySources, type LoadedKeys, type NoProviderKey } from "../src/cli.js";
import { BOX_API_URL, BoxBackend, type KeyCheck } from "@wsp/engine";
import { AGENT_KEY_VARIABLES, agentKeyEnvs, agentKeysIn, keysOf, savedEnv } from "../src/env-keys.js";
import { BOX_KEY_ENV, SOLARI_KEY_ENV, providerBackendFor } from "../src/providers.js";

/** What a run came away with, in one shape: the agents' keys it holds and the provider key under the variable the
 * row it is wired to reads, which is where every command now takes one from. */
const held = (loaded: LoadedKeys, name: string = SOLARI_KEY_ENV): Record<string, string | undefined> => ({
  ...(loaded.env[name] !== undefined ? { [name]: loaded.env[name] } : {}),
  ...loaded.keys,
});

const loadHeld = async (io: CliIO, sources: KeySources, ask?: { anthropic: boolean; noSolari?: NoProviderKey; checkSaved?: boolean }, name?: string): Promise<Record<string, string | undefined>> =>
  held(await loadKeys(io, sources, ask), name);

const SOLARI = "slr_live_fake_solari_key";

describe("help", () => {
  it("--yes says a browser or device login, or one held in the Keychain, signs in on the machine, so macOS has nothing to ask either", () => {
    setup();
    expect(HELP.replace(/\s+/g, " ")).toContain("--yes init: take every default and ask nothing (required off a terminal); a login with a browser or device sign-in, or one held in the Keychain, defaults to sign in on the machine unless a saved recipe answered copy, so macOS has nothing to ask either and the sign-ins wait for the app's terminal");
  });
});

describe("the wsp up an init names", () => {
  it("carries the serving flags the init was given, resolved and quoted, and none it was not", () => {
    const opts = { port: 4500, wsPort: 4510, named: true, address: LOOPBACK, statePath: "/tmp/wsp test/state.json" };
    expect(upCommandFor(opts, {})).toBe("wsp up");
    expect(upCommandFor(opts, { state: "state.json" })).toBe("wsp up --state '/tmp/wsp test/state.json'");
    // Every value the line hands over is quoted, as the unit spells the same words: a path with a space in it and a
    // port read the same way, and the person pastes the line whole.
    expect(upCommandFor(opts, { port: "4500", "ws-port": "4510" })).toBe("wsp up --port '4500' --ws-port '4510'");
    // The line the init hands over starts the host the init built: a run told to fork containers says so again, or
    // the host that line starts picks no provider and forks nothing.
    const docker = { ...opts, address: "0.0.0.0", advertise: "http://10.0.0.9:4500", provider: "docker", dockerHost: "tcp://10.0.0.4:2375", relay: false };
    expect(upCommandFor(docker, { provider: "docker", "docker-host": "tcp://10.0.0.4:2375" })).toBe("wsp up --provider 'docker' --docker-host 'tcp://10.0.0.4:2375'");
    expect(upCommandFor(docker, { listen: "0.0.0.0", advertise: "http://10.0.0.9:4500", "no-relay": true })).toBe("wsp up --listen '0.0.0.0' --advertise 'http://10.0.0.9:4500' --no-relay");
    // Every row of the table, so one added tomorrow is spelled here too rather than dropped from the handover.
    const all = upCommandFor(docker, { state: "s", port: "4500", "ws-port": "4510", listen: "0.0.0.0", advertise: "http://10.0.0.9:4500", provider: "docker", "docker-host": "tcp://10.0.0.4:2375", "no-relay": true });
    for (const flag of SERVE_FLAGS) expect(all, `--${flag.name} in the line an init hands over`).toContain(`--${flag.name}`);
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
    // The variable rides with the question, so a line nobody could answer still says what to put in a file.
    await expect(io.askSecret("Solari API key\nNo SOLARI_API_KEY in the environment, ./.env, or ~/.wsp/.env.", "SOLARI_API_KEY")).rejects.toThrow(
      "Solari API key: --json asks nothing; set SOLARI_API_KEY in the environment, ./.env, or ~/.wsp/.env.",
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

function fakeIO(answers: string[], isTTY = false): FakeIO {
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
    isTTY,
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
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});
function setup(): void {
  dir = mkdtempSync(join(tmpdir(), "wsp-keys-"));
  cwd = join(dir, "cwd");
  home = join(dir, "home");
  mkdirSync(cwd);
}

describe("the wsp home's own keys, the ones the app's setup reads", () => {
  it("savedEnv reads the home's .env alone: a key in the process environment or a checkout's .env is not saved", () => {
    setup();
    mkdirSync(home);
    writeFileSync(join(cwd, ".env"), "SOLARI_API_KEY=from-cwd\nANTHROPIC_API_KEY=anth-from-cwd\n");
    process.env["ANTHROPIC_API_KEY"] = "anth-from-env";
    try {
      expect(savedEnv(home)).toEqual({});
      expect(keysOf(savedEnv(home))).toEqual({});
      writeFileSync(join(home, ".env"), "SOLARI_API_KEY=from-home\nOPENAI_API_KEY=sk-x-fake\nEMPTY=\n");
      expect(savedEnv(home)).toEqual({ SOLARI_API_KEY: "from-home", OPENAI_API_KEY: "sk-x-fake" });
      // The provider's key is its row's own variable and nothing on the keys a record answers with: those are the
      // agents' alone, and this record holds none.
      expect(keysOf(savedEnv(home))).toEqual({});
    } finally {
      delete process.env["ANTHROPIC_API_KEY"];
    }
  });

  it("the agents' key variables are the catalog's declarations, and only those ride out of a saved record", () => {
    expect([...AGENT_KEY_VARIABLES].sort()).toEqual(["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY"]);
    expect(agentKeysIn({ SOLARI_API_KEY: SOLARI, OPENAI_API_KEY: "sk-x-fake", OTHER: "x", GEMINI_API_KEY: "" })).toEqual({ OPENAI_API_KEY: "sk-x-fake" });
    expect(agentKeyEnvs({ anthropic: ANTHROPIC })).toEqual({ ANTHROPIC_API_KEY: ANTHROPIC });
    expect(agentKeyEnvs({})).toEqual({});
  });
});

describe("loadKeys", () => {
  it("prompts for both keys and persists them to <home>/.env with mode 600", async () => {
    setup();
    const io = fakeIO([SOLARI, ANTHROPIC, "yes"]);
    expect(await loadHeld(io, { env: {}, cwd, home })).toEqual({ SOLARI_API_KEY: SOLARI, anthropic: ANTHROPIC });
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
    expect(key).toBe("Solari API key\nNo SOLARI_API_KEY in the environment, ./.env, or ~/.wsp/.env.\nconsole.getsolari.com");
    expect(anthropic).toMatch(/^Anthropic API key\noptional, enter skips\n/);
    expect(save).toBe(`Save the keys to ${join(home, ".env")} so wsp stops asking?`);
    expect(io.output.join("\n")).not.toMatch(/—|!/);
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
    expect(await loadHeld(io, { env: { SOLARI_API_KEY: "from-env" }, cwd, home })).toEqual({
      SOLARI_API_KEY: "from-env",
      anthropic: "anth-from-cwd",
    });
    expect(io.output).toEqual([]);

    writeFileSync(join(cwd, ".env"), "SOLARI_API_KEY=from-cwd\n");
    expect(await loadHeld(fakeIO([]), { env: {}, cwd, home })).toEqual({
      SOLARI_API_KEY: "from-cwd",
      anthropic: "anth-from-home",
    });

    rmSync(join(cwd, ".env"));
    expect(await loadHeld(fakeIO([]), { env: {}, cwd, home })).toEqual({
      SOLARI_API_KEY: "from-home",
      anthropic: "anth-from-home",
    });
  });

  it("enter skips the Anthropic key, the save question says key not keys, and the saved file has no ANTHROPIC line", async () => {
    setup();
    const io = fakeIO([SOLARI, "", "yes"]);
    expect(await loadHeld(io, { env: {}, cwd, home })).toEqual({ SOLARI_API_KEY: SOLARI });
    expect(io.output[2]).toMatch(/^Save the key to /);
    const text = readFileSync(join(home, ".env"), "utf8");
    expect(text).not.toContain("ANTHROPIC");
    expect(text).toContain(`SOLARI_API_KEY=${SOLARI}`);
  });

  it("does not persist by default (no means no)", async () => {
    setup();
    const io = fakeIO([SOLARI, ANTHROPIC, "no"]);
    expect(await loadHeld(io, { env: {}, cwd, home })).toEqual({ SOLARI_API_KEY: SOLARI, anthropic: ANTHROPIC });
    expect(existsSync(join(home, ".env"))).toBe(false);
    expect(io.output.join("\n")).not.toContain(SOLARI);
    expect(io.output.join("\n")).not.toContain(ANTHROPIC);
  });

  it("mentions subscriptions in the Anthropic prompt but never in the provider's one", async () => {
    setup();
    const io = fakeIO([SOLARI, "", "no"]);
    await loadKeys(io, { env: {}, cwd, home });
    expect(io.output[0]).not.toContain("/login");
    expect(io.output[1]).toContain("/login");
    expect(io.output.join("\n")).not.toContain("—");
  });

  it("puts a typed key to the provider before it writes it: a refused key is not saved and is asked for again in the provider's own words", async () => {
    setup();
    const asked: string[] = [];
    const io = fakeIO(["slr_live_wrong", "slr_live_right", "yes"], true);
    const keys = await loadHeld(io, { env: {}, cwd, home, checkKey: key => (asked.push(key), Promise.resolve(key === "slr_live_right" ? { state: "taken" } : { state: "refused", said: "401 Unauthorized" })) }, { anthropic: false });
    expect(asked).toEqual(["slr_live_wrong", "slr_live_right"]);
    expect(keys).toEqual({ SOLARI_API_KEY: "slr_live_right" });
    // The second question carries the provider's own words, which is what the app's field says too.
    expect(stripVTControlCharacters(io.output[1]!)).toContain(keyRefusedLine("401 Unauthorized"));
    // Only the key the provider took reached the file, and no question ever carried either key.
    expect(readFileSync(join(home, ".env"), "utf8")).toContain("SOLARI_API_KEY=slr_live_right");
    expect(readFileSync(join(home, ".env"), "utf8")).not.toContain("slr_live_wrong");
    expect(io.output.join("\n")).not.toContain("slr_live_");
  });

  it("stops asking after three refused keys, with the provider's word as the reason", async () => {
    setup();
    const io = fakeIO(["slr_live_a", "slr_live_b", "slr_live_c", "yes"], true);
    const sources = { env: {}, cwd, home, checkKey: async () => ({ state: "refused" as const, said: "401 Unauthorized" }) };
    await expect(loadKeys(io, sources, { anthropic: false })).rejects.toThrow(keyRefusedLine("401 Unauthorized"));
    expect(io.output).toHaveLength(3);
    expect(existsSync(join(home, ".env"))).toBe(false);
  });

  it("a check nothing answered takes the typed key: a road that is down is not the key's fault", async () => {
    setup();
    const io = fakeIO(["slr_live_maybe", "yes"], true);
    const keys = await loadHeld(io, { env: {}, cwd, home, checkKey: async () => ({ state: "unchecked", said: "fetch failed" }) }, { anthropic: false });
    expect(keys).toEqual({ SOLARI_API_KEY: "slr_live_maybe" });
    expect(readFileSync(join(home, ".env"), "utf8")).toContain("SOLARI_API_KEY=slr_live_maybe");
  });

  it("the build's own road checks the saved key and asks for another one on this run; every other verb takes it as it stands", async () => {
    setup();
    mkdirSync(home);
    writeFileSync(join(home, ".env"), `SOLARI_API_KEY=${SOLARI}\n`);
    const checked: string[] = [];
    const checkKey = (key: string): Promise<KeyCheck> => (checked.push(key), Promise.resolve(key === SOLARI ? { state: "refused", said: "401 Unauthorized" } : { state: "taken" }));
    // wsp init, the road that is about to build with it.
    const io = fakeIO(["slr_live_new", "yes"], true);
    expect(await loadHeld(io, { env: {}, cwd, home, checkKey }, { anthropic: false, noSolari: "offer", checkSaved: true })).toEqual({ SOLARI_API_KEY: "slr_live_new" });
    expect(checked).toEqual([SOLARI, "slr_live_new"]);
    expect(stripVTControlCharacters(io.output[0]!)).toContain(savedKeyRefusedLine("401 Unauthorized"));
  });

  it("every other verb takes the saved key as it stands: nothing is asked of the provider and nothing of the person", async () => {
    setup();
    mkdirSync(home);
    writeFileSync(join(home, ".env"), `SOLARI_API_KEY=${SOLARI}\n`);
    const checked: string[] = [];
    const sources = { env: {}, cwd, home, checkKey: (key: string): Promise<KeyCheck> => (checked.push(key), Promise.resolve({ state: "refused" as const, said: "401 Unauthorized" })) };
    for (const noSolari of ["local", "offer", undefined] as const) {
      const quiet = fakeIO([], true);
      expect(await loadHeld(quiet, sources, { anthropic: false, ...(noSolari !== undefined ? { noSolari } : {}) })).toEqual({ SOLARI_API_KEY: SOLARI });
      expect(quiet.output).toEqual([]);
    }
    expect(checked).toEqual([]);
  });

  it("a saved key the provider refused is never quietly dropped for the local road off a terminal", async () => {
    setup();
    mkdirSync(home);
    writeFileSync(join(home, ".env"), `SOLARI_API_KEY=${SOLARI}\n`);
    const sources = { env: {}, cwd, home, checkKey: async () => ({ state: "refused" as const, said: "401 Unauthorized" }) };
    await expect(loadKeys(fakeIO([]), sources, { anthropic: false, noSolari: "offer", checkSaved: true })).rejects.toThrow(savedKeyRefusedLine("401 Unauthorized"));
  });

  it("refuses to start on an empty provider key without leaking anything", async () => {
    setup();
    await expect(loadKeys(fakeIO(["   "]), { env: {}, cwd, home })).rejects.toThrow(/SOLARI_API_KEY/);
    expect(existsSync(join(home, ".env"))).toBe(false);
  });

  it("init offers the key at a terminal, and an empty answer is the answer: no provider key, and the question said so", async () => {
    setup();
    const io = fakeIO([""], true);
    expect(await loadHeld(io, { env: {}, cwd, home }, { anthropic: false, noSolari: "offer" })).toEqual({});
    expect(stripVTControlCharacters(io.output[0]!)).toBe(
      "Solari API key\nNo SOLARI_API_KEY in the environment, ./.env, or ~/.wsp/.env.\nconsole.getsolari.com\nEnter with nothing skips the cloud: this computer alone becomes your workspace, and nothing is sealed.",
    );
    // Nothing is written: there is no key to save.
    expect(existsSync(join(home, ".env"))).toBe(false);
  });

  it("init with nobody at a keyboard asks nothing at all", async () => {
    setup();
    const io = fakeIO([]);
    expect(await loadHeld(io, { env: {}, cwd, home }, { anthropic: false, noSolari: "offer" })).toEqual({});
    expect(io.output).toEqual([]);
  });

  it("the local road asks nothing even at a terminal: init already answered, and up, new --local and doctor --local seal nothing to skip", async () => {
    setup();
    const io = fakeIO([], true);
    expect(await loadHeld(io, { env: { ANTHROPIC_API_KEY: ANTHROPIC }, cwd, home }, { anthropic: false, noSolari: "local" })).toEqual({ anthropic: ANTHROPIC });
    expect(io.output).toEqual([]);
  });

  it("the Claude key rides the local road: it is the agents' key, not the provider's, and a thread here uses it", async () => {
    setup();
    const io = fakeIO([""], true);
    expect(await loadHeld(io, { env: { ANTHROPIC_API_KEY: ANTHROPIC }, cwd, home }, { anthropic: false, noSolari: "offer" })).toEqual({ anthropic: ANTHROPIC });
  });

  it("the local road is the caller's to ask for: every other command still refuses an empty answer", async () => {
    setup();
    await expect(loadKeys(fakeIO([""], true), { env: {}, cwd, home }, { anthropic: false }).then(() => "ok", exitClassOf)).resolves.toBe("auth");
  });

  it("a key that is there answers the local road too, with nothing asked", async () => {
    setup();
    const io = fakeIO([]);
    expect(await loadHeld(io, { env: { SOLARI_API_KEY: SOLARI }, cwd, home }, { anthropic: false, noSolari: "local" })).toEqual({ SOLARI_API_KEY: SOLARI });
    expect(io.output).toEqual([]);
  });

  it("the flags about a golden are refused on the local road rather than taken and ignored", async () => {
    setup();
    // Pinned off this computer's key layers: a Solari key on the Mac running the suite would make this a real init that boots a machine.
    vi.stubEnv("SOLARI_API_KEY", "");
    vi.stubEnv("WSP_HOME", home);
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const io = fakeIO([]);
    for (const flag of [["--no-local"], ["--first-workspace", "proj"], ["--import", cwd], ["--recipe", "r.json"], ["--project", cwd]]) {
      const code = await cli(["init", "--state", join(home, "state.json"), ...flag], io);
      expect([flag.join(" "), code]).toEqual([flag.join(" "), 3]);
    }
    expect(io.output.join("\n")).toContain("--no-local would leave it with nothing");
    expect(io.output.join("\n")).toContain("--first-workspace would do nothing here");
    expect(io.output.join("\n")).toContain("--import would do nothing here");
  });

  it("the save question names the file only when WSP_HOME is not the default", () => {
    expect(saveQuestion(join(homedir(), ".wsp"), 1)).toBe("Save the key so wsp stops asking?");
    expect(saveQuestion(join(homedir(), ".wsp"), 2)).toBe("Save the keys so wsp stops asking?");
    expect(saveQuestion("/srv/wsp", 1)).toBe("Save the key to /srv/wsp/.env so wsp stops asking?");
  });
});


describe("the key a run is asked for is the one its own provider reads", () => {
  const box = { WSP_PROVIDER: "box" };
  const quiet = { anthropic: false, noSolari: "local" as const };

  it("reads a registered row's key from each of the three layers, under the variable that row declares", async () => {
    setup();
    mkdirSync(home);
    writeFileSync(join(home, ".env"), `${BOX_KEY_ENV}=from-home\n`);
    expect(await loadHeld(fakeIO([]), { env: box, cwd, home }, quiet, BOX_KEY_ENV)).toEqual({ [BOX_KEY_ENV]: "from-home" });
    writeFileSync(join(cwd, ".env"), `${BOX_KEY_ENV}=from-cwd\n`);
    expect(await loadHeld(fakeIO([]), { env: box, cwd, home }, quiet, BOX_KEY_ENV)).toEqual({ [BOX_KEY_ENV]: "from-cwd" });
    expect(await loadHeld(fakeIO([]), { env: { ...box, [BOX_KEY_ENV]: "from-env" }, cwd, home }, quiet, BOX_KEY_ENV)).toEqual({ [BOX_KEY_ENV]: "from-env" });
    // The module a run builds is picked out of that same environment, so the key the layers held is the one the
    // backend forks with: this is what `wsp up --service` on a box with the key in a file had no road to before.
    const { env } = await loadKeys(fakeIO([]), { env: box, cwd, home }, quiet);
    expect(providerBackendFor(env)).toBeInstanceOf(BoxBackend);
    expect(env[BOX_KEY_ENV]).toBe("from-cwd");
  });

  it("names the wired provider's variable on the key screen and never another provider's", async () => {
    setup();
    const asked = fakeIO([""], true);
    expect(await loadHeld(asked, { env: box, cwd, home }, { anthropic: false, noSolari: "offer" }, BOX_KEY_ENV)).toEqual({});
    const screen = stripVTControlCharacters(asked.output[0]!);
    // The title is the row's own words for its key, and the variable is said once, where the line says where to put
    // it so this screen is not drawn again.
    expect(screen.split("\n")[0]).toBe("Box API key");
    expect(screen.match(new RegExp(BOX_KEY_ENV, "g"))).toHaveLength(1);
    expect(screen).toContain(`No ${BOX_KEY_ENV} in the environment, ./.env, or ~/.wsp/.env.`);
    expect(screen.toLowerCase()).not.toContain("solari");
    // With no provider named, the cloud a key alone wires is the one offered, by its own variable.
    const plain = fakeIO([""], true);
    await loadKeys(plain, { env: {}, cwd, home }, { anthropic: false, noSolari: "offer" });
    expect(stripVTControlCharacters(plain.output[0]!)).toContain(SOLARI_KEY_ENV);
    expect(stripVTControlCharacters(plain.output[0]!)).not.toContain(BOX_KEY_ENV);
    // A provider that reads no key is asked for none: there is no screen to open.
    const docker = fakeIO([], true);
    expect(await loadHeld(docker, { env: { WSP_PROVIDER: "docker" }, cwd, home }, { anthropic: false, noSolari: "offer" })).toEqual({});
    expect(docker.output).toEqual([]);
  });

  it("puts a typed key to the picked provider's own probe, with that provider's own key header", async () => {
    setup();
    const called: { url: string; auth: unknown }[] = [];
    vi.stubGlobal("fetch", (url: string | URL, init?: { headers?: Record<string, string> }) => {
      called.push({ url: String(url), auth: init?.headers?.["Authorization"] });
      return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    });
    await keySources(box).checkKey!("box_fake_key");
    await keySources({}).checkKey!("slr_live_fake_key");
    expect(called).toEqual([
      { url: `${BOX_API_URL}/limits`, auth: "Bearer box_fake_key" },
      { url: "https://api.getsolari.com/templates", auth: "Bearer slr_live_fake_key" },
    ]);
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
    expect(held(await run)).toEqual({ SOLARI_API_KEY: SOLARI });
    const out = s.text();
    expect(out).toContain("◆  Solari API key\n┃  No SOLARI_API_KEY in the environment, ./.env, or ~/.wsp/.env.\n┃  console.getsolari.com\n┃  _\n┗  enter next • esc cancel");
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
    expect(held(await run)).toEqual({ SOLARI_API_KEY: SOLARI });
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
      "Solari API key: no terminal to ask on; set SOLARI_API_KEY in the environment, ./.env, or ~/.wsp/.env.",
    );
    // The variable is the wired provider's own, so a run under a service says what to put in a file rather than
    // leaving a reader of that log to guess which key the words are about.
    await expect(loadKeys(screen(false).io, { env: { WSP_PROVIDER: "box" }, cwd, home })).rejects.toThrow(
      `Box API key: no terminal to ask on; set ${BOX_KEY_ENV} in the environment, ./.env, or ~/.wsp/.env.`,
    );
    await expect(loadKeys(s.io, { env: {}, cwd, home }).then(() => "ok", exitClassOf)).resolves.toBe("auth");
    await expect(s.io.ask("Save the key so wsp stops asking?").then(() => "ok", exitClassOf)).resolves.toBe("provider");
    expect(s.text()).toBe("");
  });
});
