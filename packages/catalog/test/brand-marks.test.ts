// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { BRAND_MARKS, CATALOG_TOOLS, serverMark, toolMark } from "../src/index.js";

// The CLIs that draw the neutral terminal glyph on purpose: no mark is registered for them yet.
const TERMINAL_GLYPH = [
  "curl", "pnpm", "uv", "python", "git", "jq", "ripgrep", "build-essential", "fd", "sqlite3", "wget", "zip", "xz", "rsync",
  "agent-browser", "docker", "go", "rust", "java", "maven", "gradle", "bun", "yarn", "ruff", "black", "mypy", "pyright",
  "pytest", "prettier", "eslint", "typescript", "gcloud", "kubectl", "aws", "vercel", "netlify", "fly", "supabase",
  "railway", "doppler", "op", "ffmpeg", "yq", "git-lfs", "tmux", "ruby", "php", "postgresql-client", "redis-tools",
  "golangci-lint", "mise", "git-delta", "shellcheck", "swift", "elixir", "bazel", "llvm", "playwright",
];

describe("brand marks", () => {
  it("every catalog CLI has a registered mark or takes the terminal glyph on purpose, never both", () => {
    const marked = CATALOG_TOOLS.filter(t => toolMark(t.id) !== undefined).map(t => t.id);
    expect(marked).toEqual(["node", "gh", "wrangler", "cloudflared"]);
    expect(CATALOG_TOOLS.filter(t => toolMark(t.id) === undefined).map(t => t.id)).toEqual(TERMINAL_GLYPH);
  });

  it("a mark names only catalog CLIs, each under one mark", () => {
    const ids = new Set(CATALOG_TOOLS.map(t => t.id));
    const claimed = BRAND_MARKS.flatMap(m => m.tools);
    for (const id of claimed) expect(ids, id).toContain(id);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(toolMark("gh")?.id).toBe("github");
    expect(toolMark("not-a-tool")).toBeUndefined();
  });

  it("every mark is simple-icons' path at a pinned release, under CC0", () => {
    for (const m of BRAND_MARKS) {
      expect(m.source, m.id).toMatch(/^https:\/\/github\.com\/simple-icons\/simple-icons\/blob\/16\.30\.0\/icons\/[a-z]+\.svg$/);
      expect(m.license, m.id).toBe("CC0-1.0");
    }
  });

  it("GitHub takes the row's ink and the others their hue, a step darker on the light side where the hue measures under 3:1", () => {
    const inks = Object.fromEntries(BRAND_MARKS.map(m => [m.id, m.inks]));
    expect(inks).toEqual({
      node: [{ dark: "#5fa04e", light: "#579348" }],
      github: undefined,
      cloudflare: [{ dark: "#f38020", light: "#cf6d1b" }],
      linear: [{ dark: "#5e6ad2", light: "#5e6ad2" }],
    });
  });

  it("a server reached over an address takes the mark of the company that serves it, by the host or a domain under it", () => {
    expect(serverMark({ kind: "http", host: "mcp.linear.app" })?.id).toBe("linear");
    expect(serverMark({ kind: "http", host: "MCP.Linear.App" })?.id).toBe("linear");
    expect(serverMark({ kind: "http", host: "api.githubcopilot.com" })?.id).toBe("github");
    expect(serverMark({ kind: "http", host: "bindings.mcp.cloudflare.com" })?.id).toBe("cloudflare");
    expect(serverMark({ kind: "http", host: "mcp.linear.app:8443" })?.id).toBe("linear");
    expect(serverMark({ kind: "http", host: "mcp.linear.app." })?.id).toBe("linear");
    expect(serverMark({ kind: "http", host: "notlinear.app" })).toBeUndefined();
    expect(serverMark({ kind: "http", host: "github.com.evil.io" })).toBeUndefined();
    expect(serverMark({ kind: "http", host: "mcp.example.com" })).toBeUndefined();
  });

  it("a command server takes the mark of the package it runs, or of an address on its line", () => {
    expect(serverMark({ kind: "stdio", line: "npx -y @modelcontextprotocol/server-github" })?.id).toBe("github");
    expect(serverMark({ kind: "stdio", line: "docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server" })?.id).toBe("github");
    expect(serverMark({ kind: "stdio", line: "npx -y @cloudflare/mcp-server-cloudflare@0.4.1 run" })?.id).toBe("cloudflare");
    expect(serverMark({ kind: "stdio", line: "npx -y mcp-remote https://mcp.linear.app/sse" })?.id).toBe("linear");
    expect(serverMark({ kind: "stdio", line: "npx -y mcp-remote HTTPS://mcp.linear.app/sse" })?.id).toBe("linear");
    expect(serverMark({ kind: "stdio", line: "node ./my-github-helper.js" })).toBeUndefined();
    expect(serverMark({ kind: "stdio", line: "" })).toBeUndefined();
  });
});
