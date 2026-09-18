// SPDX-License-Identifier: AGPL-3.0-only
// The settings page in the centre: one column of sections in the grammar
// rows.tsx holds, a caps mono zone label over each, then one hairline-separated
// row per pick with its label at the left and its control at the right edge.
// The control's own label is the explanation: no sentence under any pick,
// though a section may put one sentence of its own in a row of the same shape.
// Every pick goes to the host's preferences record and paints at once, so a
// browser tab on the same host follows.
//
// Two picks are left, the sidebar's width and the terminal's text size; the
// page follows the computer's own colour scheme and offers no side to pick.
// Computers, Account and About take no pick: they say which computers this wsp
// runs on and which agents are on each, whether this wsp is on an account, and
// the release each half of the app is on. The section about one cloud stands
// only while this host holds that cloud's key, the same rule its row in the
// table stands under.
import { PLACES_WORDS, TerminalSizeSource, fmtPx, type InitSetup, type TerminalConfig } from "@wsp/protocol";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button.js";
import { NumberField, NumberFieldDecrement, NumberFieldGroup, NumberFieldIncrement, NumberFieldInput } from "../components/ui/number-field.js";
import { ScrollArea } from "../components/ui/scroll-area.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { cn } from "../lib/utils.js";
import { useAddComputerOpen, usePreferences, useStore } from "../protocol/store.js";
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "../shell/sidebarWidth.js";
import { appTerminalFontSize } from "../terminal/ghostty/surface.js";
import { appScheme } from "../terminal/ghosttyConfig.js";
import { shellVersions } from "../shell/shellVersion.js";
import { FACT, SETTINGS_WORDS, TERMINAL_SIZE_FACT, TERMINAL_SIZE_WORDS, versionFact } from "./format.js";
import { AccountSection } from "./AccountSection.js";
import { AddComputerSheet } from "./AddComputerSheet.js";
import { Computers } from "./Computers.js";
import { ImageSection } from "./ImageSection.js";
import { CLOUD_NAMES, keyHeld } from "./providers.js";
import { Row, Section } from "./rows.js";

const SIZES = TerminalSizeSource.options.map(source => ({ value: source, label: TERMINAL_SIZE_WORDS[source] }));

/** The cloud whose own section stands on this page while it is still the road a workspace at a cloud is made on.
 * One entry, read off the name table, so the day it leaves the section leaves with its row. */
const CLOUD_SECTION = CLOUD_NAMES.find(row => row.id === "solari")!;

export function SettingsPage() {
  const preferences = usePreferences();
  const setPreferences = useStore(s => s.setPreferences);
  const readHostConfig = useStore(s => s.api?.hostTerminalConfig);
  const initGet = useStore(s => s.api?.initGet);
  const [file, setFile] = useState<TerminalConfig | null>(null);
  const [setup, setSetup] = useState<InitSetup | null>(null);
  const versions = shellVersions();
  const addComputer = useAddComputerOpen();
  const closeAddComputer = useStore(s => s.closeAddComputer);
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
  // Which keys this host holds, which is the one rule the cloud's own section stands under.
  useEffect(() => {
    if (initGet === undefined) return;
    let live = true;
    void initGet().then(
      read => {
        if (live) setSetup(read);
      },
      () => {
        if (live) setSetup(null);
      },
    );
    return () => {
      live = false;
    };
  }, [initGet]);
  const width = preferences.sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH;
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div data-settings-page className="mx-auto flex w-full max-w-[672px] flex-col gap-8 px-6 py-6">
        <Section id="settings-appearance" title={SETTINGS_WORDS.appearance}>
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
        <Section id="settings-where" title={PLACES_WORDS.section}>
          <Computers />
        </Section>
        {keyHeld(CLOUD_SECTION.id, setup) ? <ImageSection title={CLOUD_SECTION.name} /> : null}
        <AccountSection />
        <Section id="settings-about" title={SETTINGS_WORDS.about}>
          <Row id="settings-version" label={SETTINGS_WORDS.version}>
            {/* A row with no control still stands as tall as one, so the rhythm down the column never breaks. */}
            <span className={cn(FACT, "flex h-7 items-center")} data-k="version">
              {versionFact(versions.app, versions.host, versions.inShell)}
            </span>
          </Row>
        </Section>
      </div>
      {addComputer ? <AddComputerSheet onClose={closeAddComputer} /> : null}
    </ScrollArea>
  );
}
