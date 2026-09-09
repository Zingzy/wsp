// SPDX-License-Identifier: AGPL-3.0-only
// The picker the menu asked for, on the fact it named: one module per fact,
// and adding a fact is a row here beside the protocol's list.
import type { LookPart, WorkspaceView } from "@wsp/protocol";
import { IconPopover } from "./IconPopover.js";
import { ThemePopover } from "./ThemePopover.js";

const PICKERS: Record<LookPart, typeof IconPopover> = { glyph: IconPopover, theme: ThemePopover };

export function WorkspaceLookPopover({ part, ...props }: { part: LookPart; workspace: WorkspaceView; anchor: HTMLElement | null; onClose: () => void }) {
  const Picker = PICKERS[part];
  return <Picker {...props} />;
}
