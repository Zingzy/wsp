// SPDX-License-Identifier: AGPL-3.0-only
// A dev-only panel on Cmd+Shift+M that tunes the composer's glass live, so the owner can dial the material by eye
// and hand the values back to be written into index.css. It writes one style element and nothing else.
import { useEffect, useState } from "react";

type Tweaks = { blur: number; saturation: number; tint: number; ground: boolean; groundColor: string; groundStrength: number };

const KEY = "wsp:material-tweaks";
const STYLE_ID = "wsp-material-tweaks";
const DEFAULTS: Tweaks = { blur: 16, saturation: 1.08, tint: 3, ground: true, groundColor: "#232929", groundStrength: 100 };

function load(): Tweaks | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw === null ? null : { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Tweaks>) };
  } catch {
    return null;
  }
}

function css(t: Tweaks): string {
  return [
    `:root { --glass-blur: ${t.blur}px !important; --glass-saturation: ${t.saturation} !important; }`,
    `.desktop-mac { --glass-ground: ${t.ground ? "url(#glass-ground)" : "none"} !important; --glass-ground-color: ${t.groundColor} !important; --glass-ground-opacity: ${t.groundStrength / 100} !important; }`,
    `[data-slot="composer-shell"] { --chat-composer-glass-opacity: ${t.tint}% !important; }`,
  ].join("\n");
}

function apply(t: Tweaks | null): void {
  let el = document.getElementById(STYLE_ID);
  if (t === null) {
    el?.remove();
    return;
  }
  if (el === null) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = css(t);
}

function Slider({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="grid grid-cols-[6.5rem_1fr_3.5rem] items-center gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} className="accent-foreground" />
      <span className="text-end font-mono tabular-nums text-foreground">
        {value}
        {unit}
      </span>
    </label>
  );
}

export function MaterialPanel() {
  const [open, setOpen] = useState(false);
  const [t, setT] = useState<Tweaks>(() => load() ?? DEFAULTS);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const saved = load();
    if (saved !== null) apply(saved);
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && e.shiftKey && e.code === "KeyM") {
        e.preventDefault();
        setOpen(o => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const set = (patch: Partial<Tweaks>): void => {
    const next = { ...t, ...patch };
    setT(next);
    apply(next);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // A blocked storage keeps the tweak for this page only.
    }
  };

  if (!open) return null;
  return (
    <div className="fixed right-4 bottom-4 z-[100] flex w-80 flex-col gap-3 rounded-xl border border-border bg-popover p-4 text-foreground shadow-lg">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium">Composer material</span>
        <span className="font-mono text-[11px] text-muted-foreground">Cmd+Shift+M</span>
      </div>
      <Slider label="Blur" value={t.blur} min={0} max={40} step={1} unit="px" onChange={v => set({ blur: v })} />
      <Slider label="Saturation" value={t.saturation} min={1} max={1.8} step={0.02} unit="" onChange={v => set({ saturation: v })} />
      <Slider label="Tint" value={t.tint} min={0} max={20} step={0.5} unit="%" onChange={v => set({ tint: v })} />
      <label className="grid grid-cols-[6.5rem_1fr] items-center gap-3 text-xs">
        <span className="text-muted-foreground">Ground</span>
        <input type="checkbox" checked={t.ground} onChange={e => set({ ground: e.target.checked })} className="justify-self-start accent-foreground" />
      </label>
      <label className="grid grid-cols-[6.5rem_1fr_3.5rem] items-center gap-3 text-xs">
        <span className="text-muted-foreground">Ground colour</span>
        <input type="color" value={t.groundColor} onChange={e => set({ groundColor: e.target.value })} className="h-6 w-full cursor-pointer rounded border border-border bg-transparent" />
        <span className="text-end font-mono text-[11px] text-foreground">{t.groundColor}</span>
      </label>
      <Slider label="Ground strength" value={t.groundStrength} min={0} max={100} step={5} unit="%" onChange={v => set({ groundStrength: v })} />
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={() => {
            setT(DEFAULTS);
            apply(null);
            try {
              window.localStorage.removeItem(KEY);
            } catch {
              // Nothing stored to remove.
            }
          }}
          className="h-7 rounded-md border border-border px-3 text-xs text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
        >
          Reset
        </button>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(JSON.stringify(t));
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
          className="h-7 rounded-md border border-border bg-foreground px-3 text-xs text-background transition-opacity duration-150 hover:opacity-90"
        >
          {copied ? "Copied" : "Copy values"}
        </button>
      </div>
    </div>
  );
}
