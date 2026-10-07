// SPDX-License-Identifier: AGPL-3.0-only
// The four words about where a person's agents run. The join here dials a
// real ws server holding a real ed25519 pair, so the handshake typed on a
// computer is the one a host answers; the service manager is a fake runner,
// since installing a launchd agent is not this test's business.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ALREADY_JOINED_LINE, backUrl, PLACE_LOGIN_REFUSED_KIND, PLACE_HOST_KEY_KIND, PLACE_SUDO_KIND, hostKeyMismatchRefusal, hostKeyUnconfirmedRefusal, hostKeyUnscannableRefusal, PLACE_ROOT_SHELLS, placeRootShellRefusal, PLACE_NEEDS_ROOT_LINE, PlaceReport, joinToken, placeFileText, placeDaemonPaths, shellQuote, workFolderIn, type PlaceBack } from "@wsp/protocol";
import { PlaceAddTakenBackError, PlaceLoginRefusedError, type PlaceBackHolder, type PlaceLogin, type PlaceStaging } from "@wsp/runtime";
import { MissingKnownHostsError, missingKnownHostsLine, SshBackend, SSH_READ_SCRIPT, SSH_SUDO_READ, SSH_WORD_REFUSAL, keyFingerprint, sshWordReach, type SshReach, type SshRiding, type SshSudo, type SshSudoRoad, type SshTransport } from "@wsp/engine";
import { daemonBinaryIn, GUEST_DAEMON_TARGETS, noGuestDaemonLine, noPlaceSystemLine } from "../src/daemon-binary.js";
import { ADD_FOUND_END, ADD_TAKEN_LINE, DAEMON_GONE_LINE, joinedAddWrites, joinedLine, joinedPlace, PLACE_JOINED_LINE, WSP_READY_LINE } from "../src/doctor.js";
import { placeInstaller, addLineWords, backRefusedLine, dialsBackOverSshNote, placeHeldRefusal, reachScript, unreachedLine, UNSAID_CHIP_REFUSAL, ADD_LOOPBACK_REFUSAL, advertisedLoopbackRefusal, placeUnit, joinUnansweredLine, addUndoneLine, addTakenLine, placeRootHomeRefusal, PLACE_CHECK_SCRIPT, placeNoRootLine } from "../src/places.js";
import { BackCutError, backBindLine, heldPlaceScript } from "../src/place-back.js";
import { placeReport } from "../src/place-report.js";
import { opts, spooConfig, tmp } from "./places-fixture.js";

describe("the install over ssh marks its steps off the lines the deploy prints", () => {
  /** A daemon asset folder with a stand-in binary per guest target named, and a wsp command as npm lays it out.
   * Named none and it holds every target, which is a release; named one, it is a checkout that built that one. */
  function assets(root: string, targets: readonly { triple: string }[] = GUEST_DAEMON_TARGETS): { daemonDir: string; cliDir: string } {
    const daemonDir = join(root, "daemon");
    for (const target of targets) {
      mkdirSync(join(daemonDir, target.triple), { recursive: true });
      writeFileSync(daemonBinaryIn(daemonDir, target.triple), `#!/bin/sh\necho ${target.triple}\n`, { mode: 0o755 });
    }
    const cliDir = join(root, "cli");
    mkdirSync(join(cliDir, "dist"), { recursive: true });
    writeFileSync(join(cliDir, "dist", "bin.js"), "");
    writeFileSync(join(cliDir, "package.json"), JSON.stringify({ name: "@wsp-labs/wsp", version: "0.0.0" }));
    return { daemonDir, cliDir };
  }

  /** A box that takes the deploy and answers the word it is told to say about its own chip, recording every script
   * run on it and every file landed there. `arch` is what its `uname -m` answered on the read that adopted it. */
  function fakeBox(arch: string | undefined, shell = "bash", box: { reaches?: (url: string) => boolean; holds?: string; dials?: string; proxied?: boolean; home?: string; checks?: string[]; road?: SshSudoRoad; tries?: (password: string) => SshSudo; minusNRefused?: boolean } = {}): { backend: unknown; ran: string[]; landed: string[]; stages: string[]; times: Record<string, number | undefined>; stage: PlaceStaging; tried: string[]; ridden: SshRiding[]; order: string[] } {
    const tried: string[] = [];
    const order: string[] = [];
    const ridden: SshRiding[] = [];
    const ran: string[] = [];
    const landed: string[] = [];
    const stages: string[] = [];
    const machine = {
      id: "ssh://maya@box:22",
      kind: "sandbox",
      putBytes: async (path: string) => {
        landed.push(path);
      },
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      facts: async () => ({ os: "Ubuntu 24.04.4 LTS" }),
      run: async (script: string, opts?: { onLine?: (line: string) => void }) => {
        ran.push(script);
        if (script.includes("PREFLIGHT_OK")) return { exitCode: 0, stdout: "PREFLIGHT_OK\n", stderr: "" };
        if (script === heldPlaceScript("/home/maya")) return { exitCode: 0, stdout: box.holds ?? "", stderr: "" };
        if (script === PLACE_CHECK_SCRIPT) return { exitCode: 0, stdout: (box.checks ?? []).map(l => `wsp-check ${l}\n`).join(""), stderr: "" };
        const reached = reachAnswer(script, box.reaches);
        if (reached !== undefined) return reached;
        for (const line of [WSP_READY_LINE, PLACE_JOINED_LINE]) opts?.onLine?.(line);
        return { exitCode: 0, stdout: `${WSP_READY_LINE}\n${PLACE_JOINED_LINE}\nDAEMON_UP\n`, stderr: "" };
      },
    };
    const backend = {
      sudoFor: async () => {
        order.push("read");
        return box.road ?? "root";
      },
      sudoTry: async (_reach: SshReach, password: string) => {
        order.push("try");
        tried.push(password);
        return box.tries?.(password) ?? "wrong";
      },
      riding: (riding: SshRiding) => {
        ridden.push(riding);
        return backend;
      },
      hostNameFor: async (reach: SshReach) => (box.proxied === true ? undefined : (box.dials ?? reach.host)),
      adopt: async () => {
        // A sudoers the read cannot see through: the adopt under sudo -n, which rides no password, is refused.
        if (box.minusNRefused === true && ridden.length === 0) throw new Error("maya@box did not answer over ssh: sudo: a password is required");
        return { machine, login: { HOME: box.home ?? "/home/maya", PATH: "/usr/bin:/bin", USER: "maya" }, shape: { cpu: 2, memMb: 2048 }, shell, ...(arch === undefined ? {} : { arch }) };
      },
      // A computer this computer's ssh client has already met: every case below is about what the install does
      // after that, so none of them stands on the first dial of a stranger.
      keyFor: async () => BOX_KEY,
      offeredKeyFor: async () => ({ key: BOX_KEY }),
      knownHostsEntry: async () => ({ file: "/home/maya/.ssh/known_hosts", target: "box" }),
    };
    const times: Record<string, number | undefined> = {};
    return {
      backend,
      ran,
      landed,
      stages,
      times,
      tried,
      ridden,
      order,
      stage: (step, state, note, _placeId, ms) => {
        stages.push(`${step} ${state}${note === undefined ? "" : ` (${note})`}`);
        if (state !== "running") times[step] = ms;
      },
    };
  }

  /** The key the box's ssh answers with, and the key this computer's client already holds for it. */
  const BOX_KEY = "ssh-ed25519 SHA256:abc";

  /** What a box answers the reach check with: every address it was handed, reached unless `reaches` says not. */
  function reachAnswer(script: string, reaches: (url: string) => boolean = () => true): { exitCode: number; stdout: string; stderr: string } | undefined {
    if (!script.startsWith("reach() {")) return undefined;
    const urls = [...script.matchAll(/^reach '([^']+)'/gm)].map(m => m[1]!);
    return { exitCode: 0, stdout: urls.map(url => `WSP_REACH ${reaches(url) ? "ok" : "no"} ${url}\n`).join(""), stderr: "" };
  }

  const X86 = GUEST_DAEMON_TARGETS.find(t => t.uname === "x86_64")!;
  const ARM = GUEST_DAEMON_TARGETS.find(t => t.uname === "aarch64")!;

  it("sends the binary for the chip the box says it runs, on a host that holds that one alone", async () => {
    // An x86 box joined from a checkout that built the x86 Linux daemon and nothing else. The arm binary is not
    // there and is not wanted: what the box is sent is picked off the box's own word, not off this computer's chip.
    const x86 = fakeBox("x86_64");
    const install = placeInstaller({ backend: x86.backend as never, ...assets(tmp("chip-x86"), [X86]) });
    expect(await install({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, x86.stage)).toMatchObject({ name: "box" });
    const deploy = x86.ran.find(script => script.includes("uname -m"))!;
    expect(deploy).toContain(`  ${X86.uname})`);
    expect(deploy).not.toContain(ARM.uname);
    // And the reverse, from a host holding the arm one alone: nothing here is this computer's chip either way.
    const arm = fakeBox("aarch64");
    const armInstall = placeInstaller({ backend: arm.backend as never, ...assets(tmp("chip-arm"), [ARM]) });
    expect(await armInstall({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, arm.stage)).toMatchObject({ name: "box" });
    const armDeploy = arm.ran.find(script => script.includes("uname -m"))!;
    expect(armDeploy).toContain(`  ${ARM.uname})`);
    expect(armDeploy).not.toContain(X86.uname);
  });

  it("says each check on a row of its own: the chip and system, root, systemd with cgroup v2 and the room, inside the one check step", async () => {
    const box = fakeBox("x86_64", "bash", { checks: ["uid 0", "systemd yes", "cgroup2 yes", `free ${20 * 1024 ** 3}`] });
    await placeInstaller({ backend: box.backend as never, ...assets(tmp("check-rows"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, box.stage);
    expect(box.stages.filter(line => /^(check|chip|root|system|disk) /.test(line))).toEqual([
      "check running",
      "chip done (x86_64)",
      "root running",
      "root done",
      "system running",
      "system done (systemd, cgroup v2)",
      "disk running",
      "disk done (20 GB free)",
      "check done (root, systemd, cgroup v2, 20 GB free)",
    ]);
  });

  it("says how long each step took as it ends: the checks as the box timed them, every other step as this host did", async () => {
    const box = fakeBox("x86_64", "bash", { checks: ["uid 0", "ms root 2", "systemd yes", "cgroup2 yes", "ms system 3", `free ${20 * 1024 ** 3}`, "ms disk 14"] });
    await placeInstaller({ backend: box.backend as never, ...assets(tmp("check-times"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, box.stage);
    expect([box.times["root"], box.times["system"], box.times["disk"]]).toEqual([2, 3, 14]);
    for (const step of ["connect", "check", "reach", "wsp"]) expect(box.times[step], step).toEqual(expect.any(Number));
  });

  it("fails the one check a box does not pass on its own row, with the sentence that names the fix", async () => {
    const box = fakeBox("x86_64", "bash", { checks: ["uid 0", "systemd yes", "cgroup2 no"] });
    await expect(placeInstaller({ backend: box.backend as never, ...assets(tmp("check-fails"), [X86]) })({ address: "root@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, box.stage)).rejects.toThrow("no cgroup v2");
    const rows = box.stages.filter(line => /^(root|system|disk) /.test(line));
    expect(rows.slice(0, 3)).toEqual(["root running", "root done", "system running"]);
    expect(rows[3]).toMatch(/^system failed \(root@box has no cgroup v2/);
    expect(rows.some(line => line.startsWith("disk"))).toBe(false);
  });

  it("installs over a login whose sudo asks for nothing, as it does over root, with no password asked or ridden", async () => {
    // Root's own shell is zsh here, which a root login is refused for; over sudo it never runs, and is not.
    const box = fakeBox("x86_64", "zsh", { checks: ["uid 0", "systemd yes", "cgroup2 yes"], road: "free" });
    await placeInstaller({ backend: box.backend as never, ...assets(tmp("sudo-free"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, box.stage);
    expect(box.order).toEqual(["read"]);
    expect(box.tried).toEqual([]);
    expect(box.ridden).toEqual([]);
    expect(box.stages).toContain("root done");
    expect(box.ran.some(script => script.includes(WSP_READY_LINE) || script.includes("uname -m"))).toBe(true);
  });

  it("asks at the root row for the password a login's sudo wants, after reading the login as itself, with nothing of wsp's sent", async () => {
    const box = fakeBox("x86_64", "zsh", { road: "asks" });
    const said = await placeInstaller({ backend: box.backend as never, ...assets(tmp("sudo-asks"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, box.stage).then(
      () => undefined,
      (e: unknown) => e as Error & { kind?: string; fix?: string },
    );
    expect(said?.kind).toBe(PLACE_SUDO_KIND);
    expect(said?.message).toMatch(/^sudo on maya@box asks for maya's password\. Type it in Add a computer in the app, or at wsp add in a terminal/);
    expect(said?.fix).toContain("or add root@box instead, or give maya passwordless sudo");
    // Connected and the chip read as the login itself; the login's own shell is not root's and is not refused.
    expect(box.ridden).toEqual([{ asLogin: true }]);
    expect(box.stages.filter(line => /^(connect|chip|root) /.test(line))).toEqual(["connect running", "connect done (Ubuntu 24.04.4 LTS)", "chip done (x86_64)", "root running", expect.stringMatching(/^root failed \(sudo on maya@box asks for maya/)]);
    expect(box.ran).toEqual([]);
    expect(box.landed).toEqual([]);
  });

  it("rides the password sudo took for every script of the install, and says it in no step", async () => {
    const password = "Tq-not-a-real-pw";
    const box = fakeBox("x86_64", "bash", { checks: ["uid 0", "systemd yes", "cgroup2 yes"], road: "asks", tries: pw => (pw === password ? "taken" : "wrong") });
    await placeInstaller({ backend: box.backend as never, ...assets(tmp("sudo-taken"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"], sudoPassword: password }, box.stage);
    expect(box.tried).toEqual([password]);
    expect(box.order).toEqual(["read", "try"]);
    expect(box.ridden).toEqual([{ sudoPassword: password }]);
    expect(box.stages).toContain("root done");
    expect(box.landed.length).toBeGreaterThan(0);
    expect([...box.stages, ...box.ran].join("\n")).not.toContain(password);
  });

  it("asks again where sudo did not take the password, and refuses a login sudo will not run as root in one sentence naming both fixes", async () => {
    const wrong = fakeBox("x86_64", "bash", { road: "asks", tries: () => "wrong" });
    const asked = await placeInstaller({ backend: wrong.backend as never, ...assets(tmp("sudo-wrong"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"], sudoPassword: "nope" }, wrong.stage).catch((e: unknown) => e as Error & { kind?: string });
    expect(asked).toMatchObject({ kind: PLACE_SUDO_KIND, message: expect.stringMatching(/^sudo on maya@box did not take that password\./) });
    for (const sudo of ["none", "asks"] as const) {
      // A login sudo refuses outright reads as one that asks until a password is typed; with one typed it is none.
      const box = sudo === "none" ? fakeBox("x86_64", "bash", { road: "none" }) : fakeBox("x86_64", "bash", { road: "asks", tries: () => "none" });
      const said = await placeInstaller({ backend: box.backend as never, ...assets(tmp(`sudo-${sudo}`), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"], ...(sudo === "asks" ? { sudoPassword: "right" } : {}) }, box.stage).catch((e: unknown) => e as Error & { kind?: string });
      expect(said).toMatchObject({ message: "maya@box logs in as maya, who cannot run commands as root with sudo there, and wsp needs root to keep itself running as a system service; add root@box instead or give maya passwordless sudo" });
      expect((said as { kind?: string }).kind).toBeUndefined();
      expect(box.ran).toEqual([]);
    }
    // A sudo that wants a terminal: neither a password nor passwordless sudo gets past it, so the line names
    // requiretty and root@host, read off the road or off the try.
    for (const box of [fakeBox("x86_64", "bash", { road: "tty" }), fakeBox("x86_64", "bash", { road: "asks", tries: () => "tty" })]) {
      const said = await placeInstaller({ backend: box.backend as never, ...assets(tmp("sudo-tty"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"], sudoPassword: "right" }, box.stage).catch((e: unknown) => e as Error);
      expect((said as Error).message).toBe("maya@box: sudo there runs only from a terminal (Defaults requiretty), and wsp's commands over ssh have none; turn it off for maya with Defaults:maya !requiretty, or add root@box instead");
      expect((said as Error).message).not.toContain("passwordless");
    }
    // An alias: the line names the ssh config road as well.
    expect(placeNoRootLine("studio", "maya", "studio")).toBe("studio logs in as maya, who cannot run commands as root with sudo there, and wsp needs root to keep itself running as a system service; add root@studio instead, put User root under Host studio in your ssh config, or give maya passwordless sudo");
  });

  it("asks for the password where the read said free and the adopt under sudo -n was refused for one, never the login's refusal", async () => {
    const box = fakeBox("x86_64", "bash", { road: "free", minusNRefused: true, tries: pw => (pw === "right" ? "taken" : "wrong") });
    const said = await placeInstaller({ backend: box.backend as never, ...assets(tmp("sudo-mixed"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, box.stage).catch((e: unknown) => e as Error & { kind?: string });
    expect(said).not.toBeInstanceOf(PlaceLoginRefusedError);
    expect(said).toMatchObject({ kind: PLACE_SUDO_KIND, message: expect.stringMatching(/^sudo on maya@box asks for maya's password\./) });
    expect(box.stages.filter(line => /^root /.test(line))).toEqual(["root running", expect.stringMatching(/^root failed \(sudo on maya@box asks/)]);
    expect(box.ran).toEqual([]);
    // With the password it is tried, ridden, and the install goes on.
    const typed = fakeBox("x86_64", "bash", { road: "free", minusNRefused: true, checks: ["uid 0", "systemd yes", "cgroup2 yes"], tries: pw => (pw === "right" ? "taken" : "wrong") });
    await placeInstaller({ backend: typed.backend as never, ...assets(tmp("sudo-mixed-typed"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"], sudoPassword: "right" }, typed.stage);
    expect(typed.tried).toEqual(["right"]);
    expect(typed.ridden).toEqual([{ sudoPassword: "right" }]);
    expect(typed.stages).toContain("root done");
  });

  it("holds the box's key against the pinned one before the password is tried or anything runs as root", async () => {
    for (const road of ["asks", "none", "free"] as const) {
      const box = fakeBox("x86_64", "bash", { road, tries: () => "taken" });
      const said = await placeInstaller({ backend: box.backend as never, ...assets(tmp(`sudo-pin-${road}`), [X86]) })(
        { address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"], hostKey: "ssh-ed25519 SHA256:pinned", sudoPassword: "Tq-not-a-real-pw" },
        box.stage,
      ).catch((e: unknown) => e as Error);
      expect((said as Error).message, road).toContain("not the ssh-ed25519 SHA256:pinned you pinned");
      // The read as the login ran, which is the dial that wrote the key; no password tried, no road to root ridden,
      // nothing adopted or run.
      expect(box.order, road).toEqual(["read"]);
      expect(box.tried).toEqual([]);
      expect(box.ridden).toEqual([]);
      expect(box.ran).toEqual([]);
    }
  });

  it("names the chip it picked on the install line, so a wrong one is read rather than worked out later", async () => {
    const box = fakeBox("x86_64");
    await placeInstaller({ backend: box.backend as never, ...assets(tmp("chip-line"), [X86]) })(
      { address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] },
      box.stage,
    );
    expect(box.stages).toContain("wsp running (x86_64)");
    expect(addLineWords({ step: "wsp", state: "running", note: "x86_64" })).toBe("    installing wsp: x86_64");
  });

  it("says where the box will dial back as its join starts, not after the twenty seconds it would wait", async () => {
    const box = fakeBox("x86_64");
    await placeInstaller({ backend: box.backend as never, ...assets(tmp("dial-line"), [X86]) })(
      { address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://65.21.4.12:4720", "http://192.168.1.20:4720"] },
      box.stage,
    );
    // The step the join runs under, said while it is running: the addresses in the order the box will try them.
    expect(box.stages).toContain("service running (it dials this computer at http://65.21.4.12:4720, http://192.168.1.20:4720)");
  });

  it("hands the join only the addresses the box proved it reaches, before anything of wsp's lands", async () => {
    // The sighting: a box off the tailnet handed this computer's tailnet address first, which it waited twenty
    // seconds on after the whole install had landed.
    const box = fakeBox("x86_64", "bash", { reaches: url => url.includes("192.168.1.20") });
    await placeInstaller({ backend: box.backend as never, ...assets(tmp("reach-lan"), [X86]) })(
      { address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://100.129.166.28:4720", "http://192.168.1.20:4720"] },
      box.stage,
    );
    const probe = box.ran.findIndex(script => script === reachScript(["http://100.129.166.28:4720", "http://192.168.1.20:4720"]));
    const deploy = box.ran.findIndex(script => script.includes(`case "$(uname -m)" in`));
    expect(probe).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(probe);
    expect(box.ran[deploy]).toContain("join 'http://192.168.1.20:4720' --code-file");
    expect(box.ran[deploy]).not.toContain("100.129.166.28");
    expect(box.stages).toContain("reach done (http://192.168.1.20:4720)");
    expect(box.stages).toContain("service running (it dials this computer at http://192.168.1.20:4720)");
    expect(box.stages.indexOf("reach done (http://192.168.1.20:4720)")).toBeLessThan(box.stages.indexOf("wsp running (x86_64)"));
  });

  it("refuses a box that reaches none of this host's addresses in one sentence, with nothing of wsp's sent", async () => {
    const box = fakeBox("x86_64", "bash", { reaches: () => false });
    const urls = ["http://100.129.166.28:4720", "http://192.168.1.20:4720"];
    await expect(placeInstaller({ backend: box.backend as never, ...assets(tmp("reach-none"), [X86]) })({ address: "root@spoo", code: "7QK3M2VD", hostUrls: urls }, box.stage)).rejects.toThrow(
      unreachedLine("root@spoo", urls),
    );
    expect(unreachedLine("root@spoo", urls)).toBe(
      "root@spoo cannot reach this computer at http://100.129.166.28:4720, http://192.168.1.20:4720, so nothing of wsp's went onto it; link this host to your relay, or start it with --advertise naming an address root@spoo can reach",
    );
    expect(box.landed).toEqual([]);
    expect(box.ran.some(script => script.includes(`case "$(uname -m)" in`))).toBe(false);
    expect(box.stages).toContain("reach running");
    expect(box.stages.some(line => line.startsWith("wsp "))).toBe(false);
  });

  /** A holder that records what the installer asked of it into the box's own list of what ran, so the order of the
   * hold and the deploy reads off one list; `refuse` is the sentence its first standing fails with. */
  function backHolder(ran: string[], refuse?: string | Error): { holder: PlaceBackHolder; asked: { login: PlaceLogin; back: PlaceBack; home: string }[]; released: string[] } {
    const asked: { login: PlaceLogin; back: PlaceBack; home: string }[] = [];
    const released: string[] = [];
    return {
      asked,
      released,
      holder: {
        hold: async (login, back, on) => {
          asked.push({ login, back, home: on.home });
          ran.push(`HOLD ${login.ssh} ${back.boxPort}`);
          if (refuse !== undefined) throw typeof refuse === "string" ? new Error(refuse) : refuse;
          return back;
        },
        release: login => void released.push(login.ssh),
        door: () => {},
        close: () => {},
      },
    };
  }

  it("dials back over ssh where the box reaches none of the door's addresses, with the forward standing before anything lands", async () => {
    const box = fakeBox("x86_64", "bash", { reaches: () => false });
    const back = backHolder(box.ran);
    const urls = ["http://100.129.166.28:4720", "http://192.168.1.20:4720"];
    const installed = await placeInstaller({ backend: box.backend as never, back: back.holder, ...assets(tmp("back-ssh"), [X86]) })({ address: "root@spoo", code: "7QK3M2VD", hostUrls: urls, doorPort: 4720 }, box.stage);
    expect(back.asked).toEqual([{ login: { ssh: "root@spoo" }, back: { boxPort: 4720 }, home: "/home/maya" }]);
    const hold = box.ran.indexOf("HOLD root@spoo 4720");
    const deploy = box.ran.findIndex(script => script.includes(`case "$(uname -m)" in`));
    expect(hold).toBeGreaterThan(box.ran.indexOf(reachScript(urls)));
    expect(deploy).toBeGreaterThan(hold);
    expect(box.ran[deploy]).toContain(`join '${backUrl(4720)}' --code-file`);
    expect(box.ran[deploy]).not.toContain("192.168.1.20");
    expect(box.stages).toContain(`reach done (${dialsBackOverSshNote(urls, undefined)})`);
    expect(dialsBackOverSshNote(urls, undefined)).toBe("cannot reach this computer at http://100.129.166.28:4720, http://192.168.1.20:4720, so it dials back over ssh");
    expect(box.stages).toContain("service running (it dials back over ssh (127.0.0.1:4720 on spoo))");
    expect(box.stages.join("\n")).not.toContain("dials this computer at http://127.0.0.1");
    expect(installed.back).toEqual({ boxPort: 4720 });
    expect(back.released).toEqual([]);
  });

  it("dials the relay first where the box reaches only that, and back over ssh after it", async () => {
    const relay = "https://h645d7f8a8d48cbd6.example";
    const box = fakeBox("x86_64", "bash", { reaches: url => url === relay });
    const back = backHolder(box.ran);
    const urls = ["http://100.129.166.28:4720", relay];
    await placeInstaller({ backend: box.backend as never, back: back.holder, ...assets(tmp("back-relay"), [X86]) })({ address: "root@spoo", code: "7QK3M2VD", hostUrls: urls, doorPort: 4720, relay }, box.stage);
    const deploy = box.ran.find(script => script.includes(`case "$(uname -m)" in`))!;
    expect(deploy).toContain(`join '${relay}' '${backUrl(4720)}' --code-file`);
    expect(box.stages).toContain(`reach done (${relay}, and back over ssh)`);
    expect(box.stages).toContain(`service running (it dials this computer at ${relay}, then dials back over ssh (127.0.0.1:4720 on spoo))`);
  });

  it("holds no forward where the box reaches an address of the door, or on a host that names no door port of its own", async () => {
    const lan = fakeBox("x86_64", "bash", { reaches: url => url.includes("192.168.1.20") });
    const heldLan = backHolder(lan.ran);
    await placeInstaller({ backend: lan.backend as never, back: heldLan.holder, ...assets(tmp("back-none"), [X86]) })({ address: "root@spoo", code: "7QK3M2VD", hostUrls: ["http://100.129.166.28:4720", "http://192.168.1.20:4720"], doorPort: 4720 }, lan.stage);
    expect(heldLan.asked).toEqual([]);
    // A host started with --listen answers on its main port, where a peer on its loopback is the owner's own road:
    // a forward there would hand the box that road, so the add is refused as it was before any forward existed.
    const listening = fakeBox("x86_64", "bash", { reaches: () => false });
    const heldListening = backHolder(listening.ran);
    const urls = ["http://100.129.166.28:4700"];
    await expect(placeInstaller({ backend: listening.backend as never, back: heldListening.holder, ...assets(tmp("back-listen"), [X86]) })({ address: "root@spoo", code: "7QK3M2VD", hostUrls: urls }, listening.stage)).rejects.toThrow(unreachedLine("root@spoo", urls));
    expect(heldListening.asked).toEqual([]);
    expect(listening.landed).toEqual([]);
  });

  it("refuses in one sentence where the forward will not stand either, lets it go, and sends nothing", async () => {
    const box = fakeBox("x86_64", "bash", { reaches: () => false });
    const why = "Error: remote port forwarding failed for listen port 23456";
    const back = backHolder(box.ran, why);
    const urls = ["http://100.129.166.28:4720", "http://192.168.1.20:4720"];
    await expect(placeInstaller({ backend: box.backend as never, back: back.holder, ...assets(tmp("back-refused"), [X86]) })({ address: "root@spoo", code: "7QK3M2VD", hostUrls: urls, doorPort: 4720 }, box.stage)).rejects.toThrow(
      backRefusedLine("root@spoo", urls, why),
    );
    expect(backRefusedLine("root@spoo", urls, why)).toBe(
      "root@spoo cannot reach this computer at http://100.129.166.28:4720, http://192.168.1.20:4720 and the forward back over ssh did not stand (Error: remote port forwarding failed for listen port 23456); link this host to your relay, or start it with --advertise naming an address it can reach",
    );
    const long = backRefusedLine("root@spoo", urls, "x".repeat(2000));
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long).toMatch(/naming an address it can reach$/);
    // ssh copies the box's stderr raw, and the box's startup files write before the forward's up line.
    const boxWritten = backRefusedLine(`${"u".repeat(255)}@spoo`, urls, "\x1b]0;pwned\x07Connection closed");
    expect(boxWritten).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(boxWritten.length).toBeLessThanOrEqual(300);
    expect(boxWritten).toMatch(/naming an address it can reach$/);
    expect(back.released).toEqual(["root@spoo"]);
    expect(box.landed).toEqual([]);
    expect(box.ran.some(script => script.includes(`case "$(uname -m)" in`))).toBe(false);
  });

  it("says a refusal that names its own fix whole: sshd binding beyond loopback, a known hosts file that is not here", async () => {
    const urls = ["http://100.129.166.28:4720"];
    for (const refusal of [new BackCutError(backBindLine("root@spoo", "0.0.0.0")), new MissingKnownHostsError(missingKnownHostsLine("root@spoo", "/Users/lena/my"))]) {
      const box = fakeBox("x86_64", "bash", { reaches: () => false });
      const back = backHolder(box.ran, refusal);
      const refused = await placeInstaller({ backend: box.backend as never, back: back.holder, ...assets(tmp("back-whole"), [X86]) })({ address: "root@spoo", code: "7QK3M2VD", hostUrls: urls, doorPort: 4720 }, box.stage).catch((e: unknown) => e);
      expect((refused as Error).message).toBe(refusal.message);
      expect(box.landed).toEqual([]);
    }
  });

  it("lets the forward go when the deploy it was held for fails", async () => {
    const box = fakeBox("x86_64", "bash", { reaches: () => false });
    const back = backHolder(box.ran);
    const failing = {
      ...(box.backend as { adopt: () => Promise<{ machine: { run: (script: string, opts?: unknown) => Promise<unknown> } }> }),
    };
    const adopt = failing.adopt;
    failing.adopt = async () => {
      const adopted = await adopt();
      const run = adopted.machine.run;
      adopted.machine.run = async (script, opts) => (script.includes(`case "$(uname -m)" in`) ? { exitCode: 1, stdout: "", stderr: "tar: ./daemon: Cannot open: No such file or directory\n" } : run(script, opts));
      return adopted;
    };
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(placeInstaller({ backend: failing as never, back: back.holder, ...assets(tmp("back-deploy"), [X86]) })({ address: "root@spoo", code: "7QK3M2VD", hostUrls: ["http://100.129.166.28:4720"], doorPort: 4720 }, box.stage)).rejects.toThrow();
    warned.mockRestore();
    expect(back.released).toEqual(["root@spoo"]);
  });

  /** A box whose deploy fails after its join connected back, answering the read of what it already holds with the
   * writes `had` names, and the undo with `undo`. Every script it was handed is on `ran`, in order. */
  function failingBox(had: (write: { path: string; as: string }) => boolean, opts: { found?: "unsaid"; undo?: { exitCode: number; stdout: string; stderr: string }; preflight?: string; deploy?: { stdout: string; stderr: string } } = {}) {
    const box = fakeBox("x86_64");
    const writes = joinedAddWrites(joinedPlace({ home: "/home/maya", path: "/usr/bin:/bin" }, { hostUrls: [], codeFile: "/home/maya/.wsp/join-code", name: "box" }), placeUnit("/home/maya").path);
    const backend = { ...(box.backend as { adopt: () => Promise<{ machine: { run: (script: string, o?: unknown) => Promise<unknown> } }> }) };
    const adopt = backend.adopt;
    backend.adopt = async () => {
      const adopted = await adopt();
      const run = adopted.machine.run;
      adopted.machine.run = async (script, o) => {
        if (script.includes(ADD_FOUND_END)) {
          box.ran.push(script);
          if (opts.found === "unsaid") return { exitCode: 255, stdout: "", stderr: "Connection reset by peer\n" };
          return { exitCode: 0, stdout: `${writes.flatMap((w, i) => (had(w) ? [`WSP_HAD ${i}\n`] : [])).join("")}${ADD_FOUND_END}\n`, stderr: "" };
        }
        if (opts.preflight !== undefined && script.includes("PREFLIGHT_OK")) {
          box.ran.push(script);
          return { exitCode: 1, stdout: `${opts.preflight}\n`, stderr: "" };
        }
        if (script.includes(`case "$(uname -m)" in`)) {
          box.ran.push(script);
          return { exitCode: 1, ...(opts.deploy ?? { stdout: `WSP_STEP files\nWSP_STEP login\nWSP_STEP agent\nWSP_READY\n${joinedLine("box", "http://192.168.1.20:4720")}\n`, stderr: "systemctl enable --now wsp-place-abc exited 1 and said: Failed to enable unit\n" }) };
        }
        if (script.endsWith(`echo ${DAEMON_GONE_LINE}`)) {
          box.ran.push(script);
          return opts.undo ?? { exitCode: 0, stdout: `${DAEMON_GONE_LINE}\n`, stderr: "" };
        }
        return run(script, o);
      };
      return adopted;
    };
    return { ...box, backend, writes };
  }

  const SERVICE_SAID = "box connected back but its agent did not start: systemctl enable --now wsp-place-abc exited 1 and said: Failed to enable unit";

  it("takes back what a failed add put on the box once the deploy fails, and nothing the box held before the add", async () => {
    const at = placeDaemonPaths("/home/maya");
    const unit = placeUnit("/home/maya");
    // The person's own ~/.local/bin and login file were there before the add; nothing else of the list was.
    const box = failingBox(w => w.path === at.binDir || w.as === "login");
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const thrown = await placeInstaller({ backend: box.backend as never, ...assets(tmp("undo-add"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, box.stage).then(() => new Error("the add stood"), (e: unknown) => e as Error);
    warned.mockRestore();
    // Marked as taken back, which is what lets the runtime drop the record the join made.
    expect(thrown).toBeInstanceOf(PlaceAddTakenBackError);
    const said = thrown.message;
    expect(said).toBe(addUndoneLine(SERVICE_SAID, true));
    expect(said).toBe(`${SERVICE_SAID}; nothing this add put on it is left there`);
    const found = box.ran.findIndex(script => script.includes(ADD_FOUND_END));
    const deploy = box.ran.findIndex(script => script.includes(`case "$(uname -m)" in`));
    const undo = box.ran.findIndex(script => script.endsWith(`echo ${DAEMON_GONE_LINE}`));
    expect(box.ran.findIndex(script => script.startsWith("reach() {"))).toBeLessThan(found);
    expect(found).toBeLessThan(deploy);
    expect(deploy).toBeLessThan(undo);
    const lines = box.ran[undo]!.split("\n");
    // The unit the join wrote, stopped before its file goes; the profile the deploy loaded; wsp's line in their file.
    expect(lines).toContain(`systemctl disable --now ${shellQuote(unit.name)} 2>/dev/null || true`);
    expect(lines).toContain(`rm -f ${shellQuote(unit.path)}`);
    expect(box.ran[undo]).toContain("apparmor_parser -R '/etc/apparmor.d/wsp-workspace'");
    expect(box.ran[undo]).toContain(`grep -vF ${shellQuote(at.profileFile)} '/home/maya/.profile'`);
    const removed = [...box.ran[undo]!.matchAll(/rm -rf ('[^']*')/g)].map(m => m[1]);
    for (const path of [at.placeFile, at.placeKey, at.placeLog, at.dir, at.bundle, at.tokenPath, at.profileFile, "/home/maya/.wsp/join-code", `${at.binDir}/wsp-open`, `${at.binDir}/xdg-open`]) expect(removed).toContain(shellQuote(path));
    // The folders it only made go when nothing else is in them, and wsp's own folder is never taken whole.
    expect(lines).toContain(`rmdir ${shellQuote(at.wsp)} 2>/dev/null || true`);
    expect(lines).toContain(`rmdir ${shellQuote(workFolderIn("/home/maya"))} 2>/dev/null || true`);
    expect(removed).not.toContain(shellQuote(at.wsp));
    expect(removed).not.toContain(shellQuote(workFolderIn("/home/maya")));
    // What the box held before the add stays: their ~/.local/bin, their login file, and a unit this add never writes.
    expect(box.ran[undo]).not.toContain(`rmdir ${shellQuote(at.binDir)}`);
    expect(box.ran[undo]).not.toContain("|| rm -f '/home/maya/.profile'");
    expect(box.ran[undo]).not.toContain("wsp-daemon.service");
  });

  it("leaves the workspace profile and the files a box held before the add where they were", async () => {
    const at = placeDaemonPaths("/home/maya");
    const box = failingBox(w => w.as === "apparmor" || w.path === at.dir);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    await placeInstaller({ backend: box.backend as never, ...assets(tmp("undo-kept"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, box.stage).catch(() => undefined);
    warned.mockRestore();
    const undo = box.ran.find(script => script.endsWith(`echo ${DAEMON_GONE_LINE}`))!;
    expect(undo).not.toContain("apparmor_parser");
    expect(undo).not.toContain(shellQuote(at.dir));
    expect(undo).toContain(shellQuote(at.bundle));
  });

  it("takes nothing back where nothing landed, or where the box never said what it held before", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The box refused at the preflight: the deploy stopped before a byte of wsp's landed, and the refusal is said alone.
    const refused = failingBox(() => false, { preflight: PLACE_NEEDS_ROOT_LINE });
    expect(await placeInstaller({ backend: refused.backend as never, ...assets(tmp("undo-preflight"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, refused.stage).catch((e: unknown) => (e as Error).message)).toBe(PLACE_NEEDS_ROOT_LINE);
    expect(refused.ran.some(script => script.endsWith(`echo ${DAEMON_GONE_LINE}`))).toBe(false);
    // The read of what it held did not answer, so nothing on it can be told from what this add wrote.
    const unsaid = failingBox(() => false, { found: "unsaid" });
    expect(await placeInstaller({ backend: unsaid.backend as never, ...assets(tmp("undo-unsaid"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, unsaid.stage).catch((e: unknown) => (e as Error).message)).toBe(
      `${SERVICE_SAID}; what this add put on it may still be there`,
    );
    expect(unsaid.ran.some(script => script.endsWith(`echo ${DAEMON_GONE_LINE}`))).toBe(false);
    // The undo ran and did not finish.
    const dropped = failingBox(() => false, { undo: { exitCode: 255, stdout: "", stderr: "Connection closed\n" } });
    const kept = await placeInstaller({ backend: dropped.backend as never, ...assets(tmp("undo-dropped"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, dropped.stage).then(() => new Error("the add stood"), (e: unknown) => e as Error);
    expect(kept.message).toBe(addUndoneLine(SERVICE_SAID, false));
    expect(kept).not.toBeInstanceOf(PlaceAddTakenBackError);
    warned.mockRestore();
    // A box's line at the cap still leaves room for what the undo did.
    const long = addUndoneLine(`box took wsp but could not connect back: ${"x".repeat(400)}`, true);
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long).toMatch(/…; nothing this add put on it is left there$/);
  });

  it("sends no undo when the join refused the box as already joined, since what stands there is the add that won", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const box = failingBox(() => false, { deploy: { stdout: "WSP_STEP files\nWSP_STEP login\nWSP_STEP agent\nWSP_READY\n", stderr: `${ALREADY_JOINED_LINE}\n` } });
    const thrown = await placeInstaller({ backend: box.backend as never, ...assets(tmp("undo-raced"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, box.stage).then(() => new Error("the add stood"), (e: unknown) => e as Error);
    warned.mockRestore();
    expect(thrown.message).toBe(`box took wsp but could not connect back: ${ALREADY_JOINED_LINE}`);
    expect(thrown).not.toBeInstanceOf(PlaceAddTakenBackError);
    expect(box.ran.some(script => script.endsWith(`echo ${DAEMON_GONE_LINE}`))).toBe(false);
    // A name long enough that the sentence's cap cuts the join's line off still reads as refused, off the box's own line.
    const long = failingBox(() => false, { deploy: { stdout: "WSP_STEP files\nWSP_STEP login\nWSP_STEP agent\nWSP_READY\n", stderr: `${ALREADY_JOINED_LINE}\n` } });
    const cut = await placeInstaller({ backend: long.backend as never, ...assets(tmp("undo-raced-long"), [X86]) })({ address: "maya@box", name: "b".repeat(250), code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, long.stage).then(() => new Error("the add stood"), (e: unknown) => e as Error);
    expect(cut.message).not.toContain(ALREADY_JOINED_LINE);
    expect(cut).not.toBeInstanceOf(PlaceAddTakenBackError);
    expect(long.ran.some(script => script.endsWith(`echo ${DAEMON_GONE_LINE}`))).toBe(false);
  });

  it("takes nothing back, keeps the record and says so where another add took the box before this one's join ran", async () => {
    const at = placeDaemonPaths("/home/maya");
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The deploy failed at the files step, so this add's join never wrote a place file; one standing now is another add's.
    const box = failingBox(() => false, { deploy: { stdout: "WSP_STEP files\n", stderr: "tar: place.tgz: unexpected end of file\n" }, undo: { exitCode: 0, stdout: `${ADD_TAKEN_LINE}\n`, stderr: "" } });
    const thrown = await placeInstaller({ backend: box.backend as never, ...assets(tmp("undo-taken"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, box.stage).then(() => new Error("the add stood"), (e: unknown) => e as Error);
    warned.mockRestore();
    expect(thrown).not.toBeInstanceOf(PlaceAddTakenBackError);
    expect(thrown.message).toBe(addTakenLine("box did not take wsp's files: tar: place.tgz: unexpected end of file"));
    expect(thrown.message).toMatch(/; another add took the box meanwhile, so nothing was taken back off it$/);
    const undo = box.ran.find(script => script.endsWith(`echo ${DAEMON_GONE_LINE}`))!;
    expect(undo).toContain(`then echo ${ADD_TAKEN_LINE}; exit 0; fi`);
    expect(undo.indexOf(ADD_TAKEN_LINE)).toBeLessThan(undo.indexOf(`rm -rf ${shellQuote(at.placeFile)}`));
    // Past its own join the place file is this add's, and the undo takes it.
    const own = failingBox(() => false);
    await placeInstaller({ backend: own.backend as never, ...assets(tmp("undo-own"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, own.stage).catch(() => undefined);
    expect(own.ran.find(script => script.endsWith(`echo ${DAEMON_GONE_LINE}`))).not.toContain(ADD_TAKEN_LINE);
  });

  it("stops a place unit this add started and leaves one the box was already running as it was", async () => {
    const unit = placeUnit("/home/maya");
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The unit file was there, stopped and disabled: the join rewrote it, enabled it and started it.
    const idle = failingBox(w => w.as === "unit");
    await placeInstaller({ backend: idle.backend as never, ...assets(tmp("undo-idle-unit"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, idle.stage).catch(() => undefined);
    const stopped = idle.ran.find(script => script.endsWith(`echo ${DAEMON_GONE_LINE}`))!.split("\n");
    expect(stopped).toContain(`systemctl stop ${shellQuote(unit.name)} 2>/dev/null || true`);
    expect(stopped).toContain(`systemctl disable ${shellQuote(unit.name)} 2>/dev/null || true`);
    expect(stopped.join("\n")).not.toContain(`rm -f ${shellQuote(unit.path)}`);
    // Running and enabled before the add: nothing of the undo reaches for it.
    const running = failingBox(w => w.as === "unit" || w.as === "running" || w.as === "enabled");
    const said = await placeInstaller({ backend: running.backend as never, ...assets(tmp("undo-running-unit"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, running.stage).then(() => "the add stood", (e: unknown) => (e as Error).message);
    warned.mockRestore();
    expect(running.ran.find(script => script.endsWith(`echo ${DAEMON_GONE_LINE}`))).not.toContain(shellQuote(unit.name));
    // The join restarted that agent with this add's flags; the sentence says it stands because it was there before.
    expect(said).toBe(`${SERVICE_SAID}; wsp's agent was running there before this add and is left running, and nothing else this add put on it is left there`);
    expect(addUndoneLine(SERVICE_SAID, false, true)).toBe(`${SERVICE_SAID}; wsp's agent was running there before this add and is left running, and what else this add put on it may still be there`);
  });

  it("refuses a box whose login has / for its home before it reads what the box holds", async () => {
    const box = fakeBox("x86_64", "bash", { home: "/" });
    const said = await placeInstaller({ backend: box.backend as never, ...assets(tmp("root-home"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4720"] }, box.stage).catch((e: unknown) => (e as Error).message);
    expect(said).toBe(placeRootHomeRefusal("maya@box"));
    expect(box.ran.some(script => script.includes(ADD_FOUND_END) || script.startsWith("head -c ") || script.startsWith("reach() {"))).toBe(false);
    expect(box.landed).toEqual([]);
  });

  it("refuses a box that already belongs to a wsp at the connect, naming that wsp, with nothing sent", async () => {
    const studio = placeFileText({ placeId: "p_studio", name: "spoo", hostName: "studio", hostUrls: ["http://192.168.1.5:4640"], hostPublicKey: "c3R1ZGlv", keyPath: "/root/.wsp/place.key", joinedAt: "2026-09-20T10:00:00Z" });
    const elsewhere = fakeBox("x86_64", "bash", { holds: studio });
    const own = joinToken("7QK3M2VD", keyFingerprint("dGhpcyBob3N0"));
    await expect(placeInstaller({ backend: elsewhere.backend as never, ...assets(tmp("held-elsewhere"), [X86]) })({ address: "root@spoo", code: own, hostUrls: ["http://192.168.1.20:4720"] }, elsewhere.stage)).rejects.toThrow(
      "root@spoo already belongs to the wsp on studio at http://192.168.1.5:4640; wsp leave on it frees it, or wsp add spoo --update from that wsp updates it there",
    );
    expect(elsewhere.landed).toEqual([]);
    expect(elsewhere.ran).toEqual([heldPlaceScript("/home/maya")]);
    expect(elsewhere.stages).toEqual(["connect running", "host-key done (ssh-ed25519 SHA256:abc)"]);
    // The same file pinned to this host's own key is this wsp's own place, said as that.
    const mine = fakeBox("x86_64", "bash", { holds: studio.replace("c3R1ZGlv", "dGhpcyBob3N0") });
    await expect(placeInstaller({ backend: mine.backend as never, ...assets(tmp("held-here"), [X86]) })({ address: "root@spoo", code: own, hostUrls: ["http://192.168.1.20:4720"] }, mine.stage)).rejects.toThrow(
      "root@spoo is already a place in this wsp as spoo",
    );
    expect(mine.landed).toEqual([]);
    // A file the join itself would not read as a place is none, by the join's own rule.
    const junk = fakeBox("x86_64", "bash", { holds: "{}\n" });
    expect(await placeInstaller({ backend: junk.backend as never, ...assets(tmp("held-junk"), [X86]) })({ address: "maya@box", code: own, hostUrls: ["http://192.168.1.20:4720"] }, junk.stage)).toMatchObject({ name: "box" });
    expect(placeHeldRefusal("root@spoo", { ...JSON.parse(studio), hostUrls: [] }, undefined)).toBe("root@spoo already belongs to the wsp on studio; wsp leave on it frees it, or wsp add spoo --update from that wsp updates it there");
    // A long address that is still a valid one is cut like the names, so the way out survives the cap.
    const long = `http://${"a".repeat(240)}.example:4640`;
    const said = placeHeldRefusal("root@spoo", { ...JSON.parse(studio), name: "s".repeat(200), hostName: "h".repeat(200), hostUrls: [long] }, undefined);
    expect(said.length).toBeLessThanOrEqual(300);
    expect(said).toMatch(/updates it there$/);
    expect(said).toContain(` at ${long.slice(0, 48)};`);
  });

  it("reads whether an alias is this computer off the address ssh dials, not off the alias", async () => {
    const urls = ["http://127.0.0.1:4720", "http://192.168.1.20:4720"];
    // Host me / HostName 127.0.0.1: the box is this computer, where its own loopback is the address that works.
    const me = fakeBox("x86_64", "bash", { dials: "127.0.0.1" });
    await placeInstaller({ backend: me.backend as never, ...assets(tmp("alias-here"), [X86]) })({ address: "maya@me", code: "7QK3M2VD", hostUrls: urls }, me.stage);
    expect(me.stages).toContain("reach done (http://127.0.0.1:4720, http://192.168.1.20:4720)");
    // The same word landing on a box elsewhere drops the loopback before the box is asked.
    const away = fakeBox("x86_64", "bash", { dials: "178.156.161.168" });
    await placeInstaller({ backend: away.backend as never, ...assets(tmp("alias-away"), [X86]) })({ address: "maya@me", code: "7QK3M2VD", hostUrls: urls }, away.stage);
    expect(away.ran).toContain(reachScript(["http://192.168.1.20:4720"]));
    // Host inner / HostName 127.0.0.1 / ProxyJump bastion: the HostName is resolved past the jump, so it is not here.
    const jumped = fakeBox("x86_64", "bash", { proxied: true });
    await placeInstaller({ backend: jumped.backend as never, ...assets(tmp("alias-jumped"), [X86]) })({ address: "root@inner", code: "7QK3M2VD", hostUrls: urls }, jumped.stage);
    expect(jumped.ran).toContain(reachScript(["http://192.168.1.20:4720"]));
  });

  it("refuses the advertised address by name where it is this computer's own loopback, rather than dropping it behind a card", async () => {
    // The sighting's shape: a host started with a word naming its own loopback, on a computer that also answers on
    // a card. The word cannot be dialled from that box, and the card may be one the box cannot route to either, so
    // going on with the card is going on with an address the person did not choose.
    const box = fakeBox("x86_64");
    const install = placeInstaller({ backend: box.backend as never, advertise: "http://127.0.0.1:4720", ...assets(tmp("named-loopback"), [X86]) });
    await expect(install({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://127.0.0.1:4720", "http://100.129.175.77:4720"] }, box.stage)).rejects.toThrow(
      advertisedLoopbackRefusal("http://127.0.0.1:4720"),
    );
    // Refused before the dial: nothing was landed and no step was even started.
    expect(box.landed).toEqual([]);
    expect(box.stages).toEqual([]);
    // The box that is this computer under another name dials its own loopback and reaches this host, so the word
    // holds there and nothing is refused.
    const here = fakeBox("x86_64");
    const hereInstall = placeInstaller({ backend: here.backend as never, advertise: "http://127.0.0.1:4720", ...assets(tmp("named-loopback-here"), [X86]) });
    expect(await hereInstall({ address: `maya@localhost`, code: "7QK3M2VD", hostUrls: ["http://127.0.0.1:4720"] }, here.stage)).toMatchObject({ name: "localhost" });
    // A host bound to this computer alone behind a relay carries a loopback address in that list too, and nobody
    // typed that one: the install takes the relay and says nothing, which is what it always did.
    const relayed = fakeBox("x86_64");
    const relayedInstall = placeInstaller({ backend: relayed.backend as never, ...assets(tmp("relayed-loopback"), [X86]) });
    expect(await relayedInstall({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://127.0.0.1:4720", "https://wsp-box.example.com"] }, relayed.stage)).toMatchObject({ name: "box" });
    // A host that answers on its own loopback alone with no word is still the other refusal, which names the flags
    // that fix it rather than a word the person never typed.
    const alone = fakeBox("x86_64");
    const aloneInstall = placeInstaller({ backend: alone.backend as never, ...assets(tmp("loopback-alone"), [X86]) });
    await expect(aloneInstall({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://127.0.0.1:4720"] }, alone.stage)).rejects.toThrow(ADD_LOOPBACK_REFUSAL);
  });

  it("carries a box's own uname word from the ssh read through to the binary it is sent, with nothing faked between", async () => {
    // Every other case here hands the installer an arch. This one answers the real read script over a transport,
    // so the road from what the box printed to the chip arm in its deploy script is proved end to end.
    const cases = [
      { said: "x86_64", arm: "  x86_64)", gone: "aarch64" },
      { said: "aarch64", arm: "  aarch64)", gone: "x86_64" },
    ] as const;
    for (const { said, arm, gone } of cases) {
      const ran: string[] = [];
      const asLogin: string[] = [];
      const transport: SshTransport = async (_reach, script, opts) => {
        ran.push(script);
        if (opts.asLogin === true) asLogin.push(script);
        if (script === SSH_SUDO_READ) return { exitCode: 0, stdout: "WSP_SUDO free\n", stderr: "" };
        if (script === SSH_READ_SCRIPT) return { exitCode: 0, stdout: `home /home/maya\narch ${said}\nuser maya\npath /usr/bin:/bin\ncpu 2\nmemkb 4194304\n`, stderr: "" };
        if (script.includes("PREFLIGHT_OK")) return { exitCode: 0, stdout: "PREFLIGHT_OK\n", stderr: "" };
        if (script.includes("WSP_BYTES_OK")) return { exitCode: 0, stdout: "WSP_BYTES_OK\n", stderr: "" };
        const reached = reachAnswer(script);
        if (reached !== undefined) return reached;
        for (const line of [WSP_READY_LINE, PLACE_JOINED_LINE]) opts.onLine?.(line);
        return { exitCode: 0, stdout: `${WSP_READY_LINE}\n${PLACE_JOINED_LINE}\nDAEMON_UP\n`, stderr: "" };
      };
      const backend = new SshBackend({ transport, hostKey: async () => BOX_KEY, knownHosts: async () => ({}), hostName: async reach => reach.host });
      const target = GUEST_DAEMON_TARGETS.find(t => t.uname === said)!;
      const install = placeInstaller({ backend, ...assets(tmp(`road-${said}`), [target]) });
      expect(await install({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, () => {})).toMatchObject({ name: "box" });
      const deploy = ran.find(script => script.includes(`case "$(uname -m)" in`))!;
      expect(deploy).toContain(arm);
      expect(deploy).not.toContain(gone);
      // Only the read of the road to root runs as the login; with sudo asking for nothing, every script after it
      // rides the client's own road to root.
      expect(asLogin).toEqual([SSH_SUDO_READ]);
    }
  });

  it("reads the system before the chip, so a Mac of either chip is told it is a Mac and any other system its own name", async () => {
    // An Apple silicon Mac says arm64, which reads as a chip wsp builds nothing for, and an Intel Mac says x86_64,
    // which matches the Linux row and meets the systemd sentence halfway through its deploy. Neither says Mac.
    const cases: Array<[string, string, string]> = [
      ["Darwin", "arm64", noPlaceSystemLine("Darwin")],
      ["Darwin", "x86_64", noPlaceSystemLine("Darwin")],
      ["FreeBSD", "amd64", noPlaceSystemLine("FreeBSD")],
      ["Linux", "riscv64", noGuestDaemonLine("riscv64")],
    ];
    for (const [system, arch, line] of cases) {
      const ran: string[] = [];
      const transport: SshTransport = async (_reach, script) => {
        ran.push(script);
        if (script === SSH_SUDO_READ) return { exitCode: 0, stdout: "WSP_SUDO root\n", stderr: "" };
        return script === SSH_READ_SCRIPT
          ? { exitCode: 0, stdout: `home /home/maya\nsystem ${system}\narch ${arch}\nuser maya\npath /usr/bin:/bin\ncpu 2\nmemkb 4194304\n`, stderr: "" }
          : { exitCode: 0, stdout: "", stderr: "" };
      };
      const backend = new SshBackend({ transport, hostKey: async () => BOX_KEY, knownHosts: async () => ({}), hostName: async reach => reach.host });
      const install = placeInstaller({ backend, ...assets(tmp(`road-${system}-${arch}`)) });
      await expect(install({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, () => {})).rejects.toThrow(line);
      expect(ran).toEqual([SSH_SUDO_READ, SSH_READ_SCRIPT]);
    }
    expect(noPlaceSystemLine("Darwin")).toBe("that computer is a Mac, and wsp joins only a Linux computer as a place; a Mac cannot join yet");
    expect(noPlaceSystemLine("FreeBSD")).toBe("that computer runs FreeBSD, and wsp joins only a Linux computer as a place");
    expect(noPlaceSystemLine("Darwin", "that computer", true)).toBe("that computer is a Mac, and wsp keeps only a Linux computer as a place; a Mac cannot be updated as one");
  });

  it("refuses a chip wsp builds no daemon for, and a box that would not say, before a byte of wsp's lands", async () => {
    const odd = fakeBox("riscv64");
    const install = placeInstaller({ backend: odd.backend as never, ...assets(tmp("chip-odd")) });
    await expect(install({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, odd.stage)).rejects.toThrow(noGuestDaemonLine("riscv64"));
    expect(odd.landed).toEqual([]);
    const quiet = fakeBox(undefined);
    const quietInstall = placeInstaller({ backend: quiet.backend as never, ...assets(tmp("chip-quiet")) });
    await expect(quietInstall({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, quiet.stage)).rejects.toThrow(UNSAID_CHIP_REFUSAL);
    expect(quiet.landed).toEqual([]);
  });

  it("leaves the box-side join as the only thing that reads a place report, and carries no field the join dropped", async () => {
    const box = fakeBox("x86_64");
    await placeInstaller({ backend: box.backend as never, ...assets(tmp("one-reader"), [X86]) })(
      { address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] },
      box.stage,
    );
    // One command on the box builds or reads a report about it, and it is the join the person would run by hand.
    const readers = box.ran.flatMap(script => script.split("\n").filter(line => / join '?https?:/.test(line)));
    expect(readers).toHaveLength(1);
    expect(readers[0]).toContain("--code-file '/home/maya/.wsp/join-code'");
    // Nothing the deploy runs asks that box about docker: the field a report was once refused for is gone from the
    // shape both sides read, so a deploy and a hand-run join cannot disagree about whether a report is valid.
    expect(box.ran.join("\n")).not.toContain("docker");
    expect(Object.keys(PlaceReport.shape)).not.toContain("docker");
    expect(PlaceReport.safeParse({ ...(await placeReport({ name: "box", home: tmp("one-reader-home") })), dialed: "http://192.168.1.20:4400" }).success).toBe(true);
  });

  it("throws one sentence when a deploy will not come up and leaves the commands it was running to the host's log", async () => {
    const root = tmp("deploy-said");
    const machine = {
      id: "ssh://maya@box:22",
      kind: "sandbox",
      putBytes: async () => {},
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      facts: async () => ({ os: "Ubuntu 24.04.4 LTS" }),
      run: async (script: string) =>
        script.includes("PREFLIGHT_OK")
          ? { exitCode: 0, stdout: "PREFLIGHT_OK\n", stderr: "" }
          : script.includes(ADD_FOUND_END)
            ? { exitCode: 0, stdout: `${ADD_FOUND_END}\n`, stderr: "" }
            : script.endsWith(`echo ${DAEMON_GONE_LINE}`)
              ? { exitCode: 0, stdout: `${DAEMON_GONE_LINE}\n`, stderr: "" }
              : (reachAnswer(script) ?? { exitCode: 1, stdout: "WSP_STEP files\nWSP_STEP login\nWSP_STEP agent\nthe wsp-workspace apparmor profile is loaded, so workspaces isolate here\nWSP_READY\n", stderr: `${joinUnansweredLine("http://192.168.1.20:4400")}\n` }),
    };
    const backend = { adopt: async () => ({ machine, login: { HOME: "/home/maya", PATH: "/usr/bin:/bin", USER: "maya" }, shape: { cpu: 2, memMb: 2048 }, arch: "x86_64" }), keyFor: async () => BOX_KEY, sudoFor: async () => "root" as const, hostNameFor: async (reach: SshReach) => reach.host };
    const install = placeInstaller({ backend: backend as never, ...assets(root, [X86]) });
    const warned: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...said: unknown[]) => void warned.push(said.map(String).join(" ")));
    try {
      const said = await install({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, () => {}).catch((e: unknown) => (e as Error).message);
      expect(said).toBe(`box took wsp but could not connect back: ${joinUnansweredLine("http://192.168.1.20:4400")}; nothing this add put on it is left there`);
      // The join it was running, spelled as it ran there, is for whoever reads the host's log.
      expect(warned.join("\n")).toContain("join 'http://192.168.1.20:4400' --code-file '/home/maya/.wsp/join-code' --name 'box'");
    } finally {
      warn.mockRestore();
    }
  });

  it("answers the login it used and the key file it was given, so a later dial of that box takes the same road", async () => {
    const root = tmp("install-road");
    const machine = {
      id: "ssh://maya@box:22",
      kind: "sandbox",
      putBytes: async () => {},
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      facts: async () => ({ os: "Linux 6.8.0" }),
      run: async (script: string) => (script.includes("PREFLIGHT_OK") ? { exitCode: 0, stdout: "PREFLIGHT_OK\n", stderr: "" } : (reachAnswer(script) ?? { exitCode: 0, stdout: "DAEMON_UP\n", stderr: "" })),
    };
    const backend = { adopt: async () => ({ machine, login: { HOME: "/home/maya", PATH: "/usr/bin:/bin", USER: "maya" }, shape: { cpu: 2, memMb: 2048 }, arch: "x86_64" }), keyFor: async () => BOX_KEY, sudoFor: async () => "root" as const, hostNameFor: async (reach: SshReach) => reach.host };
    const install = placeInstaller({ backend: backend as never, ...assets(root) });
    // Without a key: the login alone, in the spelling a person would type back.
    expect(await install({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, () => {})).toEqual({ name: "box", ssh: "maya@box" });
    // With one: the path rides back, since every ssh child here runs with BatchMode and a dial without it would be
    // refused for the publickey on a box that is switched on.
    expect(await install({ address: "maya@box", sshPort: 2222, keyPath: "/Users/lena/.ssh/box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, () => {})).toEqual({
      name: "box",
      ssh: "maya@box:2222",
      sshKeyPath: "/Users/lena/.ssh/box",
    });
  });

  it("reads WSP_READY and PLACE_JOINED off the script's own echo lines, and never waits on a node version", async () => {
    const root = tmp("install-steps");
    const printed: string[] = [];
    const ran: string[] = [];
    // A machine that prints what the script it is given would print: each `echo <word>` line, in order, as the
    // deploy's own output reaches the host line by line; the join on it wrote the place file, so the deploy's last
    // word is DAEMON_UP.
    const machine = {
      id: "ssh://maya@box:22",
      kind: "sandbox",
      putBytes: async () => {},
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      facts: async () => ({ os: "Linux 6.8.0" }),
      run: async (script: string, opts?: { onLine?: (line: string) => void }) => {
        ran.push(script);
        if (script.includes("PREFLIGHT_OK")) return { exitCode: 0, stdout: "PREFLIGHT_OK\n", stderr: "" };
        const reached = reachAnswer(script);
        if (reached !== undefined) return reached;
        if (script.includes(ADD_FOUND_END)) return { exitCode: 0, stdout: `${ADD_FOUND_END}\n`, stderr: "" };
        const lines = script.split("\n").flatMap(line => (/^echo (\S+)$/.exec(line)?.[1] === undefined ? [] : [line.slice("echo ".length)]));
        for (const line of lines) {
          printed.push(line);
          opts?.onLine?.(line);
        }
        return { exitCode: 0, stdout: `${[...lines, "DAEMON_UP"].join("\n")}\n`, stderr: "" };
      },
    };
    const backend = {
      adopt: async () => ({ machine, login: { HOME: "/home/maya", PATH: "/usr/bin:/bin", USER: "maya" }, shape: { cpu: 2, memMb: 2048 }, arch: "x86_64", hostKey: BOX_KEY }),
      keyFor: async () => BOX_KEY,
      sudoFor: async () => "root" as const,
      hostNameFor: async (reach: SshReach) => reach.host,
      knownHostsEntry: async () => ({ file: "/home/maya/.ssh/known_hosts", target: "box" }),
    };
    const stages: string[] = [];
    const installed = await placeInstaller({ backend: backend as never, ...assets(root) })(
      { address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] },
      (step, state, note) => stages.push(`${step} ${state}${note === undefined ? "" : ` (${note})`}`),
    );
    // The login it logged in as rides back with the name: it is the road to the box when its agent stops dialling
    // in, and the join frame the record is made from says nothing about how the box was reached.
    expect(installed).toEqual({ name: "box", ssh: "maya@box", hostKey: "ssh-ed25519 SHA256:abc" });
    // The deploy printed the two words the parser reads, and nothing of a node version.
    expect(printed).toEqual([WSP_READY_LINE, PLACE_JOINED_LINE]);
    expect(ran.join("\n")).not.toContain("NODE_VERSION");
    // Every step reaches done in order, off those two lines: the bundle landing is running from the connect until
    // WSP_READY, the join from then until PLACE_JOINED. The dial's own write to this computer's known_hosts is a
    // step of its own, right after the connect, carrying the key it kept.
    expect(stages).toEqual([
      "connect running",
      "connect done (Linux 6.8.0)",
      "host-key done (ssh-ed25519 SHA256:abc)",
      // What the box must be before anything of wsp's goes on it, each check a row of its own inside the step; a box
      // whose check said nothing is not refused.
      "check running",
      "chip done (x86_64)",
      "root running",
      "root done",
      "system running",
      "system done",
      "disk running",
      "disk done",
      "check done",
      // What the box reached of this host's addresses, before anything of wsp's went onto it.
      "reach running",
      "reach done (http://192.168.1.20:4400)",
      // The chip the box said it runs, which is what picked the binary that landed, and the addresses it is about
      // to dial: both read while the step they belong to is still running, so a wrong one is not a wait first.
      "wsp running (x86_64)",
      "wsp done (x86_64)",
      "service running (it dials this computer at http://192.168.1.20:4400)",
      "service done",
    ]);
    expect(stages.some(line => line.startsWith("node"))).toBe(false);
  });

  it("ticks the known_hosts step on a login ssh would not take, since the dial wrote the key before it was refused", async () => {
    const root = tmp("install-refused");
    const backend = {
      adopt: async () => Promise.reject(new Error("maya@box: Permission denied (publickey).")),
      sudoFor: async () => "root" as const,
      hostNameFor: async (reach: SshReach) => reach.host,
      keyFor: async () => "ssh-ed25519 SHA256:abc",
      // This computer's config points the file somewhere other than the default the plan line names, so the step
      // says which file was written rather than leaving a person to read the default as the truth.
      knownHostsEntry: async () => ({ file: "/Users/lena/.ssh/known_hosts_work", target: "box" }),
    };
    const stages: string[] = [];
    const install = placeInstaller({ backend: backend as never, ...assets(root) });
    await expect(install({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, (step, state, note) => stages.push(`${step} ${state}${note === undefined ? "" : ` (${note})`}`))).rejects.toThrow(
      "Permission denied (publickey).",
    );
    // The plan said the add would write this computer's known_hosts, and it did: the step says so with the key it
    // kept, which is the whole of what a person can check. Nothing else on a failed screen would say it now that
    // the refusal no longer carries ssh's own note.
    expect(stages).toEqual(["connect running", "host-key done (ssh-ed25519 SHA256:abc in /Users/lena/.ssh/known_hosts_work)"]);
  });

  it("refuses a computer this computer has never met before a byte of wsp's leaves, naming the key it answers with", async () => {
    const box = fakeBox("x86_64");
    const never = {
      ...(box.backend as Record<string, unknown>),
      // This computer's ssh client holds no key for it, and the computer itself answers a scan with one.
      keyFor: async () => undefined,
      offeredKeyFor: async () => ({ key: BOX_KEY }),
    };
    const install = placeInstaller({ backend: never as never, ...assets(tmp("first-dial"), [X86]) });
    const refused = await install({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, box.stage).catch((e: unknown) => e as Error & { kind?: string; hostKey?: string });
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toBe(hostKeyUnconfirmedRefusal("maya@box", BOX_KEY));
    // The key rides the refusal as a field under its own kind, so a client that offers Trust reads it, never the words.
    expect(refused).toMatchObject({ kind: PLACE_HOST_KEY_KIND, hostKey: BOX_KEY });
    // Nothing was dialled, so nothing was read off the box and nothing of wsp's landed on it.
    expect(box.ran).toEqual([]);
    expect(box.landed).toEqual([]);

    // A computer no scan can reach either: the refusal names the flag and the config line that stopped the scan.
    const blind = { ...never, offeredKeyFor: async () => ({ stoppedBy: "ProxyJump" }) };
    await expect(placeInstaller({ backend: blind as never, ...assets(tmp("first-dial-blind"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, box.stage)).rejects.toThrow(
      hostKeyUnscannableRefusal("maya@box", "ProxyJump"),
    );
    expect(box.landed).toEqual([]);
  });

  it("refuses a computer that answered with a key other than the one pinned, before the bundle and the code leave", async () => {
    const box = fakeBox("x86_64");
    // The client dials a name behind the word that was typed and writes the entry under the address: the line that
    // removes it is the client's own reading, never one built here from maya@box, which would remove nothing.
    const other = {
      ...(box.backend as Record<string, unknown>),
      keyFor: async () => "ssh-ed25519 SHA256:somebody-else",
      knownHostsEntry: async () => ({ file: "/Users/lena/.ssh/known_hosts_work", target: "[10.0.0.5]:2222" }),
    };
    const install = placeInstaller({ backend: other as never, ...assets(tmp("wrong-key"), [X86]) });
    await expect(install({ address: "maya@box", hostKey: BOX_KEY, code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, box.stage)).rejects.toThrow(
      hostKeyMismatchRefusal({ address: "maya@box", pinned: BOX_KEY, wrote: "ssh-ed25519 SHA256:somebody-else", target: "[10.0.0.5]:2222", file: "/Users/lena/.ssh/known_hosts_work" }),
    );
    expect(box.landed).toEqual([]);
    // The read as the login ran, since the key ssh writes is read after the dial; nothing of wsp's followed it.
    expect(box.order).toEqual(["read"]);
    expect(box.ran).toEqual([]);

    // The same key, given as the bare fingerprint a person reads off ssh-keygen, is the key that answered.
    const pinned = fakeBox("x86_64");
    const matching = { ...(pinned.backend as Record<string, unknown>), adopt: async () => ({ ...(await (pinned.backend as { adopt: () => Promise<object> }).adopt()), hostKey: BOX_KEY }) };
    expect(await placeInstaller({ backend: matching as never, ...assets(tmp("right-key"), [X86]) })({ address: "maya@box", hostKey: BOX_KEY.split(" ")[1]!, code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, pinned.stage)).toMatchObject({ name: "box" });
  });

  it("refuses a computer whose root shell reads a file of the shared home, before anything of wsp's lands", async () => {
    // sshd hands every command the host sends to root's own shell with -c, and on a box that home is the one every
    // workspace on it writes: zsh would read ~/.zshenv there and fish config.fish, as that computer's root.
    for (const shell of ["zsh", "fish"]) {
      const box = fakeBox("x86_64", shell);
      const install = placeInstaller({ backend: box.backend as never, ...assets(tmp(`shell-${shell}`), [X86]) });
      await expect(install({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, box.stage)).rejects.toThrow(placeRootShellRefusal("maya@box", shell));
      // The read that adopted it has run, since sshd chose the shell before wsp could ask; nothing of wsp's did.
      expect(box.landed).toEqual([]);
      expect(box.ran).toEqual([]);
    }
    // A shell wsp has read no file for is refused for that, not for a file it has never seen: ash on an Alpine
    // root reads nothing under -c, and the sentence must not say it does.
    const ash = fakeBox("x86_64", "ash");
    await expect(placeInstaller({ backend: ash.backend as never, ...assets(tmp("shell-ash"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, ash.stage)).rejects.toThrow(
      placeRootShellRefusal("maya@box", "ash"),
    );
    expect(placeRootShellRefusal("maya@box", "ash")).not.toContain("reads ");
    expect(placeRootShellRefusal("maya@box", "zsh")).toContain("reads ~/.zshenv");
    expect(placeRootShellRefusal("maya@box", "fish")).toContain("reads config.fish");
    expect(ash.landed).toEqual([]);

    // The two that read nothing there install as they always did, and so does a box that named no shell at all.
    for (const shell of [...PLACE_ROOT_SHELLS, undefined]) {
      const box = fakeBox("x86_64", shell as string);
      const install = placeInstaller({ backend: box.backend as never, ...assets(tmp(`shell-ok-${shell ?? "unsaid"}`), [X86]) });
      expect(await install({ address: "maya@box", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, box.stage), shell).toMatchObject({ name: "box" });
    }
  });

  it("takes an alias out of the person's ssh config from the sheet, and refuses a word no block renames before any dial", async () => {
    const box = fakeBox("x86_64");
    const dialled: SshReach[] = [];
    const backend = { ...(box.backend as Record<string, unknown>), adopt: async (reach: SshReach) => (dialled.push(reach), (box.backend as { adopt: () => Promise<unknown> }).adopt()) };
    const sshWord = (word: string, o: { port?: number; keyPath?: string }) => sshWordReach(word, o, spooConfig(2222));
    const install = placeInstaller({ backend: backend as never, sshWord, ...assets(tmp("alias-sheet"), [X86]) });
    expect(await install({ address: "spoo", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, box.stage)).toMatchObject({ name: "spoo", ssh: "root@spoo:2222" });
    expect(dialled).toEqual([{ user: "root", host: "spoo", port: 2222 }]);

    const stranger = fakeBox("x86_64");
    await expect(placeInstaller({ backend: stranger.backend as never, sshWord, ...assets(tmp("alias-none"), [X86]) })({ address: "nonsense", code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, stranger.stage)).rejects.toThrow(
      SSH_WORD_REFUSAL("nonsense"),
    );
    expect(stranger.ran).toEqual([]);
    expect(stranger.landed).toEqual([]);
  });

  it("leaves the known_hosts step alone where the dial never got far enough to exchange a key", async () => {
    const root = tmp("install-nokey");
    const backend = {
      adopt: async () => Promise.reject(new Error("ssh: connect to host box port 22: Connection refused")),
      sudoFor: async () => Promise.reject(new Error("ssh: connect to host box port 22: Connection refused")),
      hostNameFor: async (reach: SshReach) => reach.host,
      keyFor: async () => undefined,
      knownHostsEntry: async () => ({ file: "/home/maya/.ssh/known_hosts", target: "box" }),
    };
    const stages: string[] = [];
    const install = placeInstaller({ backend: backend as never, ...assets(root) });
    // The key rides the request, so the dial is made; it never got far enough to exchange one.
    await expect(install({ address: "maya@box", hostKey: BOX_KEY, code: "7QK3M2VD", hostUrls: ["http://192.168.1.20:4400"] }, (step, state, note) => stages.push(`${step} ${state}${note === undefined ? "" : ` (${note})`}`))).rejects.toThrow("Connection refused");
    // Nothing was written, so nothing says it was: the line stands waiting, which is what happened.
    expect(stages).toEqual(["connect running"]);
  });

  it("marks a refused login and a word naming no login as the login's own refusal, and no other refusal", async () => {
    const urls = ["http://192.168.1.20:4400"];
    const kept = "host-key done (ssh-ed25519 SHA256:abc)";
    const kindOf = async (install: Promise<unknown>): Promise<unknown> => (await install.then(() => expect.unreachable(), (e: unknown) => e as { kind?: unknown }))!.kind;

    const refused = fakeBox("x86_64");
    const denied = { ...(refused.backend as Record<string, unknown>), sudoFor: async () => Promise.reject(new Error("maya@box: Permission denied (publickey).")) };
    const login = placeInstaller({ backend: denied as never, ...assets(tmp("kind-login"), [X86]) })({ address: "maya@box", code: "7QK3M2VD", hostUrls: urls }, refused.stage);
    await expect(login).rejects.toBeInstanceOf(PlaceLoginRefusedError);
    expect(await kindOf(login)).toBe(PLACE_LOGIN_REFUSED_KIND);
    expect(refused.stages).toEqual(["connect running", kept]);

    const word = fakeBox("x86_64");
    const sshWord = (w: string, o: { port?: number; keyPath?: string }) => sshWordReach(w, o, spooConfig(2222));
    expect(await kindOf(placeInstaller({ backend: word.backend as never, sshWord, ...assets(tmp("kind-word"), [X86]) })({ address: "nonsense", code: "7QK3M2VD", hostUrls: urls }, word.stage))).toBe(PLACE_LOGIN_REFUSED_KIND);

    // Refused after the login stood: each says the key the dial wrote here, and none carries the login's kind.
    const studio = placeFileText({ placeId: "p_studio", name: "spoo", hostName: "studio", hostUrls: ["http://192.168.1.5:4640"], hostPublicKey: "c3R1ZGlv", keyPath: "/root/.wsp/place.key", joinedAt: "2026-09-20T10:00:00Z" });
    const pinnedOther = fakeBox("x86_64");
    const after: [string, ReturnType<typeof fakeBox>, Record<string, unknown>, string?][] = [
      ["held", fakeBox("x86_64", "bash", { holds: studio }), {}],
      ["shell", fakeBox("x86_64", "zsh"), {}],
      ["chip", fakeBox("riscv64"), {}],
      ["unsaid chip", fakeBox(undefined), {}],
      ["mismatch", pinnedOther, { keyFor: async () => "ssh-ed25519 SHA256:somebody-else" }, BOX_KEY],
    ];
    for (const [what, box, over, hostKey] of after) {
      const install = placeInstaller({ backend: { ...(box.backend as Record<string, unknown>), ...over } as never, ...assets(tmp(`kind-${what.replace(" ", "-")}`), [X86]) });
      expect(await kindOf(install({ address: "root@spoo", code: "7QK3M2VD", hostUrls: urls, ...(hostKey === undefined ? {} : { hostKey }) }, box.stage)), what).toBeUndefined();
      expect(box.stages, what).toEqual(["connect running", what === "mismatch" ? "host-key done (ssh-ed25519 SHA256:somebody-else)" : kept]);
      expect(box.landed, what).toEqual([]);
    }

    // Refused before any dial: not a login problem either.
    const loop = fakeBox("x86_64");
    expect(await kindOf(placeInstaller({ backend: loop.backend as never, ...assets(tmp("kind-loop"), [X86]) })({ address: "root@spoo", code: "7QK3M2VD", hostUrls: ["http://127.0.0.1:4400"] }, loop.stage))).toBeUndefined();
    const stranger = fakeBox("x86_64");
    const unmet = { ...(stranger.backend as Record<string, unknown>), keyFor: async () => undefined };
    // A computer never met carries its own kind, the host key's, never the login's.
    expect(await kindOf(placeInstaller({ backend: unmet as never, ...assets(tmp("kind-unmet"), [X86]) })({ address: "root@spoo", code: "7QK3M2VD", hostUrls: urls }, stranger.stage))).toBe(PLACE_HOST_KEY_KIND);
  });
});
