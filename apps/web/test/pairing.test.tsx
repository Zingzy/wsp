// SPDX-License-Identifier: AGPL-3.0-only
// What a page does with what the host inlined: dial this origin's WS_PATH, use
// the host's token when the page came from the host's own computer, and pair
// for one of its own when it did not.
import { createServer, type Server } from "node:http";
import { createRuntime, memoryStore, serveRuntime, type RuntimeServer } from "@wsp/runtime";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WS_PATH, type BootPayload } from "@wsp/protocol";
import { BootGate } from "../src/BootGate.js";
import { PAIR_HEADING } from "../src/PairScreen.js";
import { DEVICE_TOKEN_KEY, deviceName, pageToken, redeemPairingCode, runtimeUrl, storedDeviceToken } from "../src/protocol/pairing.js";
import { stubBackend } from "../../../packages/runtime/test/stub-backend.js";

const boot = (over: Partial<BootPayload> = {}): BootPayload => ({ wsPort: 4410, wsPath: WS_PATH, paired: true, version: "0.0.0", token: "host-token", ...over });

let srv: RuntimeServer | undefined;
let http: Server | undefined;
afterEach(async () => {
  window.localStorage.clear();
  await srv?.close();
  srv = undefined;
  if (http !== undefined) await new Promise<void>(done => http!.close(() => done()));
  http = undefined;
});

/** A real host-shaped pair: an HTTP server with the runtime answering upgrades of WS_PATH on its own port. */
async function serving(): Promise<{ port: number; hostToken: string }> {
  const runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
  http = createServer((_req, res) => res.end("page"));
  await new Promise<void>(done => http!.listen(0, "127.0.0.1", done));
  srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", attach: http, devices: runtime.devices });
  return { port: (http.address() as { port: number }).port, hostToken: "host-token" };
}

describe("where the page dials", () => {
  it("dials this page's own origin and path, over ws or wss as the page was served", () => {
    expect(runtimeUrl(boot(), { protocol: "http:", host: "127.0.0.1:14400" })).toBe("ws://127.0.0.1:14400/ws");
    expect(runtimeUrl(boot(), { protocol: "https:", host: "box.example.com" })).toBe("wss://box.example.com/ws");
  });

  it("takes the host's own token when the page carries one, and this browser's when it does not", () => {
    expect(pageToken(boot(), window.localStorage)).toBe("host-token");
    expect(pageToken(boot({ token: undefined, paired: false }), window.localStorage)).toBeUndefined();
    window.localStorage.setItem(DEVICE_TOKEN_KEY, "device-token");
    expect(pageToken(boot({ token: undefined, paired: false }), window.localStorage)).toBe("device-token");
    // The host's own wins: a page from this computer never dials with a token another host handed this browser.
    expect(pageToken(boot(), window.localStorage)).toBe("host-token");
  });

  it("names this browser by its platform and the host it reached, so wsp devices has a row worth reading", () => {
    expect(deviceName({ protocol: "http:", host: "box:4400" }, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("a Mac in a browser at box:4400");
  });
});

describe("redeeming a code over the page's own socket", () => {
  it("hands back a token the host then takes on an auth frame", async () => {
    const { port } = await serving();
    const code = await (async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
      await new Promise<void>(done => ws.addEventListener("open", () => done()));
      const ask = (frame: Record<string, unknown>): Promise<Record<string, unknown>> =>
        new Promise(done => ws.addEventListener("message", e => done(JSON.parse(String(e.data)) as Record<string, unknown>), { once: true }));
      const authed = ask({});
      ws.send(JSON.stringify({ id: 1, op: "auth", token: "host-token" }));
      await authed;
      const issued = ask({});
      ws.send(JSON.stringify({ id: 2, op: "pair.issue" }));
      const answer = await issued;
      ws.close();
      return answer["code"] as string;
    })();
    const token = await redeemPairingCode(`ws://127.0.0.1:${port}${WS_PATH}`, code, "a browser");
    expect(typeof token).toBe("string");
    expect(token).not.toBe("host-token");
  });

  it("rejects with the host's own words on a code it is not holding", async () => {
    const { port } = await serving();
    await expect(redeemPairingCode(`ws://127.0.0.1:${port}${WS_PATH}`, "AAAAAAAA", "a browser")).rejects.toThrow(/pairing code/);
  });
});

describe("the screen a page with no token shows", () => {
  it("asks for a code, and keeps the token it buys in this browser", async () => {
    const { port } = await serving();
    const host = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
    await new Promise<void>(done => host.addEventListener("open", () => done()));
    const ask = (): Promise<Record<string, unknown>> => new Promise(done => host.addEventListener("message", e => done(JSON.parse(String(e.data)) as Record<string, unknown>), { once: true }));
    const authed = ask();
    host.send(JSON.stringify({ id: 1, op: "auth", token: "host-token" }));
    await authed;
    const issued = ask();
    host.send(JSON.stringify({ id: 2, op: "pair.issue" }));
    const code = (await issued)["code"] as string;
    host.close();

    render(<BootGate boot={boot({ token: undefined, paired: false })} at={{ protocol: "http:", host: `127.0.0.1:${port}` }} agent="Mozilla/5.0 (Macintosh)" storage={window.localStorage} />);
    expect(screen.getByText(PAIR_HEADING)).toBeTruthy();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: code } });
      fireEvent.click(screen.getByRole("button", { name: "Pair" }));
    });
    await waitFor(() => expect(storedDeviceToken(window.localStorage)).toBeDefined());
    expect(screen.queryByText(PAIR_HEADING)).toBeNull();
  });

  it("shows the host's refusal on a code it will not take, and stays on the screen", async () => {
    const { port } = await serving();
    render(<BootGate boot={boot({ token: undefined, paired: false })} at={{ protocol: "http:", host: `127.0.0.1:${port}` }} agent="Mozilla/5.0 (Macintosh)" storage={window.localStorage} />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "AAAAAAAA" } });
      fireEvent.click(screen.getByRole("button", { name: "Pair" }));
    });
    expect((await screen.findByRole("alert")).textContent).toMatch(/pairing code/);
    expect(screen.getByText(PAIR_HEADING)).toBeTruthy();
    expect(storedDeviceToken(window.localStorage)).toBeUndefined();
  });

  it("keeps this browser's token when the page unmounts, and drops it only when the host refuses it", async () => {
    const { port } = await serving();
    window.localStorage.setItem(DEVICE_TOKEN_KEY, "a-token-this-host-never-minted");
    const page = render(
      <BootGate boot={boot({ token: undefined, paired: false })} at={{ protocol: "http:", host: `127.0.0.1:${port}` }} agent="Mozilla/5.0 (Macintosh)" storage={window.localStorage} />,
    );
    // The client's own close on unmount is not the host refusing anything: a token dropped here would send every
    // remount back to the code screen.
    await act(async () => {
      page.unmount();
    });
    expect(storedDeviceToken(window.localStorage)).toBe("a-token-this-host-never-minted");

    // The host refusing it is the one thing that drops it, and the page goes back to asking for a code.
    render(<BootGate boot={boot({ token: undefined, paired: false })} at={{ protocol: "http:", host: `127.0.0.1:${port}` }} agent="Mozilla/5.0 (Macintosh)" storage={window.localStorage} />);
    await waitFor(() => expect(storedDeviceToken(window.localStorage)).toBeUndefined());
    expect(screen.getByText(PAIR_HEADING)).toBeTruthy();
  });

  it("goes straight to the app when the page carries the host's own token", async () => {
    await act(async () => {
      render(<BootGate boot={boot()} at={{ protocol: "http:", host: "127.0.0.1:4400" }} agent="Mozilla/5.0 (Macintosh)" storage={window.localStorage} />);
    });
    expect(screen.queryByText(PAIR_HEADING)).toBeNull();
  });
});
