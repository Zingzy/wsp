// Adapted from pingdotgg/t3code apps/web/src/components/ThreadTerminalDrawer.tsx at 57a66608 (MIT).
// The viewport's six runtime hook sites (attach stream, write, resize, server
// config, preview open, local api) are props here: a TerminalIo per terminal
// and a TerminalViewportConfig. Selection actions and the context menu left
// with them; the surface keeps its own copy and paste and lets the Command
// chords the app binds bubble to the window dispatcher.
import {
  Plus,
  Square,
  SquareSplitHorizontal,
  SquareSplitVertical,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Button } from "./ui/button";
import { PanelTabCloseButton } from "./ui/panel-tab-close-button";
import { isTerminalAppShortcut } from "../keybindings";
import { cn } from "../lib/utils";
import { getTerminalLabel } from "../lib/terminalLabels";
import { GhosttyTerminalSurface, type GhosttyTerminalFont, type GhosttyTerminalSurfaceOptions } from "../terminal/ghostty/surface";
import { type GhosttyColor, type GhosttyTheme } from "../terminal/ghostty/core";
import type { TerminalIo } from "../terminal/pty-io";
import { terminalEmptyLine, terminalInputRefusal, terminalPaneTitle, type TerminalPaneState } from "../adapt/index";
import { isTerminalLinkActivation, isTerminalUrl } from "../terminal-links";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
} from "../terminal/groups";

const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;

function maxDrawerHeight(): number {
  if (typeof window === "undefined") return DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.max(MIN_DRAWER_HEIGHT, Math.floor(window.innerHeight * MAX_DRAWER_HEIGHT_RATIO));
}

function clampDrawerHeight(height: number): number {
  const safeHeight = Number.isFinite(height) ? height : DEFAULT_THREAD_TERMINAL_HEIGHT;
  const maxHeight = maxDrawerHeight();
  return Math.min(Math.max(Math.round(safeHeight), MIN_DRAWER_HEIGHT), maxHeight);
}

function parseTerminalColor(value: string, fallback: GhosttyColor): GhosttyColor {
  if (typeof document === "undefined") return fallback;

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return fallback;

  context.clearRect(0, 0, 1, 1);
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  if (alpha === 0) return fallback;
  return {
    r: red ?? fallback.r,
    g: green ?? fallback.g,
    b: blue ?? fallback.b,
  };
}

function normalizeComputedColor(value: string | null | undefined, fallback: string): string {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return fallback;
  }
  return value ?? fallback;
}

function readThemeColor(styles: CSSStyleDeclaration, variable: string, fallback: string): string {
  return normalizeComputedColor(styles.getPropertyValue(variable), fallback);
}

export function terminalThemeFromApp(mountElement?: HTMLElement | null): GhosttyTheme {
  const isDark = document.documentElement.classList.contains("dark");
  const fallbackBackground = isDark ? "rgb(14, 18, 24)" : "rgb(255, 255, 255)";
  const fallbackForeground = isDark ? "rgb(237, 241, 247)" : "rgb(28, 33, 41)";
  const drawerSurface =
    mountElement?.closest(".thread-terminal-drawer") ??
    document.querySelector(".thread-terminal-drawer") ??
    document.body;
  const drawerStyles = getComputedStyle(drawerSurface);
  const bodyStyles = getComputedStyle(document.body);
  const themeStyles = getComputedStyle(document.documentElement);
  const background = normalizeComputedColor(
    drawerStyles.backgroundColor,
    normalizeComputedColor(bodyStyles.backgroundColor, fallbackBackground),
  );
  const foreground = normalizeComputedColor(
    drawerStyles.color,
    normalizeComputedColor(bodyStyles.color, fallbackForeground),
  );
  const terminalBackground = readThemeColor(themeStyles, "--terminal-background", background);
  const terminalForeground = readThemeColor(themeStyles, "--terminal-foreground", foreground);
  const terminalCursor = readThemeColor(
    themeStyles,
    "--terminal-cursor",
    isDark ? "rgb(180, 203, 255)" : "rgb(38, 56, 78)",
  );
  const terminalSelection = readThemeColor(
    themeStyles,
    "--terminal-selection-background",
    isDark ? "rgba(180, 203, 255, 0.25)" : "rgba(37, 63, 99, 0.2)",
  );
  return {
    background: parseTerminalColor(
      terminalBackground,
      isDark ? { r: 14, g: 18, b: 24 } : { r: 255, g: 255, b: 255 },
    ),
    foreground: parseTerminalColor(
      terminalForeground,
      isDark ? { r: 237, g: 241, b: 247 } : { r: 28, g: 33, b: 41 },
    ),
    cursor: parseTerminalColor(
      terminalCursor,
      isDark ? { r: 180, g: 203, b: 255 } : { r: 38, g: 56, b: 78 },
    ),
    selectionBackground: terminalSelection,
  };
}

export interface TerminalViewportConfig {
  font?: GhosttyTerminalFont;
  /** A modifier-click on a link in the output; by default URLs open in a new tab and paths do nothing. */
  onLinkActivate?: (text: string) => void;
}

const EMPTY_CONFIG: TerminalViewportConfig = {};

function openInNewTab(text: string): void {
  if (isTerminalUrl(text)) window.open(text, "_blank", "noopener,noreferrer");
}

interface TerminalViewportProps {
  terminalId: string;
  io: TerminalIo;
  config: TerminalViewportConfig;
  focusRequestId: number;
  autoFocus: boolean;
  resizeEpoch: number;
  drawerHeight: number;
  /** Why a keystroke must not reach the pty right now, or null; read per key so the surface never rebuilds over it. */
  inputRefusal?: () => string | null;
  onInputRefused?: (reason: string) => void;
}

const NO_REFUSAL = (): string | null => null;
const IGNORE_REFUSED = (): void => {};

export function TerminalViewport({
  terminalId,
  io,
  config,
  focusRequestId,
  autoFocus,
  resizeEpoch,
  drawerHeight,
  inputRefusal = NO_REFUSAL,
  onInputRefused = IGNORE_REFUSED,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<GhosttyTerminalSurface | null>(null);
  const fontRef = useRef(config.font);
  const activateLink = useEffectEvent((text: string) => (config.onLinkActivate ?? openInNewTab)(text));

  useEffect(() => {
    if (fontRef.current === config.font) return;
    fontRef.current = config.font;
    void terminalRef.current?.setFont(config.font ?? {});
  }, [config.font]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    let cancelled = false;
    let teardown: (() => void) | null = null;
    let setupTerminal: GhosttyTerminalSurface | null = null;
    let setupCleanups: Array<() => void> = [];

    const setup = async (): Promise<(() => void) | null> => {
      const setupFont = fontRef.current;
      const terminalOptions: GhosttyTerminalSurfaceOptions = {
        theme: terminalThemeFromApp(mount),
        ...(setupFont ? { font: setupFont } : {}),
        onData: (data) => {
          const refusal = inputRefusal();
          if (refusal !== null) onInputRefused(refusal);
          else io.write(data);
        },
        onResize: (cols, rows) => io.resize(cols, rows),
        onSelectionChange: () => {},
        beforeKey: event => !isTerminalAppShortcut(event),
        onLinkActivate: (text, event) => {
          if (isTerminalLinkActivation(event)) activateLink(text);
        },
      };
      const terminal = await GhosttyTerminalSurface.create(mount, terminalOptions);
      if (cancelled) {
        terminal.dispose();
        return null;
      }
      // The theme observer is not installed yet, so re-read the theme in case
      // the app toggled light/dark while the WASM surface was loading.
      terminal.setTheme(terminalThemeFromApp(mount));
      setupTerminal = terminal;
      terminalRef.current = terminal;
      // A font change that landed while the surface was loading found terminalRef null.
      if (fontRef.current !== setupFont) void terminal.setFont(fontRef.current ?? {});

      setupCleanups.push(
        io.attach({
          write: (data) => terminal.write(data),
          reset: () => terminal.resetAndWrite(""),
        }),
      );
      if (autoFocus) window.requestAnimationFrame(() => terminal.focus());

      const themeObserver = new MutationObserver(() => {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) return;
        activeTerminal.setTheme(terminalThemeFromApp(containerRef.current));
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
      setupCleanups.push(() => themeObserver.disconnect());

      const fitTimer = window.setTimeout(() => {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) return;
        const wasAtBottom = activeTerminal.isAtBottom();
        activeTerminal.fit();
        if (wasAtBottom) {
          activeTerminal.scrollToBottom();
        }
      }, 30);
      setupCleanups.push(() => window.clearTimeout(fitTimer));

      const cleanups = setupCleanups;
      setupCleanups = [];
      setupTerminal = null;
      return () => {
        for (const cleanup of cleanups.toReversed()) cleanup();
        if (terminalRef.current === terminal) terminalRef.current = null;
        terminal.dispose();
      };
    };

    void setup()
      .then((nextTeardown) => {
        if (cancelled) {
          nextTeardown?.();
          return;
        }
        teardown = nextTeardown;
      })
      .catch((error: unknown) => {
        for (const cleanup of setupCleanups.toReversed()) cleanup();
        setupCleanups = [];
        if (terminalRef.current === setupTerminal) terminalRef.current = null;
        setupTerminal?.dispose();
        setupTerminal = null;
        if (cancelled) return;
        const message =
          error instanceof Error ? error.message : "Unable to initialize libghostty-vt";
        mount.textContent = `${message}. Close and reopen the terminal to retry.`;
      });

    return () => {
      cancelled = true;
      teardown?.();
    };
    // autoFocus is intentionally omitted;
    // it is only read at mount time and must not trigger terminal teardown/recreation.
  }, [io, terminalId, inputRefusal, onInputRefused]);

  useEffect(() => {
    if (!autoFocus) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    const frame = window.requestAnimationFrame(() => {
      terminal.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [autoFocus, focusRequestId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const wasAtBottom = terminal.isAtBottom();
    // The surface reports grid changes through onResize, which is the single
    // channel for PTY resize RPCs; fitting here only refreshes the layout.
    const frame = window.requestAnimationFrame(() => {
      terminal.fit();
      if (wasAtBottom) {
        terminal.scrollToBottom();
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [drawerHeight, resizeEpoch, terminalId]);
  return (
    <div
      ref={containerRef}
      data-terminal-viewport={terminalId}
      className="relative h-full w-full overflow-hidden bg-[var(--terminal-background)]"
    />
  );
}

export interface ThreadTerminalDrawerProps {
  mode?: "drawer" | "panel";
  workspaceId: string;
  visible?: boolean;
  height: number;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  focusRequestId: number;
  onSplitTerminal: () => void;
  onSplitTerminalVertical: () => void;
  onNewTerminal: () => void;
  splitShortcutLabel?: string | undefined;
  splitVerticalShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onHeightChange: (height: number) => void;
  /** Prefer link-provided tab titles when present (the shell name, the foreground process). */
  terminalLabelsById?: ReadonlyMap<string, string>;
  /** The workspace's state as the pane shows it; anything but live dims the frame, refuses keys and says why. */
  pane?: TerminalPaneState;
  /** The wake every Wake button calls: the same op the Machine panel uses. */
  onWake?: () => void;
  /** Ptys the daemon no longer holds: their pane says the shell ended and offers a new one. */
  lostTerminalIds?: ReadonlySet<string>;
  /** Bytes in, keys out and resize for one terminal; the drawer itself never talks to the daemon. */
  terminalIo: (terminalId: string) => TerminalIo;
  terminalConfig?: TerminalViewportConfig;
}

interface TerminalActionButtonProps {
  label: string;
  className: string;
  onClick: () => void;
  children: ReactNode;
}

function TerminalActionButton({ label, className, onClick, children }: TerminalActionButtonProps) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        render={<button type="button" className={className} onClick={onClick} aria-label={label} />}
      >
        {children}
      </PopoverTrigger>
      <PopoverPopup
        tooltipStyle
        side="bottom"
        sideOffset={6}
        align="center"
        className="pointer-events-none select-none"
      >
        {label}
      </PopoverPopup>
    </Popover>
  );
}

const LIVE_PANE: TerminalPaneState = { kind: "live" };
const NO_LOST: ReadonlySet<string> = new Set();

/** Seconds since it mounted, ticking on its own clock so the overlay re-renders once a second at most. */
function Elapsed() {
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(since);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="tabular-nums">for {Math.max(0, Math.floor((now - since) / 1000))}s</span>;
}

/**
 * Dims the frozen frame and says why it is frozen. It takes focus only when the pane already held it (the surface
 * or the overlay itself), so a person typing elsewhere keeps their place; a key pressed on it shows the refusal
 * instead of vanishing into a socket that is down. Keys on its own button are the button's.
 */
function TerminalPaneOverlay({ pane, refused, onWake }: { pane: TerminalPaneState; refused: string | null; onWake?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [keyRefused, setKeyRefused] = useState<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.parentElement?.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [pane.kind]);
  const line = refused ?? keyRefused;
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="status"
      data-terminal-overlay={pane.kind}
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/70 px-4 text-center text-sm text-foreground outline-hidden backdrop-blur-[1px]"
      onKeyDown={event => {
        if (event.target !== event.currentTarget || event.key === "Tab" || event.key === "Escape") return;
        event.preventDefault();
        setKeyRefused(terminalInputRefusal(pane));
      }}
    >
      <p className="flex items-baseline gap-1.5">
        <span>{terminalPaneTitle(pane)}</span>
        {pane.kind === "reconnecting" ? <Elapsed key={pane.kind} /> : null}
      </p>
      {pane.kind === "not-answering" || pane.kind === "gone" ? (
        <p className="text-xs text-muted-foreground">Rebuild it from the Machine panel</p>
      ) : null}
      {pane.kind === "paused" && onWake ? (
        <Button size="xs" variant="outline" onClick={onWake}>
          Wake
        </Button>
      ) : null}
      {line !== null ? (
        <p className="text-xs text-muted-foreground" data-terminal-refused>
          {line}
        </p>
      ) : null}
    </div>
  );
}

function ShellGoneOverlay({ onNewTerminal, label }: { onNewTerminal: () => void; label: string }) {
  return (
    <div
      role="status"
      data-terminal-overlay="shell-gone"
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/70 px-4 text-center text-sm text-foreground"
    >
      <p>This shell ended when the machine was replaced</p>
      <Button size="xs" variant="outline" onClick={onNewTerminal}>
        {label}
      </Button>
    </div>
  );
}

export default function ThreadTerminalDrawer({
  mode = "drawer",
  workspaceId,
  visible = true,
  height,
  terminalIds,
  activeTerminalId,
  terminalGroups,
  activeTerminalGroupId,
  focusRequestId,
  onSplitTerminal,
  onSplitTerminalVertical,
  onNewTerminal,
  splitShortcutLabel,
  splitVerticalShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  onActiveTerminalChange,
  onCloseTerminal,
  onHeightChange,
  terminalLabelsById,
  pane = LIVE_PANE,
  onWake,
  lostTerminalIds = NO_LOST,
  terminalIo,
  terminalConfig = EMPTY_CONFIG,
}: ThreadTerminalDrawerProps) {
  const isPanel = mode === "panel";
  const refusalRef = useRef<string | null>(null);
  refusalRef.current = terminalInputRefusal(pane);
  const [refused, setRefused] = useState<string | null>(null);
  const inputRefusal = useCallback(() => refusalRef.current, []);
  const onInputRefused = useCallback((reason: string) => setRefused(reason), []);
  useEffect(() => {
    if (pane.kind === "live") setRefused(null);
  }, [pane.kind]);
  const controlledDrawerHeight = clampDrawerHeight(height);
  const [drawerHeightState, setDrawerHeightState] = useState(() => ({
    workspaceId,
    height: controlledDrawerHeight,
  }));
  const drawerHeight =
    drawerHeightState.workspaceId === workspaceId ? drawerHeightState.height : controlledDrawerHeight;
  const setDrawerHeight = useCallback(
    (update: SetStateAction<number>) => {
      setDrawerHeightState((current) => {
        const currentHeight =
          current.workspaceId === workspaceId ? current.height : controlledDrawerHeight;
        const nextHeight = typeof update === "function" ? update(currentHeight) : update;
        return nextHeight === currentHeight && current.workspaceId === workspaceId
          ? current
          : { workspaceId, height: nextHeight };
      });
    },
    [controlledDrawerHeight, workspaceId],
  );
  const setDrawerHeightFromWindowResize = useEffectEvent((nextHeight: number) => {
    setDrawerHeight(nextHeight);
  });
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const drawerHeightRef = useRef(drawerHeight);
  const lastSyncedHeightRef = useRef(controlledDrawerHeight);
  const onHeightChangeRef = useRef(onHeightChange);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const didResizeDuringDragRef = useRef(false);

  const normalizedTerminalIds = useMemo(() => {
    const normalizedIds: string[] = [];
    const seen = new Set<string>();
    for (const id of terminalIds) {
      const trimmedId = id.trim();
      if (trimmedId.length === 0 || seen.has(trimmedId)) continue;
      seen.add(trimmedId);
      normalizedIds.push(trimmedId);
    }
    return normalizedIds;
  }, [terminalIds]);

  const resolvedActiveTerminalId =
    normalizedTerminalIds.length === 0
      ? ""
      : normalizedTerminalIds.includes(activeTerminalId)
        ? activeTerminalId
        : (normalizedTerminalIds[0] ?? "");

  const resolvedTerminalGroups = useMemo(() => {
    if (normalizedTerminalIds.length === 0) {
      return [];
    }
    const validTerminalIdSet = new Set(normalizedTerminalIds);
    const assignedTerminalIds = new Set<string>();
    const usedGroupIds = new Set<string>();
    const nextGroups: ThreadTerminalGroup[] = [];

    const assignUniqueGroupId = (groupId: string): string => {
      if (!usedGroupIds.has(groupId)) {
        usedGroupIds.add(groupId);
        return groupId;
      }
      let suffix = 2;
      while (usedGroupIds.has(`${groupId}-${suffix}`)) {
        suffix += 1;
      }
      const uniqueGroupId = `${groupId}-${suffix}`;
      usedGroupIds.add(uniqueGroupId);
      return uniqueGroupId;
    };

    for (const terminalGroup of terminalGroups) {
      const nextTerminalIds: string[] = [];
      const seenGroupTerminalIds = new Set<string>();
      for (const id of terminalGroup.terminalIds) {
        const terminalId = id.trim();
        if (terminalId.length === 0) continue;
        if (seenGroupTerminalIds.has(terminalId)) continue;
        seenGroupTerminalIds.add(terminalId);
        if (!validTerminalIdSet.has(terminalId)) continue;
        if (assignedTerminalIds.has(terminalId)) continue;
        nextTerminalIds.push(terminalId);
      }
      if (nextTerminalIds.length === 0) continue;

      for (const terminalId of nextTerminalIds) {
        assignedTerminalIds.add(terminalId);
      }

      const baseGroupId =
        terminalGroup.id.trim().length > 0
          ? terminalGroup.id.trim()
          : `group-${nextTerminalIds[0] ?? normalizedTerminalIds[0] ?? ""}`;
      nextGroups.push({
        id: assignUniqueGroupId(baseGroupId),
        terminalIds: nextTerminalIds,
        ...(terminalGroup.splitDirection === "vertical"
          ? { splitDirection: "vertical" as const }
          : {}),
      });
    }

    for (const terminalId of normalizedTerminalIds) {
      if (assignedTerminalIds.has(terminalId)) continue;
      nextGroups.push({
        id: assignUniqueGroupId(`group-${terminalId}`),
        terminalIds: [terminalId],
      });
    }

    const terminalOrderIndex = new Map(
      normalizedTerminalIds.map((id, index) => [id, index] as const),
    );
    nextGroups.sort((left, right) => {
      const rank = (ids: readonly string[]) =>
        Math.min(...ids.map((id) => terminalOrderIndex.get(id) ?? Number.POSITIVE_INFINITY));
      return rank(left.terminalIds) - rank(right.terminalIds);
    });

    return nextGroups;
  }, [normalizedTerminalIds, terminalGroups]);

  const resolvedActiveGroupIndex = useMemo(() => {
    const indexById = resolvedTerminalGroups.findIndex(
      (terminalGroup) => terminalGroup.id === activeTerminalGroupId,
    );
    if (indexById >= 0) return indexById;
    const indexByTerminal = resolvedTerminalGroups.findIndex((terminalGroup) =>
      terminalGroup.terminalIds.includes(resolvedActiveTerminalId),
    );
    return indexByTerminal >= 0 ? indexByTerminal : 0;
  }, [activeTerminalGroupId, resolvedActiveTerminalId, resolvedTerminalGroups]);

  const visibleTerminalIds =
    resolvedTerminalGroups[resolvedActiveGroupIndex]?.terminalIds ??
    (normalizedTerminalIds.length > 0 ? [resolvedActiveTerminalId] : []);
  const splitDirection =
    resolvedTerminalGroups[resolvedActiveGroupIndex]?.splitDirection ?? "horizontal";
  const hasTerminalSidebar = normalizedTerminalIds.length > 1;
  const isSplitView = visibleTerminalIds.length > 1;
  const showGroupHeaders =
    resolvedTerminalGroups.length > 1 ||
    resolvedTerminalGroups.some((terminalGroup) => terminalGroup.terminalIds.length > 1);
  const hasReachedSplitLimit = visibleTerminalIds.length >= MAX_TERMINALS_PER_GROUP;
  const terminalLabelById = useMemo(() => {
    const next = new Map<string, string>();
    for (const terminalId of normalizedTerminalIds) {
      next.set(terminalId, terminalLabelsById?.get(terminalId) ?? getTerminalLabel(terminalId));
    }
    return next;
  }, [normalizedTerminalIds, terminalLabelsById]);
  const splitTerminalActionLabel = hasReachedSplitLimit
    ? `Split Terminal Horizontally (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitShortcutLabel
      ? `Split Terminal Horizontally (${splitShortcutLabel})`
      : "Split Terminal Horizontally";
  const splitTerminalVerticalActionLabel = hasReachedSplitLimit
    ? `Split Terminal Vertically (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitVerticalShortcutLabel
      ? `Split Terminal Vertically (${splitVerticalShortcutLabel})`
      : "Split Terminal Vertically";
  const newTerminalActionLabel = newShortcutLabel
    ? `New Terminal (${newShortcutLabel})`
    : "New Terminal";
  const closeTerminalActionLabel = closeShortcutLabel
    ? `Close Terminal (${closeShortcutLabel})`
    : "Close Terminal";
  const onSplitTerminalAction = useCallback(() => {
    if (hasReachedSplitLimit) return;
    onSplitTerminal();
  }, [hasReachedSplitLimit, onSplitTerminal]);
  const onSplitTerminalVerticalAction = useCallback(() => {
    if (hasReachedSplitLimit) return;
    onSplitTerminalVertical();
  }, [hasReachedSplitLimit, onSplitTerminalVertical]);
  const onNewTerminalAction = useCallback(() => {
    onNewTerminal();
  }, [onNewTerminal]);

  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  }, [onHeightChange]);

  useEffect(() => {
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  const syncHeight = useCallback((nextHeight: number) => {
    const clampedHeight = clampDrawerHeight(nextHeight);
    if (lastSyncedHeightRef.current === clampedHeight) return;
    lastSyncedHeightRef.current = clampedHeight;
    onHeightChangeRef.current(clampedHeight);
  }, []);

  useEffect(() => {
    lastSyncedHeightRef.current = controlledDrawerHeight;
  }, [controlledDrawerHeight, workspaceId]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    didResizeDuringDragRef.current = false;
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: drawerHeightRef.current,
    };
  }, []);

  const handleResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      event.preventDefault();
      const clampedHeight = clampDrawerHeight(
        resizeState.startHeight + (resizeState.startY - event.clientY),
      );
      if (clampedHeight === drawerHeightRef.current) {
        return;
      }
      didResizeDuringDragRef.current = true;
      drawerHeightRef.current = clampedHeight;
      setDrawerHeight(clampedHeight);
    },
    [setDrawerHeight],
  );

  const handleResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      resizeStateRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!didResizeDuringDragRef.current) {
        return;
      }
      syncHeight(drawerHeightRef.current);
      setResizeEpoch((value) => value + 1);
    },
    [syncHeight],
  );

  useEffect(() => {
    if (!visible) {
      return;
    }

    const onWindowResize = () => {
      const clampedHeight = clampDrawerHeight(drawerHeightRef.current);
      const changed = clampedHeight !== drawerHeightRef.current;
      if (changed) {
        setDrawerHeightFromWindowResize(clampedHeight);
        drawerHeightRef.current = clampedHeight;
      }
      if (!resizeStateRef.current) {
        syncHeight(clampedHeight);
      }
      setResizeEpoch((value) => value + 1);
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("resize", onWindowResize);
    };
  }, [syncHeight, visible]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    setResizeEpoch((value) => value + 1);
  }, [visible]);

  useEffect(() => {
    return () => {
      syncHeight(drawerHeightRef.current);
    };
  }, [syncHeight]);

  if (normalizedTerminalIds.length === 0) {
    return (
      <aside
        data-terminal-owner={isPanel ? "right-panel" : "drawer"}
        className={cn(
          "thread-terminal-drawer relative flex min-w-0 flex-col overflow-hidden bg-background",
          isPanel ? "h-full flex-1" : "shrink-0 border-t border-border/80",
        )}
        style={isPanel ? undefined : { height: `${drawerHeight}px` }}
      >
        {!isPanel ? (
          <div
            className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerEnd}
            onPointerCancel={handleResizePointerEnd}
          />
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 py-6 text-center text-sm text-muted-foreground" data-terminal-empty={pane.kind}>
          {pane.kind === "live" ? (
            <>
              <p>No terminals for this workspace yet.</p>
              <Button size="xs" variant="outline" onClick={onNewTerminalAction}>
                {newTerminalActionLabel}
              </Button>
            </>
          ) : (
            <>
              <p>{terminalEmptyLine(pane)}</p>
              {pane.kind === "paused" && onWake ? (
                <Button size="xs" variant="outline" onClick={onWake}>
                  Wake
                </Button>
              ) : null}
            </>
          )}
        </div>
      </aside>
    );
  }

  const viewport = (terminalId: string, autoFocus: boolean) => (
    <TerminalViewport
      terminalId={terminalId}
      io={terminalIo(terminalId)}
      config={terminalConfig}
      focusRequestId={focusRequestId}
      autoFocus={autoFocus}
      resizeEpoch={resizeEpoch}
      drawerHeight={drawerHeight}
      inputRefusal={inputRefusal}
      onInputRefused={onInputRefused}
    />
  );
  const activeLost = lostTerminalIds.has(resolvedActiveTerminalId);

  return (
    <aside
      data-terminal-owner={isPanel ? "right-panel" : "drawer"}
      className={cn(
        "thread-terminal-drawer relative flex min-w-0 flex-col overflow-hidden bg-background",
        isPanel ? "h-full flex-1" : "shrink-0 border-t border-border/80",
      )}
      style={isPanel ? undefined : { height: `${drawerHeight}px` }}
    >
      {!isPanel ? (
        <div
          className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerEnd}
          onPointerCancel={handleResizePointerEnd}
        />
      ) : null}

      {!hasTerminalSidebar && (
        <div className="pointer-events-none absolute right-2 top-2 z-20">
          <div className="pointer-events-auto inline-flex items-center overflow-hidden rounded-md border border-border/80 bg-background shadow-xs">
            <TerminalActionButton
              className={`p-1 text-foreground/90 transition-colors ${
                hasReachedSplitLimit
                  ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                  : "hover:bg-accent"
              }`}
              onClick={onSplitTerminalAction}
              label={splitTerminalActionLabel}
            >
              <SquareSplitHorizontal className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className={`p-1 text-foreground/90 transition-colors ${
                hasReachedSplitLimit
                  ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                  : "hover:bg-accent"
              }`}
              onClick={onSplitTerminalVerticalAction}
              label={splitTerminalVerticalActionLabel}
            >
              <SquareSplitVertical className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className="p-1 text-foreground/90 transition-colors hover:bg-accent"
              onClick={onNewTerminalAction}
              label={newTerminalActionLabel}
            >
              <Plus className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className="p-1 text-foreground/90 transition-colors hover:bg-accent"
              onClick={() => onCloseTerminal(resolvedActiveTerminalId)}
              label={closeTerminalActionLabel}
            >
              <Trash2 className="size-3.25" />
            </TerminalActionButton>
          </div>
        </div>
      )}

      <div className="relative min-h-0 w-full flex-1">
        {pane.kind !== "live" ? (
          <TerminalPaneOverlay pane={pane} refused={refused} {...(onWake !== undefined ? { onWake } : {})} />
        ) : activeLost ? (
          <ShellGoneOverlay onNewTerminal={onNewTerminalAction} label={newTerminalActionLabel} />
        ) : null}
        <div
          className={cn(
            "flex h-full min-h-0 bg-[var(--terminal-background)]",
            hasTerminalSidebar && "gap-1.5",
          )}
        >
          <div className="min-w-0 flex-1">
            {isSplitView ? (
              <div
                className="grid h-full w-full min-w-0 gap-0 overflow-hidden"
                style={
                  splitDirection === "vertical"
                    ? {
                        gridTemplateRows: `repeat(${visibleTerminalIds.length}, minmax(0, 1fr))`,
                      }
                    : {
                        gridTemplateColumns: `repeat(${visibleTerminalIds.length}, minmax(0, 1fr))`,
                      }
                }
              >
                {visibleTerminalIds.map((terminalId) => (
                  <div
                    key={terminalId}
                    className={`min-h-0 min-w-0 ${
                      splitDirection === "vertical"
                        ? "border-t first:border-t-0"
                        : "border-l first:border-l-0"
                    } ${
                      terminalId === resolvedActiveTerminalId
                        ? "border-border"
                        : "border-border/70"
                    }`}
                    onMouseDown={() => {
                      if (terminalId !== resolvedActiveTerminalId) {
                        onActiveTerminalChange(terminalId);
                      }
                    }}
                  >
                    <div className="h-full">{viewport(terminalId, terminalId === resolvedActiveTerminalId)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-full" key={resolvedActiveTerminalId}>
                {viewport(resolvedActiveTerminalId, true)}
              </div>
            )}
          </div>

          {hasTerminalSidebar && (
            <aside className="flex w-36 min-w-36 flex-col border border-border/70 bg-muted/10">
              <div className="flex h-[22px] items-stretch justify-end border-b border-border/70">
                <div className="inline-flex h-full items-stretch">
                  <TerminalActionButton
                    className={`inline-flex h-full items-center px-1 text-foreground/90 transition-colors ${
                      hasReachedSplitLimit
                        ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                        : "hover:bg-accent/70"
                    }`}
                    onClick={onSplitTerminalAction}
                    label={splitTerminalActionLabel}
                  >
                    <SquareSplitHorizontal className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className={`inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors ${
                      hasReachedSplitLimit
                        ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                        : "hover:bg-accent/70"
                    }`}
                    onClick={onSplitTerminalVerticalAction}
                    label={splitTerminalVerticalActionLabel}
                  >
                    <SquareSplitVertical className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className="inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors hover:bg-accent/70"
                    onClick={onNewTerminalAction}
                    label={newTerminalActionLabel}
                  >
                    <Plus className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className="inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors hover:bg-accent/70"
                    onClick={() => onCloseTerminal(resolvedActiveTerminalId)}
                    label={closeTerminalActionLabel}
                  >
                    <Trash2 className="size-3.25" />
                  </TerminalActionButton>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
                {resolvedTerminalGroups.map((terminalGroup) => {
                  const isGroupActive =
                    terminalGroup.terminalIds.includes(resolvedActiveTerminalId);
                  const groupActiveTerminalId = isGroupActive
                    ? resolvedActiveTerminalId
                    : (terminalGroup.terminalIds[0] ?? resolvedActiveTerminalId);
                  const terminalCount = terminalGroup.terminalIds.length;
                  const isSplitGroup = terminalCount > 1;
                  const groupLabel = !isSplitGroup
                    ? "Single"
                    : terminalGroup.splitDirection === "vertical"
                      ? "Stacked"
                      : "Side by side";
                  const GroupIcon = !isSplitGroup
                    ? Square
                    : terminalGroup.splitDirection === "vertical"
                      ? SquareSplitVertical
                      : SquareSplitHorizontal;

                  return (
                    <div key={terminalGroup.id} className="pb-0.5">
                      {showGroupHeaders && (
                        <button
                          type="button"
                          className={`flex h-[22px] w-full cursor-pointer items-center gap-1 rounded px-1.5 text-[11px] ${
                            isGroupActive
                              ? "bg-accent/50 text-foreground"
                              : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                          }`}
                          onClick={() => onActiveTerminalChange(groupActiveTerminalId)}
                        >
                          <GroupIcon className="size-3 shrink-0" />
                          <span className="min-w-0 flex-1 truncate text-left">{groupLabel}</span>
                          <span className="text-muted-foreground/70 text-[10px] tabular-nums">
                            {terminalCount}
                          </span>
                        </button>
                      )}

                      <div className="flex flex-col gap-0.5">
                        {terminalGroup.terminalIds.map((terminalId) => {
                          const isActive = terminalId === resolvedActiveTerminalId;
                          const terminalLabel = terminalLabelById.get(terminalId) ?? "Terminal";
                          const closeTerminalLabel = `Close ${terminalLabel}${
                            isActive && closeShortcutLabel ? ` (${closeShortcutLabel})` : ""
                          }`;
                          return (
                            <div
                              key={terminalId}
                              className={cn(
                                "group/tab flex h-6 w-full items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs",
                                isActive
                                  ? "bg-accent text-foreground"
                                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                              )}
                            >
                              <PanelTabCloseButton
                                label={closeTerminalLabel}
                                onClick={() => onCloseTerminal(terminalId)}
                                tooltip={closeTerminalLabel}
                              >
                                <TerminalSquare className="size-3 shrink-0" />
                              </PanelTabCloseButton>
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left"
                                onClick={() => onActiveTerminalChange(terminalId)}
                              >
                                <span className="truncate">{terminalLabel}</span>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </aside>
          )}
        </div>
      </div>
    </aside>
  );
}
