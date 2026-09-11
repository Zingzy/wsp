// SPDX-License-Identifier: AGPL-3.0-only
// The golden pipeline against a real Docker daemon, gated on WSP_DOCKER_LIVE=1:
// a builder from the base image, a two row recipe on it, a commit sealed as a
// version, and a container forked from that image answering for both rows. The
// containers and the image it makes are removed by the ids it recorded.

import { afterAll, describe, expect, it } from "vitest";
import { forkGolden, prepareBuilder, sealGolden } from "../src/golden.js";
import { DockerBackend } from "../src/docker-backend.js";
import { OWNER_LABEL } from "../src/labels.js";
import type { Machine } from "../src/machine.js";

const LIVE = process.env["WSP_DOCKER_LIVE"] === "1";
const OWNER = "live-543-golden";
/** Docker Desktop here holds 4 GB for every container on it; the builder and its smoke fork never run at once. */
const MEM_MB = 1024;

/** The two rows the recipe asks for, by the road a Debian guest installs them on. */
const APT = "export DEBIAN_FRONTEND=noninteractive\napt-get update -qq >/dev/null";
const row = (id: string, pkg: string, bin: string) => ({ id: `tools/apt/${id}`, label: id, manager: "apt" as const, cmd: `${APT}\napt-get install -y -qq ${pkg}`, shown: `apt-get install ${pkg}`, bin });

describe.runIf(LIVE)("golden on Docker, live", () => {
  const backend = LIVE ? new DockerBackend({}) : (undefined as never);
  const made: { containers: string[]; images: string[] } = { containers: [], images: [] };

  afterAll(async () => {
    for (const id of made.containers) await backend.get(id).then(m => m.kill()).catch(() => {});
    for (const id of made.images) await backend.deleteSnapshot(id).catch(() => {});
    expect((await backend.list({ [OWNER_LABEL]: OWNER })).filter(m => m.state !== "gone")).toEqual([]);
  });

  it("builds a golden image from the base image and forks a container that answers for the recipe", { timeout: 1_800_000 }, async () => {
    const onStage = (stage: string, detail?: string): void => console.log(`[${stage}]${detail === undefined ? "" : ` ${detail}`}`);
    const builder = await prepareBuilder({
      backend,
      cpu: 1,
      memMb: MEM_MB,
      labels: { [OWNER_LABEL]: OWNER },
      setup: "true",
      onStage,
      import: { recipeHash: "live543", tools: [row("git", "git", "git"), row("ripgrep", "ripgrep", "rg")], agents: [] },
    });
    made.containers.push(builder.machine.id);
    const { manifest, version } = await sealGolden(builder, {
      backend,
      hostId: "live543",
      cpu: 1,
      memMb: MEM_MB,
      labels: { [OWNER_LABEL]: OWNER },
      smoke: "git --version && rg --version",
      onStage,
    });
    made.containers = made.containers.filter(id => id !== builder.machine.id);
    made.images.push(version.snapshotId);
    if (version.templateId !== undefined) made.images.push(version.templateId);
    // The base image is the backend's own: nothing here names a provider template.
    expect(version.baseTemplate).toBe("ubuntu:24.04");
    expect(version.snapshotId).toMatch(/^sha256:/);
    expect(version.smoke.exitCode).toBe(0);

    const fork = await forkGolden(backend, manifest, { cpu: 1, memMb: MEM_MB, labels: { [OWNER_LABEL]: OWNER } });
    made.containers.push(fork.id);
    const git = await (fork as Machine).exec("git --version");
    expect(git.exitCode).toBe(0);
    expect(git.stdout).toMatch(/^git version/);
    expect((await fork.exec("rg --version")).exitCode).toBe(0);

    await fork.kill();
    made.containers = made.containers.filter(id => id !== fork.id);
    for (const id of made.images) await backend.deleteSnapshot(id).catch(() => {});
    made.images = [];
  });
});
