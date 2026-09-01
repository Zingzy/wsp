import { describe, expect, it } from "vitest";
import { PtyManager } from "../src/pty-manager.js";

describe("PtyManager", () => {
  it("keeps a session alive across client detach and replays scrollback", async () => {
    const mgr = new PtyManager();
    const s = mgr.create({ cols: 80, rows: 24, shell: "bash" });
    const got: string[] = [];
    const un1 = s.attach(d => got.push(d));
    s.write("echo HELLO-$((1+1))\n");
    await new Promise(r => setTimeout(r, 300));
    un1(); // client goes away
    s.write("echo AFTER-DETACH\n");
    await new Promise(r => setTimeout(r, 300));
    const replay: string[] = [];
    s.attach(d => replay.push(d)); // new client gets buffered scrollback first
    await new Promise(r => setTimeout(r, 50));
    expect(replay.join("")).toContain("HELLO-2");
    expect(replay.join("")).toContain("AFTER-DETACH");
    mgr.destroyAll();
  });
});
