// SPDX-License-Identifier: AGPL-3.0-only
// The tool server in the daemon binary dialling a host somewhere else, against
// the runtime's own door rather than a Rust twin of it: node proves its key at
// seal.open and seals every frame after, and a host on the account admits a
// computer on its device key. So the binary's handshake, its seal and its
// admission are held to the bytes the TypeScript host writes and reads.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyFingerprint, newPlaceKeyPair, signPlaceBytes, type PlaceKeyPair } from "@wsp/keys";
import { deviceAdmissionTranscript, EXIT_CODES, pairKeyRefusal, type AccountDevice } from "@wsp/protocol";
import { createRuntime, memoryStore, serveRuntime, type AdmittedDevices, type Runtime, type RuntimeServer } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceKeyPath } from "../src/account.js";
import { readHost, writeHost } from "../src/hosts.js";
import { mcpBinNamed, ownEnv, served } from "./stdio-session.js";
import { stubBackend } from "./stub-backend.js";

const MCP_BIN = mcpBinNamed(process.env["WSP_MCP_BIN"]);
const suite = MCP_BIN !== undefined ? describe : describe.skip;

const HOST_KEY = newPlaceKeyPair();
const SIGNER = newPlaceKeyPair();
const DEVICE = newPlaceKeyPair();
const ALIAS = "attic";

/** The account as this host reads it: the key it trusts to sign an admission, and one computer that key admitted. */
const account = (device: PlaceKeyPair): AdmittedDevices => {
  const fingerprint = keyFingerprint(device.publicKey);
  const by = keyFingerprint(SIGNER.publicKey);
  const issuedAt = "2026-09-28T00:00:00.000Z";
  const listed: AccountDevice = { id: "c_laptop", name: "the laptop", fingerprint, admissions: [{ by, issuedAt, signature: signPlaceBytes(SIGNER.privateKeyPem, deviceAdmissionTranscript(fingerprint, by, issuedAt)) }] };
  return { signer: () => ({ fingerprint: by, publicKey: SIGNER.publicKey }), list: () => [listed], refresh: async () => {} };
};

suite(`the tool server in the daemon binary against a host that proves its key${MCP_BIN === undefined ? " (set WSP_MCP_BIN)" : ""}`, () => {
  let dir: string;
  let home: string;
  let runtime: Runtime;
  let srv: RuntimeServer | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-mcp-seal-"));
    home = join(dir, "home");
  });
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  async function hostServing(admitted?: AdmittedDevices): Promise<string> {
    runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, placeLinks: { hostKey: HOST_KEY, provider: () => undefined, here: () => ({ name: "this-mac" }), hostName: () => "this-mac" } });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices, ...(admitted !== undefined ? { admitted } : {}) });
    return `http://127.0.0.1:${srv.port}`;
  }

  /** The record `wsp hosts` writes for that host, pinned to `pinned`, and this computer's device key beside it. */
  function holding(url: string, token: string, pinned: PlaceKeyPair = HOST_KEY): void {
    writeHost(home, ALIAS, { url, deviceId: token === "" ? "" : "d-held", deviceToken: token, hostKey: keyFingerprint(pinned.publicKey), pairedAt: "2026-09-28T00:00:00.000Z", via: { kind: "account", hostId: "h-attic" } });
    writeFileSync(deviceKeyPath(home), JSON.stringify(DEVICE));
  }

  async function threads(): Promise<{ structuredContent: Record<string, unknown>; isError?: boolean }> {
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "threads", arguments: {} } };
    const { out, code } = await served([MCP_BIN!, "mcp", "--state", join(dir, "state.json"), "--host", ALIAS], { ...ownEnv(), WSP_HOME: home }, [call]);
    expect(code).toBe(0);
    return (JSON.parse(out[0]!) as { result: { structuredContent: Record<string, unknown>; isError?: boolean } }).result;
  }

  it("holds the host to its key, seals the road and answers on the token a code bought there", async () => {
    const url = await hostServing();
    const { code } = await runtime.devices.issue({ now: Date.now(), ttlMs: 60_000 });
    const paired = await runtime.devices.redeem(code, "the laptop", Date.now());
    holding(url, paired!.deviceToken);
    const result = await threads();
    expect(result.isError, JSON.stringify(result)).toBeUndefined();
    expect(result.structuredContent).toEqual({ threads: [] });
  });

  it("admits a computer the account lists on its device key and writes the token that host answers into the record", async () => {
    const url = await hostServing(account(DEVICE));
    holding(url, "");
    const result = await threads();
    expect(result.isError, JSON.stringify(result)).toBeUndefined();
    const kept = readHost(home, ALIAS)!;
    expect(kept.deviceToken).not.toBe("");
    expect(await srv!.authorize(kept.deviceToken)).toMatchObject({ kind: "device", device: { id: kept.deviceId } });
    const [device] = await runtime.devices.list();
    expect(device).toMatchObject({ via: { kind: "account", fingerprint: keyFingerprint(DEVICE.publicKey) } });
  });

  it("refuses a host that proves a key other than the one pinned, in the auth class, before the token crosses", async () => {
    const url = await hostServing();
    holding(url, "a-token-it-never-sees", newPlaceKeyPair());
    const result = await threads();
    expect(result).toMatchObject({ isError: true, structuredContent: { error: pairKeyRefusal(url), class: "auth", exit: EXIT_CODES.auth } });
    expect(await runtime.devices.list()).toEqual([]);
  });
});
