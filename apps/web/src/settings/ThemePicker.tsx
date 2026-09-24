// SPDX-License-Identifier: AGPL-3.0-only
// The theme as three pictures of the app, one per pick: the window drawn small in
// the side it would take, a sidebar of bars beside a panel of bars. The
// pictures carry fixed light and dark inks, since each shows its side whatever
// the app is on now; the chosen one takes the ring.
import { ThemePreference } from "@wsp/protocol";
import { cn } from "../lib/utils.js";
import { THEME_WORDS } from "./format.js";

type Side = "light" | "dark";

/** Each side's inks: the window's ground, the panel inside it, the first bar of a column (its title) and the rest. */
const SIDE_INK: Record<Side, { ground: string; panel: string; head: string; bar: string }> = {
  light: { ground: "bg-neutral-100", panel: "bg-white border-neutral-200", head: "bg-neutral-400", bar: "bg-neutral-300" },
  dark: { ground: "bg-neutral-950", panel: "bg-black border-neutral-800", head: "bg-neutral-600", bar: "bg-neutral-700" },
};

function Bars({ widths, ink }: { widths: readonly number[]; ink: { head: string; bar: string } }) {
  return (
    <>
      {widths.map((w, at) => (
        <span key={at} className={cn("h-1.5 shrink-0 rounded-full", at === 0 ? ink.head : ink.bar)} style={{ width: `${w}%` }} />
      ))}
    </>
  );
}

function Window({ side, split = false, className }: { side: Side; split?: boolean; className?: string }) {
  const ink = SIDE_INK[side];
  return (
    <div className={cn("flex h-full gap-3 p-3", ink.ground, className)}>
      <div className={cn("flex shrink-0 flex-col gap-2.5 pt-2", split ? "w-[28%]" : "w-[14%]")}>
        <Bars widths={[70, 100, 85, 100]} ink={ink} />
      </div>
      <div className={cn("flex flex-1 flex-col gap-2.5 rounded-[6px] border p-3.5", ink.panel)}>
        <Bars widths={split ? [40, 72, 60, 32] : [55, 77, 67, 45]} ink={ink} />
      </div>
    </div>
  );
}

function Picture({ theme }: { theme: ThemePreference }) {
  if (theme !== "system") return <Window side={theme} />;
  return (
    <div className="flex h-full">
      <Window side="light" split className="w-1/2 overflow-hidden" />
      <Window side="dark" split className="w-1/2 overflow-hidden" />
    </div>
  );
}

export function ThemePicker({ value, onChange }: { value: ThemePreference; onChange: (theme: ThemePreference) => void }) {
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-4 max-sm:gap-2" data-k="theme-picker">
      {ThemePreference.options.map(theme => {
        const chosen = theme === value;
        return (
          <button
            key={theme}
            type="button"
            role="radio"
            aria-checked={chosen}
            data-theme-option={theme}
            onClick={() => onChange(theme)}
            className="group flex cursor-pointer flex-col items-center gap-2.5 outline-none"
          >
            <span
              className={cn(
                "block aspect-[16/10] w-full overflow-hidden rounded-[10px] border border-border ring-offset-2 ring-offset-background transition-shadow duration-150",
                chosen ? "ring-2 ring-primary" : "group-hover:ring-1 group-hover:ring-border",
                "group-focus-visible:ring-2 group-focus-visible:ring-ring",
              )}
            >
              <Picture theme={theme} />
            </span>
            <span className={cn("text-[13px] transition-colors duration-150", chosen ? "text-foreground" : "text-muted-foreground group-hover:text-foreground")}>{THEME_WORDS[theme]}</span>
          </button>
        );
      })}
    </div>
  );
}
