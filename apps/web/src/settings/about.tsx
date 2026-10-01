// SPDX-License-Identifier: AGPL-3.0-only
// Settings > General's Version card: the version this wsp runs, whether a
// newer release waits, and the road to it: in the app on its own host the shell
// downloads and opens it, anywhere else Get is a link. Once newer files are
// installed under a running host, Restart host stands in Get's place. The app's
// half and the host's get a line each only once they run apart.
import { placeDaemonBehind, releaseAbove, type BundleOutcome, type DesktopBridge, type ReleaseLatest, type ReleaseView } from "@wsp/protocol";
import { useEffect, useState } from "react";
import { onAnotherComputer } from "../boot.js";
import { Button } from "../components/ui/button.js";
import { desktopBridge } from "../lib/desktopShell.js";
import { RELEASES } from "../../../../packages/wspx/scripts/bundles.mjs";
import { releaseAhead } from "../shell/shellVersion.js";
import { ABOUT_WORDS } from "./format.js";
import { builtWhen } from "./image.js";
import type { SettingsCardData, SettingsItem } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";

const releaseBehind = (ctx: SettingsContext): ReleaseLatest | undefined => releaseAhead(ctx.release, ctx.shell);

function latestHover(release: ReleaseView, now: number): string | undefined {
  if (release.state === "off") return ABOUT_WORDS.offHover;
  const missed = release.state === "unreached" && release.triedAt !== undefined ? builtWhen(release.triedAt, now) : undefined;
  if (release.latest === undefined || release.checkedAt === undefined) return missed === undefined ? undefined : ABOUT_WORDS.unreachedHover(missed);
  const when = ABOUT_WORDS.readWhen(now - Date.parse(release.checkedAt));
  return missed === undefined ? ABOUT_WORDS.readHover(when) : ABOUT_WORDS.missedHover(when, missed);
}

/** Restart where the installed files are newer, a restart brings the host back, and the page is on the host's own
 * computer, since the host refuses a restart asked from anywhere else. */
const restartShown = (release: ReleaseView | null): boolean => release?.installed !== undefined && release.restartRefusal === undefined && !onAnotherComputer();

/** The Host line's hover: the files installed under the running host first, since the install already happened and
 * only its restart is left, then the line that installs the release while the host is behind it. */
function hostHover(release: ReleaseView | null): string {
  if (release?.installed !== undefined) return ABOUT_WORDS.hostInstalledHover(release.installed, release.restartRefusal ?? (restartShown(release) ? ABOUT_WORDS.restartRuns : ABOUT_WORDS.restartThere));
  if (release?.update !== undefined && release.latest !== undefined) return ABOUT_WORDS.hostUpdateHover(release.update, release.latest.version);
  return ABOUT_WORDS.hostHover;
}

const openPage = (url: string): void => void window.open(url, "_blank", "noopener,noreferrer");

type Bundle = Pick<DesktopBridge, "getBundle" | "quitAndOpen" | "bundleHover">;

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
  const { getBundle, quitAndOpen, bundleHover } = bridge ?? {};
  return here === true && getBundle !== undefined && quitAndOpen !== undefined ? { getBundle, quitAndOpen, bundleHover } : undefined;
}

/** Get while this page is behind: the shell's download only where the app itself is behind, since a host that lags
 * alone is updated its own way and the app already installed is no update for it; the link to the release anywhere
 * else. */
function GetRelease({ latest, appBehind, failed }: { latest: ReleaseLatest; appBehind: boolean; failed: (e: unknown) => void }) {
  const shellRoad = useBundleRoad();
  const road = appBehind ? shellRoad : undefined;
  const [phase, setPhase] = useState<"get" | "downloading" | "kept">("get");
  // A refused get or open puts Get back: a new get fetches nothing where the kept file still matches.
  const answered = (asked: Promise<BundleOutcome>): void =>
    void asked.then(
      outcome => {
        if (!outcome.ok) failed(outcome.error);
        setPhase(outcome.ok ? "kept" : "get");
      },
      (e: unknown) => {
        failed(e);
        setPhase("get");
      },
    );
  if (road === undefined)
    return (
      <Button size="xs" variant="outline" data-k="get-release" onClick={() => openPage(latest.url)}>
        {ABOUT_WORDS.get(latest.version)}
      </Button>
    );
  if (phase === "kept")
    return (
      <Button size="xs" variant="outline" data-k="get-release" onClick={() => answered(road.quitAndOpen())}>
        {ABOUT_WORDS.quitAndOpen}
      </Button>
    );
  const get = (): void => {
    setPhase("downloading");
    answered(road.getBundle({ version: latest.version }));
  };
  return (
    <Button size="xs" variant="outline" data-k="get-release" title={road.bundleHover} disabled={phase === "downloading"} onClick={get}>
      {phase === "downloading" ? ABOUT_WORDS.downloading : ABOUT_WORDS.get(latest.version)}
    </Button>
  );
}

/** The line under the version: whether a newer release waits, as the host last read it. */
function stateLine(release: ReleaseView | null, behind: ReleaseLatest | undefined): string {
  if (behind !== undefined) return ABOUT_WORDS.available(behind.version);
  if (release === null || release.state === "checking") return ABOUT_WORDS.checking;
  if (release.state === "off") return ABOUT_WORDS.checksOff;
  return release.latest === undefined ? ABOUT_WORDS.notChecked : ABOUT_WORDS.upToDate;
}

/** General's Version card: the one number while the two halves agree, the step to the next release where there is
 * one, and the release's notes a click away. */
export function versionCards(ctx: SettingsContext): SettingsCardData[] {
  const { inShell, app, host } = ctx.shell;
  const { release } = ctx;
  const behind = releaseBehind(ctx);
  const apart = inShell && app !== undefined && host !== undefined && app !== host;
  const late = ctx.places.filter(place => placeDaemonBehind(place) !== undefined).map(place => place.name);
  const hover = release === null ? undefined : latestHover(release, ctx.now);
  const notes = release?.latest?.url ?? RELEASES;
  const step = restartShown(release) ? (
    <Button size="xs" variant="outline" data-k="restart-host" title={ABOUT_WORDS.restartHover} onClick={() => void ctx.api?.hostRestart?.().catch(ctx.failed)}>
      {ABOUT_WORDS.restartHost}
    </Button>
  ) : behind === undefined ? null : (
    <GetRelease key={behind.version} latest={behind} appBehind={inShell && app !== undefined && release !== null && releaseAbove(release, app)} failed={ctx.failed} />
  );
  const row: SettingsItem[] = [
    {
      kind: "row",
      id: "version",
      title: ABOUT_WORDS.wsp,
      mark: host ?? app ?? ABOUT_WORDS.unknown,
      description: stateLine(release, behind),
      ...(step === null ? {} : { control: step }),
      attrs: { "data-k": "version" },
    },
  ];
  const lines: SettingsItem[] = [
    ...(apart
      ? [
          { kind: "line" as const, id: "app-version", label: ABOUT_WORDS.app, value: app, hover: ABOUT_WORDS.appHover, attrs: { "data-k": "app-version" } },
          { kind: "line" as const, id: "host-version", label: ABOUT_WORDS.host, value: host, hover: hostHover(release), attrs: { "data-k": "host-version" } },
        ]
      : []),
    ...(late.length === 0 ? [] : [{ kind: "line" as const, id: "computers-behind", label: ABOUT_WORDS.computersBehind, value: String(late.length), valueClass: "fact" as const, hover: ABOUT_WORDS.behindHover(late), attrs: { "data-k": "computers-behind" } }]),
  ];
  const whatsNew = (
    <Button size="xs" variant="outline" data-k="whats-new" {...(hover === undefined ? {} : { title: hover })} onClick={() => openPage(notes)}>
      {ABOUT_WORDS.whatsNew}
    </Button>
  );
  // A card holds rows or lines, never both: the parts that run apart stand in a card of their own under the version.
  return [{ id: "version", head: ABOUT_WORDS.title, items: row, ...(lines.length === 0 ? { under: whatsNew } : {}) }, ...(lines.length === 0 ? [] : [{ id: "version-parts", items: lines, under: whatsNew }])];
}

/** General's one word in the settings sidebar: the newer version while this wsp is behind it. */
export const versionMeta = (ctx: SettingsContext): string | undefined => releaseBehind(ctx)?.version;
