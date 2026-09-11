// SPDX-License-Identifier: AGPL-3.0-only
// The whole machine loop against a real Docker daemon, gated on
// WSP_DOCKER_LIVE=1: this computer's own socket, and the same loop again over
// DOCKER_HOST=ssh://... when one is named, which is the road to a box. Every
// container and image made here is removed by the id it was made under, never
// by name or pattern: the daemon these run against also holds containers
// nobody here owns.

import { afterAll, describe, expect, it } from "vitest";
import { DockerBackend, DOCKER_BASE_IMAGE } from "../src/docker-backend.js";
import type { Machine } from "../src/machine.js";
import { OWNER_LABEL, WSP_LABEL } from "../src/labels.js";

const LIVE = process.env["WSP_DOCKER_LIVE"] === "1";
/** The daemon on a box, for the second pass; unset runs the local pass alone. The key and the known hosts file the
 * dial uses come beside it, since the box this runs against is not in this computer's own ssh files. */
const REMOTE = process.env["WSP_DOCKER_LIVE_SSH"];
const REMOTE_KEY = process.env["WSP_DOCKER_LIVE_SSH_KEY"];
const REMOTE_KNOWN_HOSTS = process.env["WSP_DOCKER_LIVE_SSH_KNOWN_HOSTS"];
/** Docker Desktop on the Mac this runs on is capped at 4 GB across every container on it, this test's neighbours
 * included, so a machine here takes a quarter of it and the passes never overlap. */
const MEM_MB = 1024;
const OWNER = "live-543";

describe.runIf(LIVE)("Docker machines, live", () => {
  const made: { backend: DockerBackend; containers: string[]; images: string[] } = { backend: undefined as never, containers: [], images: [] };

  afterAll(async () => {
    for (const id of made.containers) {
      await made.backend.get(id).then(m => m.kill()).catch(() => {});
    }
    for (const id of made.images) await made.backend.deleteSnapshot(id).catch(() => {});
    if (made.backend !== undefined) {
      const left = await made.backend.list({ [OWNER_LABEL]: OWNER });
      expect(left.filter(m => m.state !== "gone")).toEqual([]);
    }
  });

  const loop = (name: string, host: string | undefined): void => {
    it(`${name}: create, exec, a run past one exec, a file, a snapshot, a fork, a nap, a wake and a kill`, { timeout: 300_000 }, async () => {
      const backend = new DockerBackend({
        ...(host !== undefined ? { host } : {}),
        ...(host !== undefined && REMOTE_KEY !== undefined ? { keyPath: REMOTE_KEY } : {}),
        ...(host !== undefined && REMOTE_KNOWN_HOSTS !== undefined ? { knownHostsPath: REMOTE_KNOWN_HOSTS } : {}),
      });
      made.backend = backend;
      await backend.checkKey();

      const machine = await backend.create({
        kind: "sandbox",
        template: DOCKER_BASE_IMAGE,
        cpu: 1,
        memMb: MEM_MB,
        labels: { [OWNER_LABEL]: OWNER },
        envs: { WSP_LIVE_543: "yes" },
      });
      made.containers.push(machine.id);
      expect(await machine.state()).toBe("running");

      const hello = await machine.exec("echo hello; echo bad >&2; test -n \"$WSP_LIVE_543\"");
      expect(hello).toMatchObject({ exitCode: 0, stdout: "hello\n", stderr: "bad\n" });
      expect((await machine.exec("exit 3")).exitCode).toBe(3);

      // The detached road: longer than one exec's ceiling, read line by line while it runs.
      const lines: string[] = [];
      const long = await machine.run("for i in $(seq 1 4); do echo line $i; sleep 10; done", { deadlineMs: 120_000, onLine: l => lines.push(l), pollMs: 2_000 });
      expect(long.exitCode).toBe(0);
      expect(lines).toEqual(["line 1", "line 2", "line 3", "line 4"]);

      await machine.putBytes!("/root/landed.txt", Buffer.from("bytes through the archive road\n"));
      expect((await machine.exec("cat /root/landed.txt")).stdout).toBe("bytes through the archive road\n");

      const shape = await machine.describe!();
      expect(shape).toMatchObject({ cpu: 1, memMb: MEM_MB });

      const snapshotId = await machine.snapshot(`wsp-live543-${Date.now()}`, { firstLife: true });
      made.images.push(snapshotId);
      expect(snapshotId).toMatch(/^sha256:/);
      const listed = (await backend.listSnapshots()).find(s => s.id === snapshotId);
      expect(listed?.sizeBytes).toBeGreaterThan(0);

      const templateId = await backend.promoteSnapshot(snapshotId, `wsp-live543-${OWNER}`);
      made.images.push(templateId);
      expect((await backend.getTemplate(templateId)).status).toBe("ready");

      // A fork boots cold from the image: the file is on it, since a commit is the disk.
      const fork = await backend.create({ kind: "sandbox", template: templateId, cpu: 1, memMb: MEM_MB, labels: { [OWNER_LABEL]: OWNER } });
      made.containers.push(fork.id);
      expect((await fork.exec("cat /root/landed.txt")).stdout).toBe("bytes through the archive road\n");

      await fork.pause();
      expect(await fork.state()).toBe("paused");
      await fork.resume();
      expect(await fork.state()).toBe("running");
      expect((await fork.exec("echo awake")).stdout).toBe("awake\n");

      const ours = await backend.list({ [OWNER_LABEL]: OWNER });
      expect(ours.map(m => m.id).sort()).toEqual([machine.id, fork.id].sort());
      expect(ours.every(m => m.labels[WSP_LABEL] === "1")).toBe(true);

      for (const m of [fork, machine] as Machine[]) {
        await m.kill();
        expect(await m.state()).toBe("gone");
      }
      made.containers = made.containers.filter(id => id !== machine.id && id !== fork.id);
      expect((await backend.list({ [OWNER_LABEL]: OWNER })).filter(m => m.state !== "gone")).toEqual([]);

      for (const id of [templateId, snapshotId]) await backend.deleteSnapshot(id);
      made.images = made.images.filter(id => id !== snapshotId && id !== templateId);
      expect((await backend.listSnapshots()).find(s => s.id === snapshotId)).toBeUndefined();
    });
  };

  loop("this computer's daemon", undefined);
  if (REMOTE !== undefined) loop("a daemon over ssh", REMOTE);
});
