// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { DockerBackend, NoProviderBackend, SolariBackend } from "@wsp/engine";
import { goldenRecipe, makeRuntime, optsFor, providerSlotOf, swapProvider } from "../src/cli.js";
import { PROVIDER_MODULES, providerBackendFor, providerEnvWith, providerModule } from "../src/providers.js";

const pick = (keys: Record<string, string> = {}, env: Record<string, string | undefined> = {}) => ({ keys, env });

describe("provider modules", () => {
  it("takes the module the keys name and nothing else when nothing is said", () => {
    expect(providerModule(pick()).id).toBe("none");
    expect(providerBackendFor(pick())).toBeInstanceOf(NoProviderBackend);
    expect(providerModule(pick({ solari: "sk-ant-x" })).id).toBe("solari");
    expect(providerBackendFor(pick({ solari: "sk-x" }))).toBeInstanceOf(SolariBackend);
  });

  it("takes Docker when a person names it or asks for it by the shorthand, key or no key", () => {
    expect(providerModule(pick({}, { WSP_PROVIDER: "docker" })).id).toBe("docker");
    expect(providerModule(pick({}, { WSP_DOCKER: "1" })).id).toBe("docker");
    expect(providerModule(pick({ solari: "sk-x" }, { WSP_DOCKER: "1" })).id).toBe("docker");
    expect(providerBackendFor(pick({}, { WSP_DOCKER: "1" }))).toBeInstanceOf(DockerBackend);
    // A shorthand that is off is off: a shell that exports WSP_DOCKER=0 asked for nothing.
    expect(providerModule(pick({}, { WSP_DOCKER: "0" })).id).toBe("none");
    expect(providerModule(pick({}, { WSP_DOCKER: "" })).id).toBe("none");
  });

  it("a word on the command line stands in front of the environment the host started with", () => {
    expect(providerEnvWith({ provider: "docker", dockerHost: "ssh://maya@box" }, { DOCKER_HOST: "unix:///var/run/docker.sock" })).toMatchObject({
      WSP_PROVIDER: "docker",
      DOCKER_HOST: "ssh://maya@box",
    });
    expect(providerEnvWith({}, { WSP_DOCKER: "1" })).toMatchObject({ WSP_DOCKER: "1" });
  });

  it("every row is reachable and the last one answers for any computer", () => {
    expect(PROVIDER_MODULES.map(m => m.id)).toEqual(["docker", "solari", "none"]);
    expect(PROVIDER_MODULES.at(-1)!.selects(pick())).toBe(true);
  });

  it("the words wsp up and wsp init take land in what the run picks its provider out of", () => {
    expect(optsFor({ state: "/tmp/wsp-providers/state.json", provider: "docker", "docker-host": "ssh://maya@127.0.0.1:2222" }).providerEnv).toMatchObject({
      WSP_PROVIDER: "docker",
      DOCKER_HOST: "ssh://maya@127.0.0.1:2222",
    });
  });

  it("a host told to fork containers holds the Docker module, and a key saved later swaps inside the same words", async () => {
    const rt = makeRuntime({}, "/tmp/wsp-providers/state.json", goldenRecipe({}), { WSP_DOCKER: "1" });
    try {
      const held = providerSlotOf(rt)!.current();
      // Containers: a nap that keeps RAM, no public port routes, and sizes to offer, so the fork roads are open.
      expect(held.capabilities).toMatchObject({ previewUrls: false, ramPreservingPause: true, liveCloneForks: false });
      expect(held.capabilities.sizes.length).toBeGreaterThan(0);
      swapProvider(rt, { solari: "slr_live_fake" });
      expect(providerSlotOf(rt)!.current().capabilities.previewUrls).toBe(false);
    } finally {
      await rt.close();
    }
  });

  it("a key is checked against its own provider, whatever this computer forks on", () => {
    // The words a run picks a provider out of are not the words a typed key is checked under: a person typing a
    // cloud key on a computer that forks containers is asking about the key.
    expect(providerModule({ keys: { solari: "slr_live_fake" }, env: {} }).id).toBe("solari");
  });
});
