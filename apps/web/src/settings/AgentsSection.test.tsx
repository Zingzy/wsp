// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { InitAgent, InitSetup } from "@wsp/protocol";
import type { Api } from "../protocol/client.js";
import { useStore } from "../protocol/store.js";
import { AgentsSection } from "./AgentsSection.js";
import { AGENTS_WORDS } from "./format.js";

const setup = (agents: readonly InitAgent[]): InitSetup => ({ keys: { solari: false }, home: "/Users/dev", agents: [...agents], pricing: null, job: null });

function mount(agents: readonly InitAgent[]) {
  const api = { subscribe: () => () => {}, initGet: async () => setup(agents) } as unknown as Api;
  useStore.setState({ api } as never);
  return render(<AgentsSection />);
}

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  });
};

/** Every row the section drew, in the order it drew them: which agent it is (off the label's own id, which is what
 * the column's rows are named by), the name the reader sees, the state word at the right edge and the action
 * beside it. */
const rows = (): { agent: string | undefined; label: string | undefined; state: string | undefined; action: string | undefined }[] =>
  [...document.querySelectorAll<HTMLElement>('[aria-labelledby="settings-agents"] [data-settings-row]')].map(row => ({
    agent: row.firstElementChild?.id.replace("settings-agent-", ""),
    label: row.firstElementChild?.textContent ?? undefined,
    state: row.querySelector('[data-k="agent-state"]')?.textContent ?? undefined,
    action: row.querySelector('[data-k="agent-add"]')?.textContent ?? undefined,
  }));

afterEach(() => {
  cleanup();
  useStore.setState({ api: null } as never);
});

describe("the agents found on this Mac", () => {
  it("gives one row to each, the tools state on the ones that hold them and the Add button on the ones that do not", async () => {
    mount([
      { id: "claude", name: "Claude", configured: true, takesTools: true },
      { id: "codex", name: "Codex", configured: false, takesTools: true },
      { id: "opencode", name: "opencode", configured: false, takesTools: false },
    ]);
    await settle();
    expect(rows()).toEqual([
      { agent: "claude", label: "Claude", state: AGENTS_WORDS.added, action: undefined },
      { agent: "codex", label: "Codex", state: undefined, action: AGENTS_WORDS.add },
      // An agent whose thread wsp cannot hand the tools to at launch is shown and never offered them.
      { agent: "opencode", label: "opencode", state: AGENTS_WORDS.noTools, action: undefined },
    ]);
  });

  it("draws Add held, with no reason on a hover, since adding the tools has no road from the app yet", async () => {
    mount([{ id: "codex", name: "Codex", configured: false, takesTools: true }]);
    await settle();
    const add = document.querySelector<HTMLButtonElement>('[data-k="agent-add"]');
    expect(add?.disabled).toBe(true);
    expect(add?.hasAttribute("data-held")).toBe(true);
    // A held control never has a pointer on it, so a title on one is a reason nobody can read.
    expect(add?.hasAttribute("title")).toBe(false);
  });

  it("says so in one muted row when this Mac has none", async () => {
    mount([]);
    await settle();
    expect(rows().map(row => row.label)).toEqual([AGENTS_WORDS.none]);
    expect(screen.getByText(AGENTS_WORDS.none)).toBeTruthy();
  });
});
