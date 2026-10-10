// SPDX-License-Identifier: AGPL-3.0-only
// Where this wsp stands with a newer release, and the one act that moves it
// on, read by the sidebar's update card and General's Version card alike so the
// two never disagree. The shell's download is kept here rather than in either
// card, so a Get pressed on one shows Downloading on the other. On an app that
// replaces itself the download starts by itself, unless the person dismissed
// that release.
import { releaseAbove, type BundleOutcome, type DesktopBridge, type ReleaseView } from "@wsp/protocol";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { RELEASES } from "../../../../packages/protocol/src/bundles.mjs";
import { onAnotherComputer } from "../boot.js";
import { desktopBridge } from "../lib/desktopShell.js";
import { addNotice } from "../notices/store.js";
import { useStore } from "../protocol/store.js";
import { releaseAhead, shellVersions } from "./shellVersion.js";

export const UPDATE_WORDS = {
  out: (version: string): string => `wsp ${version} is out`,
  ready: (version: string): string => `wsp ${version} is ready`,
  whatsNew: "What's new",
  dismiss: "Dismiss",
  get: "Get",
  downloading: "Downloading",
  quitAndOpen: "Quit and open",
  restart: "Restart",
  keepRunning: (running: number): string => `${running === 1 ? "Your running thread carries" : `Your ${running} running threads carry`} on. Open terminals close.`,
  notReady: (version: string, said: string): string => `wsp ${version} was not downloaded: ${said}`,
  notRestarted: (said: string): string => `wsp did not restart: ${said}`,
};

/** The act a release waits on: its page, the shell's download, that download under way, opening what it kept (a
 * disk image, or a restart into the checked copy where the app replaces itself), or a restart of a host whose
 * installed files are already newer. */
export type UpdateAct = "link" | "get" | "downloading" | "open" | "restart" | "restart-host";

/** The version the act brings, the page that holds its notes, and the act. */
export interface UpdateStage {
  readonly version: string;
  readonly url: string;
  readonly act: UpdateAct;
}

/** Whether the release is on this computer already and only a restart or an open is left. */
export const updateReady = (act: UpdateAct): boolean => act === "open" || act === "restart" || act === "restart-host";

type Bundle = Pick<DesktopBridge, "getBundle" | "quitAndOpen" | "bundleHover" | "updatesInPlace"> & Partial<Pick<DesktopBridge, "discardUpdate">>;

interface Download {
  readonly version: string;
  readonly phase: "downloading" | "kept";
}

export const useUpdateDownload = create<{ download: Download | null }>(() => ({ download: null }));

/** Restart where the installed files are newer, a restart brings the host back, and the page is on the host's own
 * computer, since the host refuses a restart asked from anywhere else. */
export const restartShown = (release: ReleaseView | null): boolean => release?.installed !== undefined && release.restartRefusal === undefined && !onAnotherComputer();

/** The stage the release stands at, or nothing while this wsp is level with it. Newer files installed under the
 * host come first, since a restart is all they need. The shell's road counts only where the app itself is behind,
 * since a host that lags alone is updated its own way. */
export function updateStage(release: ReleaseView | null, versions: ReturnType<typeof shellVersions>, road: Bundle | undefined, download: Download | null): UpdateStage | undefined {
  if (release?.installed !== undefined && restartShown(release)) return { version: release.installed, url: release.latest?.url ?? RELEASES, act: "restart-host" };
  const latest = releaseAhead(release, versions);
  if (release === null || latest === undefined) return undefined;
  const at = { version: latest.version, url: latest.url };
  const appBehind = versions.inShell && versions.app !== undefined && releaseAbove(release, versions.app);
  if (!appBehind || road === undefined) return { ...at, act: "link" };
  if (download?.version !== latest.version) return { ...at, act: "get" };
  if (download.phase === "downloading") return { ...at, act: "downloading" };
  return { ...at, act: road.updatesInPlace === true ? "restart" : "open" };
}

/** The shell's bundle road where this page is the app's own host's, else nothing: a page a host somewhere else
 * serves, a browser tab and a shell from before the road all take the link form. */
export function useBundleRoad(): Bundle | undefined {
  const bridge = desktopBridge();
  const [here, setHere] = useState<boolean | undefined>(bridge?.hosts === undefined ? true : undefined);
  useEffect(() => {
    let live = true;
    bridge?.hosts?.().then(
      view => live && setHere(view.current === null),
      () => live && setHere(false),
    );
    return () => {
      live = false;
    };
  }, [bridge]);
  const { getBundle, quitAndOpen, discardUpdate, bundleHover, updatesInPlace } = bridge ?? {};
  return here === true && getBundle !== undefined && quitAndOpen !== undefined ? { getBundle, quitAndOpen, bundleHover, updatesInPlace, ...(discardUpdate === undefined ? {} : { discardUpdate }) } : undefined;
}

export function useUpdateStage(): { stage: UpdateStage | undefined; road: Bundle | undefined } {
  const release = useStore(s => s.release);
  const download = useUpdateDownload(s => s.download);
  const road = useBundleRoad();
  return { stage: updateStage(release, shellVersions(), road, download), road };
}

const said = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The shell's download of a release; a refusal puts Get back, and a new get fetches nothing where the kept copy
 * still matches. */
export function getUpdate(road: Bundle, version: string): void {
  useUpdateDownload.setState({ download: { version, phase: "downloading" } });
  const failed = (why: string): void => {
    useUpdateDownload.setState({ download: null });
    addNotice({ kind: "error", text: UPDATE_WORDS.notReady(version, why) });
  };
  void road.getBundle({ version }).then(
    (got: BundleOutcome) => {
      if (!got.ok) return failed(got.error);
      // Dismissed while it downloaded: the copy the shell just checked goes as a ready one's would.
      if (useUpdateDownload.getState().download?.version !== version) return void road.discardUpdate?.().catch(() => undefined);
      useUpdateDownload.setState({ download: { version, phase: "kept" } });
    },
    (e: unknown) => failed(said(e)),
  );
}

function openUpdate(road: Bundle): void {
  const failed = (why: string): void => {
    useUpdateDownload.setState({ download: null });
    addNotice({ kind: "error", text: road.updatesInPlace === true ? UPDATE_WORDS.notRestarted(why) : why });
  };
  void road.quitAndOpen().then(
    done => (done.ok ? undefined : failed(done.error)),
    (e: unknown) => failed(said(e)),
  );
}

const openPage = (url: string): void => void window.open(url, "_blank", "noopener,noreferrer");

/** The stage's act, pressed: Downloading presses nothing. */
export function runUpdate(stage: UpdateStage, road: Bundle | undefined): void {
  const { act, version, url } = stage;
  if (act === "restart-host") void useStore.getState().api?.hostRestart?.().catch((e: unknown) => addNotice({ kind: "error", text: UPDATE_WORDS.notRestarted(said(e)) }));
  else if (act === "link" || road === undefined) openPage(url);
  else if (act === "get") getUpdate(road, version);
  else if (act === "open" || act === "restart") openUpdate(road);
}

export const openReleasePage = (stage: UpdateStage): void => openPage(stage.url);

/** The person is done with this release: no window shows its card again, and a copy the shell checked is deleted. */
export function dismissUpdate(stage: UpdateStage, road: Bundle | undefined): void {
  void useStore.getState().setPreferences({ updateDismissed: stage.version });
  if (road?.updatesInPlace !== true || (stage.act !== "restart" && stage.act !== "downloading")) return;
  useUpdateDownload.setState({ download: null });
  if (stage.act === "restart") void road.discardUpdate?.().catch(() => undefined);
}

/** The release the person dismissed, or null until the host's record is read, since the host answers the release
 * first and the first paint's record would show and download a dismissed one. */
export const useDismissed = (): string | undefined | null => useStore(s => (s.preferencesRead ? s.preferences.updateDismissed : null));

/** Mounted once under the store: on an app that replaces itself, a release it is behind is downloaded and checked
 * in the background, once per page and release, so the card can offer Restart. */
export function useUpdateInBackground(): void {
  const { stage, road } = useUpdateStage();
  const dismissed = useDismissed();
  const asked = useRef(new Set<string>());
  const version = stage?.act === "get" && road?.updatesInPlace === true ? stage.version : undefined;
  useEffect(() => {
    if (version === undefined || road === undefined || dismissed === null || version === dismissed || asked.current.has(version)) return;
    asked.current.add(version);
    getUpdate(road, version);
  }, [version, road, dismissed]);
}
