// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { InitSetup } from "@wsp/protocol";
import type { Api } from "../protocol/client.js";
import { useStore } from "../protocol/store.js";
import { ConnectProviderSheet } from "./ConnectProviderSheet.js";
import type { ProviderRow } from "./providers.js";

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  });
};

/** Two rows of the shape the provider table has. */
const ROWS: ProviderRow[] = [
  { id: "box", name: "ASCII", what: "always on, naps to $0", fromUsdPerHour: 0.018, placeholder: "ascii_\u2026", trial: true },
  { id: "solari", name: "Solari", what: "in memory, wakes fast", fromUsdPerHour: 0.11, placeholder: "slr_live_..." },
];

/** What the host says about its own setup; only which providers it holds a key for is read here. */
const setupWith = (...held: string[]): InitSetup => ({ keys: Object.fromEntries(ROWS.map(row => [row.id, held.includes(row.id)])), home: "/Users/dev", agents: [], pricing: null, job: null });

/** A host that takes every key, and the keys it was handed with the provider each was for. */
function fakeHost(over: Partial<Api> = {}): { api: Partial<Api>; saved: { provider?: string; key?: string }[] } {
  const saved: { provider?: string; key?: string }[] = [];
  return {
    saved,
    api: {
      initGet: async () => setupWith(),
      initKeys: async keys => {
        saved.push(keys);
        return setupWith(keys.provider ?? "");
      },
      ...over,
    } as Partial<Api>,
  };
}

const SIZES = [
  { cpu: 2, memMb: 4096, rateUsdPerHour: 0.018 },
  { cpu: 4, memMb: 8192, rateUsdPerHour: 0.036 },
];

const mount = (rows: readonly ProviderRow[], over: Partial<Api> = {}) => {
  useStore.setState({ api: { subscribe: () => () => {}, capabilities: async () => ({ sizes: SIZES }), ...over } as unknown as Api });
  return render(<ConnectProviderSheet open onOpenChange={() => {}} rows={rows} />);
};

const type = (value: string): void => {
  fireEvent.change(document.querySelector("#connect-provider-key")!, { target: { value } });
};

afterEach(() => {
  cleanup();
  useStore.setState({ api: null });
});

describe("Connect a provider", () => {
  it("picks from the provider table, each with what it is and its cheapest rate", async () => {
    mount(ROWS, fakeHost().api);
    await settle();
    expect(document.querySelector('[data-k="title"]')?.textContent).toBe("Connect a provider");
    const rows = [...document.querySelectorAll('[data-k="provider-row"]')].map(r => [r.getAttribute("data-provider"), r.textContent]);
    expect(rows).toEqual([
      ["box", "ASCIIalways on, naps to $0 \u00b7 from $0.018/hr"],
      ["solari", "Solariin memory, wakes fast \u00b7 from $0.11/hr"],
    ]);
    expect(screen.getByText("Prices are read from the provider for a 2 vCPU, 4 GB workspace. Your key stays on this Mac.")).toBeTruthy();
  });

  it("asks for a key in the picked provider's own words, and holds Save as the outline until one is pasted", async () => {
    mount(ROWS, fakeHost().api);
    await settle();
    fireEvent.click(document.querySelector('[data-k="continue"]')!);
    expect(document.querySelector('[data-k="title"]')?.textContent).toBe("Connect ASCII");
    expect(document.querySelector('[data-k="description"]')?.textContent).toBe("Paste an API key from your ASCII account. It is checked with ASCII before it is saved.");
    expect(document.querySelector<HTMLInputElement>("#connect-provider-key")?.placeholder).toBe("ascii_\u2026");
    // The sheet's title names the provider, so its field is the plain label and no id word reaches a person.
    expect(screen.getByText("API key")).toBeTruthy();
    expect(screen.queryByText("Box API key")).toBeNull();
    expect(document.querySelector('[data-k="where"]')?.textContent).toContain("Get one at ASCII");
    const save = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('[data-k="save"]')!;
    expect(save().disabled).toBe(true);
    expect(save().hasAttribute("data-held")).toBe(true);
    // The reason stands in the field's own slot before any click, since nothing hovers a disabled keycap.
    expect(document.querySelector('[data-k="key-refusal"]')?.textContent).toBe("paste the key first");
    expect(document.querySelector('[data-slot="tooltip-trigger"]')).toBeNull();
    type("ascii_live_9f3k2mx0");
    expect(save().disabled).toBe(false);
    expect(save().hasAttribute("data-held")).toBe(false);
    expect(document.querySelector('[data-k="key-refusal"]')?.textContent).toBe("");
  });

  it("keeps the loud keycap while the provider is asked and says what it is doing, and sends once", async () => {
    let letGo = (): void => {};
    const calls: unknown[] = [];
    mount(ROWS, {
      initGet: async () => setupWith(),
      initKeys: async keys => {
        calls.push(keys);
        await new Promise<void>(r => (letGo = r));
        return setupWith("box");
      },
    } as Partial<Api>);
    await settle();
    fireEvent.click(document.querySelector('[data-k="continue"]')!);
    type("ascii_live_9f3k2mx0");
    fireEvent.click(document.querySelector('[data-k="save"]')!);
    await settle();
    const asking = document.querySelector<HTMLButtonElement>('[data-k="save"]')!;
    expect(asking.textContent).toBe("Checking with ASCII");
    expect(asking.className).toContain("bg-primary");
    expect(asking.disabled).toBe(false);
    // A second press while it is asking is not a second key.
    fireEvent.click(asking);
    fireEvent.keyDown(document.querySelector("#connect-provider-key")!, { key: "Enter" });
    expect(calls).toHaveLength(1);
    letGo();
    await settle();
    expect(document.querySelector('[data-k="title"]')?.textContent).toBe("ASCII connected");
  });

  it("puts the typed key to the host under the provider it was picked for", async () => {
    const host = fakeHost();
    mount(ROWS, host.api);
    await settle();
    fireEvent.click(document.querySelector('[data-k="continue"]')!);
    type("ascii_live_9f3k2mx0");
    fireEvent.click(document.querySelector('[data-k="save"]')!);
    await settle();
    expect(host.saved).toEqual([{ provider: "box", key: "ascii_live_9f3k2mx0" }]);
    expect(document.querySelector('[data-k="title"]')?.textContent).toBe("ASCII connected");
  });

  it("saves on Enter, the key the footer says that keycap does", async () => {
    const host = fakeHost();
    mount(ROWS, host.api);
    await settle();
    fireEvent.click(document.querySelector('[data-k="continue"]')!);
    expect(document.querySelector('[data-k="foot-note"]')?.textContent).toContain("saves");
    type("ascii_live_9f3k2mx0");
    fireEvent.keyDown(document.querySelector("#connect-provider-key")!, { key: "Enter" });
    await settle();
    expect(host.saved).toEqual([{ provider: "box", key: "ascii_live_9f3k2mx0" }]);
  });

  it("puts what the provider said under the field and leaves the link where it was", async () => {
    mount(
      ROWS,
      fakeHost({
        initKeys: async () => {
          throw new Error("Solari refused this key: 401 Unauthorized");
        },
      }).api,
    );
    await settle();
    fireEvent.click(document.querySelector('[data-k="continue"]')!);
    type("ascii_live_9f3k2mx0");
    fireEvent.click(document.querySelector('[data-k="save"]')!);
    await settle();
    // The provider the person picked is the one the refusal names, whatever words the host put around the status.
    expect(document.querySelector('[data-k="key-refusal"]')?.textContent).toBe("ASCII refused this key (401). Paste one from your ASCII account, or make a new one there.");
    expect(document.querySelector<HTMLInputElement>("#connect-provider-key")?.getAttribute("aria-invalid")).toBe("true");
    // The next press is the person's own move whatever the provider said, so the keycap says so either way.
    expect(document.querySelector('[data-k="save"]')?.textContent).toBe("Try again");
    expect(document.querySelector('[data-k="where"]')).toBeTruthy();
    expect(document.querySelector('[data-k="title"]')?.textContent).toBe("Connect ASCII");
  });

  it("offers to press again when nothing answered about the key at all", async () => {
    mount(
      ROWS,
      fakeHost({
        initKeys: async () => {
          throw new Error("runtime connection lost");
        },
      }).api,
    );
    await settle();
    fireEvent.click(document.querySelector('[data-k="continue"]')!);
    type("ascii_live_9f3k2mx0");
    fireEvent.click(document.querySelector('[data-k="save"]')!);
    await settle();
    expect(document.querySelector('[data-k="key-refusal"]')?.textContent).toBe("ASCII could not be reached to check the key. Check the network and try again.");
    expect(document.querySelector('[data-k="save"]')?.textContent).toBe("Try again");
  });

  it("says what was saved and where once the provider takes the key", async () => {
    mount(ROWS, fakeHost().api);
    await settle();
    fireEvent.click(document.querySelector('[data-k="continue"]')!);
    type("ascii_live_9f3k2mx0");
    fireEvent.click(document.querySelector('[data-k="save"]')!);
    await settle();
    expect(document.querySelector('[data-k="description"]')?.textContent).toBe("Workspaces can be created on ASCII. Your image is built there the first time, about three minutes.");
    const lines = [...document.querySelectorAll('[data-k="lines"] [data-k="line"]')].map(l => l.textContent);
    expect(lines).toEqual(["key accepted \u00b7 ASCII", "saved on this Mac \u00b7 never sent anywhere else"]);
  });

  it("lists the sizes the provider offers and opens a workspace on it", async () => {
    mount(ROWS, fakeHost().api);
    await settle();
    fireEvent.click(document.querySelector('[data-k="continue"]')!);
    type("ascii_live_9f3k2mx0");
    fireEvent.click(document.querySelector('[data-k="save"]')!);
    await settle();
    const rows = [...document.querySelectorAll('[data-k="size-row"]')].map(r => [...r.querySelectorAll("td")].map(c => c.textContent));
    expect(rows).toEqual([
      ["2 vCPU", "4 GB", "$0.018/hr"],
      ["4 vCPU", "8 GB", "$0.036/hr"],
    ]);
    expect(document.querySelector('[data-k="new-workspace"]')?.textContent).toBe("New workspace on ASCII");
  });

  it("reads a key this computer already holds as dots with saved beside it, and Change empties the field", async () => {
    mount(ROWS, fakeHost({ initGet: async () => setupWith("box") }).api);
    await settle();
    fireEvent.click(document.querySelector('[data-k="continue"]')!);
    expect(document.querySelector<HTMLInputElement>("#connect-provider-key")?.value).toBe("\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022");
    expect(document.querySelector('[data-k="key-state"]')?.textContent).toBe("saved");
    expect(document.querySelector('[data-k="save"]')?.textContent).toBe("Continue");
    expect(document.querySelector('[data-k="where"]')).toBeNull();
    fireEvent.click(document.querySelector('[data-k="change"]')!);
    expect(document.querySelector<HTMLInputElement>("#connect-provider-key")?.value).toBe("");
    expect(document.querySelector('[data-k="save"]')?.textContent).toBe("Save");
  });

  it("asks for a key on a provider whose key this computer does not hold, though it holds another's", async () => {
    mount(ROWS, fakeHost({ initGet: async () => setupWith("solari") }).api);
    await settle();
    fireEvent.click(document.querySelector('[data-k="continue"]')!);
    expect(document.querySelector<HTMLInputElement>("#connect-provider-key")?.value).toBe("");
    expect(document.querySelector('[data-k="key-state"]')).toBeNull();
  });

  it("moves a held key straight to what the provider offers, asking for nothing", async () => {
    const host = fakeHost({ initGet: async () => setupWith("box") });
    mount(ROWS, host.api);
    await settle();
    fireEvent.click(document.querySelector('[data-k="continue"]')!);
    fireEvent.click(document.querySelector('[data-k="save"]')!);
    await settle();
    expect(host.saved).toEqual([]);
    expect(document.querySelector('[data-k="title"]')?.textContent).toBe("ASCII connected");
  });
});
