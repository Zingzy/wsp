// SPDX-License-Identifier: AGPL-3.0-only
// The workspace-level words for a daemon link, read from the one state table:
// what a pane says over its frame, and the word and sentence a resting tile
// carries while the link is down. Both come from the same pane state, so the sidebar
// and a pane can never say two things about one link. Beside them, the one
// read of a folder's branch over the link, keyed on the link's word.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isLocalWorkspace, workspaceStateOf, type DaemonLinkStatus, type PlaceView, type RepoStateWord, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { linkDownLine, linkDownWord, terminalPaneHints, terminalPaneState, type TerminalPaneState } from "../adapt/index.js";
import { repoAbsence } from "../adapt/git.js";
import { useOutOfMemoryReading } from "../machine/live.js";
import { useCapabilities, usePlaces, useStatus, useStore, useWorkspace } from "../protocol/store.js";
import { absenceOf } from "../settings/places.js";
import { computerName } from "../sidebar/workspaceRows.js";
import { gitStatus } from "./daemon-fs.js";
import { everyTerminals, getTerminals, NOT_OPENED_YET, onTerminals, type TerminalWire } from "./link.js";

/** A link's pane state off the store's record of its workspace: the one reading useTerminalPane and the sidebar's
 * link words both take, so a tile and a pane cannot say two things about one link. */
function paneOf(input: { workspace: WorkspaceView | null; status: WorkspaceStatus | null; places: readonly PlaceView[]; socket: DaemonLinkStatus; refusal: string | null; outOfMemory?: Parameters<typeof terminalPaneState>[0]["outOfMemory"] }): TerminalPaneState {
  const { workspace, status } = input;
  const view = status ?? workspace;
  const local = workspace !== null && isLocalWorkspace(workspace);
  // What this link's sentences name: the person's own computer by its name once the places list holds it, else the
  // workspace, which on a machine wsp forked is that machine's own name.
  const computer = workspace === null ? "" : computerName(input.places, { workspace, status });
  const where = local && computer !== "" ? computer : (workspace?.name ?? "");
  return terminalPaneState({
    state: view === null ? "running" : workspaceStateOf(view, status),
    reach: status?.reach.state ?? null,
    socket: input.socket,
    outOfMemory: input.outOfMemory ?? null,
    refusal: input.refusal,
    local,
    absent: absenceOf(input.places, workspace, status, null),
    ...(where === "" ? {} : { where }),
  });
}

/** The pane's state from the workspace's one vocabulary plus this link's socket and its last memory reading, the
 * lines under it, and the wake every pane offers. */
export function useTerminalPane(workspaceId: string, socket: DaemonLinkStatus, refusal: string | null = null): { pane: TerminalPaneState; hints: string[]; onWake: () => void } {
  const workspace = useWorkspace(workspaceId);
  const status = useStatus(workspaceId);
  const capabilities = useCapabilities();
  const wake = useStore(s => s.wake);
  const places = usePlaces();
  const phase = status?.phase ?? workspace?.phase ?? "running";
  const outOfMemory = useOutOfMemoryReading(workspaceId, phase);
  const pane = useMemo(() => paneOf({ workspace, status, places, socket, refusal, outOfMemory }), [workspace, status, places, socket, refusal, outOfMemory]);
  const size = status?.size ?? null;
  const sizes = capabilities?.sizes ?? null;
  const hints = useMemo(() => terminalPaneHints(pane, size, sizes), [pane, size, sizes]);
  const onWake = useCallback(() => void wake(workspaceId), [wake, workspaceId]);
  return { pane, hints, onWake };
}

const NEVER = (): (() => void) => () => {};

/** This workspace's link as the registry holds it, for a surface that draws no pane of its own. A workspace with no
 * model yet reads as a link nothing has been open on, which is what it is. */
export function useLinkSocket(workspaceId: string | null): { socket: DaemonLinkStatus; refusal: string | null } {
  const terms = useSyncExternalStore(onTerminals, () => (workspaceId === null ? null : getTerminals(workspaceId)));
  const subscribe = useCallback((fn: () => void) => terms?.onStatus(fn) ?? NEVER(), [terms]);
  const socket = useSyncExternalStore(subscribe, () => terms?.status() ?? NOT_OPENED_YET);
  const refusal = useSyncExternalStore(subscribe, () => terms?.refusal() ?? null);
  return { socket, refusal };
}

/** The word every git read over this workspace's wire keys on, so each reader asks again when the link changes it.
 * The wire is handed out before the link's first status lands, and a read made over a link that is not up yet comes
 * back unreachable: asked once, that failure stands as the reader's last word for the whole of a session, on a folder
 * it could read fine. The composer's folder row and the Diff pane's header both read the folder's branch, and both
 * key their read on this. */
export function useLinkWord(workspaceId: string | null): DaemonLinkStatus {
  return useLinkSocket(workspaceId).socket;
}

/** What git said about a folder: a branch, or a state a slot draws as nothing. */
export type Branch = { readonly kind: RepoStateWord } | { readonly kind: "repo"; readonly head: string };

const UNKNOWN: Branch = { kind: "unknown" };

/** A turn running in the folder: while it runs the answer in hand stands, since a checkout inside it shows once it
 * ends, and `moved` is what asks again while there is no answer yet. */
export interface BranchTurn {
  readonly running: boolean;
  readonly moved: number;
}

/** The branch git names for a folder over a workspace's wire, asked while `ask` holds and again every time the link
 * changes its word, the rule useLinkWord carries. The last answer for the same folder stands between asks. With a
 * turn, a folder with no answer yet, or one whose read failed, is asked again as the turn moves, since the first ask
 * can go out before a new copy's folder is there. A read in flight is kept until it settles; only a new wire, folder
 * or link word drops it, so a turn moving faster than a round trip still gets its answer and never stacks one read
 * per entry. The composer's folder row reads this for a folder other than its workspace's own checkout. */
export function useBranch(wire: TerminalWire | null, folder: string | null, ask: boolean, link: DaemonLinkStatus, turn?: BranchTurn): Branch {
  const [state, setState] = useState<{ folder: string | null; branch: Branch }>({ folder, branch: UNKNOWN });
  const [again, setAgain] = useState(0);
  const epoch = useRef(0);
  const flying = useRef(false);
  const movedNow = useRef(turn?.moved ?? 0);
  movedNow.current = turn?.moved ?? 0;
  useEffect(() => {
    epoch.current += 1;
    flying.current = false;
  }, [wire, folder, link]);
  const known = state.folder === folder && (state.branch.kind === "repo" || state.branch.kind === "none");
  const key = !ask ? "off" : turn === undefined || !turn.running ? "idle" : known ? "held" : `${turn.moved}:${again}`;
  useEffect(() => {
    if (!wire || folder === null || key === "off" || key === "held" || flying.current) return;
    const at = epoch.current;
    const askedAt = movedNow.current;
    flying.current = true;
    const land = (branch: Branch): void => {
      if (epoch.current !== at) return;
      flying.current = false;
      setState({ folder, branch });
      // The turn moved while this read was out: one more ask, now that nothing is in flight.
      if (movedNow.current !== askedAt) setAgain(n => n + 1);
    };
    gitStatus(wire, folder).then(
      status => land({ kind: "repo", head: status.branch.head }),
      (e: unknown) => land({ kind: repoAbsence(e) }),
    );
  }, [wire, folder, link, key]);
  return state.folder === folder ? state.branch : UNKNOWN;
}

/** A workspace's link being down, as a resting tile shows it: one word in its slot and the pane's sentence on its
 * hover. */
export interface LinkDown {
  readonly word: string;
  readonly sentence: string;
}

const NO_LINKS_DOWN: Readonly<Record<string, LinkDown>> = {};

const sameDowns = (a: Readonly<Record<string, LinkDown>>, b: Readonly<Record<string, LinkDown>>): boolean => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => a[k]!.word === b[k]?.word && a[k]!.sentence === b[k]?.sentence);
};

/** Every workspace whose link is down, for the sidebar's tiles: one subscription over the links there are, and the
 * same object while nothing changes. A workspace with no link open is not down. */
export function useLinkDowns(): Readonly<Record<string, LinkDown>> {
  const workspaces = useStore(s => s.workspaces);
  const statuses = useStore(s => s.statuses);
  const places = usePlaces();
  const last = useRef(NO_LINKS_DOWN);
  const subscribe = useCallback((fn: () => void) => {
    let offs: Array<() => void> = [];
    const watch = () => {
      offs.forEach(off => off());
      offs = [...everyTerminals()].map(([, terms]) => terms.onStatus(fn));
    };
    watch();
    const offRegistry = onTerminals(() => {
      watch();
      fn();
    });
    return () => {
      offRegistry();
      offs.forEach(off => off());
    };
  }, []);
  const snapshot = useCallback(() => {
    const next: Record<string, LinkDown> = {};
    for (const [id, terms] of everyTerminals()) {
      const workspace = workspaces.find(w => w.id === id) ?? null;
      const status = statuses[id] ?? null;
      if (workspace === null && status === null) continue;
      const pane = paneOf({ workspace, status, places, socket: terms.status(), refusal: terms.refusal() });
      const sentence = linkDownLine(pane);
      const word = linkDownWord(pane);
      if (sentence !== null && word !== null) next[id] = { word, sentence };
    }
    if (!sameDowns(last.current, next)) last.current = Object.keys(next).length === 0 ? NO_LINKS_DOWN : next;
    return last.current;
  }, [places, statuses, workspaces]);
  return useSyncExternalStore(subscribe, snapshot);
}
