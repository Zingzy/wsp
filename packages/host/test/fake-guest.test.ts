// SPDX-License-Identifier: AGPL-3.0-only
// The guest a stand-in provider's machines get: where one process keeps a
// machine's daemon token, and that everything it started goes when its command
// is done.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { standInMachinePath } from "@wsp/protocol";
import { closeStandInGuests, fakeGuestAt, fakeNoPortLine } from "../src/fake-guest.js";

describe("a stand-in machine's guest", () => {
  const made: string[] = [];
  afterEach(async () => {
    await closeStandInGuests();
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const throwaway = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-fake-guest-test-"));
    made.push(dir);
    return dir;
  };

  it("keeps each process's daemon token in a file of its own, since the machine's folder is shared and its token is not", () => {
    const root = throwaway();
    const guest = fakeGuestAt(root);
    const held = guest.tokenPath("fk_c0ffee");
    // The folder is the machine's disk and two processes look at the same one; the token is the runtime's, and a
    // second process writing its own over the first left the host serving the app holding a token its own daemon
    // had stopped reading, so the terminal, the files and the live rows went dark until it was restarted.
    expect(held.startsWith(`${standInMachinePath(root, "fk_c0ffee")}/`)).toBe(true);
    expect(held).toContain(String(process.pid));
    expect(guest.folder("fk_c0ffee")).toBe(standInMachinePath(root, "fk_c0ffee"));
  });

  it("starts a daemon at the first road asked for and takes it away when the command that asked is done", async () => {
    const root = throwaway();
    const guest = fakeGuestAt(root);
    const reach = await guest.reach("fk_c0ffee", 7070);
    expect(reach.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // A daemon that opened its own port is a reason this process stays: a verb that dialled one printed its whole
    // answer and then sat at a prompt that never came back.
    expect((await fetch(reach.url)).status).toBe(426);
    expect(existsSync(guest.tokenPath("fk_c0ffee"))).toBe(true);
    await closeStandInGuests();
    await expect(fetch(reach.url)).rejects.toThrow();
  }, 20_000);

  it("leaves no daemon behind when the host that spawned it is stopped", async () => {
    const root = throwaway();
    const guest = fakeGuestAt(root);
    const reach = await guest.reach("fk_c0ffee", 7070);
    const argv = execFileSync("ps", ["-ax", "-o", "args="], { encoding: "utf8" });
    expect(argv).toContain(guest.tokenPath("fk_c0ffee"));
    // The daemon is a child process now, and a child outlives the parent that spawned it: a lab whose host was
    // stopped left one of these running on the person's computer per machine a tester had opened.
    await closeStandInGuests();
    expect(execFileSync("ps", ["-ax", "-o", "args="], { encoding: "utf8" })).not.toContain(guest.tokenPath("fk_c0ffee"));
    await expect(fetch(reach.url)).rejects.toThrow();
  }, 20_000);

  it("has no road to any other port, since answering with this computer's own would frame whatever runs there", async () => {
    const guest = fakeGuestAt(throwaway());
    await expect(guest.reach("fk_c0ffee", 5173)).rejects.toThrow(fakeNoPortLine("fk_c0ffee", 5173));
  });
});
