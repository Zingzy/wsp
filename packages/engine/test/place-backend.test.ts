// SPDX-License-Identifier: AGPL-3.0-only
// The backend for a computer somebody joined: one call leaves it, the
// transport, and every road the runtime already has works over that one call.
import { describe, expect, it } from "vitest";
import { PlaceBackend, PlaceMachine, parsePlaceMachineId, placeMachineId, type PlaceTransport } from "../src/place-backend.js";
import { SSH_BYTES_OK, putBytesScript } from "../src/ssh-backend.js";
import type { ExecResult } from "../src/machine.js";

interface Sent {
  placeId: string;
  cmd: string;
  timeoutMs?: number;
  stdin?: Uint8Array;
}

function recorder(answer: (sent: Sent) => ExecResult = () => ({ exitCode: 0, stdout: "", stderr: "" })): { transport: PlaceTransport; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    transport: async (placeId, cmd, opts) => {
      sent.push({ placeId, cmd, ...opts });
      return answer(sent.at(-1)!);
    },
  };
}

describe("the one written form of a place's machine", () => {
  it("names the place and nothing else, and reads back the same string", () => {
    expect(placeMachineId("p_ab12cd34")).toBe("place:p_ab12cd34");
    expect(parsePlaceMachineId("place:p_ab12cd34")).toBe("p_ab12cd34");
  });

  it("answers nothing for an id another backend wrote, so a record of theirs is never taken for a place's", () => {
    expect(parsePlaceMachineId("ssh://maya@box:22")).toBeUndefined();
    expect(parsePlaceMachineId("place:")).toBeUndefined();
    expect(parsePlaceMachineId("sbx_123")).toBeUndefined();
  });
});

describe("what a place's backend offers", () => {
  const backend = new PlaceBackend(recorder().transport);

  it("forks, pauses, snapshots and resizes nothing, and the machine is the person's own and kept", () => {
    const caps = backend.capabilities;
    expect(caps.sizes).toEqual([]);
    expect(caps.kept).toBe(true);
    expect(caps.pauseMode).toBeUndefined();
    for (const flag of [caps.liveCloneForks, caps.resize, caps.replacesMachine, caps.previewUrls, caps.signedUrls, caps.containers, caps.callbackRelay, caps.diskSnapshots, caps.snapshotListing, caps.templates]) {
      expect(flag).toBe(false);
    }
  });

  it("bills nothing, since wsp neither made the computer nor runs it", () => {
    expect(backend.pricing.rateUsdPerHour({ cpu: 8, memMb: 16384 })).toBe(0);
    expect(backend.pricing.defaultSize).toEqual({ cpu: 0, memMb: 0 });
  });

  it("answers a machine from the id and nothing from a listing: the records are the fleet", async () => {
    const machine = await backend.get(placeMachineId("p_1"));
    expect(machine.id).toBe("place:p_1");
    expect(await backend.list()).toEqual([]);
    await expect(backend.get("ssh://maya@box:22")).rejects.toThrow(/is not a machine this host reaches as a place/);
    await expect(backend.create()).rejects.toThrow(/already exists/);
  });

  it("refuses every move only a machine wsp forks takes, in its own words", async () => {
    const machine = await backend.get(placeMachineId("p_1"));
    await expect(machine.snapshot("x", { firstLife: true })).rejects.toThrow(/cannot be snapshotted/);
    await expect(machine.pause()).rejects.toThrow(/cannot be paused/);
    await expect(machine.resume()).rejects.toThrow(/cannot be resumed/);
    await expect(machine.downloadUrl("/x")).rejects.toThrow(/no signed download URL/);
    await expect(machine.uploadUrl("/x")).rejects.toThrow(/no signed upload URL/);
    // A delete drops the record; the computer is the person's own and wsp never made it.
    await expect(machine.kill()).resolves.toBeUndefined();
    expect(await machine.state()).toBe("running");
  });
});

describe("a command on a place", () => {
  it("goes to the transport with the place's id and the command as it stands", async () => {
    const { transport, sent } = recorder(() => ({ exitCode: 7, stdout: "said", stderr: "" }));
    const machine = new PlaceMachine("p_1", transport);
    expect(await machine.exec("echo hi", { timeoutMs: 1_234 })).toEqual({ exitCode: 7, stdout: "said", stderr: "" });
    expect(sent).toEqual([{ placeId: "p_1", cmd: "echo hi", timeoutMs: 1_234 }]);
  });

  it("carries a file's bytes on the exec op's stdin under the script the ssh road writes with", async () => {
    const { transport, sent } = recorder(() => ({ exitCode: 0, stdout: SSH_BYTES_OK, stderr: "" }));
    const machine = new PlaceMachine("p_1", transport);
    const bytes = new TextEncoder().encode("a token\n");
    await machine.putBytes("/home/maya/.wsp/daemon-token", bytes);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.stdin).toEqual(bytes);
    // The temporary name is minted per write, so the command is the one script with that name in it.
    const tmp = sent[0]!.cmd.match(/\.wsp-in-[0-9a-f]+/)![0];
    expect(sent[0]!.cmd).toBe(putBytesScript("/home/maya/.wsp/daemon-token", bytes.length, `/home/maya/.wsp/daemon-token${tmp}`));
  });

  it("says the bytes did not land when the script did not say they had", async () => {
    const { transport } = recorder(() => ({ exitCode: 1, stdout: "WSP_BYTES_SHORT", stderr: "" }));
    const machine = new PlaceMachine("p_1", transport);
    await expect(machine.putBytes("/home/maya/x", new Uint8Array(3))).rejects.toThrow(/did not land at \/home\/maya\/x over the link/);
  });

  it("launches a long run under wsp's own folder on that computer, and refuses one where no home is on record", async () => {
    // The launch is the one frame this proves: what the detached road does after it is the road's own, and its own
    // tests hold it. A launch the machine refused is the shortest honest end to the run.
    const { transport, sent } = recorder(() => ({ exitCode: 1, stdout: "", stderr: "no such folder" }));
    const machine = new PlaceMachine("p_1", transport, "/home/maya/.wsp/run");
    await expect(machine.run("echo long", { deadlineMs: 5_000, pollMs: 10 })).rejects.toThrow(/launch failed on place:p_1/);
    expect(sent[0]!.cmd).toContain("/home/maya/.wsp/run/");
    // A shared temporary folder is another account's on somebody's own computer, so a place with no home on record
    // takes no long run rather than guessing one.
    const homeless = new PlaceMachine("p_2", transport);
    expect(() => homeless.run("echo long", { deadlineMs: 1_000 })).toThrow(/has no run folder on record/);
  });

  it("says what the computer is off one read, and throws when it says none of it", async () => {
    const facts = recorder(() => ({ exitCode: 0, stdout: "pretty Ubuntu 24.04\nuptime 4242\nhome /home/maya\n", stderr: "" }));
    const machine = new PlaceMachine("p_1", facts.transport);
    const read = await machine.facts();
    expect(read.folder).toBe("/home/maya");
    expect(read.os).toContain("Ubuntu");
    expect(read.uptimeMs).toBe(4_242_000);
    const quiet = new PlaceMachine("p_1", recorder(() => ({ exitCode: 1, stdout: "", stderr: "no" })).transport);
    await expect(quiet.facts()).rejects.toThrow(/did not say what it is over its link/);
  });

  it("reads its own shape over the link, since a computer somebody owns is upgraded under wsp rather than by it", async () => {
    const { transport } = recorder(() => ({ exitCode: 0, stdout: "cpu 8\nmemkb 16777216\n", stderr: "" }));
    expect(await new PlaceMachine("p_1", transport).describe()).toEqual({ cpu: 8, memMb: 16384 });
  });
});
