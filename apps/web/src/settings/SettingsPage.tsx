// SPDX-License-Identifier: AGPL-3.0-only
// The settings page in the centre: one column of sections in the app's
// grammar, a zone label over each, a sentence-case label over each pick, the
// choices as radio rows of one height with a fact in the muted mono voice
// where a choice has one. Every pick goes to the host's preferences record
// and paints at once, so a browser tab on the same host follows.
import { SidebarMode, TerminalSizeSource, ThemePreference, fmtPx, type TerminalConfig } from "@wsp/protocol";
import { useEffect, useState, type ReactNode } from "react";
import { SIDEBAR_MODE_WORDS } from "../actions/format.js";
import { Button } from "../components/ui/button.js";
import { Label } from "../components/ui/label.js";
import { Radio, RadioGroup } from "../components/ui/radio-group.js";
import { ScrollArea } from "../components/ui/scroll-area.js";
import { usePreferences, useStore } from "../protocol/store.js";
import { appTerminalFontSize } from "../terminal/ghostty/surface.js";
import { appScheme } from "../terminal/ghosttyConfig.js";
import { SETTINGS_WORDS, TERMINAL_SIZE_FACT, TERMINAL_SIZE_WORDS, THEME_WORDS } from "./format.js";

const ZONE_LABEL = "font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground";
const FACT = "font-mono text-[11px] tabular-nums text-muted-foreground";

export function SettingsPage() {
  const preferences = usePreferences();
  const setPreferences = useStore(s => s.setPreferences);
  const readHostConfig = useStore(s => s.api?.hostTerminalConfig);
  const [file, setFile] = useState<TerminalConfig | null>(null);
  // The file's size is a fact the host already reads for the pane; the page shows it beside the choice that would use it.
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
  const appPx = appTerminalFontSize();
  const pick =
    <T extends string>(parse: (value: string) => T | undefined, apply: (value: T) => void) =>
    (value: unknown): void => {
      const parsed = typeof value === "string" ? parse(value) : undefined;
      if (parsed !== undefined) apply(parsed);
    };
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div data-settings-page className="mx-auto flex w-full max-w-xl flex-col gap-8 px-6 py-6">
        <Section id="settings-appearance" title={SETTINGS_WORDS.appearance}>
          <Field id="settings-theme" label={SETTINGS_WORDS.theme}>
            <RadioGroup aria-labelledby="settings-theme" className="gap-0" value={preferences.theme} onValueChange={pick(v => ThemePreference.safeParse(v).data, theme => void setPreferences({ theme }))}>
              {ThemePreference.options.map(theme => (
                <Choice key={theme} value={theme} title={THEME_WORDS[theme].title} detail={THEME_WORDS[theme].detail} />
              ))}
            </RadioGroup>
          </Field>
          <Field id="settings-sidebar" label={SETTINGS_WORDS.sidebar}>
            <RadioGroup aria-labelledby="settings-sidebar" className="gap-0" value={preferences.sidebarMode} onValueChange={pick(v => SidebarMode.safeParse(v).data, sidebarMode => void setPreferences({ sidebarMode }))}>
              {SidebarMode.options.map(mode => (
                <Choice key={mode} value={mode} title={SIDEBAR_MODE_WORDS[mode].name} detail={SIDEBAR_MODE_WORDS[mode].hint} />
              ))}
            </RadioGroup>
          </Field>
          <Field id="settings-sidebar-width" label={SETTINGS_WORDS.sidebarWidth}>
            <div className="flex h-9 items-center gap-2.5 text-sm" data-settings-row>
              <span className={FACT} data-k="sidebar-width">
                {preferences.sidebarWidth === undefined ? SETTINGS_WORDS.sidebarWidthDefault : fmtPx(preferences.sidebarWidth)}
              </span>
              <Button size="xs" variant="ghost-muted" className="ml-auto" disabled={preferences.sidebarWidth === undefined} onClick={() => void setPreferences({ sidebarWidth: null })}>
                {SETTINGS_WORDS.reset}
              </Button>
            </div>
          </Field>
        </Section>
        <Section id="settings-terminal" title={SETTINGS_WORDS.terminal}>
          <Field id="settings-text-size" label={SETTINGS_WORDS.textSize}>
            <RadioGroup aria-labelledby="settings-text-size" className="gap-0" value={preferences.terminalSize} onValueChange={pick(v => TerminalSizeSource.safeParse(v).data, terminalSize => void setPreferences({ terminalSize }))}>
              {TerminalSizeSource.options.map(source => (
                <Choice key={source} value={source} title={TERMINAL_SIZE_WORDS[source]} fact={TERMINAL_SIZE_FACT[source](appPx, file?.fontSize)} />
              ))}
            </RadioGroup>
          </Field>
        </Section>
      </div>
    </ScrollArea>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <h2 id={id} className={ZONE_LABEL}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label id={id}>{label}</Label>
      {children}
    </div>
  );
}

/** One choice row: the radio, the word, the sentence under it where the word does not say it all, and a fact at the right edge where the choice has one. */
function Choice({ value, title, detail, fact }: { value: string; title: string; detail?: string; fact?: string }) {
  return (
    <label className="flex h-9 cursor-pointer items-center gap-2.5 text-sm" data-settings-row>
      <Radio value={value} />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="text-foreground">{title}</span>
        {detail !== undefined ? <span className="truncate text-[11px] text-muted-foreground">{detail}</span> : null}
      </span>
      {fact !== undefined ? <span className={FACT}>{fact}</span> : null}
    </label>
  );
}
