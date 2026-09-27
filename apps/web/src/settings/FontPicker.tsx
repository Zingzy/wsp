// SPDX-License-Identifier: AGPL-3.0-only
// The control on a font row. In the desktop it is a list of the families
// installed on this computer, read once from the shell's own font index, with
// Default first; a page that has no such list, a browser tab or a window on a
// host somewhere else, takes a field the family is typed into.
import { useEffect, useState } from "react";
import { DraftInput } from "../components/ui/draft-input.js";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { desktopBridge } from "../lib/desktopShell.js";
import { FONT_WORDS } from "./format.js";

let families: Promise<string[]> | undefined;

/** The installed families, asked of the shell once per window; nothing where the shell will not say. */
function installedFamilies(): Promise<string[]> | undefined {
  const read = desktopBridge()?.fontFamilies;
  if (read === undefined) return undefined;
  families ??= read().catch(() => {
    families = undefined;
    throw new Error("no font list");
  });
  return families;
}

/** Forgets the list read, so a test starts from a window that has asked nothing. */
export function forgetFontFamilies(): void {
  families = undefined;
}

export function FontPicker({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (family: string) => void }) {
  const [listed, setListed] = useState<string[] | "typed" | null>(() => (installedFamilies() === undefined ? "typed" : null));
  useEffect(() => {
    const asked = installedFamilies();
    if (asked === undefined) return;
    let live = true;
    asked.then(
      names => live && setListed(names),
      () => live && setListed("typed"),
    );
    return () => {
      live = false;
    };
  }, []);

  if (listed === "typed") {
    return <DraftInput data-k={id} aria-label={label} size="sm" className="w-48 max-sm:w-36" placeholder={FONT_WORDS.default} value={value} onCommit={next => onChange(next.trim())} />;
  }
  const options = listed === null || value === "" || listed.includes(value) ? (listed ?? []) : [value, ...listed];
  return (
    <Select value={value} onValueChange={next => onChange(typeof next === "string" ? next : "")}>
      <SelectTrigger size="sm" aria-label={label} data-k={id} className="w-48 max-sm:w-36">
        <SelectValue>{(picked: string) => (picked === "" ? FONT_WORDS.default : picked)}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="">{FONT_WORDS.default}</SelectItem>
        {options.map(family => (
          <SelectItem key={family} value={family}>
            <span style={{ fontFamily: `"${family.replace(/["\\]/g, "")}"` }}>{family}</span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
