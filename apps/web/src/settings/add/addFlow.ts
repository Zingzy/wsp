// SPDX-License-Identifier: AGPL-3.0-only
// Add a computer as the dialog walks it: where, the checks and the install,
// the picks step by step, the summary, then the setup running. The install is
// the host's add over ssh and its steps; the picks are kept on the pending add
// as they move, so closing the dialog leaves the computer pending with them;
// Set up hands them to the host. Which step a pending add was left at is this
// window's own, kept beside its id.
import { create } from "zustand";
import { PLACE_HOST_KEY_KIND, type PendingComputer, type PlaceAddJob, type PlaceEstimate, type PlaceSetup, type PlaceView, type ProjectIcon, type RecipeFile, type RecipeOptions } from "@wsp/protocol";
import { noticeFailure } from "../../notices/store.js";
import type { Api } from "../../protocol/client.js";
import { useStore } from "../../protocol/store.js";
import { failureOf, type Failure } from "../../protocol/failure.js";
import { addOverSsh } from "../adds.js";
import { ADD_COMPUTER_WORDS } from "../format.js";

/** The steps a person walks, in the order they run. Start from stands only where a recipe is saved. */
export const ADD_STEPS = ["where", "checks", "startfrom", "agents", "mcp", "clis", "skills", "plugins", "github", "projects", "other", "summary"] as const;
export type AddStep = (typeof ADD_STEPS)[number] | "running" | "ready";

/** The title of each step a person walks. */
export const STEP_TITLES: Record<Exclude<AddStep, "running" | "ready">, string> = {
  where: ADD_COMPUTER_WORDS.title,
  checks: "Checks",
  startfrom: "Start from",
  agents: "Agents",
  mcp: "MCP servers",
  clis: "CLIs",
  skills: "Skills",
  plugins: "Plugins",
  github: "GitHub",
  projects: "Import projects",
  other: "Other config",
  summary: "Summary",
};

/** The first step past the install: Start from where a recipe is saved, else Agents. */
export const firstPick = (recipes: number): AddStep => (recipes > 0 ? "startfrom" : "agents");

/** The steps this add walks, Start from left out where no recipe is saved. */
export const stepsFor = (recipes: number): readonly AddStep[] => ADD_STEPS.filter(step => step !== "startfrom" || recipes > 0);

interface SaveAs {
  on: boolean;
  name: string;
  icon: ProjectIcon;
}

interface AddFlowState {
  open: boolean;
  step: AddStep;
  /** The address typed or picked. */
  address: string;
  /** The install this dialog started, by its stream. */
  addId: string | null;
  /** The computer once it joined. */
  placeId: string | null;
  /** The pending add standing for it until Set up. */
  pendingId: string | null;
  picks: RecipeFile | null;
  /** The saved recipe the picks started from, by slug; "here" is everything, "none" is nothing. */
  from: string;
  options: RecipeOptions | null;
  optionsRefused: Failure | null;
  saveAs: SaveAs;
  /** How many saves have landed in this dialog: the foot's check draws in once more on each. */
  saves: number;
  /** Set up asked and not answered, and its refusal where it was refused. */
  starting: boolean;
  refused: Failure | null;
  /** What the picks weigh against the computer's room, read on the summary; null until the host answered. */
  estimate: PlaceEstimate | null;
}

const CLOSED: AddFlowState = { open: false, step: "where", address: "", addId: null, placeId: null, pendingId: null, picks: null, from: "here", options: null, optionsRefused: null, saveAs: { on: false, name: "", icon: "rocket" }, saves: 0, starting: false, refused: null, estimate: null };

export const useAddFlow = create<AddFlowState>(() => CLOSED);

const REACHED_KEY = "wsp:add-reached";

/** The record last parsed and the text it was parsed from, so a render reads a string and parses only a change. */
let reached: { raw: string | null; held: Record<string, AddStep> } = { raw: null, held: {} };

/** The step each pending add was left at in this window, by the pending add's id. */
export function reachedSteps(): Record<string, AddStep> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(REACHED_KEY);
  } catch {
    return {};
  }
  if (raw === reached.raw) return reached.held;
  let held: unknown = {};
  try {
    held = JSON.parse(raw ?? "{}") as unknown;
  } catch {
    held = {};
  }
  reached = { raw, held: held !== null && typeof held === "object" ? (held as Record<string, AddStep>) : {} };
  return reached.held;
}

function keepReached(pendingId: string, step: AddStep | null): void {
  if (step !== null && reachedSteps()[pendingId] === step) return;
  const held = { ...reachedSteps() };
  if (step === null) delete held[pendingId];
  else held[pendingId] = step;
  try {
    localStorage.setItem(REACHED_KEY, JSON.stringify(held));
  } catch {
    // A window that keeps nothing opens a pending add at its first pick.
  }
}

export function openAdd(): void {
  useAddFlow.setState({ ...CLOSED, open: true });
}

/** A pending add opened again: where it was left, with its picks. An add that never joined opens at Where. */
export function openPending(pending: PendingComputer, recipes: number): void {
  if (pending.placeId === undefined) {
    useAddFlow.setState({ ...CLOSED, open: true, address: pending.address, pendingId: pending.id });
    return;
  }
  const step = reachedSteps()[pending.id] ?? firstPick(recipes);
  useAddFlow.setState({ ...CLOSED, open: true, address: pending.address, placeId: pending.placeId, pendingId: pending.id, picks: pending.choices, from: pending.recipe ?? "here", step: step === "startfrom" && recipes === 0 ? "agents" : step });
}

/** A computer being set up, opened on its running steps. */
export function openSetup(placeId: string): void {
  useAddFlow.setState({ ...CLOSED, open: true, placeId, step: "running" });
}

/** Closes the dialog: picks not yet kept are kept now, and the next open starts from what it opens on. */
export function closeAdd(): void {
  keepNow();
  useAddFlow.setState(CLOSED);
}

export function go(step: AddStep): void {
  const { pendingId } = useAddFlow.getState();
  useAddFlow.setState({ step });
  if (pendingId !== null && step !== "running" && step !== "ready") keepReached(pendingId, step);
}

/** Asks the host to add the computer over ssh, with the key the person trusted where one was asked. */
export function connect(api: Api, address: string, hostKey?: string): void {
  const addId = addOverSsh(api, { address: address.trim(), ...(hostKey === undefined ? {} : { hostKey }) });
  useAddFlow.setState({ address: address.trim(), addId, step: "checks" });
}

/** The key a computer this one never dialled answered with, on an add refused for it, for the person to trust. */
export const askedHostKey = (job: PlaceAddJob | undefined): string | undefined => (job?.state === "failed" && job.kind === PLACE_HOST_KEY_KIND ? job.hostKey : undefined);

/** Reads what the picks can be made from, once per dialog. */
export function readOptions(api: Api): void {
  if (api.recipesOptions === undefined || useAddFlow.getState().options !== null) return;
  void api.recipesOptions().then(
    options => useAddFlow.setState({ options, optionsRefused: null }),
    (e: unknown) => useAddFlow.setState({ optionsRefused: failureOf(e) }),
  );
}

/** The setup a start answered, onto the computer's row at once: its frames fold onto that run, not the one before. */
function showSetup(answer: { place: PlaceView; setup?: PlaceSetup }): void {
  useStore.setState(s => ({ places: s.places.map(p => (p.id === answer.place.id ? { ...answer.place, ...(answer.setup === undefined ? {} : { setup: answer.setup }) } : p)) }));
}

/** How long picks rest before they are kept: a burst of ticks or a name typed is one write. */
const KEEP_AFTER_MS = 400;
let keeping: { timer: ReturnType<typeof setTimeout>; write: () => void } | undefined;

/** The write that waits, made now. */
function keepNow(): void {
  if (keeping === undefined) return;
  clearTimeout(keeping.timer);
  const { write } = keeping;
  keeping = undefined;
  write();
}

/** The picks as they now stand, kept on the pending add a moment after the last change, and said saved. */
export function setPicks(api: Api | null, picks: RecipeFile, from?: string): void {
  useAddFlow.setState(s => ({ picks, ...(from === undefined ? {} : { from }), saves: s.saves + 1, estimate: null }));
  const { placeId, from: started } = useAddFlow.getState();
  if (keeping !== undefined) clearTimeout(keeping.timer);
  const write = (): void => {
    if (api?.placesChoose === undefined || placeId === null) return;
    void api.placesChoose(placeId, picks, started === "here" || started === "none" ? undefined : started).catch(() => undefined);
  };
  keeping = {
    timer: setTimeout(() => {
      keeping = undefined;
      write();
    }, KEEP_AFTER_MS),
    write,
  };
}

/** Weighs the picks against the computer's room. An answer for picks that have moved on since is dropped, and a host
 * that would not weigh them leaves the summary on the room alone. */
export function weigh(api: Api, placeId: string, picks: RecipeFile): void {
  if (api.placesEstimate === undefined) return;
  void api.placesEstimate(placeId, picks).then(
    estimate => {
      if (useAddFlow.getState().picks === picks) useAddFlow.setState({ estimate });
    },
    () => undefined,
  );
}

/** Whether the picks need more room than the computer has free, as last weighed. */
export const tooBig = (estimate: PlaceEstimate | null): boolean => estimate?.freeBytes !== undefined && estimate.freeBytes < estimate.neededBytes;

export function setSaveAs(next: Partial<SaveAs>): void {
  useAddFlow.setState(s => ({ saveAs: { ...s.saveAs, ...next } }));
}

/** Set up: the picks to the host, and the running steps; then, where the person asked, the picks saved as a recipe
 * the computer follows, its icon kept with the person's other looks. A recipe the host would not save is said as a
 * notice, since the setup it would have named is already running. */
export async function setUp(api: Api, setIcon: (slug: string, icon: ProjectIcon) => void): Promise<void> {
  const { placeId, picks, saveAs, pendingId } = useAddFlow.getState();
  if (placeId === null || picks === null || api.placesSetup === undefined) return;
  if (keeping !== undefined) clearTimeout(keeping.timer);
  keeping = undefined;
  useAddFlow.setState({ starting: true, refused: null });
  try {
    showSetup(await api.placesSetup(placeId, { choices: picks }));
  } catch (e) {
    useAddFlow.setState({ starting: false, refused: failureOf(e) });
    return;
  }
  if (pendingId !== null) keepReached(pendingId, null);
  useAddFlow.setState({ starting: false, step: "running" });
  if (!saveAs.on || saveAs.name.trim() === "" || api.recipesSave === undefined) return;
  await api.recipesSave(saveAs.name.trim(), { computer: placeId }).then(
    saved => setIcon(saved.slug, saveAs.icon),
    (e: unknown) => noticeFailure(e),
  );
}

/** Retry on a computer whose setup missed something: the host runs again whatever is not there. */
export async function retrySetup(api: Api | null, placeId: string): Promise<Failure | null> {
  if (api?.placesSetup === undefined) return null;
  try {
    showSetup(await api.placesSetup(placeId, {}));
    return null;
  } catch (e) {
    return failureOf(e);
  }
}
