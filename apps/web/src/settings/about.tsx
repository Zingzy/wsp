// SPDX-License-Identifier: AGPL-3.0-only
// Settings > About: the two halves of one release that can run apart, one
// line each, the newest release as the host last read it, the computers whose
// daemon is behind, and the road to the next release under them: in the app
// on its own host the shell downloads and opens it, anywhere else Get is a
// link. A browser tab has no shell half and shows the host's line alone.
import { placeDaemonBehind, releaseAbove, releaseWord, type BundleOutcome, type DesktopBridge, type ReleaseLatest, type ReleaseView } from "@wsp/protocol";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button.js";
import { desktopBridge } from "../lib/desktopShell.js";
import { isMacPlatform } from "../lib/utils.js";
import { RELEASES } from "../../../../packages/wspx/scripts/bundles.mjs";
import { ABOUT_WORDS } from "./format.js";
import { builtWhen } from "./image.js";
import type { SettingsCardData, SettingsLineData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";

/** The release this page's app or host is behind, or nothing: what the Latest ink, the buttons and the sidebar's
 * word all read, so the three cannot disagree. */
function releaseBehind(ctx: SettingsContext): ReleaseLatest | undefined {
  const { release, shell } = ctx;
  if (release === null) return undefined;
  const running = [shell.host, shell.inShell ? shell.app : undefined].filter((version): version is string => version !== undefined);
  return releaseAbove(release, ...running) ? release.latest : undefined;
}

function latestHover(release: ReleaseView, now: number): string | undefined {
  if (release.state === "off") return ABOUT_WORDS.offHover;
  const missed = release.state === "unreached" && release.triedAt !== undefined ? builtWhen(release.triedAt, now) : undefined;
  if (release.latest === undefined || release.checkedAt === undefined) return missed === undefined ? undefined : ABOUT_WORDS.unreachedHover(missed);
  const when = ABOUT_WORDS.readWhen(now - Date.parse(release.checkedAt));
  return missed === undefined ? ABOUT_WORDS.readHover(when) : ABOUT_WORDS.missedHover(when, missed);
}

const openPage = (url: string): void => void window.open(url, "_blank", "noopener,noreferrer");

type Bundle = Pick<DesktopBridge, "getBundle" | "quitAndOpen">;

/** The shell's bundle road where this page is the app's own host's, else nothing: a page a host somewhere else
 * serves, a browser tab and a shell from before the road all take the link form. */
function useBundleRoad(): Bundle | undefined {
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
  const { getBundle, quitAndOpen } = bridge ?? {};
  return here === true && getBundle !== undefined && quitAndOpen !== undefined ? { getBundle, quitAndOpen } : undefined;
}

function GetRelease({ latest, mac, failed }: { latest: ReleaseLatest; mac: boolean; failed: (e: unknown) => void }) {
  const road = useBundleRoad();
  const [phase, setPhase] = useState<"get" | "downloading" | "kept">("get");
  const said = (outcome: BundleOutcome): boolean => {
    if (!outcome.ok) failed(outcome.error);
    return outcome.ok;
  };
  if (road === undefined)
    return (
      <Button size="xs" variant="outline" data-k="get-release" onClick={() => openPage(latest.url)}>
        {ABOUT_WORDS.get(latest.version)}
      </Button>
    );
  if (phase === "kept")
    return (
      <Button size="xs" variant="outline" data-k="get-release" onClick={() => void road.quitAndOpen().then(said, failed)}>
        {ABOUT_WORDS.quitAndOpen}
      </Button>
    );
  const get = (): void => {
    setPhase("downloading");
    road.getBundle({ version: latest.version }).then(
      outcome => setPhase(said(outcome) ? "kept" : "get"),
      (e: unknown) => {
        failed(e);
        setPhase("get");
      },
    );
  };
  return (
    <Button size="xs" variant="outline" data-k="get-release" title={ABOUT_WORDS.getHover(mac)} disabled={phase === "downloading"} onClick={get}>
      {phase === "downloading" ? ABOUT_WORDS.downloading : ABOUT_WORDS.get(latest.version)}
    </Button>
  );
}

export function aboutCards(ctx: SettingsContext): SettingsCardData[] {
  const { inShell, app, host } = ctx.shell;
  const { release } = ctx;
  const behind = releaseBehind(ctx);
  const late = ctx.places.filter(place => placeDaemonBehind(place) !== undefined).map(place => place.name);
  const hover = release === null ? undefined : latestHover(release, ctx.now);
  const lines: SettingsLineData[] = [
    ...(inShell ? [{ kind: "line" as const, id: "app-version", label: ABOUT_WORDS.app, value: app ?? ABOUT_WORDS.unknown, hover: ABOUT_WORDS.appHover, attrs: { "data-k": "app-version" } }] : []),
    { kind: "line", id: "host-version", label: ABOUT_WORDS.host, value: host ?? ABOUT_WORDS.unknown, hover: ABOUT_WORDS.hostHover, attrs: { "data-k": "host-version" } },
    ...(release === null ? [] : [{ kind: "line" as const, id: "latest-version", label: ABOUT_WORDS.latest, value: releaseWord(release), valueClass: behind === undefined ? ("fact" as const) : ("value" as const), ...(hover === undefined ? {} : { hover }), attrs: { "data-k": "latest-version" } }]),
    ...(late.length === 0 ? [] : [{ kind: "line" as const, id: "computers-behind", label: ABOUT_WORDS.computersBehind, value: String(late.length), valueClass: "fact" as const, hover: ABOUT_WORDS.behindHover(late), attrs: { "data-k": "computers-behind" } }]),
  ];
  return [
    {
      id: "about",
      items: lines,
      under: (
        <>
          {behind === undefined ? null : <GetRelease key={behind.version} latest={behind} mac={isMacPlatform(ctx.platform)} failed={ctx.failed} />}
          <Button size="xs" variant="outline" data-k="releases" onClick={() => openPage(RELEASES)}>
            {ABOUT_WORDS.releases}
          </Button>
        </>
      ),
    },
  ];
}

/** The About row's one word in the settings sidebar: the newer version while this page is behind it. */
export const aboutMeta = (ctx: SettingsContext): string | undefined => releaseBehind(ctx)?.version;
