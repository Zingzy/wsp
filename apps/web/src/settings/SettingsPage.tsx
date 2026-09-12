// SPDX-License-Identifier: AGPL-3.0-only
// The settings page in the centre: one column of sections in the app's
// grammar, a caps mono zone label over each, then one hairline-separated row
// per pick with its label at the left and its control at the right edge. The
// control's own label is the explanation: no sentence under any pick. Every
// pick goes to the host's preferences record and paints at once, so a browser
// tab on the same host follows. About is the one section that takes no pick:
// it names the release each half of the app is on.
import { SidebarMode, TerminalSizeSource, ThemePreference, fmtPx, type TerminalConfig } from "@wsp/protocol";
import { useEffect, useState, type ReactNode } from "react";
import { SIDEBAR_MODE_WORDS } from "../actions/format.js";
import { Button } from "../components/ui/button.js";
import { NumberField, NumberFieldDecrement, NumberFieldGroup, NumberFieldIncrement, NumberFieldInput } from "../components/ui/number-field.js";
import { ScrollArea } from "../components/ui/scroll-area.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { cn } from "../lib/utils.js";
import { usePreferences, useStore } from "../protocol/store.js";
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "../shell/sidebarWidth.js";
import { appTerminalFontSize } from "../terminal/ghostty/surface.js";
import { appScheme } from "../terminal/ghosttyConfig.js";
import { shellVersions } from "../shell/shellVersion.js";
import { SETTINGS_WORDS, TERMINAL_SIZE_FACT, TERMINAL_SIZE_WORDS, THEME_WORDS, versionFact } from "./format.js";
import { WhereAgentsRun } from "./WhereAgentsRun.js";

const ZONE_LABEL = "font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground";
const FACT = "font-mono text-[11px] tabular-nums text-muted-foreground";

const THEMES = ThemePreference.options.map(theme => ({ value: theme, label: THEME_WORDS[theme] }));
const BODIES = SidebarMode.options.map(mode => ({ value: mode, label: SIDEBAR_MODE_WORDS[mode].name }));
const SIZES = TerminalSizeSource.options.map(source => ({ value: source, label: TERMINAL_SIZE_WORDS[source] }));

export function SettingsPage() {
  const preferences = usePreferences();
  const setPreferences = useStore(s => s.setPreferences);
  const readHostConfig = useStore(s => s.api?.hostTerminalConfig);
  const [file, setFile] = useState<TerminalConfig | null>(null);
  const versions = shellVersions();
  // The file's size is a fact the host already reads for the pane; the page shows it beside the pick that would use it.
  useEffect(() => {
    if (readHostConfig === undefined) return;
    let live = true;
    void readHostConfig(appScheme())
      .then(config => {
        if (live) setFile(config);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [readHostConfig]);
  const width = preferences.sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH;
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div data-settings-page className="mx-auto flex w-full max-w-[672px] flex-col gap-8 px-6 py-6">
        <Section id="settings-appearance" title={SETTINGS_WORDS.appearance}>
          <Row id="settings-theme" label={SETTINGS_WORDS.theme}>
            <SegmentedControl aria-labelledby="settings-theme" value={preferences.theme} segments={THEMES} onChange={theme => void setPreferences({ theme })} />
          </Row>
          <Row id="settings-sidebar" label={SETTINGS_WORDS.sidebar}>
            <SegmentedControl aria-labelledby="settings-sidebar" value={preferences.sidebarMode} segments={BODIES} onChange={sidebarMode => void setPreferences({ sidebarMode })} />
          </Row>
          <Row id="settings-sidebar-width" label={SETTINGS_WORDS.sidebarWidth}>
            {preferences.sidebarWidth === undefined ? null : (
              <Button size="xs" variant="ghost-muted" onClick={() => void setPreferences({ sidebarWidth: null })}>
                {SETTINGS_WORDS.reset}
              </Button>
            )}
            <NumberField
              aria-labelledby="settings-sidebar-width"
              className="w-auto"
              size="sm"
              min={SIDEBAR_MIN_WIDTH}
              max={SIDEBAR_MAX_WIDTH}
              step={8}
              value={width}
              onValueChange={value => {
                // Held to the drag's bounds before the host hears it, since every keystroke lands here; the field's own
                // clamp on blur then repeats the value, which is not sent twice.
                if (value === null || !Number.isFinite(value)) return;
                const sidebarWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
                if (sidebarWidth !== width) void setPreferences({ sidebarWidth });
              }}
            >
              <NumberFieldGroup className="w-auto">
                <NumberFieldDecrement aria-label="Narrower" />
                <NumberFieldInput data-k="sidebar-width" aria-label={SETTINGS_WORDS.sidebarWidth} className="w-14 font-mono text-[11px]" />
                <NumberFieldIncrement aria-label="Wider" />
              </NumberFieldGroup>
            </NumberField>
          </Row>
        </Section>
        <Section id="settings-terminal" title={SETTINGS_WORDS.terminal}>
          <Row id="settings-text-size" label={SETTINGS_WORDS.textSize}>
            <span className={FACT} data-k="terminal-size">
              {TERMINAL_SIZE_FACT[preferences.terminalSize](appTerminalFontSize(), file?.fontSize)}
            </span>
            <SegmentedControl aria-labelledby="settings-text-size" value={preferences.terminalSize} segments={SIZES} onChange={terminalSize => void setPreferences({ terminalSize })} />
          </Row>
        </Section>
        <WhereAgentsRun />
        <Section id="settings-about" title={SETTINGS_WORDS.about}>
          <Row id="settings-version" label={SETTINGS_WORDS.version}>
            {/* A row with no control still stands as tall as one, so the rhythm down the column never breaks. */}
            <span className={cn(FACT, "flex h-7 items-center")} data-k="version">
              {versionFact(versions.app, versions.host, versions.inShell)}
            </span>
          </Row>
        </Section>
      </div>
    </ScrollArea>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className={ZONE_LABEL}>
        {title}
      </h2>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

/** One pick: its label at the left, its control and the fact beside it at the right edge, a hairline under it. The
 * row is one height by the control's; in a column too narrow for both the control drops under the label, still at
 * the right edge, so the page never scrolls sideways and no word is cut. */
function Row({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-11 flex-wrap items-center justify-end gap-x-3 gap-y-1 border-b border-border/60 py-2 last:border-transparent" data-settings-row>
      <span id={id} className="flex-1 text-sm text-foreground">
        {label}
      </span>
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </div>
  );
}
