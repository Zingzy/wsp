// SPDX-License-Identifier: AGPL-3.0-only
// What every settings page is drawn from, composed once: the host's records
// off the store, the reads the page made, the clock, which shell holds the
// page, and the acts a row can raise. A page is a plain function of this, so
// the search can walk every group's rows with one call each and the sidebar
// can dim a group with no match.
import type { AccountView, PlaceView, Preferences, PreferencesPatch, ProjectView, ReleaseView, SessionView, WorkspaceLanding, WorkspaceStatus, WorkspaceView } from "@wsp/protocol";
import { useNowMinute } from "../hooks/useNowMinute.js";
import { isDesktopShell } from "../lib/desktopShell.js";
import type { Api } from "../protocol/client.js";
import { useStore } from "../protocol/store.js";
import { shellVersions } from "../shell/shellVersion.js";
import { CLOUD_NAMES } from "./providers.js";
import { resolveAt, useSettingsStore, type SettingsAt, type SettingsReads } from "./settingsStore.js";

export interface SettingsContext {
  readonly preferences: Preferences;
  readonly places: ReadonlyArray<PlaceView>;
  readonly projects: ReadonlyArray<ProjectView>;
  readonly workspaces: ReadonlyArray<WorkspaceView>;
  readonly sessions: Readonly<Record<string, SessionView[]>>;
  readonly statuses: Readonly<Record<string, WorkspaceStatus>>;
  readonly landings: Readonly<Record<string, WorkspaceLanding | null>>;
  readonly reads: SettingsReads;
  readonly now: number;
  readonly shell: { readonly inShell: boolean; readonly app: string | undefined; readonly host: string | undefined };
  /** The newest release as the host last read it; null where it gave none. */
  readonly release: ReleaseView | null;
  readonly platform: string;
  readonly desktopShell: boolean;
  readonly api: Api | null;
  readonly go: (at: SettingsAt) => void;
  readonly setPreferences: (patch: PreferencesPatch) => void;
  readonly openAddComputer: () => void;
  readonly openSetup: () => void;
  readonly openAddProject: () => void;
  readonly rereadDevices: () => void;
  readonly toast: (line: string) => void;
}

/** The account read as the row reads it: the record, or null before an answer and after a refusal alike. */
export const accountOf = (reads: SettingsReads): AccountView | null => reads.account;

export function useSettingsContext(): SettingsContext {
  const preferences = useStore(s => s.preferences);
  const places = useStore(s => s.places);
  const projects = useStore(s => s.projects);
  const workspaces = useStore(s => s.workspaces);
  const sessions = useStore(s => s.sessions);
  const statuses = useStore(s => s.statuses);
  const landings = useStore(s => s.landings);
  const api = useStore(s => s.api);
  const release = useStore(s => s.release);
  const reads = useSettingsStore(s => s.reads);
  // The minute clock every countdown in the app reads, as a stamp.
  const now = Date.parse(`${useNowMinute()}:00Z`);
  return {
    preferences,
    places,
    projects,
    workspaces,
    sessions,
    statuses,
    landings,
    reads,
    now,
    shell: shellVersions(),
    release,
    platform: navigator.platform,
    desktopShell: isDesktopShell(),
    api,
    go: at => useSettingsStore.getState().go(at),
    setPreferences: patch => void useStore.getState().setPreferences(patch),
    openAddComputer: () => useStore.getState().openAddComputer(),
    openSetup: () => useStore.getState().openSetup(),
    openAddProject: () => useSettingsStore.getState().openAddProject(),
    rereadDevices: () => useSettingsStore.getState().rereadDevices(),
    toast: line => useStore.setState({ toast: line }),
  };
}

/** The cloud whose page a toast's Open lands on with the image sheet over it: the one this host builds at. */
const SETUP_CLOUD = CLOUD_NAMES.find(row => row.id === "solari")!;

/** The page Settings is on: the image sheet overrides the memory while it stands, then a remembered page whose
 * noun is gone falls back to its group. While the image sheet is asked for the page is the cloud's, so the sheet
 * stands over the rows it is about, and the remembered page comes back when it shuts. The Add a computer door is
 * not an override but a move: it writes Computers as the page, so the computer it adds is on the list the person
 * is left on. */
export function useSettingsAt(): SettingsAt {
  const stored = useSettingsStore(s => s.at);
  const setupOpen = useStore(s => s.setupOpen);
  const places = useStore(s => s.places);
  const projects = useStore(s => s.projects);
  if (setupOpen) return resolveAt({ kind: "computer", id: SETUP_CLOUD.id }, places, projects);
  return resolveAt(stored, places, projects);
}
