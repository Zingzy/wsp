// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaceView } from "@wsp/protocol";
import type { Api, InstallStage, SshLogin } from "../protocol/client.js";
import { useStore } from "../protocol/store.js";
import { AddComputerSheet } from "./AddComputerSheet.js";

const HERE: PlaceView = { id: "here", kind: "computer", name: "This Mac", default: false, shape: { cpu: 8, memMb: 16 * 1024 }, diskFreeBytes: 210 * 1024 ** 3, docker: false, present: true };
const LAPTOP: PlaceView = {
  id: "p_2",
  kind: "computer",
  name: "old-macbook",
  default: true,
  os: "macOS 15.6",
  shape: { cpu: 4, memMb: 8 * 1024 },
  diskFreeBytes: 91 * 1024 ** 3,
  docker: false,
  present: true,
  joinedAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
  workspaceId: "ws_old",
};
const HETZNER: PlaceView = { ...LAPTOP, id: "p_1", name: "hetzner", os: "Ubuntu 24.04", shape: { cpu: 2, memMb: 4 * 1024 }, diskFreeBytes: 38 * 1024 ** 3, docker: true, workspaceId: "ws_fix" };

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
  });
};

/** A host that hands out a code, answers the list from whatever the run has set, and runs the ssh installer the
 * test drives by hand. */
function fakeApi(over: Partial<Api> = {}) {
  return {
    subscribe: () => () => {},
    joinCode: async () => ({ code: "QW4K-7PZX", expiresAt: Date.now() + 10 * 60_000 }),
    places: async () => [HERE],
    ...over,
  } as unknown as Api;
}

const mount = (api: Api) => {
  useStore.setState({ api });
  return render(<AddComputerSheet open onOpenChange={() => {}} />);
};

afterEach(() => {
  cleanup();
  useStore.setState({ api: null });
  vi.useRealTimers();
});

describe("the app road", () => {
  it("hands out the address and the code and says it is waiting", async () => {
    mount(fakeApi());
    await settle();
    expect(document.querySelector('[data-k="join-code"]')?.textContent).toContain("QW4K-7PZX");
    expect(document.querySelector('[data-k="join-address"]')?.textContent).toContain(window.location.host);
    expect(document.querySelector('[data-k="code-line"]')?.textContent).toBe("the code is good for 10 minutes");
    expect(document.querySelector('[data-k="lines"] [data-k="line"]')?.getAttribute("data-state")).toBe("running");
    expect(screen.getByText("waiting for it to connect")).toBeTruthy();
  });

  it("carries the terminal road for a computer with no app on it", async () => {
    mount(fakeApi());
    await settle();
    fireEvent.click(document.querySelector('[data-k="no-app"]')!);
    expect(document.querySelector('[data-k="install-line"]')?.textContent).toContain("npm i -g wsp");
    expect(document.querySelector('[data-k="join-line"]')?.textContent).toContain(`wsp join ${window.location.host} --code QW4K-7PZX`);
  });

  it("reads the computer as joined once it is on the host's list, and offers to open it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let held: PlaceView[] = [HERE];
    mount(fakeApi({ places: async () => held }));
    await settle();
    held = [HERE, LAPTOP];
    await act(async () => {
      vi.advanceTimersByTime(2_100);
      await Promise.resolve();
    });
    await settle();
    expect(document.querySelector('[data-k="title"]')?.textContent).toBe("old-macbook joined");
    expect(document.querySelector('[data-k="description"]')?.textContent).toBe("It runs your agents as one workspace. Without Docker it cannot run copies of your image.");
    expect(document.querySelector('[data-k="place-row"]')?.textContent).toContain("0 · agents only");
    expect(screen.getByText("install Docker to run copies of your image")).toBeTruthy();
    expect(document.querySelector('[data-k="open-place"]')?.textContent).toBe("Open old-macbook");
    // The roads are a choice no longer, so the control goes.
    expect(document.querySelector('[data-slot="segmented-control"]')).toBeNull();
  });
});

describe("the ssh road", () => {
  // The road is moved with the arrow the radio group answers to: jsdom builds no PointerEvent, so a click on a
  // segment never reaches base-ui's own handler.
  const toSsh = async (): Promise<void> => {
    fireEvent.keyDown(document.querySelector('[data-segment="app"]')!, { key: "ArrowRight" });
    await settle();
  };

  it("holds Add until a login is typed", async () => {
    mount(fakeApi({ addComputerOverSsh: async () => HETZNER }));
    await settle();
    await toSsh();
    expect(document.querySelector<HTMLButtonElement>('[data-k="ssh-add"]')?.disabled).toBe(true);
    fireEvent.change(document.querySelector("#add-computer-login")!, { target: { value: "root@65.21.4.12" } });
    expect(document.querySelector<HTMLButtonElement>('[data-k="ssh-add"]')?.disabled).toBe(false);
  });

  it("holds Add on a wsp whose host cannot log in over ssh at all", async () => {
    mount(fakeApi());
    await settle();
    await toSsh();
    fireEvent.change(document.querySelector("#add-computer-login")!, { target: { value: "root@65.21.4.12" } });
    expect(document.querySelector<HTMLButtonElement>('[data-k="ssh-add"]')?.disabled).toBe(true);
  });

  it("shows the installer's own stages while it runs, and the roads go", async () => {
    let report: ((stage: InstallStage) => void) | undefined;
    const api = fakeApi({
      addComputerOverSsh: (_login: SshLogin, onStage: (stage: InstallStage) => void) =>
        new Promise<PlaceView>(() => {
          report = onStage;
        }),
    } as unknown as Partial<Api>);
    mount(api);
    await settle();
    await toSsh();
    fireEvent.change(document.querySelector("#add-computer-login")!, { target: { value: "root@65.21.4.12" } });
    fireEvent.click(document.querySelector('[data-k="ssh-add"]')!);
    await settle();
    act(() => {
      report?.({ word: "connected · Ubuntu 24.04", state: "done" });
      report?.({ word: "installing node 22", state: "done", fact: "18 s" });
      report?.({ word: "installing wsp 0.2.0", state: "running" });
    });
    expect(document.querySelector('[data-slot="segmented-control"]')).toBeNull();
    expect(document.querySelector('[data-k="ssh-login"]')?.textContent).toContain("root@65.21.4.12");
    const lines = [...document.querySelectorAll('[data-k="lines"] [data-k="line"]')].map(l => [l.textContent, l.getAttribute("data-state")]);
    expect(lines).toEqual([
      ["connected · Ubuntu 24.04", "done"],
      ["installing node 2218 s", "done"],
      ["installing wsp 0.2.0", "running"],
    ]);
  });

  it("reads the box as joined once the installer answers with it", async () => {
    mount(fakeApi({ addComputerOverSsh: async () => HETZNER }));
    await settle();
    await toSsh();
    fireEvent.change(document.querySelector("#add-computer-login")!, { target: { value: "root@65.21.4.12" } });
    fireEvent.click(document.querySelector('[data-k="ssh-add"]')!);
    await settle();
    expect(document.querySelector('[data-k="title"]')?.textContent).toBe("hetzner joined");
    expect(document.querySelector('[data-k="description"]')?.textContent).toBe("It can run copies of your image. Your image is built there the first time a workspace is created on it.");
    expect(document.querySelector('[data-k="place-row"]')?.textContent).toContain("38 GB");
  });

  it("puts what ssh refused under both fields and leaves the fields as they were", async () => {
    mount(
      fakeApi({
        addComputerOverSsh: async () => {
          throw new Error("ssh refused the login (publickey).");
        },
      }),
    );
    await settle();
    await toSsh();
    fireEvent.change(document.querySelector("#add-computer-login")!, { target: { value: "root@65.21.4.12" } });
    fireEvent.click(document.querySelector('[data-k="ssh-add"]')!);
    await settle();
    expect(document.querySelector('[data-k="ssh-refusal"]')?.textContent).toContain("ssh refused the login (publickey).");
    expect(document.querySelector('[data-k="ssh-refusal"]')?.textContent).toContain("pick a key file");
    expect(document.querySelector<HTMLInputElement>("#add-computer-login")?.value).toBe("root@65.21.4.12");
  });
});
