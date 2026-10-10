// SPDX-License-Identifier: AGPL-3.0-only
// Settings > General's Version card: the version this wsp runs, whether a
// newer release waits, and the road to it: in the app on its own host the shell
// downloads and opens it, or stages it and restarts into it where the app
// replaces itself, anywhere else Get is a link. Once newer files are
// installed under a running host, Restart host stands in Get's place. The app's
// half and the host's get a line each only once they run apart.
import type { ReleaseLatest, ReleaseView } from "@wsp/protocol";
import { Mark } from "../brand/Brand.js";
import { Button } from "../components/ui/button.js";
import { RELEASES } from "../../../../packages/protocol/src/bundles.mjs";
import { releaseAhead } from "../shell/shellVersion.js";
import { restartShown, runUpdate, useUpdateStage, type UpdateAct } from "../shell/update.js";
import { ABOUT_WORDS } from "./format.js";
import { GlyphFrame } from "./grid.js";
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

/** The Host line's hover: the files installed under the running host first, since the install already happened and
 * only its restart is left, then the line that installs the release while the host is behind it. */
function hostHover(release: ReleaseView | null): string {
  if (release?.installed !== undefined) return ABOUT_WORDS.hostInstalledHover(release.installed, release.restartRefusal ?? (restartShown(release) ? ABOUT_WORDS.restartRuns : ABOUT_WORDS.restartThere));
  if (release?.update !== undefined && release.latest !== undefined) return ABOUT_WORDS.hostUpdateHover(release.update, release.latest.version);
  return ABOUT_WORDS.hostHover;
}

const openPage = (url: string): void => void window.open(url, "_blank", "noopener,noreferrer");

const STEP_WORDS: Record<UpdateAct, (version: string) => string> = {
  link: ABOUT_WORDS.get,
  get: ABOUT_WORDS.get,
  downloading: () => ABOUT_WORDS.downloading,
  open: () => ABOUT_WORDS.quitAndOpen,
  restart: () => ABOUT_WORDS.restartToUpdate,
  "restart-host": () => ABOUT_WORDS.restartHost,
};

/** The step to the release this page is behind, the same act the sidebar's update card offers. */
function UpdateStep() {
  const { stage, road } = useUpdateStage();
  if (stage === undefined) return null;
  const { act, version } = stage;
  const title = act === "restart-host" ? ABOUT_WORDS.restartHover : act === "get" ? road?.bundleHover : undefined;
  return (
    <Button size="xs" variant="outline" data-k={act === "restart-host" ? "restart-host" : "get-release"} {...(title === undefined ? {} : { title })} disabled={act === "downloading"} onClick={() => runUpdate(stage, road)}>
      {STEP_WORDS[act](version)}
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
  const hover = release === null ? undefined : latestHover(release, ctx.now);
  const notes = release?.latest?.url ?? RELEASES;
  const step = restartShown(release) || behind !== undefined ? <UpdateStep /> : null;
  const row: SettingsItem[] = [
    {
      kind: "row",
      id: "version",
      title: ABOUT_WORDS.wsp,
      lead: (
        <GlyphFrame>
          <Mark className="size-4 text-foreground" />
        </GlyphFrame>
      ),
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
