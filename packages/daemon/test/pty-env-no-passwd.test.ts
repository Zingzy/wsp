// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async importOriginal => {
  const os = await importOriginal<typeof import("node:os")>();
  return {
    ...os,
    userInfo: () => {
      throw Object.assign(new Error("ENOENT: no such file or directory, uv_os_get_passwd"), { code: "ENOENT" });
    },
  };
});

const { ptyEnv } = await import("../src/pty-manager.js");

describe("ptyEnv on a uid without a passwd row", () => {
  const saved = { HOME: process.env["HOME"], USER: process.env["USER"] };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("leaves HOME and USER unset instead of failing the pty", () => {
    delete process.env["HOME"];
    process.env["USER"] = "";
    const env = ptyEnv();
    expect(env).not.toHaveProperty("HOME");
    expect(env).not.toHaveProperty("USER");
    expect(env["BROWSER"]).toBe("/usr/local/bin/wsp-open");
  });

  it("keeps what the daemon inherited, since the lookup only runs for a blank", () => {
    process.env["HOME"] = "/srv/elsewhere";
    process.env["USER"] = "someone";
    expect(ptyEnv()).toMatchObject({ HOME: "/srv/elsewhere", USER: "someone" });
  });
});
