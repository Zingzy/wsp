// SPDX-License-Identifier: AGPL-3.0-only
// The four words about where a person's agents run. The join here dials a
// real ws server holding a real ed25519 pair, so the handshake typed on a
// computer is the one a host answers; the service manager is a fake runner,
// since installing a launchd agent is not this test's business.
import { describe, expect, it } from "vitest";
import { hostKeyAsk, hostKeyUnconfirmedRefusal, hostKeyUnscannableRefusal, PLACE_ADD_WORDS, placeDaemonPaths, type PlaceView } from "@wsp/protocol";
import { sshWordReach, type SshReach, type SshTransport } from "@wsp/engine";
import { ADD_FLAGS_REFUSAL, addCommand, addFlags, addRefusal, placeDialler, placeLogReader, PLACE_LOG_TAIL, UPDATE_FLAGS_REFUSAL } from "../src/places.js";
import { captured } from "./verbs-fixture.js";
import { opts, spooConfig, systemPlaceDeps, tmp } from "./places-fixture.js";

describe("wsp add on a computer reached over ssh", () => {
  it("asks the host to do it, prints each step as it lands and says what joined", async () => {
    const io = captured();
    const frames: ((frame: Record<string, unknown>) => void)[] = [];
    const place: PlaceView = { id: "p_1", kind: "computer", name: "box", default: true, shape: { cpu: 4, memMb: 4096 }, diskFreeBytes: 38 * 1024 ** 3, engine: "none", present: true, takesForks: true };
    const client = {
      request: async (op: string, params?: Record<string, unknown>) => {
        expect(op).toBe("places.add");
        expect(params).toMatchObject({ address: "root@10.0.0.9", name: "box", sshPort: 2222 });
        // The line minted the stream it asks under, since the steps reach the terminal before the reply does.
        const addId = String(params!["addId"]);
        expect(addId).toMatch(/^a_/);
        for (const fn of frames) {
          fn({ type: "place.stage", addId, step: "connect", state: "done", note: "Linux 6.8.0" });
          // Another client's install on the same host is another stream, and this line prints none of it.
          fn({ type: "place.stage", addId: "a_other", step: "connect", state: "done", note: "somebody else" });
        }
        return { addId, place, hostKey: "ssh-ed25519 SHA256:abc" } as Record<string, unknown>;
      },
      events: async () => {},
      onFrame: (fn: (frame: Record<string, unknown>) => void) => {
        frames.push(fn);
        return () => frames.splice(frames.indexOf(fn), 1);
      },
      closeWords: () => "",
      closed: Promise.resolve(),
      close: () => {},
      terminate: () => {},
    };
    const deps = { ...systemPlaceDeps, dial: async () => client as never };
    expect(await addCommand(io, opts(tmp("add-ssh")), ["root@10.0.0.9"], addFlags("box", "2222", undefined), deps)).toBe(0);
    const said = io.lines.join("\n");
    expect(said).toContain(`${PLACE_ADD_WORDS.connect}: Linux 6.8.0`);
    expect(said).toContain("box joined this wsp");
    expect(said).toContain("ssh-ed25519 SHA256:abc");
    // A computer that joined runs your workspaces by definition, so the only doctor sentence left on the line is
    // the engine a project's own containers would run on there.
    expect(said).not.toContain("box runs your workspaces");
    expect(said).toContain("box has no container engine");
    expect(said).toContain("wsp remove box");
    expect(said).not.toContain("somebody else");
  });

  it("says a failed step's sentence once: the step is marked on its line and the sentence is the failure's own", async () => {
    const io = captured();
    const frames: ((frame: Record<string, unknown>) => void)[] = [];
    const sentence = "root@10.0.0.9 cannot reach this computer at http://192.168.1.20:4640, so nothing of wsp's went onto it";
    const client = {
      request: async (_op: string, params?: Record<string, unknown>) => {
        const addId = String(params!["addId"]);
        for (const fn of frames) {
          fn({ type: "place.stage", addId, step: "connect", state: "done", note: "Linux 6.8.0" });
          fn({ type: "place.stage", addId, step: "reach", state: "failed", note: sentence });
        }
        throw new Error(sentence);
      },
      events: async () => {},
      onFrame: (fn: (frame: Record<string, unknown>) => void) => {
        frames.push(fn);
        return () => frames.splice(frames.indexOf(fn), 1);
      },
      closeWords: () => "",
      closed: Promise.resolve(),
      close: () => {},
      terminate: () => {},
    };
    const deps = { ...systemPlaceDeps, dial: async () => client as never };
    await expect(addCommand(io, opts(tmp("add-ssh-failed")), ["root@10.0.0.9"], addFlags("box", "2222", undefined), deps)).rejects.toThrow(sentence);
    expect(io.lines).toContain(`  x ${PLACE_ADD_WORDS.reach}`);
    expect([...io.lines, ...io.errors].filter(line => line.includes(sentence))).toEqual([]);
  });

  it("asks about the key of a computer this one has never dialled, sends the one it was answered with, and sends nothing off a terminal", async () => {
    const OFFERED = "ssh-ed25519 SHA256:offered";
    const sent: (Record<string, unknown> | undefined)[] = [];
    const client = {
      request: async (_op: string, params?: Record<string, unknown>) => {
        sent.push(params);
        return { place: { id: "p_1", kind: "computer", name: "box", default: true, engine: "none", present: true, takesForks: true } as PlaceView } as Record<string, unknown>;
      },
      events: async () => {},
      onFrame: () => () => {},
      closeWords: () => "",
      closed: Promise.resolve(),
      close: () => {},
      terminate: () => {},
    };
    const deps = {
      ...systemPlaceDeps,
      dial: async () => client as never,
      heldHostKey: async () => undefined,
      offeredHostKey: async () => ({ key: OFFERED }),
    };

    // Nobody at the keyboard: the line refuses with the key the computer answers with and the line that pins it,
    // and the host is never asked, so nothing was dialled from here either.
    const quiet = captured();
    expect(await addCommand(quiet, opts(tmp("add-quiet")), ["root@10.0.0.9"], {}, deps)).toBe(1);
    expect(quiet.errors).toEqual([hostKeyUnconfirmedRefusal("root@10.0.0.9", OFFERED)]);
    expect(sent).toEqual([]);

    // A person at the keyboard who says no: the same refusal and nothing sent.
    const asked: string[] = [];
    const no = { ...captured(), isTTY: true, ask: async (q: string) => (asked.push(q), "no") };
    expect(await addCommand(no, opts(tmp("add-no")), ["root@10.0.0.9"], {}, deps)).toBe(1);
    expect(asked).toEqual([hostKeyAsk("root@10.0.0.9", OFFERED)]);
    expect(sent).toEqual([]);

    // A yes sends the key the person just read, and the host is the one that holds the computer to it.
    const yes = { ...captured(), isTTY: true, ask: async () => "yes" };
    expect(await addCommand(yes, opts(tmp("add-yes")), ["root@10.0.0.9"], {}, deps)).toBe(0);
    expect(sent.at(-1)).toMatchObject({ address: "root@10.0.0.9", hostKey: OFFERED });

    // The flag pins it with nothing asked and nothing scanned, whether or not the scan could have answered.
    const pinned = captured();
    const blind = { ...deps, offeredHostKey: async () => ({ stoppedBy: "ProxyJump" }) };
    expect(await addCommand(pinned, opts(tmp("add-pin")), ["root@10.0.0.9"], { hostKey: "SHA256:typed" }, blind)).toBe(0);
    expect(sent.at(-1)).toMatchObject({ hostKey: "SHA256:typed" });

    // No flag and no scan to ask: the refusal names the flag and the config line that stopped the scan.
    const stopped = captured();
    expect(await addCommand(stopped, opts(tmp("add-blind")), ["root@10.0.0.9"], {}, blind)).toBe(1);
    expect(stopped.errors).toEqual([hostKeyUnscannableRefusal("root@10.0.0.9", "ProxyJump")]);

    // A computer this computer's client already holds a key for is dialled as it always was, with none sent.
    const known = captured();
    expect(await addCommand(known, opts(tmp("add-known")), ["root@10.0.0.9"], {}, { ...deps, heldHostKey: async () => "ssh-ed25519 SHA256:held" })).toBe(0);
    expect(sent.at(-1)!["hostKey"]).toBeUndefined();
  });

  it("takes an alias out of the person's ssh config as the login its block names, and still refuses a word no block renames", async () => {
    const sent: (Record<string, unknown> | undefined)[] = [];
    const read: SshReach[] = [];
    const client = {
      request: async (_op: string, params?: Record<string, unknown>) => {
        sent.push(params);
        return { place: { id: "p_1", kind: "computer", name: "spoo", default: true, engine: "none", present: true, takesForks: true } as PlaceView } as Record<string, unknown>;
      },
      events: async () => {},
      onFrame: () => () => {},
      closeWords: () => "",
      closed: Promise.resolve(),
      close: () => {},
      terminate: () => {},
    };
    const deps = { ...systemPlaceDeps, dial: async () => client as never, heldHostKey: async (reach: SshReach) => (read.push(reach), "ssh-ed25519 SHA256:held") };

    // The alias stays the host so the block keeps applying, and the record reads the login that block names.
    const io = captured();
    expect(await addCommand(io, opts(tmp("add-alias")), ["spoo"], {}, deps), io.errors.join("\n")).toBe(0);
    expect(sent.at(-1)).toMatchObject({ address: "root@spoo" });
    expect(read.at(-1)).toEqual({ user: "root", host: "spoo", port: 22 });

    // A block with a Port of its own keeps it: a 22 on the dial would override the config.
    const ported = captured();
    const portDeps = { ...deps, sshWord: (word: string, o: { port?: number; keyPath?: string }) => sshWordReach(word, o, spooConfig(2222)) };
    expect(await addCommand(ported, opts(tmp("add-alias-port")), ["spoo"], {}, portDeps), ported.errors.join("\n")).toBe(0);
    expect(sent.at(-1)).toMatchObject({ address: "root@spoo:2222" });
    expect(read.at(-1)).toEqual({ user: "root", host: "spoo", port: 2222 });

    // A word ssh does not rename is refused as it always was, and nothing was asked of the host.
    const before = sent.length;
    const refused = captured();
    expect(await addCommand(refused, opts(tmp("add-no-alias")), ["nonsense"], {}, deps)).toBe(1);
    expect(refused.errors).toEqual([addRefusal("nonsense")]);
    expect(sent.length).toBe(before);
  });

  it("reads the port and the key by the rule every ssh road on this command line reads them by", () => {
    expect(addFlags("box", "2222", "/tmp/id_ed25519")).toEqual({ name: "box", sshPort: 2222, keyPath: "/tmp/id_ed25519" });
    expect(addFlags(undefined, undefined, undefined)).toEqual({});
    // The pinned key rides the same reading, with the spaces a person leaves around a pasted word taken off.
    expect(addFlags(undefined, undefined, undefined, undefined, undefined, undefined, undefined, {}, "  ssh-ed25519 SHA256:abc  ")).toEqual({ hostKey: "ssh-ed25519 SHA256:abc" });
    expect(addFlags(undefined, undefined, undefined, undefined, undefined, undefined, undefined, {}, "   ")).toEqual({});
    expect(() => addFlags(undefined, "no", undefined)).toThrow("--ssh-port");
  });

  it("refuses the ssh road's flags when no computer was named beside them, naming the word that does name one", async () => {
    const io = captured();
    expect(await addCommand(io, opts(tmp("add-flags")), [], { sshPort: 2222 }, systemPlaceDeps)).toBe(1);
    expect(io.errors).toEqual([ADD_FLAGS_REFUSAL]);
    // A pinned key is one of the ssh road's flags too: it names nothing on its own and belongs beside none of the
    // other two words this verb takes.
    const pinned = captured();
    expect(await addCommand(pinned, opts(tmp("add-pin-alone")), [], { hostKey: "SHA256:x" }, systemPlaceDeps)).toBe(1);
    expect(pinned.errors).toEqual([ADD_FLAGS_REFUSAL]);
    const updating = captured();
    expect(await addCommand(updating, opts(tmp("add-pin-update")), ["box"], { update: true, hostKey: "SHA256:x" }, systemPlaceDeps)).toBe(1);
    expect(updating.errors).toEqual([UPDATE_FLAGS_REFUSAL]);
  });
});

describe("dialling a box whose agent stopped calling home", () => {
  /** One ssh child, as the transport sees it: the dial it was given and the script it was asked to run. */
  const dialler = (answer: { exitCode: number; stdout?: string; stderr?: string }) => {
    const asked: { reach: SshReach; script: string }[] = [];
    const transport: SshTransport = async (reach, script) => {
      asked.push({ reach, script });
      return { exitCode: answer.exitCode, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
    };
    return { asked, dial: placeDialler({ transport }) };
  };

  it("opens one connection over the login on the record, runs a command every unix has, and installs nothing", async () => {
    const { asked, dial } = dialler({ exitCode: 0 });
    await dial({ ssh: "root@65.21.4.12" });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.reach).toEqual({ user: "root", host: "65.21.4.12", port: 22 });
    expect(asked[0]!.script).toBe("exit 0");
  });

  it("hands back ssh's own line and nothing of the reader that asked, which is the sentence the person came for", async () => {
    const said = "ssh: connect to host 65.21.4.12 port 22: Connection refused";
    const { dial } = dialler({ exitCode: 255, stderr: `${said}\n` });
    // Not "root@... did not say what it is over ssh (exit 255): ...": the half before the colon is the reader
    // talking about itself, which is the class of leak the absent computer's own sentence was cut of.
    await expect(dial({ ssh: "root@65.21.4.12" })).rejects.toThrow(said);
    await expect(dial({ ssh: "root@65.21.4.12" })).rejects.toThrow(/^ssh: connect to host/);
  });

  it("drops ssh's debug chatter, keeping the line a person would have read in their own terminal", async () => {
    const said = "root@65.21.4.12: Permission denied (publickey).";
    const { dial } = dialler({ exitCode: 255, stderr: `debug1: Reading configuration data\ndebug2: resolving\n${said}\n` });
    await expect(dial({ ssh: "root@65.21.4.12" })).rejects.toThrow(said);
    await expect(dial({ ssh: "root@65.21.4.12" })).rejects.not.toThrow(/debug/);
  });

  it("says who refused where ssh itself said nothing, rather than throwing an empty sentence", async () => {
    const { dial } = dialler({ exitCode: 255 });
    await expect(dial({ ssh: "root@65.21.4.12" })).rejects.toThrow("root@65.21.4.12 refused the login over ssh (exit 255)");
  });

  it("dials with the key file the add was given, since ssh here runs with BatchMode and would refuse for the publickey", async () => {
    const { asked, dial } = dialler({ exitCode: 0 });
    await dial({ ssh: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner" });
    expect(asked[0]!.reach.keyPath).toBe("/Users/lena/.ssh/hetzner");
  });

  it("dials the port the login names, so a box on a port of its own is reached at it", async () => {
    const { asked, dial } = dialler({ exitCode: 0 });
    await dial({ ssh: "root@65.21.4.12:2222" });
    expect(asked[0]!.reach.port).toBe(2222);
  });
});

describe("what a box that took the agent and did not dial back says for itself", () => {
  /** One ssh child, as the transport sees it: the dial it was given and the script it was asked to run. */
  const reader = (answer: { exitCode: number; stdout?: string }) => {
    const asked: { reach: SshReach; script: string }[] = [];
    const transport: SshTransport = async (reach, script) => {
      asked.push({ reach, script });
      return { exitCode: answer.exitCode, stdout: answer.stdout ?? "", stderr: "" };
    };
    return { asked, read: placeLogReader({ transport }) };
  };

  const SAID = [
    "https://h645d7f8a8d48cbd6.example could not be dialled: not an http address",
    "http://100.129.175.77:4420 did not answer in 10s",
  ];

  it("reads the end of the agent's own log over the login the install used, at the path the box's own HOME names", async () => {
    const { asked, read } = reader({ exitCode: 0, stdout: `${SAID.join("\n")}\n` });
    expect(await read({ ssh: "root@spoo" })).toEqual(SAID);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.reach).toEqual({ user: "root", host: "spoo", port: 22 });
    // $HOME rather than a home read here: the login's own home is the box's reading of it, and one ssh child is
    // what a person waiting on a wait that already ran out can afford.
    expect(asked[0]!.script).toBe(`tail -n ${PLACE_LOG_TAIL} "${placeDaemonPaths("$HOME").placeLog}" 2>/dev/null`);
  });

  it("hands back nothing where the box has no log yet, leaving the wait's own sentence as it stands", async () => {
    const { read } = reader({ exitCode: 1 });
    expect(await read({ ssh: "root@spoo" })).toEqual([]);
  });

  it("keeps the last ten lines and no more, which is what reads under one sentence", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const { read } = reader({ exitCode: 0, stdout: `${lines.join("\n")}\n` });
    expect(await read({ ssh: "root@spoo" })).toEqual(lines.slice(-PLACE_LOG_TAIL));
  });

  it("carries the key file the add was given, since every ssh child here runs with BatchMode on", async () => {
    const { asked, read } = reader({ exitCode: 0, stdout: "linked\n" });
    await read({ ssh: "root@spoo:2222", keyPath: "/Users/lena/.ssh/hetzner" });
    expect(asked[0]!.reach).toEqual({ user: "root", host: "spoo", port: 2222, keyPath: "/Users/lena/.ssh/hetzner" });
  });
});
