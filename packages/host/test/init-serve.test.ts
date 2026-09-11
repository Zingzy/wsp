// SPDX-License-Identifier: AGPL-3.0-only
// The line wsp init ends on and the ssh forward under it, both read off the
// address the host bound: the forward is advice only when the address the page
// is on answers on the computer the host runs on and nowhere else.
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { appUrl } from "../src/init-first.js";
import { openApp } from "../src/init-serve.js";

const SSH = { SSH_CONNECTION: "10.0.0.2 51000 10.0.0.9 22" };

/** One openApp run at one address, with what it printed and what it asked a browser to open. */
async function run(o: { address?: string; env?: Record<string, string | undefined>; interactive?: boolean }): Promise<{ text: string; opened: string[] }> {
  const chunks: string[] = [];
  const output = new PassThrough();
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  const opened: string[] = [];
  const at = { port: 4400, address: o.address };
  await openApp(
    appUrl(at),
    at,
    {
      output,
      env: o.env ?? {},
      open: (url: string) => {
        opened.push(url);
        return Promise.resolve(true);
      },
    },
    o.interactive ?? true,
  );
  return { text: stripVTControlCharacters(chunks.join("")), opened };
}

describe("the address wsp init hands over, and the ssh forward under it", () => {
  it("over ssh, a host on this computer alone prints the forward, spelled with the address the page is on", async () => {
    const { text, opened } = await run({ env: SSH });
    expect(text).toContain("Open http://127.0.0.1:4400/");
    expect(text).toContain("ssh -L 4400:127.0.0.1:4400 <this host>");
    expect(opened).toEqual([]);
  });

  it("over ssh, a host on an address beyond this computer prints that address and no forward, since the page is already there", async () => {
    const { text } = await run({ address: "100.64.0.3", env: SSH });
    expect(text).toContain("Open http://100.64.0.3:4400/");
    expect(text).not.toContain("ssh -L");
    expect(text).not.toContain("forward");
  });

  it("over ssh, a loopback address spelled another way still gets a forward, through the one authority rule", async () => {
    const { text } = await run({ address: "::1", env: SSH });
    expect(text).toContain("Open http://[::1]:4400/");
    expect(text).toContain("ssh -L 4400:[::1]:4400 <this host>");
  });

  it("over ssh, an IPv6 address beyond this computer prints bracketed and gets no forward", async () => {
    const { text } = await run({ address: "2001:db8::5", env: SSH });
    expect(text).toContain("Open http://[2001:db8::5]:4400/");
    expect(text).not.toContain("ssh -L");
  });

  it("over ssh, a wildcard bind keeps the forward: the page is handed over at loopback, which is the one address a wildcard is not dialled at", async () => {
    const { text } = await run({ address: "0.0.0.0", env: SSH });
    expect(text).toContain("Open http://127.0.0.1:4400/");
    expect(text).toContain("ssh -L 4400:127.0.0.1:4400 <this host>");
  });

  it("off a terminal but not over ssh, the address is printed with no forward: nobody here is on the far side of one", async () => {
    const { text, opened } = await run({ interactive: false });
    expect(text).toContain("Open http://127.0.0.1:4400/");
    expect(text).not.toContain("ssh -L");
    expect(opened).toEqual([]);
  });

  it("on a terminal the person is at, the browser opens and nothing about ssh is said", async () => {
    const { text, opened } = await run({ address: "100.64.0.3" });
    expect(opened).toEqual(["http://100.64.0.3:4400/"]);
    expect(text).toContain("Opened http://100.64.0.3:4400/");
    expect(text).not.toContain("ssh -L");
  });
});
