// SPDX-License-Identifier: AGPL-3.0-only
// Add a cloud goes on to the image: once a cloud's key is saved, the same
// Image card the cloud's page draws stands under the panel, headed with that
// cloud's name. Nothing is built by getting there; a copy is built on its
// press alone, with the time and the rate beside it.
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, fmtRate, placeBuildsNoImageLine, type InitJob, type InitSetup, type PlaceView, type SealedImage, type SealedImageBuilt, type SealedImageCopy, type SealedImageView } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { ADD_COMPUTER_WORDS } from "../src/settings/format.js";
import { copyCost, IMAGE_WORDS } from "../src/settings/image.js";
import { placeName } from "../src/settings/places.js";
import { mountSettings, pageAt, resetSettings, settingsApi, settle } from "./settings-harness.js";

const AT = "2026-09-12T11:00:00.000Z";
const HASH = "a".repeat(64);
const IMAGE: SealedImage = {
  name: "default",
  version: 3,
  hash: HASH,
  recipeHash: "recipe-1",
  logins: [{ name: "claude", state: "copied" }],
  sealedAt: "2026-09-12T09:12:00.000Z",
  sealedFrom: "this Mac",
  vault: { sha256: "c".repeat(64), bytes: 4_200, paths: 7, takenAt: AT },
  usedBytes: 4.2 * 1024 ** 3,
};
const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", default: true, present: true, takesForks: false, engine: "none", buildsImages: false };
const box: PlaceView = { id: "p_2", kind: "computer", name: "hetzner", default: false, present: true, takesForks: true, engine: "docker", buildsImages: true };
const ascii: PlaceView = { id: "box", kind: "provider", name: "box", default: false, rateUsdPerHour: 0.018, takesForks: true, buildsImages: true };
const copyAt = (place: string): SealedImageCopy => ({ place, version: 1, hash: HASH, snapshotId: `snap_${place}`, builtAt: AT, sizeBytes: 4.2 * 1024 ** 3 });
const setupOf = (keys: Record<string, boolean>): InitSetup => ({ keys, home: "/Users/dev", agents: [], pricing: null, job: null }) as InitSetup;
const WITH_IMAGE: SealedImageView = { image: IMAGE, copies: [copyAt("solari")], projects: [] };

/** A host holding one image view, recording every image.build it is sent. */
function host(view: SealedImageView, over: Partial<Api> = {}) {
  const builds: { place: string; force: boolean | undefined }[] = [];
  const fake = settingsApi({
    initGet: async () => setupOf({ solari: false, box: false }),
    image: async () => view,
    imageBuild: async (place: string, force?: boolean): Promise<SealedImageBuilt> => {
      builds.push({ place, force });
      return { copy: copyAt(place), built: true };
    },
    ...over,
  } as Partial<Api>);
  return { ...fake, builds };
}

const road = (name: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-settings-page] [data-k='road-${name}']`);
const card = (within: HTMLElement | null): HTMLElement | null => within?.querySelector<HTMLElement>("[data-settings-card='image']") ?? null;
const head = (within: HTMLElement | null): string | undefined => card(within)?.querySelector("[data-settings-head]")?.textContent ?? undefined;
const stateRow = (within: HTMLElement | null): HTMLElement => card(within)!.querySelector<HTMLElement>("[data-k='image-state']")!;
const title = (within: HTMLElement | null): string => stateRow(within).querySelector("[data-settings-title]")?.textContent ?? "";
const press = (within: HTMLElement | null): HTMLButtonElement => stateRow(within).querySelector<HTMLButtonElement>("[data-k='image-press']")!;
const cost = (within: HTMLElement | null): string[] => [...stateRow(within).querySelectorAll("[data-k='image-cost'] > span")].map(line => line.textContent ?? "");

const openRoad = async (api: Api, _name: "cloud"): Promise<void> => {
  mountSettings({ api, at: { kind: "group", group: "computers" } });
  await settle();
  fireEvent.click(document.querySelector("[data-k='add-cloud-button']")!);
  await settle();
};

beforeEach(() => {
  resetSettings();
  useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: false }, places: [here], initJob: null, goldenFrames: {} });
});

afterEach(() => cleanup());

describe("Add a cloud goes on to the image", () => {
  it("draws the card for a cloud once its key is saved, with the rate beside Copy, and bills nothing for the save", async () => {
    let places: PlaceView[] = [here];
    const fake = host(WITH_IMAGE, {
      initKeys: async () => {
        places = [here, ascii];
        return setupOf({ solari: false, box: true });
      },
      placesList: async () => ({ places, adds: [] }),
    } as unknown as Partial<Api>);
    await openRoad(fake.api, "cloud");
    const cloud = road("cloud");
    expect(card(cloud)).toBeNull();
    const boxKey = cloud!.querySelector("[data-provider='box']")!;
    fireEvent.change(boxKey.querySelector("[data-k='cloud-key']")!, { target: { value: "k-123" } });
    fireEvent.click(boxKey.querySelector("[data-k='cloud-save']")!);
    await settle();
    expect(boxKey.querySelector("[data-k='key-state']")?.textContent).toBe(ADD_COMPUTER_WORDS.keySaved);
    // One name for the cloud: the key block's, which the card's head and the cloud's own page read too.
    expect(boxKey.querySelector("[data-k='provider-name']")?.textContent).toBe("Boat");
    expect(head(cloud)).toBe(IMAGE_WORDS.head("Boat"));
    expect(placeName(ascii)).toBe("Boat");
    expect(press(cloud).textContent).toBe(IMAGE_WORDS.copyHere);
    expect(cost(cloud)).toEqual(copyCost(0.018));
    expect(cost(cloud)[1]).toBe(fmtRate(0.018));
    expect(fake.builds).toEqual([]);
    fireEvent.click(press(cloud));
    await settle();
    expect(fake.builds).toEqual([{ place: "box", force: undefined }]);
  });

  it("draws no card for a key the host already held when the page opened, since nothing was added", async () => {
    useStore.setState({ places: [here, ascii] });
    await openRoad(host(WITH_IMAGE, { initGet: async () => setupOf({ solari: false, box: true }) } as Partial<Api>).api, "cloud");
    expect(card(road("cloud"))).toBeNull();
  });

  it("says under a key the host already held where that cloud's image stands, one line whose chevron opens the cloud's page", async () => {
    useStore.setState({ places: [here, ascii] });
    await openRoad(host(WITH_IMAGE, { initGet: async () => setupOf({ solari: false, box: true }) } as Partial<Api>).api, "cloud");
    const boxKey = road("cloud")!.querySelector("[data-provider='box']")!;
    const line = boxKey.querySelector<HTMLButtonElement>("[data-k='held-image']");
    expect(line?.textContent).toBe(`${IMAGE_WORDS.head("Boat")}${IMAGE_WORDS.state.notHere}`);
    expect(line?.querySelector("svg")).not.toBeNull();
    // Solari's key is not held, so it says nothing of an image.
    expect(road("cloud")!.querySelector("[data-provider='solari'] [data-k='held-image']")).toBeNull();
    fireEvent.click(line!);
    await settle();
    expect(pageAt()).toBe("computer:box");
  });

  it("says the held key's image is ready where the cloud holds the current copy", async () => {
    useStore.setState({ places: [here, ascii] });
    const view: SealedImageView = { ...WITH_IMAGE, copies: [{ ...copyAt("box"), version: IMAGE.version }] };
    await openRoad(host(view, { initGet: async () => setupOf({ solari: false, box: true }) } as Partial<Api>).api, "cloud");
    expect(road("cloud")!.querySelector("[data-provider='box'] [data-k='held-image']")?.textContent).toBe(`${IMAGE_WORDS.head("Boat")}${IMAGE_WORDS.state.ready}`);
  });
});
