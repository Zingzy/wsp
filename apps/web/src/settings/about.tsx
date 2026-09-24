// SPDX-License-Identifier: AGPL-3.0-only
// Settings > About: the two halves of one release that can run apart, one
// line each, the newest release as the host last read it, the computers whose
// daemon is behind, and the road to the next release under them. A browser
// tab has no shell half and shows the host's line alone.
import { placeDaemonBehind, releaseWord, type ReleaseLatest, type ReleaseView } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { RELEASES } from "../../../../packages/wspx/scripts/bundles.mjs";
import { releaseAhead } from "../shell/shellVersion.js";
import { ABOUT_WORDS } from "./format.js";
import { builtWhen } from "./image.js";
import type { SettingsCardData, SettingsLineData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";

const releaseBehind = (ctx: SettingsContext): ReleaseLatest | undefined => releaseAhead(ctx.release, ctx.shell);

function latestHover(release: ReleaseView, now: number): string | undefined {
  if (release.state === "off") return ABOUT_WORDS.offHover;
  const missed = release.state === "unreached" && release.triedAt !== undefined ? builtWhen(release.triedAt, now) : undefined;
  if (release.latest === undefined || release.checkedAt === undefined) return missed === undefined ? undefined : ABOUT_WORDS.unreachedHover(missed);
  const when = ABOUT_WORDS.readWhen(now - Date.parse(release.checkedAt));
  return missed === undefined ? ABOUT_WORDS.readHover(when) : ABOUT_WORDS.missedHover(when, missed);
}

const openPage = (url: string): void => void window.open(url, "_blank", "noopener,noreferrer");

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
          {behind === undefined ? null : (
            <Button size="xs" variant="outline" data-k="get-release" onClick={() => openPage(behind.url)}>
              {ABOUT_WORDS.get(behind.version)}
            </Button>
          )}
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
