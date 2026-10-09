// SPDX-License-Identifier: AGPL-3.0-only
// The wsp verbs against a host over the fake runtime: each one a client of
// the protocol on localhost, authenticated with the token the host wrote,
// reading the same session index the sidebar reads.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { AGENTS_ON, HERE_PLACE_ID, EXIT_CODES, unknownAgentLine, noSuchPlaceRefusal, type PlaceView, noFastLine } from "@wsp/protocol";
import { createRuntime } from "@wsp/runtime";
import { describe, expect, it, vi } from "vitest";
import { cli, localWiring, serve } from "../src/cli.js";
import { placeWiring } from "../src/places.js";
import { dialHost, noHostServingLine, threadTree } from "../src/verbs.js";
import { withRefused } from "../../runtime/test/fs-refusal.js";
import { fakeDaemonStart, projectOn, EXPORT_SESSION, EXPORT_SOURCE, captured, exportGuest, heldAgent, type Captured } from "./verbs-fixture.js";
import { runsFromItsOwnFolder } from "./own-folder.js";
import { CLOUD_ON } from "../src/cloud.js";
import { verbsHost } from "./verbs-host.js";

runsFromItsOwnFolder();

// A path the process may not read is refused here and not by chmod: these tests run as root, which reads anything.
vi.mock("node:fs", async importOriginal => (await import("../../runtime/test/fs-refusal.js")).refusingFs(await importOriginal<typeof import("node:fs")>()));

describe("wsp verbs over the host: folders, export and what a person sets", () => {
  const h = verbsHost();

  /** A folder on this computer with one source file and one secret-shaped file, not a repository. */
  function projectFolder(): string {
    const proj = join(h.dir, "proj");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "index.ts"), "export const a = 1;\n");
    writeFileSync(join(proj, ".env"), "API_TOKEN=sk-ant-x\n");
    return proj;
  }
  const landings = (): string[] => h.backend.machines[0]!.runLog.filter(s => s.includes("mv "));

  it("folders lists one level of this computer's folders with the repository marked and the hidden ones counted, and refuses a path outside the roots", async () => {
    const home = join(h.dir, "user");
    mkdirSync(join(home, "code", "spoo", ".git"), { recursive: true });
    mkdirSync(join(home, "code", "notes"), { recursive: true });
    mkdirSync(join(home, "code", ".cache"), { recursive: true });
    const { code, io } = await h.run("folders", join(home, "code"));
    expect(code).toBe(0);
    const lines = io.lines[0]!.split("\n");
    const cells = (line: string): string[] => line.split(/ {2,}/);
    expect(cells(lines[0]!)).toEqual(["FOLDER", "GIT"]);
    expect(lines.slice(1, 3).map(cells)).toEqual([[join(home, "code", "notes")], [join(home, "code", "spoo"), "git"]]);
    expect(lines.at(-1)).toBe(`2 folders in ${join(home, "code")}, 1 hidden. Browsable: ${home}.`);
    // The dot-named folder is a row only when it is asked for, and --json is the listing the app's picker reads.
    const shown = await h.run("folders", join(home, "code"), "--hidden", "--json");
    expect(h.json(shown.io)).toEqual([{ dir: join(home, "code"), roots: [home], folders: [{ path: join(home, "code", ".cache"), repo: false }, { path: join(home, "code", "notes"), repo: false }, { path: join(home, "code", "spoo"), repo: true }], hidden: 1 }]);
    const outside = await h.run("folders", "/etc");
    expect(outside.code).toBe(1);
    expect(outside.io.errors.join("\n")).toBe(`wsp folders: /etc is outside the folders wsp browses on this computer: ${home}`);
    const many = await h.run("folders", join(home, "code"), join(home, "Applications"));
    // A line refused before anything was dialled is a usage refusal, which is the code an agent branches on.
    expect(many.code).toBe(3);
    expect(many.io.errors.join("\n")).toContain("takes one folder on this computer at most");
  });

  it("folders --on reads the computer it names, this computer by its own name, and refuses a name nobody holds with the computers there are", async () => {
    const home = join(h.dir, "user");
    mkdirSync(join(home, "code"), { recursive: true });
    const client = await dialHost(h.statePath);
    let places: PlaceView[];
    try {
      places = (await client.request<{ places: PlaceView[] }>("places.list")).places;
    } finally {
      client.close();
    }
    const here = places.find(p => p.id === HERE_PLACE_ID)!;
    const mine = await h.run("folders", "--on", here.name, "--json");
    expect(mine.code).toBe(0);
    expect(h.json(mine.io)[0]).toMatchObject({ dir: home, roots: [home] });
    const nobody = await h.run("folders", "--on", "nowhere");
    expect(nobody.code).toBe(EXIT_CODES.usage);
    expect(nobody.io.errors.join("\n")).toContain(noSuchPlaceRefusal("nowhere", places.map(p => p.name)));
  });

  it("terminal config reads this computer's Ghostty config with its theme, prints it as Ghostty lines or one object, resolves the scheme asked for, and refuses a word outside light and dark", async () => {
    const home = join(h.dir, "user");
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
    mkdirSync(join(home, ".config", "ghostty", "themes"), { recursive: true });
    writeFileSync(join(home, ".config", "ghostty", "config"), "theme = light:Day,dark:Night\nfont-family = Berkeley Mono\nfont-size = 13\nbackground-opacity = 0.9\n");
    writeFileSync(join(home, ".config", "ghostty", "themes", "Night"), "background = #1e1e2e\nforeground = #cdd6f4\npalette = 1=#f38ba8\n");
    writeFileSync(join(home, ".config", "ghostty", "themes", "Day"), "background = #fafafa\n");
    const { code, io } = await h.run("terminal", "config");
    expect(code).toBe(0);
    expect(io.lines[0]!.split("\n")).toEqual([
      `Read ${join(home, ".config", "ghostty", "config")}, ${join(home, ".config", "ghostty", "themes", "Night")}`,
      "font-family = Berkeley Mono",
      "font-size = 13",
      "theme = Night",
      "background = #1e1e2e",
      "foreground = #cdd6f4",
      "palette = 1 of 16 colors",
      "background-opacity = 0.9",
    ]);
    const light = await h.run("terminal", "config", "--scheme", "light", "--json");
    expect(light.code).toBe(0);
    expect(h.json(light.io)).toEqual([
      expect.objectContaining({ files: [join(home, ".config", "ghostty", "config"), join(home, ".config", "ghostty", "themes", "Day")], theme: "Day", background: { r: 250, g: 250, b: 250 }, fontFamily: ["Berkeley Mono"], fontSize: 13, backgroundOpacity: 0.9 }),
    ]);
    // The same answer the app gets over the host's socket, so the line and the pane never disagree.
    const client = await dialHost(h.statePath);
    try {
      expect(await client.request("host.terminalConfig", { scheme: "light" })).toMatchObject({ config: h.json(light.io)[0] });
    } finally {
      client.close();
    }
    const sepia = await h.run("terminal", "config", "--scheme", "sepia");
    expect(sepia.code).toBe(3);
    expect(sepia.io.errors).toEqual(['wsp terminal config: --scheme takes one of light, dark, and got "sepia". Name one of those.']);
    const extra = await h.run("terminal", "config", "now");
    expect(extra.code).toBe(3);
    // No config at all is not a failure: the empty object says the pane keeps its defaults.
    rmSync(join(home, ".config", "ghostty"), { recursive: true });
    const none = await h.run("terminal", "config", "--json");
    expect(none.code).toBe(0);
    expect(h.json(none.io)).toEqual([{ files: [], fontFamily: [], palette: Array<null>(16).fill(null) }]);
  });

  it("a folder inside the roots this Mac will not let the host read comes back as one stderr line at the provider's code, not a usage refusal", async () => {
    const home = join(h.dir, "user");
    const shut = join(home, "Documents");
    mkdirSync(shut, { recursive: true });
    const words = `EACCES: permission denied, scandir '${shut}'`;
    const refused = await withRefused(shut, () => h.run("folders", shut));
    expect(refused.code).toBe(1);
    expect(refused.io.errors).toEqual([`wsp folders: ${words}`]);
    // The machine said no, so the class is the provider's on the JSON door too, where stdout stays empty.
    const asJson = await withRefused(shut, () => h.run("folders", shut, "--json"));
    expect(asJson.io.lines).toEqual([]);
    expect(asJson.io.errors).toHaveLength(1);
    expect(JSON.parse(asJson.io.errors[0]!)).toEqual({ error: words, class: "provider", exit: 1 });
  });







  it("export brings the folder home to the path given, streams the stages, prints the done line, and keys the sessions to the folder in the homes here", async () => {
    const guest = exportGuest(h.backend);
    await h.run("new", "alpha");
    const dest = join(h.dir, "out", "proj");
    const { code, io } = await h.run("export", "alpha", dest, "--from", EXPORT_SOURCE);
    expect(io.errors).toEqual([]);
    expect(code).toBe(0);
    expect(readFileSync(join(dest, "src", "index.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(readFileSync(join(dest, ".env"), "utf8")).toBe("TOKEN=x\n");
    const real = realpathSync(dest);
    const key = real.replace(/[^A-Za-z0-9]/g, "-");
    expect(readFileSync(join(h.dir, "user", ".claude", "projects", key, "S1.jsonl"), "utf8")).toBe(EXPORT_SESSION(real));
    expect(io.lines).toEqual([`2 files, 28 B, landed at ${dest}; 1 cache left behind; sessions: Claude Code (1 session) moved.`]);
    expect(io.streamed.split("\n").filter(l => l !== "")).toEqual(expect.arrayContaining([`Packing ${EXPORT_SOURCE} on the machine.`, "Packing the agents' state for it on the machine.", `Landing at ${dest}.`]));
    expect(io.streamed).not.toContain("landed at");
    expect(guest.sources).toEqual([EXPORT_SOURCE]);
  });

  it("export refuses an existing folder in two lines, the second naming --replace, and replaces it when asked; --from defaults to the folder's own path; --agents narrows; --json prints the result", async () => {
    const guest = exportGuest(h.backend);
    await h.run("new", "alpha");
    const dest = join(h.dir, "out", "proj");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "old.txt"), "old");
    const refused = await h.run("export", "alpha", dest);
    expect(refused.code).toBe(1);
    expect(refused.io.lines).toEqual([]);
    expect(refused.io.errors).toEqual([`wsp export: ${dest} already exists on this computer with 1 file; export with replace to overwrite it\nRun again with --replace to overwrite it.`]);
    expect(guest.sources).toEqual([]);
    const replaced = await h.run("export", "alpha", dest, "--replace", "--agents", "codex,pi", "--json");
    expect(replaced.code).toBe(0);
    expect(replaced.io.errors).toEqual([]);
    expect(h.json(replaced.io)).toEqual([{ dest, files: 2, bytes: 28, excluded: ["node_modules"], agents: [] }]);
    expect(replaced.io.streamed).toBe("");
    expect(existsSync(join(dest, "old.txt"))).toBe(false);
    expect(guest.sources).toEqual([dest]);
    expect(existsSync(join(h.dir, "user", ".claude"))).toBe(false);
  });

  it("export refuses an --agents id the catalog does not know before anything reaches the machine, naming it and the ids it knows", async () => {
    const guest = exportGuest(h.backend);
    await h.run("new", "alpha");
    const typo = await h.run("export", "alpha", join(h.dir, "out", "proj"), "--agents", "claude,codx");
    expect(typo.code).toBe(3);
    expect(typo.io.lines).toEqual([]);
    expect(typo.io.errors).toEqual([`wsp export: ${unknownAgentLine("codx", CATALOG_AGENTS.map(a => a.id))}. Name one of those, or drop the flag.`]);
    expect(guest.sources).toEqual([]);
    expect(existsSync(join(h.dir, "out"))).toBe(false);
  });

  it.runIf(CLOUD_ON)("every verb takes --json and --help; a bad flag prints the usage", async () => {
    for (const verb of [["fork"], ["snapshot"], ["pause"], ["wake"], ["forget"], ["delete"], ["threads"], ["threads", "wait"], ["run"], ["send"], ["stop"], ["exec"], ["projects"], ["export"]]) {
      const help = await h.run(...verb, "--help");
      expect(help.code).toBe(0);
      expect(help.io.lines[0]).toMatch(new RegExp(`^usage: wsp ${verb.join(" ")}`));
      expect(help.io.lines[0]).toContain("--json");
    }
    const bad = await h.run("threads", "--nope");
    expect(bad.code).toBe(3);
    expect(bad.io.errors[0]).toContain("Unknown option '--nope'");
    expect(bad.io.errors[0]).toContain("usage: wsp threads");
    // A flag another verb reads is refused naming that verb, so the caller is told where it lives: run's --agent on send, threads' --tree on stop.
    const foreign = await h.run("send", "row_1", "--agent", "claude", "hello");
    expect(foreign.code).toBe(3);
    expect(foreign.io.errors).toEqual(['--agent belongs to wsp skills add, wsp servers signin, wsp servers tools, wsp servers add, wsp servers remove, wsp servers disable, wsp servers enable, wsp projects set, wsp fork, wsp start, wsp review and wsp run; wsp send does not read it. usage: wsp send <thread> [--model, --effort <value>] [--fast] [--file <path>] [--detach] "<message>"']);
    const within = await h.run("stop", "row_1", "--tree");
    expect(within.io.errors[0]).toContain("--tree belongs to wsp threads; wsp stop does not read it");
    // A flag wsp used to read is nobody's now: the parser's own line, with the verb's usage under it.
    const old = await h.run("threads", "--in", "alpha");
    expect(old.code).toBe(3);
    expect(old.io.errors[0]).toContain("Unknown option '--in'");
    expect(old.io.errors[0]).toContain("usage: wsp threads");
    // A flag spelled like a prototype member is nobody's: the tables are read as own keys, so it gets the parser's line.
    const proto = await h.run("threads", "--constructor");
    expect(proto.code).toBe(3);
    expect(proto.io.errors[0]).toContain("Unknown option '--constructor'");
    expect(proto.io.errors[0]).not.toContain("belongs to");
    const half = await h.run("thread");
    expect(half.code).toBe(3);
    expect(half.io.errors).toEqual([
      'wsp thread opens a line rather than being one. usage: wsp thread read <thread> [--last]\nusage: wsp thread head <thread>\nusage: wsp thread rename <thread> "<title>"\nusage: wsp thread forget <thread> [--yes]\nusage: wsp thread settle <thread>... [--finished]\nusage: wsp thread restore <thread>...\nusage: wsp thread allow <thread>\nusage: wsp thread deny <thread> [--reason "<words>"]',
    ]);
  });

  it("without a host serving the state file, and with nothing to start one, every verb refuses in one line before dialling anything", async () => {
    await h.handle!.close();
    h.handle = undefined;
    const io = captured();
    expect(await cli(["threads", "--state", h.statePath], io, undefined, h.env, false)).toBe(1);
    expect(io.errors).toEqual([`wsp threads: ${noHostServingLine(h.statePath)}`]);
  });

  it("a wrong token is refused by the host, under the auth class", async () => {
    writeFileSync(join(h.dir, "state", "host-token"), "not-the-token\n");
    const { code, io } = await h.run("threads");
    expect(code).toBe(2);
    expect(io.errors).toEqual(["wsp threads: unauthorized"]);
  });

  describe("what a person sets on one of their computers", () => {
    it("sets threads at once on a computer by its name or id, answers the row with its default beside it, and a reset takes it back", async () => {
      const here = (await h.rt.places!.rows()).find(p => p.id === HERE_PLACE_ID)!;
      const fallback = (here.capDefault as { threads: number }).threads;
      const set = await h.run("computers", "set", HERE_PLACE_ID, "--threads", "2");
      expect(set.code, set.io.errors.join("\n")).toBe(0);
      expect(set.io.lines).toEqual([`${here.name}: 2 threads at once (${fallback} by default), no turn limit (the default), agents may spawn: up to 3 workspaces (the default), 2 levels deep (the default)`]);
      expect((await h.rt.places!.rows()).find(p => p.id === HERE_PLACE_ID)).toMatchObject({ cap: { threads: 2 }, settings: { threads: 2 } });
      const asJson = await h.run("computers", "set", here.name, "--threads", "1", "--json");
      expect(h.json(asJson.io).at(-1)).toMatchObject({ computer: { id: HERE_PLACE_ID, cap: { threads: 1 }, capDefault: { threads: fallback } } });
      const back = await h.run("computers", "set", HERE_PLACE_ID, "--reset", "threads");
      expect(back.io.lines).toEqual([`${here.name}: ${fallback} ${fallback === 1 ? "thread" : "threads"} at once (the default), no turn limit (the default), agents may spawn: up to 3 workspaces (the default), 2 levels deep (the default)`]);
      expect((await h.rt.places!.rows()).find(p => p.id === HERE_PLACE_ID)!.settings).toBeUndefined();
    });

    it("sets the nap after on a computer that forks in minutes or off, and refuses it on this one and past three hours", async () => {
      // The host again with its provider wired as a place, which is a row whose workspaces nap.
      await h.handle?.close();
      h.rt = createRuntime({ statePath: h.statePath, backend: h.backend, store: h.store, adapters: { claude: h.claude.adapter }, local: localWiring(join(h.dir, "user"), process.env, fakeDaemonStart, h.statePath, h.copier), placeLinks: { ...placeWiring(h.statePath), provider: () => ({ id: "default", rateUsdPerHour: 0.1 }) }, daemonChannel: h.daemon.open });
      h.handle = await serve(captured(), { port: 0, statePath: h.statePath, webDir: join(h.dir, "web"), runtime: h.rt });
      const forks = (await h.rt.places!.rows()).find(p => p.takesForks === true)!;
      const set = await h.run("computers", "set", forks.id, "--nap", "5");
      expect(set.code, set.io.errors.join("\n")).toBe(0);
      expect(set.io.lines[0]).toContain("naps after 5m (20m by default)");
      const off = await h.run("computers", "set", forks.id, "--nap", "off", "--json");
      expect(h.json(off.io).at(-1)).toMatchObject({ computer: { napMs: null, settings: { napMs: null } } });
      const here = await h.run("computers", "set", HERE_PLACE_ID, "--nap", "5");
      expect(here.code).toBe(EXIT_CODES.usage);
      expect(here.io.errors[0]).toContain("not nap after");
      const long = await h.run("computers", "set", forks.id, "--nap", "181");
      expect(long.code).toBe(EXIT_CODES.usage);
      expect(long.io.errors[0]).toBe(`wsp computers set: --nap for ${forks.id} takes whole minutes from 1 to 180, or off, and got "181". Write it as --nap 20 or --nap off.`);
    });

    it("sets the turn limit in whole hours or off, on this computer and on a cloud, and a reset takes it back", async () => {
      await h.handle?.close();
      h.rt = createRuntime({ statePath: h.statePath, backend: h.backend, store: h.store, adapters: { claude: h.claude.adapter }, local: localWiring(join(h.dir, "user"), process.env, fakeDaemonStart, h.statePath, h.copier), placeLinks: { ...placeWiring(h.statePath), provider: () => ({ id: "default", rateUsdPerHour: 0.1 }) }, daemonChannel: h.daemon.open });
      h.handle = await serve(captured(), { port: 0, statePath: h.statePath, webDir: join(h.dir, "web"), runtime: h.rt });
      const set = await h.run("computers", "set", HERE_PLACE_ID, "--turn-limit", "8");
      expect(set.code, set.io.errors.join("\n")).toBe(0);
      expect(set.io.lines[0]).toContain("stops a turn at 8h (off by default)");
      const cloud = (await h.rt.places!.rows()).find(p => p.kind === "provider")!;
      expect(cloud).toMatchObject({ turnLimitMs: 6 * 3_600_000, turnLimitDefault: 6 * 3_600_000 });
      const off = await h.run("computers", "set", cloud.id, "--turn-limit", "off", "--json");
      expect(h.json(off.io).at(-1)).toMatchObject({ computer: { turnLimitMs: null, turnLimitDefault: 6 * 3_600_000, settings: { turnLimitMs: null } } });
      const back = await h.run("computers", "set", cloud.id, "--reset", "turn-limit");
      expect(back.io.lines[0]).toContain("stops a turn at 6h (the default)");
      for (const word of ["0", "25", "1.5", "six"]) {
        const wrong = await h.run("computers", "set", HERE_PLACE_ID, "--turn-limit", word);
        expect(wrong.code).toBe(EXIT_CODES.usage);
        expect(wrong.io.errors[0]).toBe(`wsp computers set: --turn-limit for ${HERE_PLACE_ID} takes whole hours from 1 to 24, or off, and got ${JSON.stringify(word)}. Write it as --turn-limit 6 or --turn-limit off.`);
      }
      expect((await h.rt.places!.rows()).find(p => p.id === HERE_PLACE_ID)).toMatchObject({ turnLimitMs: 8 * 3_600_000 });
    });

    it("sets whether agents there may start agents for every workspace that says nothing of its own, and a workspace reads it", async () => {
      await h.run("new", "alpha");
      const off = await h.run("computers", "set", HERE_PLACE_ID, "--spawn", "off");
      expect(off.code, off.io.errors.join("\n")).toBe(0);
      expect(off.io.lines[0]).toContain("agents may not spawn (on, up to 3 by default)");
      const capped = await h.run("computers", "set", HERE_PLACE_ID, "--spawn", "on", "--max-machines", "1", "--json");
      expect(h.json(capped.io).at(-1)).toMatchObject({ computer: { spawn: { spawn: true, maxMachines: 1, maxDepth: 2 } } });
      const mac = await h.macProject("mine");
      expect(mac.code, mac.io.errors.join("\n")).toBe(0);
      expect((await h.rt.workspaces.list()).find(w => w.name === "mine")!.agents).toEqual({ spawn: true, maxMachines: 1, maxDepth: 2 });
      const wrong = await h.run("computers", "set", HERE_PLACE_ID, "--spawn", "yes");
      expect(wrong.code).toBe(EXIT_CODES.usage);
      expect(wrong.io.errors[0]).toContain("--spawn for here takes on or off");
      expect((await h.run("computers", "set", HERE_PLACE_ID, "--reset", "spawn")).code).toBe(0);
      expect((await h.rt.workspaces.list()).find(w => w.name === "mine")!.agents).toEqual(AGENTS_ON);
    });

    it("refuses a count that is not a whole number of one or more, a word reset does not take, and a line that sets nothing, as usage", async () => {
      const zero = await h.run("computers", "set", HERE_PLACE_ID, "--threads", "0");
      expect(zero.code).toBe(EXIT_CODES.usage);
      expect(zero.io.errors[0]).toBe('wsp computers set: --threads for here takes a whole number of one or more, and got "0". Write it as --threads <n>.');
      // Every refusal of a flag's shape names the computer, as the host's own refusals on this verb do.
      const depth = await h.run("computers", "set", HERE_PLACE_ID, "--max-depth", "0");
      expect(depth.io.errors[0]).toContain('--max-depth for here takes a whole number of one or more, and got "0"');
      const wrong = await h.run("computers", "set", HERE_PLACE_ID, "--reset", "everything");
      expect(wrong.code).toBe(EXIT_CODES.usage);
      expect(wrong.io.errors[0]).toContain("--reset for here takes one of threads");
      const nothing = await h.run("computers", "set", HERE_PLACE_ID);
      expect(nothing.code).toBe(EXIT_CODES.usage);
      expect(nothing.io.errors[0]).toContain("nothing to set on");
      const none = await h.run("computers", "set");
      expect(none.code).toBe(EXIT_CODES.usage);
    });
  });

  describe("what the agents on a workspace may do", () => {
    it("the switch is on under the default caps until a person turns it off, and the record carries it", async () => {
      await h.run("new", "alpha");
      expect((await h.rt.workspaces.list())[0]!.agents).toEqual(AGENTS_ON);
      const on = await h.run("workspaces", "agents", "alpha", "--spawn", "on", "--max-machines", "2");
      expect(on.code).toBe(0);
      expect(on.io.lines).toEqual(["alpha: agents may spawn: up to 2 workspaces"]);
      expect((await h.rt.workspaces.list())[0]!.agents).toEqual({ spawn: true, maxMachines: 2, maxDepth: 2 });
      const back = await h.run("workspaces", "agents", "alpha", "--spawn", "off");
      expect(back.io.lines).toEqual(["alpha: agents may not spawn"]);
      // Off keeps the numbers it was given rather than throwing them away, so turning it on again is one word.
      expect((await h.rt.workspaces.list())[0]!.agents).toEqual({ spawn: false, maxMachines: 2, maxDepth: 2 });
    });

    it("a cap alone tightens the switch it finds and leaves it on or off, and a word that is neither on nor off, or no word at all, is refused", async () => {
      await h.run("new", "alpha");
      const tightened = await h.run("workspaces", "agents", "alpha", "--max-machines", "2");
      expect(tightened.code, tightened.io.errors.join("\n")).toBe(0);
      expect((await h.rt.workspaces.list())[0]!.agents).toEqual({ ...AGENTS_ON, maxMachines: 2 });
      expect((await h.run("workspaces", "agents", "alpha", "--spawn", "off")).code).toBe(0);
      expect((await h.run("workspaces", "agents", "alpha", "--max-depth", "2")).code).toBe(0);
      expect((await h.rt.workspaces.list())[0]!.agents).toEqual({ spawn: false, maxMachines: 2, maxDepth: 2 });
      expect((await h.run("workspaces", "agents", "alpha", "--spawn", "on")).code).toBe(0);
      const wrong = await h.run("workspaces", "agents", "alpha", "--spawn", "yes");
      expect(wrong.code).toBe(EXIT_CODES.usage);
      expect(wrong.io.errors[0]).toContain("--spawn takes on or off");
      const none = await h.run("workspaces", "agents", "alpha");
      expect(none.code).toBe(EXIT_CODES.usage);
      expect(none.io.errors[0]).toContain("--max-machines");
      expect((await h.rt.workspaces.list())[0]!.agents).toEqual({ spawn: true, maxMachines: 2, maxDepth: 2 });
      // A new workspace takes a cap alone the same way, on the default switch.
      expect((await h.run("new", "beta", "--max-machines", "1")).code).toBe(0);
      expect((await h.rt.workspaces.list()).find(w => w.name === "beta")!.agents).toEqual({ ...AGENTS_ON, maxMachines: 1 });
    });

    it("--max-depth 0 is a usage sentence, not a shape the wire refuses", async () => {
      await h.run("new", "alpha");
      const zero = await h.run("workspaces", "agents", "alpha", "--spawn", "on", "--max-depth", "0");
      expect(zero.code).toBe(EXIT_CODES.usage);
      expect(zero.io.errors[0]).toBe('wsp workspaces agents: --max-depth takes a whole number of one or more, and got "0". Write it as --max-depth <n>.');
      // Zero machines is a switch that is on and forks nothing, which is a thing a person may mean.
      const none = await h.run("workspaces", "agents", "alpha", "--spawn", "on", "--max-machines", "0");
      expect(none.code).toBe(0);
      expect((await h.rt.workspaces.list())[0]!.agents).toEqual({ spawn: true, maxMachines: 0, maxDepth: 2 });
    });

    it("a project folder on this computer takes the switch, by the project's name, since its agents reach the host as themselves", async () => {
      const folder = realpathSync(mkdtempSync(join(h.dir, "repo-mine-")));
      execFileSync("git", ["init", "-q", folder]);
      await projectOn(h.rt, HERE_PLACE_ID, folder, { name: "mine" });
      const made = await h.run("new", "mine", "mine", "--spawn", "on");
      expect(made.io.errors).toEqual([]);
      expect(made.code).toBe(0);
      expect((await h.rt.workspaces.list())[0]!.agents).toEqual({ spawn: true, maxMachines: 3, maxDepth: 2 });
      const set = await h.run("workspaces", "agents", "mine", "--spawn", "off");
      expect(set.code, set.io.errors.join("\n")).toBe(0);
      expect((await h.rt.workspaces.list()).find(w => w.name === "mine")!.agents?.spawn).toBe(false);
    });

    it("a create with --spawn on turns the switch on", async () => {
      const made = await h.run("new", "alpha", "--spawn", "on", "--max-machines", "1");
      expect(made.code).toBe(0);
      expect((await h.rt.workspaces.list())[0]!.agents).toEqual({ spawn: true, maxMachines: 1, maxDepth: 2 });
    });

    it("--tree draws a thread an agent spawned under the thread that spawned it, and stop ends the tree as one", async () => {
      const held = heldAgent(false);
      await h.restartHost({ claude: held.adapter });
      await h.run("new", "alpha", "--spawn", "on");
      const alpha = (await h.rt.workspaces.list())[0]!;
      const lead = await h.rt.sessions.start(alpha.id, { prompt: "lead" });
      const leadThread = lead.view().threadId!;
      const child = await h.rt.sessions.start(alpha.id, { prompt: "builder" }, { origin: "relayed", by: { kind: "thread", threadId: leadThread, workspaceId: alpha.id, rootThreadId: leadThread } });
      const childThread = child.view().threadId!;
      // The thread's own cell is the third: a tree indents that cell and leaves the project and the workspace alone.
      const rows = (io: Captured): string[] => io.lines[0]!.split("\n").slice(1);
      expect(rows((await h.run("threads")).io).some(r => r.split(/ {2,}/)[2]!.startsWith(" "))).toBe(false);
      const drawn = rows((await h.run("threads", "--tree")).io);
      const at = drawn.findIndex(r => r.includes(leadThread));
      expect(drawn[at + 1]).toContain(`  ${childThread}`);
      // Two rows naming each other are under no top row; the listing prints every row it was given all the same.
      expect(threadTree([
        { id: "a", parentThreadId: "b" },
        { id: "b", parentThreadId: "a" },
      ] as unknown as Parameters<typeof threadTree>[0]).map(t => t.row.id).sort()).toEqual(["a", "b"]);
      const stopped = await h.run("stop", leadThread);
      expect(stopped.io.lines[0]).toBe(`thread ${leadThread} stopped, and with it 1 thread its agents spawned: ${childThread.slice(0, 8)}`);
      expect((await h.rt.sessions.list(alpha.id)).every(v => v.status !== "running")).toBe(true);
    });
  });

  describe("a file on a message from the command line", () => {
    /** A real PNG head, so the type is read off the bytes as the verbs read it; the rest is filler of a known weight. */
    const pngFile = (dirPath: string, name: string, bytes: number): string => {
      const path = join(dirPath, name);
      writeFileSync(path, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(bytes - 8, 7)]));
      return path;
    };

    it("wsp send --file reads the file here and sends its bytes, so the machine never reaches back for this computer's files", async () => {
      await h.run("new", "alpha");
      await h.run("run", "alpha", "hello");
      const [row] = await h.rt.sessions.list();
      const path = pngFile(h.dir, "shot.png", 2048);
      const sent = await h.run("send", row!.threadId!, "--file", path, "what does this show?");
      expect(sent.code).toBe(0);
      const start = h.claude.starts.at(-1)!;
      expect(start.images).toEqual([{ mediaType: "image/png", bytes: readFileSync(path).toString("base64") }]);
      // The path itself never travels: the agent is handed the bytes, not somewhere on this computer to look.
      expect(JSON.stringify(start)).not.toContain(path);
    });

    it("the flag repeats, and the images reach the agent in the order they were named", async () => {
      await h.run("new", "alpha");
      await h.run("run", "alpha", "hello");
      const [row] = await h.rt.sessions.list();
      const one = pngFile(h.dir, "one.png", 512);
      const two = pngFile(h.dir, "two.png", 1024);
      const sent = await h.run("send", row!.threadId!, "--file", one, "--file", two, "these two");
      expect(sent.code).toBe(0);
      expect(h.claude.starts.at(-1)!.images?.map(i => i.bytes)).toEqual([readFileSync(one).toString("base64"), readFileSync(two).toString("base64")]);
    });

    it("run --file opens the thread with the image on its first turn", async () => {
      await h.run("new", "alpha");
      const path = pngFile(h.dir, "opening.png", 256);
      const opened = await h.run("run", "alpha", "--file", path, "what is this?");
      expect(opened.code).toBe(0);
      expect(h.claude.starts.at(-1)!.images).toEqual([{ mediaType: "image/png", bytes: readFileSync(path).toString("base64") }]);
    });

    it("the person's turn prints one bracket per image on stderr, since a terminal draws no pixels", async () => {
      await h.run("new", "alpha");
      const path = pngFile(h.dir, "big.png", 1_258_291);
      const opened = await h.run("run", "alpha", "--file", path, "what is this?");
      expect(opened.io.streamed).toContain("[image 1 MB png]");
    });

    it("a path this computer has no file at answers in a sentence, not in the reader's own error", async () => {
      await h.run("new", "alpha");
      const missing = join(h.dir, "not-here.png");
      const refused = await h.run("send", "--file", missing, "x", "y");
      expect(refused.io.errors[0]).not.toContain("ENOENT");
      const opening = await h.run("run", "alpha", "--file", missing, "look");
      expect(opening.code).toBe(EXIT_CODES.usage);
      expect(opening.io.errors).toEqual([`wsp run: there is no file at ${missing} on this computer. Name a file that is already here.`]);
      expect(h.claude.starts).toHaveLength(0);
    });

    it("a folder named where an image should be is refused the same way, rather than failing on the read", async () => {
      await h.run("new", "alpha");
      const refused = await h.run("run", "alpha", "--file", h.dir, "look");
      expect(refused.code).toBe(EXIT_CODES.usage);
      expect(refused.io.errors).toEqual([`wsp run: there is no file at ${h.dir} on this computer. Name a file that is already here.`]);
    });

    it("a file that is not an image travels under its own name, and the agent is told where it landed", async () => {
      await h.run("new", "alpha");
      const path = join(h.dir, "notes.pdf");
      writeFileSync(path, "%PDF-1.7 not an image at all");
      const opened = await h.run("run", "alpha", "--file", path, "look");
      expect(opened.code).toBe(0);
      const start = h.claude.starts.at(-1)!;
      expect(start.images).toBeUndefined();
      expect(start.prompt).toMatch(/^look\n\nAttached files:\n- \S+\/\.wsp-files\/[^/]+\/[^/]+\/notes\.pdf$/);
      expect(opened.io.streamed).toContain("[file 28 B notes.pdf]");
    });

    it("a 12 MB image is refused with the cap in the sentence, and the file is never read whole", async () => {
      await h.run("new", "alpha");
      const path = pngFile(h.dir, "huge.png", 12 * 1024 * 1024);
      const refused = await h.run("run", "alpha", "--file", path, "look");
      expect(refused.code).toBe(EXIT_CODES.usage);
      expect(refused.io.errors).toEqual(["wsp run: huge.png is 12 MB, over the 10 MB an image may be. Drop that one and send the rest."]);
      expect(h.claude.starts).toHaveLength(0);
    });

    it("six files are refused with both counts", async () => {
      await h.run("new", "alpha");
      const paths = Array.from({ length: 6 }, (_, i) => pngFile(h.dir, `n${i}.png`, 64));
      const refused = await h.run("run", "alpha", ...paths.flatMap(p => ["--file", p]), "look");
      expect(refused.code).toBe(EXIT_CODES.usage);
      expect(refused.io.errors).toEqual(["wsp run: only 5 files fit one message; this one carries 6. Drop that one and send the rest."]);
    });

    it("--fast runs the turn in the agent's fast mode on a model that offers one, and is refused by the model's name on one that does not", async () => {
      await h.run("new", "alpha");
      const opened = await h.run("run", "alpha", "--fast", "hello");
      expect(opened.code).toBe(0);
      expect(h.claude.starts.at(-1)!.fast).toBe(true);
      const refused = await h.run("run", "alpha", "--model", "claude-haiku-4-5-20251001", "--fast", "hello");
      expect(refused.code).toBe(EXIT_CODES.usage);
      expect(refused.io.errors[0]).toContain(noFastLine("Haiku 4.5"));
      const [row] = await h.rt.sessions.list();
      expect((await h.run("send", row!.threadId!, "--fast", "again")).code).toBe(0);
      expect(h.claude.starts.at(-1)!.fast).toBe(true);
    });

    it("--fast on a send that names no model is checked against the model the thread runs on", async () => {
      await h.run("new", "alpha");
      expect((await h.run("run", "alpha", "--model", "claude-haiku-4-5-20251001", "hello")).code).toBe(0);
      const haiku = (await h.rt.sessions.list()).at(-1)!;
      const starts = h.claude.starts.length;
      const refused = await h.run("send", haiku.threadId!, "--fast", "again");
      expect(refused.code).toBe(EXIT_CODES.usage);
      expect(refused.io.errors[0]).toContain(noFastLine("Haiku 4.5"));
      expect(h.claude.starts).toHaveLength(starts);
    });
  });
});
