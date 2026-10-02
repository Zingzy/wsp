// Adapted from pingdotgg/t3code apps/web/src/commandPaletteBus.ts at 57a66608 (MIT).
// Tiny event bus allowing components to programmatically open the command palette
// without owning its React state.
const COMMAND_PALETTE_OPEN_EVENT = "wsp:open-command-palette";

export interface CommandPaletteOpenDetail {
  /** Text the input starts with; ">" lists actions only. */
  readonly query?: string;
  /** Close instead when the palette is already open. */
  readonly toggle?: boolean;
  /** The page it opens on in place of its root: the projects New thread picks from. */
  readonly page?: CommandPalettePage;
}

export type CommandPalettePage = "new-thread";

export function openCommandPalette(detail?: CommandPaletteOpenDetail): void {
  window.dispatchEvent(
    new CustomEvent(COMMAND_PALETTE_OPEN_EVENT, detail ? { detail } : undefined),
  );
}

export function toggleCommandPalette(): void {
  openCommandPalette({ toggle: true });
}

export function onOpenCommandPalette(
  listener: (detail: CommandPaletteOpenDetail) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<CommandPaletteOpenDetail>).detail ?? {});
  };
  window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
  return () => window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
}

/** Read at event time so consumers do not subscribe to transient dialog state. */
export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}
