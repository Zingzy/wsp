// SPDX-License-Identifier: AGPL-3.0-only
// The server half of a place's machines: every machine.* frame the host sends
// over the link, answered against the backend this computer offers. It lives
// beside the place agent rather than in the daemon package because the daemon
// is what a fork runs and must carry no engine; the agent is the command line,
// which carries one already.
//
// The ops are registered on the link socket alone, so nothing that merely
// holds this daemon's token can drive the Docker daemon behind them: the
// mutual key handshake the link was opened with is the whole gate.

import { mkdirSync, rmSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { MachineLinkRequest, type MachineHandle } from "@wsp/protocol";
import type { Machine, MachineBackend } from "@wsp/engine";
import type { PlaceOffer } from "./place-offers.js";
import type { LinkOp } from "@wsp/daemon";

/** One upload in flight: which machine and path its parts are for, and which part comes next. A part that names
 * another machine or arrives out of order ends it, so nothing half-assembled is ever landed. */
interface Upload {
  machineId: string;
  path: string;
  next: number;
}

/** What the handle carries, as the client needs it to build a machine whose optional calls are present exactly
 * where this one's are. */
const handleOf = (machine: Machine): MachineHandle => ({
  id: machine.id,
  kind: machine.kind,
  ...(machine.streamUrl !== undefined ? { streamUrl: machine.streamUrl } : {}),
  ...(machine.labels !== undefined ? { labels: machine.labels } : {}),
  ...(machine.seen !== undefined ? { seen: machine.seen } : {}),
  ...(machine.replayed !== undefined ? { replayed: machine.replayed } : {}),
  ...(machine.daemonSupervisor !== undefined ? { daemonSupervisor: machine.daemonSupervisor } : {}),
  roads: {
    previewUrl: machine.previewUrl !== undefined,
    daemonAnswers: machine.daemonAnswers !== undefined,
    putBytes: machine.putBytes !== undefined,
    describe: machine.describe !== undefined,
    facts: machine.facts !== undefined,
    metrics: machine.metrics !== undefined,
  },
});

/** One frame as the protocol writes it. Every op reads its own request through here, so the shape on the wire has
 * one home and this side never takes a frame the sender could not have sent. */
function asked<O extends MachineLinkRequest["op"]>(op: O, msg: Record<string, unknown>): Extract<MachineLinkRequest, { op: O }> {
  const frame = MachineLinkRequest.parse(msg);
  if (frame.op !== op) throw new Error(`${frame.op} was answered by the table's ${op}`);
  return frame as Extract<MachineLinkRequest, { op: O }>;
}

/** What a call this backend does not carry is refused with; the capabilities said so before the frame was sent, so
 * this is a client that asked for a road its own facts denied. */
const noRoad = (op: string): never => {
  throw new Error(`this computer's backend has no ${op}`);
};

/** Every machine.* op bound to one backend, for the link's ops table. `offer` is the id of the row this computer
 * serves, which the host stamps on every fork made here. Handles are cached by id so a machine driven through many
 * frames is fetched once; a kill drops one, since the next frame about that id is about a machine that is gone. */
export function machineOps(offer: PlaceOffer["id"], backend: MachineBackend, putDir: string): Record<string, LinkOp> {
  const handles = new Map<string, Machine>();
  const uploads = new Map<string, Upload>();
  const partPath = (uploadId: string): string => join(putDir, uploadId);

  const machineOf = async (id: string): Promise<Machine> => {
    const held = handles.get(id);
    if (held !== undefined) return held;
    const machine = await backend.get(id);
    handles.set(id, machine);
    return machine;
  };

  const dropUpload = (uploadId: string): void => {
    uploads.delete(uploadId);
    rmSync(partPath(uploadId), { force: true });
  };

  return {
    "machine.backend": async () => ({
      offer,
      capabilities: backend.capabilities,
      pricing: {
        defaultSize: backend.pricing.defaultSize,
        snapshotStorage: backend.pricing.snapshotStorage,
        ...(backend.pricing.builderDiskGb !== undefined ? { builderDiskGb: backend.pricing.builderDiskGb } : {}),
      },
      ...(backend.lifecycle !== undefined ? { lifecycle: { budgets: backend.lifecycle.budgets } } : {}),
      ...(backend.baseTemplates !== undefined ? { baseTemplates: backend.baseTemplates } : {}),
    }),
    "machine.capacity": async () => (backend.capacity === undefined ? noRoad("capacity") : backend.capacity()),
    "machine.checkKey": async () => {
      if (backend.checkKey === undefined) noRoad("checkKey");
      await backend.checkKey!();
      return {};
    },
    "machine.create": async msg => {
      const machine = await backend.create(asked("machine.create", msg).spec);
      handles.set(machine.id, machine);
      return { machine: handleOf(machine) };
    },
    "machine.get": async msg => ({ machine: handleOf(await machineOf(asked("machine.get", msg).machineId)) }),
    "machine.list": async msg => ({ machines: await backend.list(asked("machine.list", msg).labels) }),
    "machine.deleteSnapshot": async msg => {
      await backend.deleteSnapshot(asked("machine.deleteSnapshot", msg).snapshotId);
      return {};
    },
    "machine.listSnapshots": async () => (backend.listSnapshots === undefined ? noRoad("listSnapshots") : { snapshots: await backend.listSnapshots() }),
    "machine.promoteSnapshot": async msg => {
      const frame = asked("machine.promoteSnapshot", msg);
      return backend.promoteSnapshot === undefined ? noRoad("promoteSnapshot") : { templateId: await backend.promoteSnapshot(frame.snapshotId, frame.name) };
    },
    "machine.getTemplate": async msg =>
      backend.getTemplate === undefined ? noRoad("getTemplate") : { template: await backend.getTemplate(asked("machine.getTemplate", msg).templateId) },
    "machine.listTemplates": async () => (backend.listTemplates === undefined ? noRoad("listTemplates") : { templates: await backend.listTemplates() }),
    "machine.deleteTemplate": async msg => {
      if (backend.deleteTemplate === undefined) noRoad("deleteTemplate");
      await backend.deleteTemplate!(asked("machine.deleteTemplate", msg).templateId);
      return {};
    },
    "machine.exec": async msg => {
      const frame = asked("machine.exec", msg);
      const machine = await machineOf(frame.machineId);
      return { result: await machine.exec(frame.cmd, frame.timeoutMs === undefined ? {} : { timeoutMs: frame.timeoutMs }) };
    },
    "machine.snapshot": async msg => {
      const frame = asked("machine.snapshot", msg);
      const machine = await machineOf(frame.machineId);
      return { snapshotId: await machine.snapshot(frame.name, frame.life) };
    },
    "machine.pause": async msg => {
      await (await machineOf(asked("machine.pause", msg).machineId)).pause();
      return {};
    },
    "machine.resume": async msg => {
      await (await machineOf(asked("machine.resume", msg).machineId)).resume();
      return {};
    },
    "machine.kill": async msg => {
      const machine = await machineOf(asked("machine.kill", msg).machineId);
      try {
        await machine.kill();
      } finally {
        handles.delete(machine.id);
      }
      return {};
    },
    "machine.state": async msg => ({ state: await (await machineOf(asked("machine.state", msg).machineId)).state() }),
    "machine.describe": async msg => {
      const machine = await machineOf(asked("machine.describe", msg).machineId);
      return machine.describe === undefined ? noRoad("describe") : { shape: await machine.describe() };
    },
    "machine.facts": async msg => {
      const machine = await machineOf(asked("machine.facts", msg).machineId);
      return machine.facts === undefined ? noRoad("facts") : { facts: await machine.facts() };
    },
    "machine.metrics": async msg => {
      const machine = await machineOf(asked("machine.metrics", msg).machineId);
      if (machine.metrics === undefined) noRoad("metrics");
      await machine.metrics!();
      return {};
    },
    "machine.daemonAnswers": async msg => {
      const frame = asked("machine.daemonAnswers", msg);
      const machine = await machineOf(frame.machineId);
      if (machine.daemonAnswers === undefined) noRoad("daemonAnswers");
      return { answers: await machine.daemonAnswers!(frame.timeoutMs === undefined ? {} : { timeoutMs: frame.timeoutMs }) };
    },
    "machine.previewUrl": async msg => {
      const frame = asked("machine.previewUrl", msg);
      const machine = await machineOf(frame.machineId);
      return machine.previewUrl === undefined ? noRoad("previewUrl") : { reach: await machine.previewUrl(frame.port) };
    },
    "machine.downloadUrl": async msg => {
      const frame = asked("machine.downloadUrl", msg);
      return { url: await (await machineOf(frame.machineId)).downloadUrl(frame.path) };
    },
    "machine.uploadUrl": async msg => {
      const frame = asked("machine.uploadUrl", msg);
      return { url: await (await machineOf(frame.machineId)).uploadUrl(frame.path) };
    },
    "machine.putBytes": async msg => {
      const frame = asked("machine.putBytes", msg);
      const machine = await machineOf(frame.machineId);
      if (machine.putBytes === undefined) noRoad("putBytes");
      const held = uploads.get(frame.uploadId);
      if (frame.seq !== (held?.next ?? 0)) {
        dropUpload(frame.uploadId);
        throw new Error(`part ${frame.seq} of ${frame.uploadId} is out of order; the upload is dropped and starts again`);
      }
      if (held !== undefined && (held.machineId !== machine.id || held.path !== frame.path)) {
        dropUpload(frame.uploadId);
        throw new Error(`${frame.uploadId} was carrying ${held.path} to ${held.machineId}; the upload is dropped and starts again`);
      }
      mkdirSync(putDir, { recursive: true, mode: 0o700 });
      await appendFile(partPath(frame.uploadId), Buffer.from(frame.data, "base64"));
      uploads.set(frame.uploadId, { machineId: machine.id, path: frame.path, next: frame.seq + 1 });
      if (!frame.last) return {};
      const bytes = await readFile(partPath(frame.uploadId));
      try {
        await machine.putBytes!(frame.path, bytes, frame.timeoutMs === undefined ? {} : { timeoutMs: frame.timeoutMs });
      } finally {
        dropUpload(frame.uploadId);
      }
      return {};
    },
  };
}
