// SPDX-License-Identifier: AGPL-3.0-only
// The newest release as the host last read it off GitHub, and what the host
// reads about itself beside it. The host asks, not the page, so every window,
// tab, phone and command line reads one view.
import { z } from "zod";
import { compareVersions } from "./semver.mjs";

/** One published release: its number, the tag that carries it, the page that holds its notes and downloads. */
export const ReleaseLatest = z.object({ version: z.string(), tag: z.string(), url: z.string(), publishedAt: z.string() });
export type ReleaseLatest = z.infer<typeof ReleaseLatest>;

/** `checking` until this host's first ask since it started has answered, `read` after an answer, `unreached` after
 * an ask that failed, `off` under the switch. */
export const ReleaseState = z.enum(["checking", "read", "unreached", "off"]);
export type ReleaseState = z.infer<typeof ReleaseState>;

/** How this host came up, which decides whether a restart brings it back: the desktop app's own, or one of the three
 * roads the lock records. */
export const HostShape = z.enum(["app", "verb", "up", "service"]);
export type HostShape = z.infer<typeof HostShape>;

/** `latest` stands whenever the host ever read one, whatever the last ask did, and is absent under `off`, so a person
 * who turned checks off is offered nothing off a stale number. `checkedAt` is the last answer, `triedAt` the last ask.
 * `installed` is the version the files this host was started from carry now, present only once it differs from the
 * running one, which is what a reinstall under a running host looks like. */
export const ReleaseView = z.object({
  state: ReleaseState,
  latest: ReleaseLatest.optional(),
  checkedAt: z.string().optional(),
  triedAt: z.string().optional(),
  installed: z.string().optional(),
  shape: HostShape,
  restartReturns: z.boolean(),
});
export type ReleaseView = z.infer<typeof ReleaseView>;

/** The host's reading changed; every socket gets the whole view. */
export const ReleaseChangedEvent = z.object({ type: z.literal("release.changed"), release: ReleaseView });
export type ReleaseChangedEvent = z.infer<typeof ReleaseChangedEvent>;

/** Whether the newest release is above any of the versions that run, the app's and the host's: a build ahead of it,
 * a prerelease or a checkout's, reads level. */
export const releaseAbove = (view: Pick<ReleaseView, "latest">, ...running: string[]): boolean => view.latest !== undefined && running.some(version => compareVersions(view.latest!.version, version) > 0);

/** The one word a reading says wherever it is shown: the number whenever one was read, else the state. */
export const releaseWord = (view: Pick<ReleaseView, "state" | "latest">): string => view.latest?.version ?? view.state;
