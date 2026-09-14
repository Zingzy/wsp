// SPDX-License-Identifier: AGPL-3.0-only
// Machines on another computer, driven a frame at a time. What the far side
// answers is what its own backend answered, and which optional calls a handle
// carries is the far side's to say.
import { describe, expect, it } from "vitest";
import { MACHINE_PUT_PART_BYTES, type BackendFacts, type Capabilities, type MachineHandle } from "@wsp/protocol";
import { LINK_MARGIN_MS, LinkBackend, LinkMachine, PlaceAbsentError, isPlaceAbsent, type MachineLink } from "../src/link-backend.js";
import type { SnapshotProgress } from "../src/machine.js";
import { INLINE_EXEC_MS } from "../src/exec-detached.js";
import { isMissing } from "../src/errors.js";

interface Sent {
  op: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
  idempotencyKey?: string;
}

const CAPABILITIES: Capabilities = {
  liveCloneForks: false,
  pauseMode: "memory",
  replacesMachine: true,
  previewUrls: false,
  signedUrls: false,
  callbackRelay: true,
  diskSnapshots: true,
  snapshotsAnyLife: false,
  snapshotListing: true,
  templates: true,
  kept: false,
  sizes: [{ cpu: 2, memMb: 4096, rateUsdPerHour: 0 }],
};

const FACTS: BackendFacts = {
  offer: "docker",
  capabilities: CAPABILITIES,
  pricing: { defaultSize: { cpu: 2, memMb: 4096 }, snapshotStorage: { freeGb: 0, usdPerGbMonth: 0, billedFrom: "" } },
  lifecycle: { budgets: { wakeAttempts: 1, daemonAnswersMs: 30_000 } },
  baseTemplates: { sandbox: "ubuntu:24.04", desktop: "ubuntu:24.04" },
};

const ROADS: MachineHandle["roads"] = { previewUrl: true, daemonAnswers: true, putBytes: true, describe: true, facts: true, metrics: true };
const HANDLE: MachineHandle = { id: "c1", kind: "sandbox", daemonSupervisor: "entrypoint", roads: ROADS };

function link(answers: (sent: Sent) => unknown = () => ({}), dialsBack?: () => Promise<boolean>): { link: MachineLink; sent: Sent[]; forwarded: number[] } {
  const sent: Sent[] = [];
  const forwarded: number[] = [];
  return {
    sent,
    forwarded,
    link: {
      request: async (op, params, opts) => {
        sent.push({
          op,
          params: params ?? {},
          ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts?.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
        });
        const answer = answers(sent.at(-1)!);
        if (answer instanceof Error) throw answer;
        return (answer as Record<string, unknown>) ?? {};
      },
      ...(dialsBack !== undefined ? { dialsBack } : {}),
      forward: async placePort => {
        forwarded.push(placePort);
        return { localPort: 51000 + forwarded.length };
      },
    },
  };
}

const opened = (answers: (sent: Sent) => unknown): ReturnType<typeof link> => {
  const made = link(sent => (sent.op === "machine.backend" ? FACTS : answers(sent)));
  return made;
};

describe("what a backend over a link says about itself", () => {
  it("asks once and answers with what the far side said", async () => {
    const l = opened(() => ({}));
    const backend = await LinkBackend.open(l.link);
    expect(l.sent.map(s => s.op)).toEqual(["machine.backend"]);
    expect(backend.capabilities).toEqual(CAPABILITIES);
    expect(backend.lifecycle?.budgets.wakeAttempts).toBe(1);
    expect(backend.baseTemplates?.sandbox).toBe("ubuntu:24.04");
  });

  it("carries the snapshot listing under its capability and not otherwise", async () => {
    const l = opened(() => ({}));
    expect((await LinkBackend.open(l.link)).listSnapshots).toBeDefined();
    const off = link(() => ({ ...FACTS, capabilities: { ...CAPABILITIES, snapshotListing: false } }));
    expect((await LinkBackend.open(off.link)).listSnapshots).toBeUndefined();
  });

  it("carries the four template calls together, under their capability", async () => {
    const on = await LinkBackend.open(opened(() => ({})).link);
    for (const call of [on.promoteSnapshot, on.getTemplate, on.listTemplates, on.deleteTemplate]) expect(call).toBeDefined();
    const off = await LinkBackend.open(link(() => ({ ...FACTS, capabilities: { ...CAPABILITIES, templates: false } })).link);
    for (const call of [off.promoteSnapshot, off.getTemplate, off.listTemplates, off.deleteTemplate]) expect(call).toBeUndefined();
  });

  it("prices a size off the offers the far side sent, and nothing for one it does not offer", async () => {
    const backend = await LinkBackend.open(opened(() => ({})).link);
    expect(backend.pricing.rateUsdPerHour({ cpu: 2, memMb: 4096 })).toBe(0);
    expect(backend.pricing.rateUsdPerHour({ cpu: 64, memMb: 9999 })).toBe(0);
    expect(backend.pricing.defaultSize).toEqual({ cpu: 2, memMb: 4096 });
  });
});

describe("a machine over a link", () => {
  const withMachine = async (answers: (sent: Sent) => unknown) => {
    const l = opened(sent => (sent.op === "machine.create" || sent.op === "machine.get" ? { machine: HANDLE } : answers(sent)));
    const backend = await LinkBackend.open(l.link);
    return { l, backend };
  };

  it("sends the spec whole and carries exactly the roads the handle named", async () => {
    const { l, backend } = await withMachine(() => ({}));
    const machine = await backend.create({ kind: "sandbox", template: "wsp/dev:template", cpu: 2, memMb: 4096 });
    expect(l.sent.at(-1)!.params["spec"]).toEqual({ kind: "sandbox", template: "wsp/dev:template", cpu: 2, memMb: 4096 });
    expect(machine.previewUrl).toBeDefined();
    expect(machine.putBytes).toBeDefined();
    expect(machine.daemonSupervisor).toBe("entrypoint");
  });

  it("carries the sentence the computer answered the create with, and none where it answered none", async () => {
    const said = "size 2x4 on 2 cores: cpu clamped to 1 and memory clamped to 2 GB";
    const l = opened(sent => (sent.op === "machine.create" ? { machine: { ...HANDLE, notice: said } } : {}));
    expect((await (await LinkBackend.open(l.link)).create({ kind: "sandbox", cpu: 2, memMb: 4096 })).notice).toBe(said);
    const { backend } = await withMachine(() => ({}));
    expect((await backend.create({ kind: "sandbox" })).notice).toBeUndefined();
  });

  it("leaves out a road the handle did not name", async () => {
    const l = opened(sent => (sent.op === "machine.create" ? { machine: { ...HANDLE, roads: { ...ROADS, previewUrl: false, metrics: false } } } : {}));
    const machine = await (await LinkBackend.open(l.link)).create({ kind: "sandbox" });
    expect(machine.previewUrl).toBeUndefined();
    expect(machine.metrics).toBeUndefined();
    expect(machine.describe).toBeDefined();
  });

  it("execs with the caller's bound, and waits a little longer than it for the answer", async () => {
    const { l, backend } = await withMachine(() => ({ result: { exitCode: 0, stdout: "hi", stderr: "" } }));
    const machine = await backend.create({ kind: "sandbox" });
    expect(await machine.exec("echo hi", { timeoutMs: 1000 })).toEqual({ exitCode: 0, stdout: "hi", stderr: "" });
    expect(l.sent.at(-1)).toMatchObject({ op: "machine.exec", params: { machineId: "c1", cmd: "echo hi", timeoutMs: 1000 }, timeoutMs: 1000 + LINK_MARGIN_MS });
  });

  it("runs a script over exec frames and sends no run frame of its own", async () => {
    const { l, backend } = await withMachine(sent => ({
      result: { exitCode: 0, stdout: String(sent.params["cmd"]).includes("WSP_LAUNCHED") ? "WSP_LAUNCHED" : "0", stderr: "" },
    }));
    const machine = await backend.create({ kind: "sandbox" });
    await machine.run("echo hi", { deadlineMs: 100, pollMs: 1 }).catch(() => undefined);
    expect(l.sent.every(s => s.op !== "machine.run")).toBe(true);
    expect(l.sent.filter(s => s.op === "machine.exec").length).toBeGreaterThan(0);
  });

  it("reads a refusal the far side's own backend gave, so a container it lost is missing here", async () => {
    const l = opened(sent => (sent.op === "machine.get" ? Object.assign(new Error("no such container"), { kind: "missing", status: 404 }) : {}));
    const backend = await LinkBackend.open(l.link);
    await expect(backend.get("c9")).rejects.toSatisfy(isMissing);
  });

  it("passes a place that is not connected through as it is", async () => {
    const l = opened(sent => (sent.op === "machine.get" ? new PlaceAbsentError("srv is not connected right now") : {}));
    const backend = await LinkBackend.open(l.link);
    await expect(backend.get("c1")).rejects.toSatisfy(isPlaceAbsent);
  });

  it("sends a file in parts under one upload, in order, the last one marked", async () => {
    const { l, backend } = await withMachine(() => ({}));
    const machine = await backend.create({ kind: "sandbox" });
    await machine.putBytes!("/root/big", new Uint8Array(9 * 1024 * 1024));
    const parts = l.sent.filter(s => s.op === "machine.putBytes");
    expect(parts.map(p => p.params["seq"])).toEqual([0, 1, 2]);
    expect(parts.map(p => p.params["last"])).toEqual([false, false, true]);
    expect(new Set(parts.map(p => p.params["uploadId"])).size).toBe(1);
    expect(Buffer.from(String(parts[0]!.params["data"]), "base64").length).toBe(MACHINE_PUT_PART_BYTES);
  });

  it("names a create by the key its spec carries, so the far side answers the machine it already made, and names one with no key not at all", async () => {
    const { l, backend } = await withMachine(() => ({}));
    await backend.create({ kind: "sandbox", idempotencyKey: "workspace/ws_1:a1" });
    expect(l.sent.at(-1)!.idempotencyKey).toBe("workspace/ws_1:a1");
    await backend.create({ kind: "sandbox" });
    expect(l.sent.at(-1)!.idempotencyKey).toBeUndefined();
  });

  it("names an exec the caller says lands the same twice, and sends every other one unnamed", async () => {
    const { l, backend } = await withMachine(() => ({ result: { exitCode: 0, stdout: "", stderr: "" } }));
    const machine = await backend.create({ kind: "sandbox" });
    await machine.exec("rm -f /tmp/x", { idempotencyKey: "clean/1" });
    expect(l.sent.at(-1)!.idempotencyKey).toBe("clean/1");
    await machine.exec("echo hi");
    expect(l.sent.at(-1)!.idempotencyKey).toBeUndefined();
  });

  it("carries no key on a part, and sends the whole upload again under a fresh id when the link went and came back", async () => {
    let broken = true;
    const l = link(
      sent => {
        if (sent.op === "machine.backend") return FACTS;
        if (sent.op === "machine.create") return { machine: HANDLE };
        if (sent.op === "machine.putBytes" && broken && sent.params["seq"] === 1) return new Error("connection lost");
        return {};
      },
      async () => {
        broken = false;
        return true;
      },
    );
    const machine = await (await LinkBackend.open(l.link)).create({ kind: "sandbox" });
    await machine.putBytes!("/root/big", new Uint8Array(9 * 1024 * 1024));
    const parts = l.sent.filter(s => s.op === "machine.putBytes");
    // A part appended twice would splice the file, so no part names itself as one to ask again.
    expect(parts.every(p => p.idempotencyKey === undefined)).toBe(true);
    // Two parts of the broken upload, then all three again under a name the far side holds nothing under.
    expect(parts.map(p => p.params["seq"])).toEqual([0, 1, 0, 1, 2]);
    const ids = [...new Set(parts.map(p => p.params["uploadId"]))];
    expect(ids).toHaveLength(2);
    expect(parts.slice(2).every(p => p.params["uploadId"] === ids[1])).toBe(true);
  });

  it("fails an upload with the part's own answer when the computer never came back, and asks nothing again when the link never went", async () => {
    const away = link(
      sent => (sent.op === "machine.backend" ? FACTS : sent.op === "machine.create" ? { machine: HANDLE } : sent.op === "machine.putBytes" ? new Error("connection lost") : {}),
      async () => false,
    );
    const gone = await (await LinkBackend.open(away.link)).create({ kind: "sandbox" });
    await expect(gone.putBytes!("/root/big", new Uint8Array([1]))).rejects.toThrow("connection lost");
    expect(away.sent.filter(s => s.op === "machine.putBytes")).toHaveLength(1);

    const refused = link(
      sent => (sent.op === "machine.backend" ? FACTS : sent.op === "machine.create" ? { machine: HANDLE } : sent.op === "machine.putBytes" ? new Error("no space left on device") : {}),
      async () => false,
    );
    const full = await (await LinkBackend.open(refused.link)).create({ kind: "sandbox" });
    await expect(full.putBytes!("/root/big", new Uint8Array([1]))).rejects.toThrow("no space left on device");
    expect(refused.sent.filter(s => s.op === "machine.putBytes")).toHaveLength(1);
  });

  it("sends one part for one byte", async () => {
    const { l, backend } = await withMachine(() => ({}));
    const machine = await backend.create({ kind: "sandbox" });
    await machine.putBytes!("/root/one", new Uint8Array([7]));
    const parts = l.sent.filter(s => s.op === "machine.putBytes");
    expect(parts.length).toBe(1);
    expect(parts[0]!.params["last"]).toBe(true);
  });

  it("turns the far side's own loopback route into one on this computer", async () => {
    const { l, backend } = await withMachine(sent => (sent.op === "machine.previewUrl" ? { reach: { url: "http://127.0.0.1:32773", token: "", expiresAt: 1 } } : {}));
    const machine = await backend.create({ kind: "sandbox" });
    const reach = await machine.previewUrl!(7070);
    expect(l.forwarded).toEqual([32773]);
    expect(reach).toEqual({ url: "http://127.0.0.1:51001", token: "", expiresAt: Number.MAX_SAFE_INTEGER });
  });

  it("asks the machine itself whether its daemon answers, with the caller's bound", async () => {
    const { l, backend } = await withMachine(() => ({ answers: true }));
    const machine = await backend.create({ kind: "sandbox" });
    expect(await machine.daemonAnswers!()).toBe(true);
    expect(l.sent.at(-1)).toMatchObject({ op: "machine.daemonAnswers", params: { timeoutMs: INLINE_EXEC_MS }, timeoutMs: INLINE_EXEC_MS + LINK_MARGIN_MS });
  });

  it("stops waiting on a resume the caller gave up on, having sent it once", async () => {
    const never = new Promise<never>(() => {});
    const l = opened(sent => {
      if (sent.op === "machine.create") return { machine: HANDLE };
      if (sent.op === "machine.resume") return never;
      return {};
    });
    const backend = await LinkBackend.open(l.link);
    const machine = await backend.create({ kind: "sandbox" });
    const stop = new AbortController();
    const resumed = machine.resume(stop.signal);
    stop.abort(new Error("the person stopped the wake"));
    await expect(resumed).rejects.toThrow("the person stopped the wake");
    expect(l.sent.filter(s => s.op === "machine.resume").length).toBe(1);
  });

  it("reads the capacity of the computer on the far side", async () => {
    const capacity = { cores: 3, memMb: 3900, memRoomMb: 1950, machineMemMb: 1950, diskFreeBytes: 10, images: [], machines: { running: 1, paused: 0 } };
    const l = opened(sent => (sent.op === "machine.capacity" ? capacity : {}));
    expect(await (await LinkBackend.open(l.link)).capacity()).toEqual(capacity);
  });
});

describe("a snapshot over a link is a job asked after a frame at a time", () => {
  const readings = [
    { state: "running", bytes: 0 },
    { state: "running", bytes: 1520442115, total: 5284823040 },
    { state: "done", bytes: 5373952000, total: 5284823040, snapshotId: "sha256:abc" },
  ];

  it("names the job at once, asks after it until it reads done, hands every reading to the caller and answers the snapshot's id", async () => {
    let asked = 0;
    const l = link(sent => {
      if (sent.op === "machine.snapshot") return { job: "j1" };
      if (sent.op === "machine.snapshotJob") return readings[asked++];
      return {};
    });
    const machine = new LinkMachine(l.link, HANDLE, 1);
    const seen: SnapshotProgress[] = [];
    const id = await machine.snapshot("v1", { firstLife: true }, { onProgress: p => seen.push(p) });
    expect(id).toBe("sha256:abc");
    expect(l.sent.map(s => s.op)).toEqual(["machine.snapshot", "machine.snapshotJob", "machine.snapshotJob", "machine.snapshotJob"]);
    expect(l.sent[0]!.params).toEqual({ machineId: "c1", name: "v1", life: { firstLife: true } });
    expect(l.sent[1]!.params).toEqual({ job: "j1" });
    // No frame of the job carries a bound of its own: each is one short ask under the link's own.
    expect(l.sent.every(s => s.timeoutMs === undefined)).toBe(true);
    expect(seen).toEqual([{ bytes: 0 }, { bytes: 1520442115, total: 5284823040 }, { bytes: 5373952000, total: 5284823040 }]);
    // The ask after the job is a read of the job and is named by it, so a link that drops while a layer is written
    // is waited out; the frame that starts the job is not, since a second one would start a second snapshot.
    expect(l.sent[0]!.idempotencyKey).toBeUndefined();
    expect(l.sent.slice(1).map(s => s.idempotencyKey)).toEqual(["snapshotJob/j1", "snapshotJob/j1", "snapshotJob/j1"]);
  });

  it("a job the far side failed is the refusal it failed with, and one it no longer knows reads missing", async () => {
    const failed = link(sent => (sent.op === "machine.snapshot" ? { job: "j1" } : Object.assign(new Error("/var/lib/wsp/layers/blobs/sha256/commit-x.partial: No space left on device"), {})));
    await expect(new LinkMachine(failed.link, HANDLE, 1).snapshot("v1", { firstLife: true })).rejects.toThrow("No space left on device");
    const lost = link(sent => (sent.op === "machine.snapshot" ? { job: "j1" } : Object.assign(new Error("no such snapshot job: j1"), { kind: "missing", status: 404 })));
    const err = await new LinkMachine(lost.link, HANDLE, 1).snapshot("v1", { firstLife: true }).catch(e => e as unknown);
    expect(isMissing(err)).toBe(true);
  });

  it("a job whose bytes stand still past the stall bound is given up with the count it stopped at, and one that keeps moving is not", async () => {
    const stuck = link(sent => (sent.op === "machine.snapshot" ? { job: "j1" } : { state: "running", bytes: 4096, total: 8192 }));
    const started = Date.now();
    await expect(new LinkMachine(stuck.link, HANDLE, 1, 40).snapshot("v1", { firstLife: true })).rejects.toThrow("has written nothing past 4096 bytes");
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(stuck.sent.filter(s => s.op === "machine.snapshotJob").length).toBeGreaterThanOrEqual(2);
    // Bytes that move reset the bound: a job read many times over the same span completes when it says done.
    let moving = 0;
    const alive = link(sent => (sent.op === "machine.snapshot" ? { job: "j2" } : ++moving < 8 ? { state: "running", bytes: moving * 1024 } : { state: "done", bytes: 8192, snapshotId: "sha256:def" }));
    await expect(new LinkMachine(alive.link, HANDLE, 1, 40).snapshot("v1", { firstLife: true })).resolves.toBe("sha256:def");
  });

  it("a job that reads done with no id is refused rather than answered as a snapshot", async () => {
    const l = link(sent => (sent.op === "machine.snapshot" ? { job: "j1" } : { state: "done", bytes: 1 }));
    await expect(new LinkMachine(l.link, HANDLE, 1).snapshot("v1", { firstLife: true })).rejects.toThrow("read done without a snapshot id");
  });
});
