// Adapted from pingdotgg/t3code apps/web/src/components/RightPanelTabs.tsx at 57a66608 (MIT).
import { Plus, type LucideIcon } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type { RightPanelSurface } from "../rightPanelStore";
import { PANE_KINDS, paneOf, paneTitle, type RightPanelKind } from "../panes";
import { cn } from "../lib/utils";
import { CARD_SURFACE } from "../settings/rows";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { Kbd } from "./ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "./ui/menu";
import { ScrollArea } from "./ui/scroll-area";
import { PanelTabCloseButton } from "./ui/panel-tab-close-button";

import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";

/** What a browser surface's tab shows; the browser pane supplies these per open tab. */
export interface PreviewTabSnapshot {
  tabId: string;
  url: string | null;
  title: string;
}

interface RightPanelTabsProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  /** Forwarded to PreviewPanelShell so this surface persists its own width. */
  widthStorageKey?: string;
  /** Forwarded to PreviewPanelShell as the initial width before a user resize. */
  defaultWidth?: number;
  layoutControls?: ReactNode;
  surfaces: readonly RightPanelSurface[];
  activeSurfaceId: string | null;
  previewSessions: Readonly<Record<string, PreviewTabSnapshot>>;
  terminalLabelsById: ReadonlyMap<string, string>;
  onActivate: (surface: RightPanelSurface) => void;
  onCloseSurface: (surface: RightPanelSurface) => void;
  onAdd: (kind: RightPanelKind) => void;
  available: Readonly<Record<RightPanelKind, boolean>>;
  /** Why each unavailable surface is greyed out; shown on its launcher row and menu item. */
  unavailableReasons?: Partial<Record<RightPanelKind, string>>;
  children: ReactNode;
}

/** Overlays that must win over the launcher's letter shortcuts. */
const LAUNCHER_SHORTCUT_BLOCKING_LAYERS = [
  '[data-slot="dialog-popup"]',
  '[data-slot="alert-dialog-popup"]',
  '[data-slot="command-dialog-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");

type SurfaceShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "defaultPrevented" | "isComposing" | "key" | "metaKey"
>;

export function surfaceShortcutActionForKey<
  const Action extends { available: boolean; shortcut: string },
>(actions: readonly Action[], event: SurfaceShortcutEvent): Action | null {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  return (
    actions.find(
      (action) => action.available && action.shortcut.toLowerCase() === event.key.toLowerCase(),
    ) ?? null
  );
}

/**
 * A focused editable is a typing context whether or not it has text yet: an
 * empty chat composer at rest is still where the user's next keystrokes are
 * meant to land, and claiming launcher letters from it would redirect prompts
 * into whatever surface opens. The `:not` clause lets `closest` see past
 * non-editable islands (`contenteditable="false"`) to an editable host around
 * them, matching ComposerPendingUserInputPanel's typing guard.
 */
export function surfaceShortcutTargetsTypingContext(
  target: { closest(selectors: string): unknown } | null,
): boolean {
  return (
    target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !=
    null
  );
}

function DisabledReasonTooltip(props: { reason: string; trigger: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.trigger} />
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

function SurfaceMenuItem(props: {
  available: boolean;
  disabledReason?: string;
  shortcut: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const item = (
    <MenuItem
      className={!props.available ? "data-disabled:pointer-events-auto" : undefined}
      onClick={props.onClick}
      disabled={!props.available}
      aria-keyshortcuts={props.shortcut}
    >
      {props.children}
      <MenuShortcut>{props.shortcut}</MenuShortcut>
    </MenuItem>
  );
  if (props.available || !props.disabledReason) return item;
  return <DisabledReasonTooltip reason={props.disabledReason} trigger={item} />;
}

interface SurfaceAction {
  key: RightPanelKind;
  label: string;
  description: string;
  icon: LucideIcon;
  shortcut: string;
  available: boolean;
  disabledReason: string;
  onClick: () => void;
}

function surfaceActions(
  props: Pick<RightPanelTabsProps, "onAdd" | "available" | "unavailableReasons">,
): readonly SurfaceAction[] {
  return PANE_KINDS.map((key) => {
    const pane = paneOf(key);
    return {
      key,
      label: pane.label,
      description: pane.description,
      icon: pane.icon,
      shortcut: pane.shortcut,
      available: props.available[key],
      disabledReason: props.unavailableReasons?.[key] ?? pane.hint,
      onClick: () => props.onAdd(key),
    };
  });
}

/**
 * Card launcher shown when the right panel has nothing open. Keyboard-first
 * without palette chrome: a panel's letter opens it directly from anywhere
 * outside a typing context, and arrows plus Enter work while the launcher is
 * focused. The highlight only appears on hover or arrow use. A panel that
 * cannot open stays visible with a one-line reason. The person's word for one
 * of these is panel; surface is ours and stays in the code.
 */
function RightPanelEmptyState(props: { actions: readonly SurfaceAction[] }) {
  const { actions } = props;
  // -1 means no highlight: it only appears on hover or arrow use.
  const [highlight, setHighlight] = useState(-1);

  const availableActions = actions.filter((action) => action.available);
  const highlightIndex =
    availableActions.length === 0 ? -1 : Math.min(highlight, availableActions.length - 1);

  // Letter shortcuts work while the launcher is visible, not only while it
  // is focused; focus moves around too easily (stray clicks) to carry them.
  // Capture phase so app-level key handlers cannot swallow the event first;
  // typing contexts and already-handled events are left alone.
  const shortcutActionsRef = useRef(availableActions);
  useEffect(() => {
    shortcutActionsRef.current = availableActions;
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const action = surfaceShortcutActionForKey(shortcutActionsRef.current, event);
      if (!action) return;
      if (document.querySelector(LAUNCHER_SHORTCUT_BLOCKING_LAYERS)) return;
      const target = event.target;
      if (target instanceof Element && surfaceShortcutTargetsTypingContext(target)) return;
      event.preventDefault();
      event.stopPropagation();
      action.onClick();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (availableActions.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      setHighlight((highlightIndex + 1) % availableActions.length);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      setHighlight(
        highlightIndex === -1
          ? availableActions.length - 1
          : (highlightIndex - 1 + availableActions.length) % availableActions.length,
      );
      return;
    }
    if (event.key === "Enter") {
      // A focused card button owns its own activation; only open from the
      // highlight when the container itself has focus.
      if (event.target instanceof HTMLElement && event.target.closest("button")) return;
      const action = availableActions[highlightIndex];
      if (!action) return;
      event.preventDefault();
      action.onClick();
    }
  };

  // Stable identity so React only runs this callback ref on mount/unmount;
  // an inline arrow would re-attach and re-focus on every render.
  const focusOnMount = useCallback((node: HTMLDivElement | null) => {
    node?.focus();
  }, []);

  const isHighlighted = (action: SurfaceAction) =>
    highlightIndex !== -1 && availableActions[highlightIndex] === action;

  // py-2 and the hairline around 36px of text make a 54px tile, on the 4px pitch.
  const tileClass = cn(CARD_SURFACE, "flex w-full items-center gap-3 px-3 py-2 text-left");
  const rowText = (action: SurfaceAction, line: string, head?: string) => {
    const Icon = action.icon;
    return (
      <>
        <Icon className={cn("size-4 shrink-0 text-foreground/80", head)} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn("text-foreground text-sm", head)}>{action.label}</span>
          <span className="text-muted-foreground text-xs">{line}</span>
        </span>
        <Kbd className={head}>{action.shortcut}</Kbd>
      </>
    );
  };

  return (
    <div
      ref={focusOnMount}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label="Open a panel"
      data-surface-launcher-keys={availableActions.map((action) => action.shortcut).join("")}
      className={cn(
        "flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 pt-6 outline-none",
        // The panel topbar sits above this container; matching bottom padding
        // keeps the rows centered against the full panel, not the leftover.
        "pb-[calc(var(--workspace-topbar-height)+--spacing(6))]",
      )}
    >
      <div className="relative w-full max-w-sm">
        <div className="absolute inset-x-0 bottom-full mb-5 text-center">
          <h3 className="font-medium text-foreground text-sm">Open a panel</h3>
          <p className="mt-1 text-muted-foreground text-xs">
            A browser, a terminal, the diff, the computer or what runs on it.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          {actions.map((action) =>
            action.available ? (
              <button
                key={action.label}
                type="button"
                data-surface-launch={action.key}
                onClick={action.onClick}
                onMouseEnter={() => setHighlight(availableActions.indexOf(action))}
                onMouseLeave={() =>
                  setHighlight((current) =>
                    current === availableActions.indexOf(action) ? -1 : current,
                  )
                }
                className={cn(
                  tileClass,
                  // Not the accent: on the dark themes the accent and the card are the same few percent of white.
                  "cursor-pointer transition-colors duration-150 hover:bg-card-hover",
                  isHighlighted(action) && "bg-card-hover",
                )}
              >
                {rowText(action, action.description)}
              </button>
            ) : (
              <div
                key={action.label}
                data-surface-launch={action.key}
                data-available="false"
                className={tileClass}
              >
                {/* The dimming sits on the glyph, the label and the key, never on the reason, which is the one
                    sentence a person is asked to read. */}
                {rowText(action, action.disabledReason, "opacity-64")}
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

function SurfaceIcon({ surface }: { surface: RightPanelSurface }) {
  const Icon = paneOf(surface.kind).icon;
  return <Icon className="size-3 shrink-0" />;
}

export function RightPanelTabs(props: RightPanelTabsProps) {
  const tabListRef = useRef<HTMLDivElement>(null);
  const [addSurfaceMenuOpen, setAddSurfaceMenuOpen] = useState(false);

  const addSurfaceActions = surfaceActions(props);

  const handleAddSurfaceMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = surfaceShortcutActionForKey(addSurfaceActions, event.nativeEvent);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    setAddSurfaceMenuOpen(false);
    action.onClick();
  };

  const handleTabMouseDown = useCallback((event: ReactMouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
  }, []);
  const handleTabAuxClick = useCallback(
    (event: ReactMouseEvent, surface: RightPanelSurface) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      props.onCloseSurface(surface);
    },
    [props],
  );

  useEffect(() => {
    const activeTab = tabListRef.current?.querySelector<HTMLElement>("[data-active-tab='true']");
    activeTab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [props.activeSurfaceId]);

  return (
    <PreviewPanelShell
      mode={props.mode}
      {...(props.maximized !== undefined ? { maximized: props.maximized } : {})}
      {...(props.widthStorageKey !== undefined ? { widthStorageKey: props.widthStorageKey } : {})}
      {...(props.defaultWidth !== undefined ? { defaultWidth: props.defaultWidth } : {})}
    >
      <div
        className={cn(
          "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pl-2",
          // The sheet overlays from the viewport top, so its tab bar keeps
          // the titlebar's height: a compact row re-centers the layout
          // controls a few pixels higher and the cluster jumps on open.
          props.mode === "inline" && !props.layoutControls ? "pr-28" : "pr-3",
        )}
        data-right-panel-tabbar
      >
        <ScrollArea
          ref={tabListRef}
          hideScrollbars
          scrollFade
          className="min-w-0 flex-1 rounded-none"
          data-right-panel-tab-list
        >
          <div className="flex h-full w-max min-w-full items-center gap-1">
            {props.surfaces.map((surface) => {
              const active = surface.id === props.activeSurfaceId;
              const title = paneTitle(surface, props);
              return (
                <div
                  key={surface.id}
                  data-active-tab={active}
                  onMouseDown={handleTabMouseDown}
                  onAuxClick={(event) => handleTabAuxClick(event, surface)}
                  className={cn(
                    "cursor-pointer group/tab flex h-6 max-w-36 shrink-0 items-center gap-0.5 rounded-sm pr-2 pl-1.5 text-xs",
                    active
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <PanelTabCloseButton
                    label={`Close ${title}`}
                    onClick={() => props.onCloseSurface(surface)}
                  >
                    <SurfaceIcon surface={surface} />
                  </PanelTabCloseButton>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          className="cursor-pointer flex min-w-0 items-center"
                          onClick={() => props.onActivate(surface)}
                        >
                          <span className="truncate">{title}</span>
                        </button>
                      }
                    />
                    <TooltipPopup>{title}</TooltipPopup>
                  </Tooltip>
                </div>
              );
            })}
            {props.surfaces.length > 0 ? (
              <Menu open={addSurfaceMenuOpen} onOpenChange={setAddSurfaceMenuOpen}>
                <MenuTrigger
                  render={
                    <Button
                      aria-label="Add a panel"
                      className="size-7"
                      size="icon-sm"
                      variant="ghost-muted"
                    />
                  }
                >
                  <Plus className="size-3.5" />
                </MenuTrigger>
                <MenuPopup
                  align="start"
                  side="bottom"
                  sideOffset={6}
                  className="min-w-44"
                  onKeyDownCapture={handleAddSurfaceMenuKeyDown}
                >
                  {addSurfaceActions.map((action) => {
                    const Icon = action.icon;
                    return (
                      <SurfaceMenuItem
                        key={action.label}
                        available={action.available}
                        disabledReason={action.disabledReason}
                        shortcut={action.shortcut}
                        onClick={action.onClick}
                      >
                        <Icon />
                        {action.label}
                      </SurfaceMenuItem>
                    );
                  })}
                </MenuPopup>
              </Menu>
            ) : null}
          </div>
        </ScrollArea>
        {props.layoutControls}
      </div>
      <div className="flex min-h-0 flex-1 flex-col" data-right-panel-surface-content>
        {props.activeSurfaceId === null ? (
          <RightPanelEmptyState actions={addSurfaceActions} />
        ) : (
          props.children
        )}
      </div>
    </PreviewPanelShell>
  );
}
