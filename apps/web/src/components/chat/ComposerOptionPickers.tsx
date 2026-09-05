// SPDX-License-Identifier: AGPL-3.0-only
// The model, effort and permission pickers in the composer's context strip.
// Each lists what the runtime's catalog says the harness's CLI takes, and a
// picker whose list is empty does not exist. The label reads the pick, else
// the running session's value while a turn streams, else the catalog's
// default, else the picker's own name. A pick rides the next sessions.start
// and is remembered per workspace; a turn already running keeps its flags.
import { ChevronDownIcon } from "lucide-react";
import type { HarnessCatalog, HarnessOption, SessionView } from "@wsp/protocol";
import { useHarnessCatalog, useLatestSession } from "../../protocol/store";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { useComposerOptions, useComposerOptionsStore, type ComposerOptionKey } from "./composerOptionsStore";
import type { ChatThreadHandle } from "./useChatThread";

export const DEFAULT_HARNESS = "claude";

const PICKERS: ReadonlyArray<{ key: ComposerOptionKey; name: string; list: keyof Pick<HarnessCatalog, "models" | "efforts" | "permissionModes"> }> = [
  { key: "model", name: "Model", list: "models" },
  { key: "effort", name: "Effort", list: "efforts" },
  { key: "permissionMode", name: "Permissions", list: "permissionModes" },
];

/** What the picker stands for right now: the value that will run, or null when the CLI decides. */
export function currentOption(input: { picked: string | undefined; running: string | undefined; options: ReadonlyArray<HarnessOption> }): string | null {
  return input.picked ?? input.running ?? input.options.find(o => o.isDefault)?.value ?? null;
}

function OptionPicker({
  workspaceId,
  picker,
  options,
  value,
}: {
  workspaceId: string;
  picker: (typeof PICKERS)[number];
  options: ReadonlyArray<HarnessOption>;
  value: string | null;
}) {
  const pick = useComposerOptionsStore(s => s.pick);
  const label = value === null ? picker.name : (options.find(o => o.value === value)?.label ?? value);
  return (
    <Menu>
      <MenuTrigger
        render={<Button type="button" variant="ghost" size="xs" />}
        className="shrink-0 font-medium text-muted-foreground/70 hover:text-foreground/80"
        aria-label={value === null ? picker.name : `${picker.name}: ${label}`}
        data-composer-picker={picker.key}
        data-value={value ?? undefined}
      >
        <span className="truncate">{label}</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="end" side="top" className="w-64">
        <MenuRadioGroup value={value} onValueChange={next => { if (typeof next === "string") pick(workspaceId, picker.key, next); }}>
          {options.map(option => (
            <MenuRadioItem key={option.value} value={option.value} data-composer-option={option.value}>
              <span className="block truncate">{option.label}</span>
              {option.description !== undefined ? <span className="block truncate text-xs text-muted-foreground">{option.description}</span> : null}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

/** The running session's values, from the runtime's row for it; the CLI's announced model wins over the request's. */
function runningValues(session: SessionView | null, running: boolean): Partial<Record<ComposerOptionKey, string>> {
  if (!running || session === null || session.status !== "running") return {};
  return {
    ...(session.model !== undefined ? { model: session.model } : {}),
    ...(session.effort !== undefined ? { effort: session.effort } : {}),
    ...(session.permissionMode !== undefined ? { permissionMode: session.permissionMode } : {}),
  };
}

export function ComposerOptionPickers({ workspaceId, thread }: { workspaceId: string; thread: ChatThreadHandle }) {
  const latest = useLatestSession(workspaceId);
  const catalog = useHarnessCatalog(latest?.harness ?? DEFAULT_HARNESS);
  const picked = useComposerOptions(workspaceId);
  if (catalog === null) return null;
  const running = runningValues(latest, thread.view.running);
  return (
    <>
      {PICKERS.map(picker => {
        const options = catalog[picker.list];
        if (options.length === 0) return null;
        const value = currentOption({ picked: picked[picker.key], running: running[picker.key], options });
        return <OptionPicker key={picker.key} workspaceId={workspaceId} picker={picker} options={options} value={value} />;
      })}
    </>
  );
}
