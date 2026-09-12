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

/** Two rows of the shape the provider table has, with the first one's key road handed in per test. */
const rowsWith = (save: ProviderRow["save"], held?: ProviderRow["held"]): ProviderRow[] => [
  { id: "box", name: "ASCII", what: "always on, naps to $0", fromUsdPerHour: 0.018, placeholder: "ascii_…", trial: true, ...(save === undefined ? {} : { save }), ...(held === undefined ? {} : { held }) },
  { id: "solari", name: "Solari", what: "in memory, wakes fast", fromUsdPerHour: 0.11, placeholder: "slr_live_..." },
];

/** What the host says about its own setup; only whether a key is held is read here. */
const setupWith = (solari: boolean): InitSetup => ({ keys: { solari }, home: "/Users/dev", agents: [], pricing: null, job: null });

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
    mount(rowsWith(async () => {}));
    await settle();
    expect(document.querySelector('[data-k="title"]')?.textContent).toBe("Connect a provider");
    const rows = [...document.querySelectorAll('[data-k="provider-row"]')].map(r => [r.getAttribute("data-provider"), r.textContent]);
    expect(rows).toEqual([
      ["box", "ASCIIalways on, naps to $0 · from $0.018/hr"],
      ["solari", "Solariin memory, wakes fast · from $0.11/hr"],
    ]);
    expect(screen.getByText("Prices are read from the provider for a 2 vCPU, 4 GB workspace. Your key stays on this Mac.")).toBeTruthy();
  });

  it("asks for a key in the picked provider's own words, and holds Save until one is pasted", async () => {
    mount(rowsWith(async () => {}));
    await settle();
    fireEvent.click(document.querySelector('[data-k="continue"]')!);
    expect(document.querySelector('[data-k="title"]')?.textContent).toBe("Connect ASCII");
    expect(document.querySelector('[data-k="description"]')?.textContent).toBe("Paste an API key from your ASCII account. It is checked with ASCII before it is saved.");
    expect(document.querySelector<HTMLInputElement>("#connect-provider-key")?.placeholder).toBe("ascii_…");
    // The field's label is the key's own name, off the one table the host's registry reads.
    expect(screen.getByText("Box API key")).toBeTruthy();
    expect(document.querySelector('[data-k="where"]')?.textContent).toContain("Get one at ASCII");
    expect(document.querySelector<HTMLButtonElement>('[data-k="save"]')?.disabled).toBe(true);
    type("ascii_live_9f3k2mx0");
    expect(document.querySelector<HTMLButtonElement>('[data-k="save"]')?.disabled).toBe(false);
  });

  it("holds Save on a provider whose key has no road on the wire", async () => {
    mount(rowsWith(undefined));
    await settle();
    fireEvent.click(document.querySelector('[data-k="continue"]')!);
    type("ascii_live_9f3k2mx0");
    expect(document.querySelector<HTMLButtonElement>('[data-k="save"]')?.disabled).toBe(true);
  });

  it("puts what the provider said under the field and leaves the link where it was", async () => {
    mount(
      rowsWith(async () => {
        throw new Error("ASCII answered 401");
      }),
    );
    await settle();
    fireEvent.click(document.querySelector('[data-k="continue"]')!);
    type("ascii_live_9f3k2mx0");
    fireEvent.click(document.querySelector('[data-k="save"]')!);
    await settle();
    expect(document.querySelector('[data-k="key-refusal"]')?.textContent).toBe("ASCII refused this key (401). Paste one from your ASCII account, or make a new one there.");
    expect(document.querySelector<HTMLInputElement>("#connect-provider-key")?.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector('[data-k="save"]')?.textContent).toBe("Save");
    expect(document.querySelector('[data-k="where"]')).toBeTruthy();
  });

  it("offers to press again when nothing answered about the key at all", async () => {
    mount(
      rowsWith(async () => {
        throw new Error("runtime connection lost");
      }),
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
    const sent: string[] = [];
    mount(
      rowsWith(async (_api, key) => {
        sent.push(key);
      }),
    );
    await settle();
    fireEvent.click(document.querySelector('[data-k="continue"]')!);
    type("ascii_live_9f3k2mx0");
    fireEvent.click(document.querySelector('[data-k="save"]')!);
    await settle();
    expect(sent).toEqual(["ascii_live_9f3k2mx0"]);
    expect(document.querySelector('[data-k="title"]')?.textContent).toBe("ASCII connected");
    expect(document.querySelector('[data-k="description"]')?.textContent).toBe("Workspaces can be created on ASCII. Your image is built there the first time, about three minutes.");
    const lines = [...document.querySelectorAll('[data-k="lines"] [data-k="line"]')].map(l => l.textContent);
    expect(lines).toEqual(["key accepted · ASCII", "saved on this Mac · never sent anywhere else"]);
  });

  it("lists the sizes the provider offers and opens a workspace on it", async () => {
    mount(rowsWith(async () => {}));
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
    mount(rowsWith(async () => {}, setup => setup.keys.solari), { initGet: async () => setupWith(true) } as unknown as Partial<Api>);
    await settle();
    fireEvent.click(document.querySelector('[data-k="continue"]')!);
    expect(document.querySelector<HTMLInputElement>("#connect-provider-key")?.value).toBe("••••••••••••");
    expect(document.querySelector('[data-k="key-state"]')?.textContent).toBe("saved");
    expect(document.querySelector('[data-k="save"]')?.textContent).toBe("Continue");
    expect(document.querySelector('[data-k="where"]')).toBeNull();
    fireEvent.click(document.querySelector('[data-k="change"]')!);
    expect(document.querySelector<HTMLInputElement>("#connect-provider-key")?.value).toBe("");
    expect(document.querySelector('[data-k="save"]')?.textContent).toBe("Save");
  });

  it("moves a held key straight to what the provider offers, asking for nothing", async () => {
    const sent: string[] = [];
    mount(
      rowsWith(async (_api, key) => {
        sent.push(key);
      }, setup => setup.keys.solari),
      { initGet: async () => setupWith(true) } as unknown as Partial<Api>,
    );
    await settle();
    fireEvent.click(document.querySelector('[data-k="continue"]')!);
    fireEvent.click(document.querySelector('[data-k="save"]')!);
    await settle();
    expect(sent).toEqual([]);
    expect(document.querySelector('[data-k="title"]')?.textContent).toBe("ASCII connected");
  });
});
