// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COPY_CURRENT, COPY_STALE, type InitSetup, type SealedImage, type SealedImageCopy, type SealedImageView } from "@wsp/protocol";
import type { Api } from "../protocol/client.js";
import { useStore } from "../protocol/store.js";
import { ImageSection } from "./ImageSection.js";
import { builtWhen, IMAGE_WORDS } from "./image.js";

const HASH = "a".repeat(63) + "1";
const OLDER = "b".repeat(63) + "2";

const at = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

/** Where every fixture row's tick came from; the section counts rows and never reads this. */
const SOURCE = { kind: "popular", sessions: 0, images: 0 } as const;

const IMAGE: SealedImage = {
  name: "default",
  version: 2,
  hash: HASH,
  recipeHash: "recipe-1",
  recipe: {
    version: 1,
    at: at(2),
    histories: [],
    rows: [
      { id: "agents/claude", kind: "agent", on: true, source: SOURCE },
      { id: "agents/codex", kind: "agent", on: true, source: SOURCE },
      { id: "agents/opencode", kind: "agent", on: false, source: SOURCE },
      { id: "tools/brew/ripgrep", kind: "tool", on: true, source: SOURCE },
      { id: "tools/brew/fd", kind: "tool", on: true, source: SOURCE },
      { id: "tools/brew/jq", kind: "tool", on: false, source: SOURCE },
    ],
  },
  logins: [
    { name: "claude", state: "copied" },
    { name: "gh", state: "signed-in" },
    { name: "npm", state: "skipped" },
  ],
  sealedAt: at(2),
  sealedFrom: "this Mac",
  vault: { sha256: "c".repeat(64), bytes: 4_200, paths: 7, takenAt: at(2) },
  usedBytes: 4.2 * 1024 ** 3,
};

const copy = (place: string, extra: Partial<SealedImageCopy> = {}): SealedImageCopy => ({
  place,
  version: 1,
  hash: HASH,
  snapshotId: `snap_${place}`,
  builtAt: at(1),
  sizeBytes: 4.2 * 1024 ** 3,
  ...extra,
});

const SETUP: InitSetup = { keys: { solari: true }, home: "/Users/dev", agents: [{ id: "claude", name: "Claude", configured: true, takesTools: true }], pricing: null, job: null };

function mount(view: SealedImageView) {
  const api = {
    subscribe: () => () => {},
    image: async () => view,
    initGet: async () => SETUP,
  } as unknown as Api;
  useStore.setState({ api } as never);
  return render(<ImageSection />);
}

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  });
};

afterEach(() => {
  cleanup();
  useStore.setState({ api: null } as never);
});

describe("the image row", () => {
  it("reads the record's fields in the section's order", async () => {
    const { container } = mount({ image: IMAGE, copies: [], projects: [] });
    await settle();
    expect(container.querySelector('[data-k="image-facts"]')?.textContent).toBe("v2 · 4.2 GB · 2 agents · 2 tools · 2 sign-ins");
  });

  it("says when the record was sealed and from which computer, whatever hour the day is read at", async () => {
    // The clock is this computer's, so the row is read at a fixed instant rather than at whatever hour the suite
    // runs: a stamp two hours old reads yesterday between midnight and 02:00 and the words would follow the run.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // A day that is not the day this suite runs: a clock that failed to take would read the stamp as years old
      // and the row would carry a date rather than the word today.
      vi.setSystemTime(new Date(2025, 2, 4, 15, 0, 0));
      const sealedAt = new Date(2025, 2, 4, 9, 12, 0).toISOString();
      const { container } = mount({ image: { ...IMAGE, sealedAt }, copies: [], projects: [] });
      await settle();
      expect(container.querySelector('[data-k="image-built"]')?.textContent).toBe("today 09:12 · from this Mac");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a stamp", () => {
  it("reads the clock alone on the day it happened, the day before that, and the date beyond", () => {
    const now = Date.parse("2026-09-12T15:00:00");
    expect(builtWhen("2026-09-12T09:12:00", now)).toBe("today 09:12");
    expect(builtWhen("2026-09-11T23:40:00", now)).toBe("yesterday 23:40");
    // The whole string, not a shape it happens to fit: the stamp is spelled in the app's own locale, so a shell
    // started under another one reads `2 Sept 08:05` here and this is what catches it.
    expect(builtWhen("2026-09-02T08:05:00", now)).toBe("Sep 2 08:05");
    // A stamp nothing can read is handed back as it came rather than drawn as a date nobody meant.
    expect(builtWhen("not a time", now)).toBe("not a time");
  });
});

describe("the copies table", () => {
  it("words each copy current or stale off the record's hash", async () => {
    const { container } = mount({ image: IMAGE, copies: [copy("hetzner"), copy("ascii", { hash: OLDER })], projects: [] });
    await settle();
    const rows = [...container.querySelectorAll('[data-k="image-copy"]')].map(row => ({
      place: row.getAttribute("data-place"),
      state: row.querySelector('[data-k="copy-state"]')?.textContent?.trim(),
      size: row.querySelector('[data-k="copy-size"]')?.textContent,
    }));
    expect(rows).toEqual([
      { place: "hetzner", state: COPY_CURRENT, size: "4.2 GB" },
      { place: "ascii", state: COPY_STALE, size: "4.2 GB" },
    ]);
  });

  it("keeps the word's slot standing at one width whether it holds current, stale or nothing", async () => {
    // A record with no vault has nothing to judge its copies by, so the word is left off; the slot it would have
    // filled stays, which is what keeps the Version, Size and Built columns in one place.
    const { vault: _held, ...noVault } = IMAGE;
    const { container } = mount({ image: noVault, copies: [copy("hetzner"), copy("ascii", { hash: OLDER })], projects: [] });
    await settle();
    const slots = [...container.querySelectorAll('[data-k="copy-state"]')];
    expect(slots).toHaveLength(2);
    for (const slot of slots) {
      expect(slot.textContent).toBe("");
      expect(slot.className).toContain("w-[7ch]");
    }
  });
});

describe("before anything is sealed", () => {
  it("says the image is not built and what will build it, and shows no copies table", async () => {
    const { container } = mount({ image: null, copies: [], projects: [] });
    await settle();
    expect(container.querySelector('[data-k="image-facts"]')?.textContent).toBe(IMAGE_WORDS.notBuilt);
    expect(screen.getByText(IMAGE_WORDS.firstBuild)).toBeTruthy();
    expect(container.querySelector('[data-k="image-copies"]')).toBeNull();
    expect(container.querySelector('[data-k="image-built"]')).toBeNull();
  });

  it("shows the record's rows once one is sealed", async () => {
    const { container } = mount({ image: IMAGE, copies: [copy("hetzner")], projects: [] });
    await settle();
    expect(container.querySelector('[data-k="image-built"]')).not.toBeNull();
    expect(container.querySelector('[data-k="image-copies"]')).not.toBeNull();
    expect(screen.queryByText(IMAGE_WORDS.firstBuild)).toBeNull();
  });
});

describe("Edit", () => {
  it("opens the init screens under the title Your image", async () => {
    const { container } = mount({ image: IMAGE, copies: [], projects: [] });
    await settle();
    fireEvent.click(container.querySelector('[data-k="edit-image"]')!);
    await settle();
    const dialog = document.querySelector("[data-cloud-setup-dialog]");
    expect(dialog).not.toBeNull();
    expect(screen.getByText(IMAGE_WORDS.sheet)).toBeTruthy();
    // The screens themselves are the shipped ones: the first is the choice, drawn by the same component the
    // sidebar's road draws.
    expect(dialog?.querySelector('[data-k="choice"]')).not.toBeNull();
  });
});
