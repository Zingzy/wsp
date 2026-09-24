// SPDX-License-Identifier: AGPL-3.0-only
// The shell's road to a newer release. The page hands over a version and no
// URL: this builds the answer's and the download's URLs off the repo, reads
// the sha256 GitHub publishes for the asset, and keeps the bytes only where
// they match. Opening what was kept quits the app, since the running host
// serves the page and the daemon binaries out of the bundle by path.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { RELEASE_BODY_MAX_BYTES, RELEASE_TIMEOUT_MS, cappedText, releaseAssetUrl, releaseTagUrl } from "@wsp/host";
import type { BundleOutcome } from "@wsp/protocol";
import { RELEASE_TAG, bundleNames } from "../../../packages/wspx/scripts/bundles.mjs";

export const BUNDLE_WORDS = {
  notAVersion: "not a release version",
  noBundle: (platform: string): string => `no wsp bundle is built for ${platform}`,
  noDigest: (asset: string): string => `the release publishes no sha256 for ${asset}`,
  mismatch: (asset: string): string => `${asset} did not match the release's sha256 and was deleted`,
  unreached: (asset: string, why: string): string => `${asset} was not downloaded: ${why}`,
  nothingKept: "no verified download to open",
} as const;

type Env = Readonly<Record<string, string | undefined>>;

/** How long a download may go without a byte before it is given up, so a stalled connection never holds Downloading. */
export const BUNDLE_STALL_MS = 30_000;

/** What opens a kept bundle: the system's opener, which answers an empty string or its own reason, and the folder view. */
export interface BundleOpeners {
  open(file: string): Promise<string>;
  reveal(file: string): void;
}

/** One platform's bundle: which asset of a release it is, and what makes it the person's next step once kept. */
interface BundleRoad {
  asset(version: string): string;
  open(file: string, openers: BundleOpeners): Promise<string>;
}

const BUNDLE_ROADS: Partial<Record<NodeJS.Platform, BundleRoad>> = {
  // Mounting the disk image opens its drag window.
  darwin: { asset: version => bundleNames(version).mac, open: (file, o) => o.open(file) },
  linux: {
    asset: version => bundleNames(version).appImage,
    open: async (file, o) => {
      await chmod(file, 0o755);
      o.reveal(file);
      return "";
    },
  },
};

/** The version out of the page's ask, only where it is one the release workflow would tag. */
export function askedVersion(raw: unknown): string | undefined {
  const version = typeof raw === "object" && raw !== null ? (raw as { version?: unknown }).version : undefined;
  return typeof version === "string" && RELEASE_TAG.exec(`v${version}`)?.[1] === version ? version : undefined;
}

export interface BundleDeps {
  platform: NodeJS.Platform;
  /** Where the download lands: the person's Downloads folder. */
  dir: string;
  env: Env;
  userAgent: string;
  fetch: typeof fetch;
  stallMs?: number;
}

/** The hex sha256 GitHub publishes for this asset of the release, or nothing where it lists none. */
async function publishedSum(tag: string, asset: string, deps: BundleDeps): Promise<string | undefined> {
  const res = await deps.fetch(releaseTagUrl(deps.env, tag), { headers: { accept: "application/vnd.github+json", "user-agent": deps.userAgent }, signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const answer = JSON.parse(await cappedText(res, RELEASE_BODY_MAX_BYTES)) as { assets?: unknown };
  const row = Array.isArray(answer.assets) ? (answer.assets as unknown[]).find(a => (a as { name?: unknown } | null)?.name === asset) : undefined;
  const digest = (row as { digest?: unknown } | undefined)?.digest;
  return typeof digest === "string" ? /^sha256:([0-9a-f]{64})$/.exec(digest)?.[1] : undefined;
}

async function sumOf(file: string): Promise<string | undefined> {
  const hash = createHash("sha256");
  try {
    await pipeline(createReadStream(file), hash);
  } catch {
    return undefined;
  }
  return hash.digest("hex");
}

/** Streams the download beside its final name, hashing as it writes; renamed into place on a match, deleted otherwise. */
async function download(url: string, file: string, sum: string, asset: string, deps: BundleDeps): Promise<BundleOutcome> {
  const part = `${file}.part`;
  const hash = createHash("sha256");
  const stallMs = deps.stallMs ?? BUNDLE_STALL_MS;
  const stalled = new AbortController();
  let timer = setTimeout(() => stalled.abort(), stallMs);
  const tee = new Transform({
    transform(chunk: Buffer, _enc, done) {
      clearTimeout(timer);
      timer = setTimeout(() => stalled.abort(), stallMs);
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    const res = await deps.fetch(url, { headers: { "user-agent": deps.userAgent }, signal: stalled.signal });
    if (!res.ok || res.body === null) return { ok: false, error: BUNDLE_WORDS.unreached(asset, `GitHub answered ${res.status}`) };
    await pipeline(Readable.fromWeb(res.body as ReadableStream), tee, createWriteStream(part), { signal: stalled.signal });
  } catch (e) {
    await rm(part, { force: true });
    return { ok: false, error: BUNDLE_WORDS.unreached(asset, stalled.signal.aborted ? `no bytes for ${stallMs / 1000} s` : e instanceof Error ? e.message : String(e)) };
  } finally {
    clearTimeout(timer);
  }
  if (hash.digest("hex") !== sum) {
    await rm(part, { force: true });
    return { ok: false, error: BUNDLE_WORDS.mismatch(asset) };
  }
  await rename(part, file);
  return { ok: true };
}

/** This release's bundle for this platform in the download folder, verified against the published sha256. */
export async function getBundle(version: string, deps: BundleDeps): Promise<{ ok: true; file: string } | { ok: false; error: string }> {
  const road = BUNDLE_ROADS[deps.platform];
  if (road === undefined) return { ok: false, error: BUNDLE_WORDS.noBundle(deps.platform) };
  const tag = `v${version}`;
  const asset = road.asset(version);
  let sum: string | undefined;
  try {
    sum = await publishedSum(tag, asset, deps);
  } catch (e) {
    return { ok: false, error: BUNDLE_WORDS.unreached(asset, e instanceof Error ? e.message : String(e)) };
  }
  if (sum === undefined) return { ok: false, error: BUNDLE_WORDS.noDigest(asset) };
  const file = join(deps.dir, asset);
  if ((await sumOf(file)) === sum) return { ok: true, file };
  const got = await download(releaseAssetUrl(deps.env, tag, asset), file, sum, asset, deps);
  return got.ok ? { ok: true, file } : got;
}

/** Hands a kept bundle to the person's next step on its platform. */
export async function openBundle(kept: { file: string; platform: NodeJS.Platform }, openers: BundleOpeners): Promise<BundleOutcome> {
  const road = BUNDLE_ROADS[kept.platform];
  if (road === undefined) return { ok: false, error: BUNDLE_WORDS.noBundle(kept.platform) };
  const said = await road.open(kept.file, openers);
  return said === "" ? { ok: true } : { ok: false, error: said };
}

export interface BundleShell {
  get(raw: unknown): Promise<BundleOutcome>;
  open(): Promise<BundleOutcome>;
}

/** The two bridge channels' state: asks that overlap share one download, and open reaches only what a get kept. */
export function bundleShell(deps: BundleDeps & BundleOpeners & { quit(): void }): BundleShell {
  let kept: string | undefined;
  const getting = new Map<string, Promise<BundleOutcome>>();
  return {
    get: raw => {
      const version = askedVersion(raw);
      if (version === undefined) return Promise.resolve({ ok: false, error: BUNDLE_WORDS.notAVersion });
      const running = getting.get(version);
      if (running !== undefined) return running;
      kept = undefined;
      const asked = getBundle(version, deps)
        .then((got): BundleOutcome => {
          if (!got.ok) return got;
          kept = got.file;
          return { ok: true };
        })
        .finally(() => getting.delete(version));
      getting.set(version, asked);
      return asked;
    },
    open: async () => {
      if (kept === undefined) return { ok: false, error: BUNDLE_WORDS.nothingKept };
      const opened = await openBundle({ file: kept, platform: deps.platform }, deps);
      if (opened.ok) deps.quit();
      return opened;
    },
  };
}
