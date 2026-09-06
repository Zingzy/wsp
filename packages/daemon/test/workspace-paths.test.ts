// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { OpError, resolveInside } from "../src/workspace-paths.js";

const root = mkdtempSync(join(tmpdir(), "wsp-paths-root-"));
const outside = mkdtempSync(join(tmpdir(), "wsp-paths-outside-"));
const project = mkdtempSync(join(tmpdir(), "wsp-paths-project-"));
mkdirSync(join(root, "a", "b"), { recursive: true });
writeFileSync(join(root, "a", "file.txt"), "in");
writeFileSync(join(outside, "secret.txt"), "out");
symlinkSync(outside, join(root, "escape"));
symlinkSync(join(outside, "secret.txt"), join(root, "a", "leak.txt"));
symlinkSync(join(root, "a", "file.txt"), join(root, "a", "inner.txt"));
writeFileSync(join(project, "package.json"), "{}");
symlinkSync(project, join(root, "into-project"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof OpError ? e.code : `not an OpError: ${String(e)}`;
  }
}

describe("workspace path confinement", () => {
  it("resolves relative and absolute paths that stay inside the root", async () => {
    const real = await resolveInside([root], "a/file.txt");
    expect(real.endsWith(join("a", "file.txt"))).toBe(true);
    expect(await resolveInside([root], join(root, "a", "b"))).toBe(await resolveInside([root], "a/b"));
    expect(await resolveInside([root], ".")).toBe(await resolveInside([root], ""));
    expect(await resolveInside([root], "a/../a/b")).toBe(await resolveInside([root], "a/b"));
  });

  it("refuses .. escapes and absolute paths outside the root before touching the disk", async () => {
    expect(await code(resolveInside([root], ".."))).toBe("outside-root");
    expect(await code(resolveInside([root], "a/../../x"))).toBe("outside-root");
    expect(await code(resolveInside([root], outside))).toBe("outside-root");
    expect(await code(resolveInside([root], `${root}-sibling/x`))).toBe("outside-root");
    expect(await code(resolveInside([root], "/etc/passwd"))).toBe("outside-root");
  });

  it("refuses symlinks that leave the root, directly or through a parent", async () => {
    expect(await code(resolveInside([root], "escape"))).toBe("outside-root");
    expect(await code(resolveInside([root], "escape/secret.txt"))).toBe("outside-root");
    expect(await code(resolveInside([root], "a/leak.txt"))).toBe("outside-root");
  });

  it("follows symlinks that stay inside", async () => {
    expect(await resolveInside([root], "a/inner.txt")).toBe(await resolveInside([root], "a/file.txt"));
  });

  it("reports a missing path as not-found only when its parent is inside", async () => {
    expect(await code(resolveInside([root], "a/missing.txt"))).toBe("not-found");
    expect(await code(resolveInside([root], "escape/missing.txt"))).toBe("outside-root");
  });

  it("works when the root itself is given through a symlinked prefix", async () => {
    const linkedRoot = join(outside, "root-link");
    symlinkSync(root, linkedRoot);
    expect(await resolveInside([linkedRoot], "a/file.txt")).toBe(await resolveInside([root], "a/file.txt"));
    expect(await code(resolveInside([linkedRoot], "escape/secret.txt"))).toBe("outside-root");
  });
});

describe("a second root, the imported project folder", () => {
  const roots = [root, project];

  it("resolves an absolute path under the project as it does one under home", async () => {
    expect(await resolveInside(roots, join(project, "package.json"))).toBe(await resolveInside([project], "package.json"));
    expect(await resolveInside(roots, project)).toBe(await resolveInside([project], "."));
    expect(await resolveInside(roots, join(root, "a", "file.txt"))).toBe(await resolveInside([root], "a/file.txt"));
  });

  it("resolves a relative path against home, the first root", async () => {
    expect(await resolveInside(roots, "a/file.txt")).toBe(await resolveInside([root], "a/file.txt"));
    expect(await code(resolveInside(roots, "package.json"))).toBe("not-found");
  });

  it("refuses a path outside both roots with the same sentence", async () => {
    const err = await resolveInside(roots, join(outside, "secret.txt")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpError);
    expect((err as OpError).code).toBe("outside-root");
    expect((err as Error).message).toBe(`${join(outside, "secret.txt")} resolves outside the workspace root`);
    expect(await code(resolveInside(roots, `${project}-sibling/x`))).toBe("outside-root");
    expect(await code(resolveInside(roots, "escape/secret.txt"))).toBe("outside-root");
  });

  it("says a path under a root that is gone does not exist, rather than that it is outside", async () => {
    const gone = `${project}-gone`;
    expect(await code(resolveInside([root, gone], join(gone, "src")))).toBe("not-found");
    expect(await code(resolveInside([root, gone], join(outside, "x")))).toBe("outside-root");
    expect(await resolveInside([root, gone], "a/file.txt")).toBe(await resolveInside([root], "a/file.txt"));
  });

  it("follows a symlink from home into the project, since both are browsable", async () => {
    expect(await resolveInside(roots, "into-project/package.json")).toBe(await resolveInside([project], "package.json"));
    expect(await code(resolveInside([root], "into-project/package.json"))).toBe("outside-root");
  });
});
