// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { DaemonEvent, DaemonRequest, GoldenVersion, HTTP_URL_MAX, HTTP_URL_RE, hostOf, isHttpUrl } from "../src/index.js";

describe("callback relay wire shapes", () => {
  it("browser.open carries the URL and, when the redirect_uri named one, the port", () => {
    const bare = { type: "browser.open", url: "https://github.com/login/device" };
    expect(DaemonEvent.parse(bare)).toEqual(bare);
    const withPort = { type: "browser.open", url: "https://dash.example.com/auth?redirect_uri=http%3A%2F%2Flocalhost%3A8976%2Fcb", port: 8976 };
    expect(DaemonEvent.parse(withPort)).toEqual(withPort);
    expect(() => DaemonEvent.parse({ type: "browser.open" })).toThrow();
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "smb://host/share", "\\\\host\\share", "ftp://x/y"]) {
      expect(() => DaemonEvent.parse({ type: "browser.open", url })).toThrow();
    }
  });

  it("callback.port names a loopback listener; port.open may say it is loopback-bound", () => {
    expect(DaemonEvent.parse({ type: "callback.port", port: 45543 })).toEqual({ type: "callback.port", port: 45543 });
    expect(() => DaemonEvent.parse({ type: "callback.port" })).toThrow();
    const open = { type: "port.open", port: 8976, loopback: true };
    expect(DaemonEvent.parse(open)).toEqual(open);
    expect(DaemonEvent.parse({ type: "port.open", port: 3000 })).toEqual({ type: "port.open", port: 3000 });
  });

  it("tunnel ops and events: open by id and port, base64 data both ways, end from the guest", () => {
    expect(DaemonRequest.parse({ id: 1, op: "tunnel.open", tunnelId: "t1", port: 8976 })).toEqual({ id: 1, op: "tunnel.open", tunnelId: "t1", port: 8976 });
    expect(() => DaemonRequest.parse({ id: 1, op: "tunnel.open", tunnelId: "t1", port: 0 })).toThrow();
    expect(() => DaemonRequest.parse({ id: 1, op: "tunnel.open", tunnelId: "t1", port: 70000 })).toThrow();
    expect(DaemonRequest.parse({ id: 2, op: "tunnel.write", tunnelId: "t1", data: "aGk=" })).toEqual({ id: 2, op: "tunnel.write", tunnelId: "t1", data: "aGk=" });
    expect(DaemonRequest.parse({ id: 3, op: "tunnel.close", tunnelId: "t1" })).toEqual({ id: 3, op: "tunnel.close", tunnelId: "t1" });
    expect(DaemonEvent.parse({ type: "tunnel.data", tunnelId: "t1", data: "aGk=" })).toEqual({ type: "tunnel.data", tunnelId: "t1", data: "aGk=" });
    expect(DaemonEvent.parse({ type: "tunnel.end", tunnelId: "t1" })).toEqual({ type: "tunnel.end", tunnelId: "t1" });
  });

  it("isHttpUrl is the one rule: http or https in any case, nothing else, and browser.open follows it", () => {
    expect(isHttpUrl("HTTPS://EXAMPLE.COM/A")).toBe(true);
    expect(isHttpUrl("Http://x.test")).toBe(true);
    expect(isHttpUrl("https://github.com/login/device")).toBe(true);
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "smb://host/share", "\\\\host\\share", "ftp://x/y", "", 42, undefined, "httpss://x"]) {
      expect(isHttpUrl(bad)).toBe(false);
    }
    expect(DaemonEvent.parse({ type: "browser.open", url: "HTTPS://EXAMPLE.COM/A" })).toEqual({ type: "browser.open", url: "HTTPS://EXAMPLE.COM/A" });
  });

  it("isHttpUrl also caps the length and refuses whitespace and control characters, on every side", () => {
    const long = `https://x.test/${"a".repeat(HTTP_URL_MAX)}`;
    expect(isHttpUrl(long)).toBe(false);
    expect(isHttpUrl(`https://x.test/${"a".repeat(HTTP_URL_MAX - 15)}`)).toBe(true);
    for (const bad of ["https://x.test/a b", "https://x.test/a\nb", "https://x.test/\tq", "https://x.test/\x00", "https://x.test/\x7f", "https://x.test/a\r"]) {
      expect(isHttpUrl(bad)).toBe(false);
      expect(() => DaemonEvent.parse({ type: "browser.open", url: bad })).toThrow();
    }
    expect(HTTP_URL_RE.flags).toBe("i");
  });

  it("isHttpUrl also requires the URL to parse, so a hostname can always be read from it", () => {
    for (const bad of ["https://%", "https://[::1", "https://exa%mple.com/x"]) {
      expect(isHttpUrl(bad)).toBe(false);
      expect(() => DaemonEvent.parse({ type: "browser.open", url: bad })).toThrow();
    }
    expect(isHttpUrl("https://[::1]:8976/cb")).toBe(true);
  });

  it("hostOf reads the host (with its port, without userinfo) and returns undefined instead of throwing", () => {
    expect(hostOf("https://github.com/login/device")).toBe("github.com");
    expect(hostOf("https://github.com:8443/x")).toBe("github.com:8443");
    expect(hostOf("https://github.com@evil.example/login")).toBe("evil.example");
    expect(hostOf("https://[::1]:8976/cb")).toBe("[::1]:8976");
    for (const bad of ["https://%", "https://[::1", "not a url", ""]) expect(hostOf(bad)).toBeUndefined();
  });

  it("relay ports on the wire are integers in 1024..65535, on browser.open and callback.port alike", () => {
    for (const port of [1024, 8976, 65535]) {
      expect(DaemonEvent.parse({ type: "callback.port", port })).toEqual({ type: "callback.port", port });
      expect(DaemonEvent.parse({ type: "browser.open", url: "https://x.test/a", port })).toEqual({ type: "browser.open", url: "https://x.test/a", port });
    }
    for (const port of [70000, 65536, 1023, 80, 0, 1.5, -1]) {
      expect(() => DaemonEvent.parse({ type: "callback.port", port })).toThrow();
      expect(() => DaemonEvent.parse({ type: "browser.open", url: "https://x.test/a", port })).toThrow();
    }
  });

  it("a golden version may say it was sealed with the browser shim; older versions carry no flag", () => {
    const base = { version: 1, snapshotId: "s", baseTemplate: "base", setupSha: "x", createdAt: "2026-09-04T00:00:00Z", smoke: { cmd: "true", exitCode: 0 } };
    expect(GoldenVersion.parse(base)).toEqual(base);
    expect(GoldenVersion.parse({ ...base, browserShim: true })).toEqual({ ...base, browserShim: true });
    expect(() => GoldenVersion.parse({ ...base, browserShim: "yes" })).toThrow();
  });
});
