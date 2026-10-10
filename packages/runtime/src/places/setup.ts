// SPDX-License-Identifier: AGPL-3.0-only
import { AsyncLocalStorage } from "node:async_hooks";
import {
  NO_RECIPE,
  absentComputer,
  placeNoHomeLine,
  placeNoPicksLine,
  placeProvisionPaths,
  placeProvisioningLine,
  EXEC_DEADLINE_EXIT,
  placeSyncingLine,
  setupRowFix,
  ghStatusOf,
  provisionLogLine,
  RecipeFile,
  lastLine,
  SETUP_STEP_WORDS,
  SIGN_IN_WAIT_MS,
  copiedFromLine,
  copiedNotSignedInLine,
  SIGNED_IN_THERE,
  NO_SIGN_IN_ROAD,
  NO_FOLDER_ROAD,
  noCopyLine,
  signInThereFix,
  signInWithFix,
  GITHUB_ROW,
  GITHUB_CLI,
  signInRowId,
  signInOfRow,
  agentOfRow,
  AT_ITS_TERMINAL,
  waitsForInstallLine,
  GITHUB_SKIPPED_LINE,
  NEEDS_GITHUB_LINE,
  WAITS_ON_GITHUB_LINE,
  SKIPPED_FOR_NOW,
  wasThereLine,
  UNLAND_FAILED_LINE,
  editedThereLine,
  setupWidth,
  floorFailedLine,
  noAgentLine,
  type PlaceSetup,
  type PlaceSetupEvent,
  type PlaceSetupLine,
  type PlaceSync,
  type PlaceSyncEvent,
  type PlaceSetupStep,
  type PlaceWait,
  type SetupEnd,
  type PlaceProvisionRow,
  githubAddress,
  shellQuote,
  toolRowId,
} from "@wsp/protocol";
import { GITHUB_TOKEN_ENV, unlandFiles, PlaceAbsentError, PlaceMachine, envInput, hookOf, newSetupRun, pathLine, putFiles, storesReached, withEnvFromInput, type EngineStep, type ExecResult, type Machine, type MachineLink, type ProvisionPlan, type ProvisionStage } from "@wsp/engine";
import { CATALOG_AGENTS, asksThePerson, hasLogin, loginSignIn, mintsToken, serverValuesOf, sharedOn } from "@wsp/catalog";
import { runGraph, type GraphStep } from "../setup-graph.js";
import { recipeChanges, stepsFor, type RecipeChange } from "../recipe-sync.js";
import { appliedView, type FolderMove, type HeldApplied, type HeldRow, type PlaceRecord, type RecipeResolver } from "./types.js";
import {
  bounded, vaultSignIn, landedOn, type LandedRow, type SyncJob, setupOutcome, UNDO_MS, SIGN_IN_SLACK_MS, GITHUB_MS, cliFirst,
  engineRow,
  INSTALLS, FILES, PROBE_MS, SIGNIN_STATUS_MS, firstLineOf, picksHash, PROVISION_LOG_EVERY_MS, PROVISION_LOG_LINES,
} from "./helpers.js";
import type { PlaceDoorContext } from "./context.js";
import type { PlaceRecordsArea } from "./records.js";

/** The links' waits, the setup and the sync of a computer to its recipe, and the link a machine there is driven over. */
export function placeSetup(ctx: PlaceDoorContext, recordArea: PlaceRecordsArea) {
  const { opts, wiring, recording, clockNow, frameWaitMs, relinkWaitMs, live, kept, signInsHere } = ctx;
  const { recordOf, change, loginListed } = recordArea;

  /** Who is reading one computer's daemon events, by place id: the channels a road on this host opened over that
   * computer's link. A channel is the one road the events it asked for come back on, so a pty on one computer is
   * never pushed at a reader of another. */
  const channels = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  /** What is waiting for one computer to open a socket again, by its place id: every ask that may be made a second
   * time parks here for the gap, and the attach that takes the next socket wakes them. */
  const waiting = new Map<string, Set<(back: boolean) => void>>();
  /** When each computer's last socket closed under this host, by place id. A gap is a computer between sockets, and
   * this is the only reading that tells one from a computer that is simply off: an ask made into the gap is waited
   * out from the close, and an ask made at a computer this host holds no closed socket for is refused at once, as
   * every ask at an absent computer was before anything waited. */
  const closedAt = new Map<string, number>();
  /** Ends every wait on one computer: true for the socket it just opened, false for a place this host is letting
   * go, which leaves each held request failing with what it failed with the first time. */
  const woken = (placeId: string, back: boolean): void => {
    const held = waiting.get(placeId);
    waiting.delete(placeId);
    for (const wake of held ?? []) wake(back);
  };
  /** Waits for that computer to dial in again, up to `until`. False on a link that is up, which is what says a
   * frame failed on the far side's own answer rather than on the road, and false on a computer that did not come
   * back inside the wait. A socket that is closing is not up: its frames are already refused and its close event is
   * on its way, so a wait on it waits for the socket after it. */
  const dialsBack = (placeId: string, until: number): Promise<boolean> =>
    new Promise(resolve => {
      const up = live.get(placeId);
      if (up !== undefined && up.socket.readyState === up.socket.OPEN) return resolve(false);
      const left = until - Date.now();
      if (left <= 0) return resolve(false);
      const held = waiting.get(placeId) ?? new Set<(back: boolean) => void>();
      waiting.set(placeId, held);
      const wake = (back: boolean): void => {
        held.delete(wake);
        clearTimeout(timer);
        resolve(back);
      };
      const timer = setTimeout(() => wake(false), left);
      timer.unref?.();
      held.add(wake);
    });

  /** The computers a setup is going on, by place id: one per computer, so a second run is refused rather than two
   * runs installing over each other. A computer is in here from before its picks are planned, which is a read of
   * this whole computer, until the job ends. */
  const setting = new Set<string>();
  /** The computers a sync to their recipe is going on: one at a time per computer, apart from the setups above, since
   * a sync moves rows on a computer already set up and never stands in the way of a thread there. */
  const syncing = new Set<string>();

  /** The sign-ins a setup is following on a computer, by `<place id>/<agent>`: what a later run that takes one over
   * quiets at once and lets go of once it follows the sign-in itself. */
  const signingIn = new Map<string, { mute(): void; leave(): void }>();
  /** What a skip of a row a running setup is waiting on does, by `<place id>/<row>`: lands it skipped and stops what
   * waited. */
  const skippers = new Map<string, () => Promise<void>>();
  /** What lands a sign-in the person finished outside the run on the run still writing that computer's rows, setup or
   * sync, by place id: the run writes its rows over the record whole, so a row landed on the record alone is put back
   * at its next write. Answers whether the run held that row skipped or failed and landed it, under the label it had. */
  const landers = new Map<string, (r: LandedRow) => Promise<boolean>>();
  /** The computer the host runs on, by the name the app reads it by. */
  const here = (): string => {
    const at = wiring.here();
    return at.label ?? at.name;
  };

  /** The sentence a fork there, or a second setup, is refused with while a setup stands running on that computer:
   * one this host is driving, or one a stopped host left, which resumes when that computer dials back. The one
   * reading, so the start, the update and the gate a create passes cannot disagree about whether it is busy. */
  const settingNow = (record: PlaceRecord): string | undefined =>
    setting.has(record.id) || record.setup?.state === "running" ? placeProvisioningLine(record.name, record.setup?.steps.find(l => l.state === "running")?.step) : undefined;
  /** The computer whose setup's own folder step the running call belongs to: a project's clone there is the job's
   * own work rather than a fork landing on a half set up computer, so the gate lets that call alone through. Every
   * call reached from the folder add carries the pass, so nothing reached from it may fork a workspace there. */
  const foldersOf = new AsyncLocalStorage<string>();

  /** One write of a setup's state onto the record as it stands. */
  const writeSetup = async (placeId: string, patch: Partial<Pick<PlaceRecord, "setup" | "applied" | "picks" | "recipe" | "sync">>): Promise<void> => {
    await change(placeId, now => {
      const next = { ...now, ...patch };
      if ("sync" in patch && patch.sync === undefined) delete next.sync;
      return next;
    });
  };

  /** Which computers follow a recipe moved, or the recipe did, on the stream every client watches. */
  const recipesMoved = (slug: string): void => opts.onSetup?.({ type: "recipes.changed", slug });

  /** One move of a computer's sync on the stream every client watches. */
  const syncFrame = (event: Omit<PlaceSyncEvent, "type">): void => opts.onSetup?.({ type: "place.sync", ...event });

  /** One frame of a setup on the stream whoever started it is watching. */
  const setupFrame = (event: Omit<PlaceSetupEvent, "type">): void => opts.onSetup?.({ type: "place.setup", ...event });

  /** The job's own log on the computer itself, so a person at its shell reads what happened without this host: the
   * lines appended in batches. Nothing here fails the job; a computer that will not take its own log is still a
   * computer its picks landed on. */
  const provisionRecord = (machine: Machine, home: string, header: string) => {
    const at = placeProvisionPaths(home);
    // The time goes on the line as it is written, not as its batch goes up: the lines travel in batches, and a
    // batch's own moment says nothing about when the job reached the line.
    const stamped = (line: string): string => provisionLogLine(clockNow(), line);
    let lines: string[] = [stamped(header)];
    let timer: NodeJS.Timeout | undefined;
    let writing: Promise<void> = Promise.resolve();
    const flush = (): Promise<void> => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const sending = lines;
      lines = [];
      if (sending.length === 0) return writing;
      writing = writing.then(() => putFiles(machine, [{ path: at.log, text: `${sending.join("\n")}\n`, append: true }]).then(() => undefined)).catch(() => undefined);
      return writing;
    };
    return {
      write: (line: string): void => {
        lines.push(stamped(line));
        if (lines.length >= PROVISION_LOG_LINES) void flush();
        else if (timer === undefined) {
          timer = setTimeout(() => void flush(), PROVISION_LOG_EVERY_MS);
          timer.unref?.();
        }
      },
      close: async (setup: PlaceSetup): Promise<void> => {
        await flush();
        await putFiles(machine, [{ path: at.result, text: `${JSON.stringify(setup, null, 2)}\n` }]).catch(() => undefined);
      },
    };
  };

  /** The run itself, behind whoever asked for it. Every step is written onto the record as it starts and as it ends,
   * with its rows, so a host that stops resumes it at the next link and redoes no step that ended; a step already
   * done in `done` is passed over. The floor first, since a failure there stops the job; then the steps after it as
   * their work allows, at most as many at once as that computer's memory takes (`setupWidth`): the agents and every
   * other install one at a time, since two package managers run into each other; the files rounds one at a time,
   * since they stage in one folder there, the servers after the CLIs they run and not every CLI; the sign-ins
   * started and left waiting on the person; GitHub before the folders, so a private repository clones with it, and
   * GitHub waits on gh alone where gh is one of the CLIs; the machine context last, so it names what did not land. */
  const runSetup = async (placeId: string, addId: string, picks: RecipeFile, done: ReadonlySet<PlaceSetupStep>, started: PlaceSetup, rerun: readonly PlaceWait[], sync?: SyncJob): Promise<void> => {
    const provisioner = wiring.provision!;
    const record = (await recordOf(placeId))!;
    const home = record.report.login["HOME"]!;
    const machine = new PlaceMachine(linkTo(placeId), { id: record.name, home });
    const log = provisionRecord(machine, home, `wsp ${wiring.hostName()} ${sync === undefined ? "set up" : "synced"} ${record.name} ${sync === undefined ? "from" : "to"} ${picks.name} at ${sync === undefined ? started.startedAt : new Date(clockNow()).toISOString()}`);
    // Held row by row against what was applied, a recipe followed or the picks themselves, so a follow or a sync
    // after the setup runs only what moved rather than every row again.
    const shelf = opts.recipes?.();
    const resolved = sync ?? (await (record.recipe === undefined || record.recipe === NO_RECIPE ? shelf?.resolveFile(picks) : shelf?.resolve(record.recipe))?.catch(() => undefined));
    const hash = resolved?.hash ?? picksHash(picks);
    const before = record.applied?.rows ?? [];
    // What an earlier run put on reads present to every step run after it, since the engine's read there cannot tell
    // who put it on. It stays wsp's on the record until its own step reads it again, through a resume and a step that
    // threw, so a recipe that drops it later still takes it off.
    const put = before.filter(r => engineRow(r) && r.outcome === "installed");
    // A project an earlier run made stays wsp's the same way, until the folders step reads it again.
    const made = before.filter(r => r.step === "folders" && r.project !== undefined);
    const carried = new Set<HeldRow>(sync !== undefined ? [] : [...put, ...made].filter(r => !done.has(r.step!)).map(r => ({ ...r, earlier: true })));
    // The rows of the steps that already ended stand: a resume runs only what did not. A sync keeps every row and
    // writes each step's over its own.
    const rows: HeldRow[] = sync !== undefined ? [...before] : [...before.filter(r => r.step !== undefined && done.has(r.step)), ...carried];
    const ours = (got: PlaceProvisionRow[]): PlaceProvisionRow[] => got.map(r => (r.outcome === "present" && put.some(p => p.id === r.id) ? { ...r, outcome: "installed", earlier: true } : r));
    let held = started;
    let ended = false;
    let writing: Promise<void> = Promise.resolve();
    const applied = (): HeldApplied => {
      // A sync holds the recipe it started from until its last step ended, so one cut partway still reads changes.
      const from = sync !== undefined && !ended ? { hash: record.applied?.hash ?? "", items: record.applied?.items } : { hash, items: resolved?.items };
      return {
        hash: from.hash,
        at: new Date(clockNow()).toISOString(),
        rows: [...new Map(rows.map(r => [r.id, r])).values()].map(r => {
          const fix = r.outcome === "failed" && r.fix === undefined ? setupRowFix(r, record.name) : undefined;
          return fix === undefined ? r : { ...r, fix };
        }),
        ...(from.items !== undefined ? { items: from.items } : {}),
      };
    };
    const push = (next: PlaceSetup): void => {
      held = next;
      writing = writing.then(() => writeSetup(placeId, { setup: next, applied: applied() })).catch(() => undefined);
    };
    /** A frame said once the writes before it are on the record: a client reads the record again on a frame that
     * ends something, and a read that beats the write puts back what the frame took away. */
    const frameAfterWrite = (event: Omit<PlaceSetupEvent, "type">): void => {
      writing = writing.then(() => setupFrame(event)).catch(() => undefined);
    };
    /** The steps running this moment, which every line's frame names. */
    const running = new Set<PlaceSetupStep>();
    /** Whether any step started, so a sync that failed before one did put nothing on and still reads behind. */
    let stepped = false;
    const line = (l: PlaceSetupLine): void => {
      if (l.state === "running") running.add(l.step);
      else running.delete(l.step);
      // A sync's steps are not the setup's: the setup stands as it ended, and the sync's own frames carry its lines.
      push(sync !== undefined ? { ...held } : { ...held, steps: held.steps.some(s => s.step === l.step) ? held.steps.map(s => (s.step === l.step ? l : s)) : [...held.steps, l] });
      log.write(`[${l.step}] ${SETUP_STEP_WORDS[l.step]}: ${l.state}${l.note === undefined ? "" : ` (${l.note})`}`);
      if (sync !== undefined) syncFrame({ placeId, sync: sync.state, line: l });
      else frameAfterWrite({ addId, placeId, line: l, running: [...running] });
    };
    const stage: ProvisionStage = detail => log.write(detail);
    /** Each step's lines carry the step, so its own output reads back off the log there. */
    const stageOf = (s: PlaceSetupStep): ProvisionStage => detail => log.write(`[${s}] ${detail}`);
    const vault = (): Readonly<Record<string, string>> => opts.vault?.() ?? {};

    /** How a setup came out, said once its steps ended and again when the last sign-in waiting on the person lands:
     * ready, or Needs you while a wait stands or a folder or the GitHub sign-in failed. */
    const outcome = (): { end: SetupEnd; said?: string } => setupOutcome(held, applied());

    /** One step: marked running, run, its rows kept with the step on each, and marked done or failed with what it
     * took. A step that throws is one failed row, unless the computer stopped answering, which the job waits out. */
    const step = async (name: PlaceSetupStep, work: () => Promise<PlaceProvisionRow[]>): Promise<{ rows: PlaceProvisionRow[]; failed: boolean } | undefined> => {
      if (done.has(name) || (sync !== undefined && !sync.steps.has(name))) return undefined;
      stepped = true;
      const began = clockNow();
      line({ step: name, state: "running", startedAt: new Date(began).toISOString() });
      let got: PlaceProvisionRow[];
      try {
        got = (await work()).map(r => ({ ...r, step: name }));
        rows.splice(0, rows.length, ...rows.filter(r => !(carried.has(r) && r.step === name)));
      } catch (e) {
        if (e instanceof PlaceAbsentError) throw e;
        got = [{ id: `${name}/stopped`, label: SETUP_STEP_WORDS[name], outcome: "failed", step: name, note: firstLineOf(e) }];
      }
      rows.push(...got);
      const failed = got.filter(r => r.outcome === "failed");
      line({ step: name, state: failed.length > 0 ? "failed" : "done", ms: Math.max(0, Math.round(clockNow() - began)), ...(failed.length > 0 ? { note: `${failed.length} of ${got.length} failed` } : {}) });
      return { rows: got, failed: failed.length > 0 };
    };

    /** A row that lands after its step ended, since it waited on the person: it takes the place of what stood under
     * that id and is said on the stream, and the last wait gone after the steps ended is the setup coming out again,
     * said with it. */
    const landRow = (r: HeldRow): void => {
      rows.splice(0, rows.length, ...rows.filter(x => x.id !== r.id), r);
      push({ ...held });
      const through = ended && held.waiting.length === 0 && foldersWaiting === 0;
      frameAfterWrite({ addId, placeId, landed: r.id, ...(through ? outcome() : {}) });
      if (through && sync === undefined) letGo();
    };
    /** The folders waiting on the GitHub sign-in: the setup comes out again only once the last of them is in. */
    let foldersWaiting = 0;
    const lander = async (r: LandedRow): Promise<boolean> => {
      const landed = landedOn(rows, r)?.find(x => x.id === r.id);
      if (landed === undefined) return false;
      landRow(landed);
      await writing;
      return true;
    };
    landers.set(placeId, lander);
    /** This run writes no more rows: what lands from outside goes on the record itself. */
    const letGo = (): void => {
      if (landers.get(placeId) === lander) landers.delete(placeId);
    };

    /** A sign-in on that computer that waits on the person: its row waits with the page and the code as the relay
     * reads them, and when the wait runs out it reads expired and a retry asks for a fresh one. It never holds the
     * job; its row lands whenever the person is through, and `settled` hears whether it signed in. */
    const signInThere = (ask: string, row: string, label: string, rowStep: PlaceSetupStep, settled?: (ok: boolean) => void): void => {
      const signIn = recording.signIn;
      const begun = clockNow();
      const wait: PlaceWait = { row, label, expiresAt: new Date(begun + SIGN_IN_WAIT_MS).toISOString(), state: "waiting" };
      const putWait = (w: PlaceWait | undefined): void => {
        push({ ...held, waiting: [...held.waiting.filter(x => x.row !== row), ...(w === undefined ? [] : [w])] });
        if (w !== undefined) frameAfterWrite({ addId, placeId, wait: w });
      };
      const landed = (r: PlaceProvisionRow): void => {
        skippers.delete(`${placeId}/${row}`);
        held = { ...held, waiting: held.waiting.filter(x => x.row !== row) };
        settled?.(r.outcome === "installed");
        landRow({ ...r, step: rowStep });
      };
      if (signIn === undefined) {
        landed({ id: row, label, outcome: "failed", note: NO_SIGN_IN_ROAD });
        return;
      }
      putWait(wait);
      let current = wait;
      // The run that followed this sign-in before goes quiet at once, so only this one writes what it comes to, and
      // lets go once this one follows it, so a relay still waiting keeps its page and code.
      const key = `${placeId}/${ask}`;
      const before = signingIn.get(key);
      before?.mute();
      let gone = false;
      let leave: (() => void) | undefined;
      let stop: (() => void) | undefined;
      const mine = {
        mute: () => void (gone = true),
        leave: () => {
          gone = true;
          leave?.();
        },
      };
      signingIn.set(key, mine);
      // Skip for now: the row reads skipped, nothing more of this login is heard, and the login there stops.
      skippers.set(`${placeId}/${row}`, async () => {
        if (gone) return;
        gone = true;
        stop?.();
        leave?.();
        if (signingIn.get(key) === mine) signingIn.delete(key);
        landed({ id: row, label, outcome: "skipped", note: SKIPPED_FOR_NOW });
        await writing;
      });
      void signIn(placeId, ask, e => {
        if (gone) return;
        if (e.state !== "waiting" && e.state !== "running" && signingIn.get(key) === mine) signingIn.delete(key);
        if (e.state === "waiting" || e.state === "running") {
          if (e.url === undefined && e.code === undefined) return;
          current = { ...current, ...(e.url !== undefined ? { url: e.url } : {}), ...(e.code !== undefined ? { code: e.code } : {}) };
          putWait(current);
        } else if (e.state === "signed-in") {
          landed({ id: row, label, outcome: "installed", note: SIGNED_IN_THERE, ms: Math.round(clockNow() - begun) });
        } else if (clockNow() >= begun + SIGN_IN_WAIT_MS - SIGN_IN_SLACK_MS) {
          putWait({ ...current, state: "expired" });
          settled?.(false);
        } else {
          landed({ id: row, label, outcome: "failed", note: e.said ?? "the sign-in did not finish" });
        }
      }).then(
        handle => {
          leave = () => handle.leave();
          stop = () => handle.stop?.();
          before?.leave();
          if (gone) handle.leave();
        },
        (e: unknown) => {
          if (!gone) landed({ id: row, label, outcome: "failed", note: firstLineOf(e) });
        },
      );
    };
    /** Whether an agent is signed in on that computer, by its own status command run there as the hand sign-in
     * plans it; the logins that computer's daemon last listed only where that status cannot be read. A login the
     * status reads goes on that list, which a login copied or signed in there by hand is not on until the next dial. */
    const agentSignedIn = async (agent: string, plan: ProvisionPlan): Promise<boolean> => {
      const check = loginSignIn(agent)?.status;
      if (check !== undefined) {
        const line = await recording.signInLine?.(placeId, agent).catch(() => undefined);
        const res = line?.status === undefined ? undefined : await machine.exec(withEnvFromInput(`${pathLine(plan.path, plan.prefix)}\n${line.status} 2>&1`), { timeoutMs: SIGNIN_STATUS_MS, stdin: envInput(line.env ?? {}) }).catch(() => undefined);
        // A status cut at its deadline said nothing about the login, so it is not read as signed out.
        if (res !== undefined && res.exitCode !== EXEC_DEADLINE_EXIT) {
          const signedIn = check.signedIn(res.stdout, res.exitCode);
          if (signedIn) await loginListed(placeId, agent);
          return signedIn;
        }
      }
      return signInsHere(placeId)?.[agent] === "signed-in";
    };
    /** An agent's sign-in on that computer, started only where it is not signed in there already: its login clears
     * the one standing the moment it starts, so only the person's own Sign in may replace a login. */
    const agentSignIn = async (agent: string, plan: ProvisionPlan): Promise<void> => {
      const label = CATALOG_AGENTS.find(a => a.id === agent)?.name ?? agent;
      const id = signInRowId(agent);
      if (await agentSignedIn(agent, plan)) return landRow({ id, label, outcome: "present", note: SIGNED_IN_THERE, step: "signins" });
      // A login that asks the person to pick runs at a terminal they sit at, which this run has none of: it is theirs
      // to start from the row once the setup is through, and nothing here has failed.
      const signIn = CATALOG_AGENTS.find(a => a.id === agent)?.signIn;
      if (signIn !== undefined && asksThePerson(signIn)) return landRow({ id, label, outcome: "skipped", note: AT_ITS_TERMINAL, step: "signins" });
      signInThere(agent, id, label, "signins");
    };

    /** A login runs where its agent is, and only its agent's status reads one standing there: an agent that did not
     * install has neither until a Retry puts it on. */
    const notInstalled = (agent: string): boolean => rows.some(r => agentOfRow(r) === agent && r.outcome === "failed");

    /** The sign-ins step: an agent that signs in from the vault reads its token there now, and every turn there is
     * handed it; an agent that signs in on that computer and is not signed in there yet is started and left waiting
     * on the person. */
    const signIns = async (plan: ProvisionPlan): Promise<PlaceProvisionRow[]> => {
      const out: PlaceProvisionRow[] = [];
      for (const [agent, row] of Object.entries(picks.agents)) {
        if (sync !== undefined && !sync.changes.some(c => c.key === `agents/${agent}` && (c.how === "added" || c.how === "changed"))) continue;
        const label = CATALOG_AGENTS.find(a => a.id === agent)?.name ?? agent;
        if ((row.signin ?? "vault") === "machine") {
          if (notInstalled(agent)) {
            out.push({ id: signInRowId(agent), label, outcome: "skipped", note: waitsForInstallLine(label) });
            continue;
          }
          await agentSignIn(agent, plan);
          continue;
        }
        const signIn = CATALOG_AGENTS.find(a => a.id === agent)?.signIn;
        if (vaultSignIn(agent, vault()) === "vault-key") {
          out.push({ id: signInRowId(agent), label, outcome: "present", note: copiedFromLine(here()) });
          continue;
        }
        const copied = await loginCopied(agent, label, plan);
        if (copied !== undefined) {
          out.push(copied);
          continue;
        }
        // An agent with no login to run there signs in with the token or key this host keeps for every turn there.
        const fix = signIn === undefined || hasLogin(signIn) ? signInThereFix(record.name) : signInWithFix(label, mintsToken(signIn) ? "token" : "key");
        out.push({ id: signInRowId(agent), label, outcome: "failed", note: noCopyLine(label, here()), fix });
      }
      return out;
    };

    /** An agent's login as this computer holds it, put where every thread there reads it, on the run's input alone:
     * a login standing there already stays, since only the person's own Sign in may replace one. Nothing where this
     * computer holds no login of that agent's or its threads' folder for it is out of the login's reach. */
    const loginCopied = async (agent: string, label: string, plan: ProvisionPlan): Promise<PlaceProvisionRow | undefined> => {
      const shared = sharedOn(agent);
      const held = shared === undefined ? undefined : await recording.loginHere?.(agent).catch(() => undefined);
      const store = held === undefined ? undefined : (await storesHere())?.[agent];
      if (shared === undefined || held === undefined || store === undefined) return undefined;
      const id = signInRowId(agent);
      // A copy over a login no status could read would replace it.
      if (notInstalled(agent)) return { id, label, outcome: "skipped", note: waitsForInstallLine(label) };
      if (await agentSignedIn(agent, plan)) return { id, label, outcome: "present", note: SIGNED_IN_THERE };
      const at = shellQuote(`${store}/${shared.file}`);
      const put = await machine.exec(`umask 077 && mkdir -p ${shellQuote(store)} && cat > ${at}.wsp && mv -f ${at}.wsp ${at}`, { timeoutMs: SIGNIN_STATUS_MS, stdin: held }).catch((e: unknown) => ({ exitCode: -1, stdout: "", stderr: firstLineOf(e) }));
      if (put.exitCode !== 0) return { id, label, outcome: "failed", note: lastLine(put.stderr) ?? `the copy exited ${put.exitCode}`, fix: signInThereFix(record.name) };
      return (await agentSignedIn(agent, plan)) ? { id, label, outcome: "installed", note: copiedFromLine(here()) } : { id, label, outcome: "failed", note: copiedNotSignedInLine(label, here()), fix: signInThereFix(record.name) };
    };

    /** Whether gh can clone a private repository there, which the GitHub step settles: at once from the vault or a
     * skip, once the person is through where it signs in on that computer. A setup with no GitHub row clones as it
     * always did, with whatever the vault holds. */
    let githubSettled: (ok: boolean) => void = () => {};
    const githubReady = new Promise<boolean>(resolve => (githubSettled = resolve));
    const githubWord = picks.configs.github?.signin ?? "vault";
    if (picks.configs.github === undefined) githubSettled(true);
    // A step that will not run this time (it ended before a resume, or a sync does not carry it) settles off its row.
    else if ((done.has("github") || (sync !== undefined && !sync.steps.has("github"))) && !rerun.some(w => w.row === GITHUB_ROW)) githubSettled(rows.some(r => r.id === GITHUB_ROW && (r.outcome === "present" || r.outcome === "installed")));
    /** Whether that settling is in yet, without waiting on it. */
    let githubKnown: boolean | undefined;
    void githubReady.then(ok => (githubKnown = ok));

    /** gh's own status there, over the vault's token on the run's input where one is given, else its own login. */
    const ghStatus = (plan: ProvisionPlan, token?: string): Promise<ExecResult> => {
      const cmd = `${pathLine(plan.path, plan.prefix)}\ngh auth status --hostname github.com 2>&1`;
      return token === undefined ? machine.exec(cmd, { timeoutMs: GITHUB_MS }) : machine.exec(withEnvFromInput(cmd), { timeoutMs: GITHUB_MS, stdin: envInput({ [GITHUB_TOKEN_ENV]: token }) });
    };
    /** gh's login on that computer through the sign-in relay, started only where gh is not signed in there already. */
    const githubSignIn = async (plan: ProvisionPlan): Promise<void> => {
      if ((await ghStatus(plan).catch(() => undefined))?.exitCode === 0) {
        githubSettled(true);
        return landRow({ id: GITHUB_ROW, label: "GitHub", outcome: "present", note: SIGNED_IN_THERE, step: "github" });
      }
      signInThere(GITHUB_CLI, GITHUB_ROW, "GitHub", "github", ok => githubSettled(ok));
    };

    /** The GitHub step: gh put on where nothing else puts it, then signed in by the row's word: the vault's token
     * on the run's input and nowhere else, gh's own login on that computer through the sign-in relay, or skipped. */
    const github = async (plan: ProvisionPlan): Promise<PlaceProvisionRow[]> => {
      if (picks.configs.github === undefined) return [];
      if (githubWord === "skip") {
        // What the row's Sign in put on there and signed in since stays: a run again keeps the gh wsp owns, so a
        // recipe that drops GitHub later takes it off, and does not call a GitHub signed in there skipped.
        const before = (record.applied?.rows ?? []).filter(r => r.step === "github" && (r.outcome === "installed" || (r.id === GITHUB_ROW && r.outcome === "present")));
        githubSettled(before.some(r => r.id === GITHUB_ROW));
        return before.some(r => r.id === GITHUB_ROW) ? before : [...before, { id: GITHUB_ROW, label: "GitHub", outcome: "skipped", note: GITHUB_SKIPPED_LINE }];
      }
      const gh = ours(await provisioner.step(machine, plan, "github", run, stageOf("github"), { home }));
      if (gh.some(r => r.outcome === "failed")) {
        githubSettled(false);
        return gh;
      }
      if (githubWord === "machine") {
        await githubSignIn(plan);
        return gh;
      }
      const token = vault()[GITHUB_TOKEN_ENV];
      if (token === undefined) {
        githubSettled(false);
        return [...gh, { id: GITHUB_ROW, label: "GitHub", outcome: "failed", note: noCopyLine("GitHub", here()), fix: signInThereFix(record.name) }];
      }
      const res = await ghStatus(plan, token);
      // gh names the token's scopes on its status, which the row carries so a person reads what a clone may reach.
      const scopes = ghStatusOf(res.stdout).scopes?.join(", ");
      githubSettled(res.exitCode === 0);
      return [...gh, res.exitCode === 0 ? { id: GITHUB_ROW, label: "GitHub", outcome: "present", note: `${copiedFromLine(here())}${scopes === undefined || scopes === "" ? "" : `; token scopes: ${scopes}`}` } : { id: GITHUB_ROW, label: "GitHub", outcome: "failed", note: lastLine(res.stdout) ?? `gh auth status exited ${res.exitCode}` }];
    };

    /** Whether a folder's repository clones there only with GitHub signed in: one on GitHub that an anonymous read of
     * it from that computer is refused. */
    const needsGitHub = async (folder: RecipeFile["folders"][string]): Promise<boolean> => {
      const remote = await recording.folderRemote?.(folder).catch(() => undefined);
      const at = remote === undefined ? undefined : githubAddress(remote);
      if (at === undefined) return false;
      const read = await machine.exec(`GIT_TERMINAL_PROMPT=0 git -c credential.helper= ls-remote --quiet ${shellQuote(at)} HEAD >/dev/null 2>&1`, { timeoutMs: PROBE_MS }).catch(() => undefined);
      return read?.exitCode !== 0;
    };

    /** One folder made a project there by the add's own road, under the id of the project wsp made from it before
     * where there is one. */
    const addFolder = async (key: string, folder: RecipeFile["folders"][string], move?: FolderMove): Promise<HeldRow> => {
      const label = folder.name ?? key;
      const add = recording.addFolder;
      if (add === undefined) return { id: `folders/${key}`, label, outcome: "failed", note: NO_FOLDER_ROAD };
      // The add's own lines go to the step's log as it clones and seeds, so the open row reads them as they come.
      const said = stageOf("folders");
      return foldersOf.run(placeId, () => add(placeId, key, folder, move, line => said(`${label}: ${line}`))).catch((e: unknown): PlaceProvisionRow => ({ id: `folders/${key}`, label, outcome: "failed", note: firstLineOf(e) }));
    };

    /** The folders, each a project on that computer. One whose repository needs GitHub there waits on the GitHub
     * sign-in while the person has it open, and lands once they are through; with GitHub skipped or not signed in it
     * reads as needing GitHub to clone, and nothing is asked of the remote. */
    const folders = async (): Promise<HeldRow[]> => {
      const out: HeldRow[] = [];
      const standing = new Set((await recording.projectsOn(placeId)).map(p => p.id));
      for (const [key, folder] of Object.entries(picks.folders)) {
        if (sync !== undefined && !sync.moved.has(`folders/${key}`)) continue;
        const label = folder.name ?? key;
        // A project an earlier run made from this same pick stands as wsp's, since a second add of its source is
        // refused as already one; a recipe that moved its look puts the look on it.
        const was = made.find(r => r.id === `folders/${key}`);
        const claim: FolderMove | undefined = was?.project !== undefined && was.pick !== undefined ? { id: was.project.id, pick: was.pick, ...(was.createdAt !== undefined ? { createdAt: was.createdAt } : {}) } : undefined;
        const ours = claim !== undefined && standing.has(claim.id) ? claim : undefined;
        if (ours !== undefined && ours.pick.from === folder.from && ours.pick.name === folder.name && ours.pick.keep.join("\n") === folder.keep.join("\n")) {
          const row: HeldRow = { id: `folders/${key}`, label: was!.label, outcome: "installed", project: { id: ours.id }, pick: folder };
          if (ours.pick.icon === folder.icon && ours.pick.hue === folder.hue) out.push({ ...row, earlier: true });
          else out.push(await recording.folderLook(ours.id, ours.pick, folder).then(() => row, (e: unknown): HeldRow => ({ ...row, outcome: "failed", note: firstLineOf(e), pick: ours.pick })));
          continue;
        }
        // One whose kept files alone moved gets the new ones copied in; one whose source or name moved is added again
        // under the id it had, the old one taken off only once GitHub, the folder and the seed say the new one can
        // land and its folder there is gone. A row that did not land keeps the claim, so the next run moves it and a
        // remove takes it.
        const claimed = (r: HeldRow): HeldRow => (claim === undefined || r.project !== undefined ? r : { ...r, project: { id: claim.id }, pick: claim.pick, ...(claim.createdAt !== undefined ? { createdAt: claim.createdAt } : {}) });
        if (githubKnown === true || !(await needsGitHub(folder))) {
          out.push(claimed(await addFolder(key, folder, claim)));
          continue;
        }
        if (githubKnown === false) {
          out.push(claimed({ id: `folders/${key}`, label, outcome: "failed", note: NEEDS_GITHUB_LINE }));
          continue;
        }
        out.push(claimed({ id: `folders/${key}`, label, outcome: "skipped", note: WAITS_ON_GITHUB_LINE }));
        foldersWaiting++;
        void githubReady.then(async ok => {
          const landed = ok ? await addFolder(key, folder, claim) : { id: `folders/${key}`, label, outcome: "failed" as const, note: NEEDS_GITHUB_LINE };
          foldersWaiting--;
          landRow(claimed({ ...landed, step: "folders" }));
        });
      }
      return out;
    };

    const end = async (failed?: string): Promise<void> => {
      ended = true;
      if (sync !== undefined) {
        // A sync leaves the computer in step whatever its rows came to: a row that failed stands with Retry, and the
        // computer holds the recipe it applied.
        await writing;
        if (failed !== undefined) log.write(failed);
        await writeSetup(placeId, { applied: applied(), picks, sync: undefined });
        letGo();
        syncFrame({ placeId, applied: appliedView(applied()) });
        return;
      }
      push({ ...held, state: failed === undefined ? "done" : "failed", finishedAt: new Date(clockNow()).toISOString(), ...(failed !== undefined ? { said: failed } : {}) });
      await writing;
      if (held.waiting.length === 0 && foldersWaiting === 0) letGo();
      // A folder still cloning lands later and says the end itself, once the last of them is in.
      if (failed === undefined && foldersWaiting > 0) return;
      setupFrame({ addId, placeId, ...(failed === undefined ? outcome() : { end: "failed", said: failed }) });
    };

    /** The folder each agent's threads there are pointed at that the computer's login reaches, where the servers
     * step merges and lands their files and a sync takes those files back off. */
    const storesHere = async (): Promise<Readonly<Record<string, string>> | undefined> => {
      const stores = recording.storesOn?.(placeId, home);
      const login = stores === undefined ? undefined : await ctx.door.folderComputer(placeId)?.machine.loginOf();
      return stores === undefined || login === undefined ? undefined : storesReached(login, stores);
    };

    /** A sync's removals, before anything is planned: each row the recipe took out comes off by its own road, a row
     * the computer had before wsp stays, and a file the person has written since stays and its row says so. */
    const undo = async (): Promise<void> => {
      const removed = sync?.changes.filter(c => c.how === "removed") ?? [];
      if (sync === undefined || removed.length === 0 || provisioner.undo === undefined) return;
      const planned = await provisioner.undo(sync.before, removed, { home });
      for (const u of planned) {
        // What wsp put there, read off the one row its road installed: a sign-in or a file wsp landed for a tool the
        // box had before wsp says nothing about who put the tool there.
        const owned = u.owner === undefined ? undefined : rows.find(r => r.id === u.owner)?.outcome;
        const ours = owned === "installed";
        const left: PlaceProvisionRow[] = [];
        if (owned === "present") left.push({ id: u.key, label: u.label, outcome: "skipped", note: wasThereLine(record.name) });
        if (u.dests !== undefined) {
          const out = await unlandFiles(machine, home, u.dests, await storesHere());
          if (out === undefined) left.push({ id: u.key, label: u.label, outcome: "failed", note: UNLAND_FAILED_LINE });
          else if (out.kept.length > 0) left.push({ id: u.key, label: u.label, outcome: "skipped", note: editedThereLine(record.name, out.kept) });
          stage(`${u.label}: ${out === undefined ? "its files were not taken off" : `${out.gone.length} files taken off, ${out.kept.length} kept`}`);
        }
        const project = rows.find(r => r.id === u.owner)?.project;
        if (u.folder !== undefined && project !== undefined) await recording.removeFolder(placeId, project.id).catch((e: unknown) => stage(`${u.label}: ${firstLineOf(e)}`));
        // A road with no way off says so on the row, where the person reads what stayed.
        if (u.cmd === undefined && u.note !== undefined && ours) left.push({ id: u.key, label: u.label, outcome: "skipped", note: u.note });
        if (u.cmd !== undefined && ours) {
          const res = await machine.exec(u.cmd, { timeoutMs: UNDO_MS }).catch((e: unknown) => ({ exitCode: -1, stdout: "", stderr: firstLineOf(e) }));
          if (res.exitCode !== 0) left.push({ id: u.key, label: u.label, outcome: "failed", note: `not taken off: ${lastLine(res.stderr || res.stdout) ?? `exit ${res.exitCode}`}` });
          stage(`${u.label}: ${res.exitCode === 0 ? "taken off" : "not taken off"}`);
        }
        rows.splice(0, rows.length, ...rows.filter(r => !u.ids.includes(r.id) && r.id !== u.key), ...left);
      }
    };

    const run = newSetupRun();
    try {
      if (picks.configs.github !== undefined && githubWord === "vault" && vault()[GITHUB_TOKEN_ENV] === undefined) await wiring.githubToken?.().catch(() => undefined);
      await undo();
      const planned = await provisioner.setup(picks, { home }, sync?.steps);
      // A sync puts on only the plugins it added; the rest are there, and their install would run again.
      const kept = sync === undefined || planned.plugins === undefined ? planned : { ...planned, plugins: planned.plugins.filter(p => sync.moved.has(p.id)) };
      // gh comes with the CLIs where it is one of them, first among them, and on its own before them otherwise; the
      // CLIs with a hook the folders wait on come next, then the CLIs the servers run.
      const ghCli = picks.clis[GITHUB_CLI];
      const ghRow = ghCli === undefined ? undefined : toolRowId(ghCli.via, GITHUB_CLI);
      const hooks = kept.steps.slice(kept.agents).filter(s => hookOf(s) !== undefined).map(s => s.id);
      const plan = cliFirst(kept, [...(ghRow !== undefined ? [ghRow] : []), ...hooks, ...(kept.serverTools ?? [])]);
      // A sign-in the last run left waiting is run again for a fresh page and code: the pty behind the old one is gone.
      for (const w of rerun) {
        if (w.row === GITHUB_ROW) await githubSignIn(plan);
        else await agentSignIn(signInOfRow(w.row)!, plan);
      }
      const engine = (s: EngineStep) => async () => {
        const stores = s === "mcp" ? await storesHere() : undefined;
        return ours(await provisioner.step(machine, plan, s, run, stageOf(s), { home, held: new Set(Object.keys(serverValuesOf(vault()))), ...(stores !== undefined ? { stores } : {}) }));
      };
      const floor = await step("floor", engine("floor"));
      if (floor?.failed === true) return await end(floorFailedLine(floor.rows));
      let stopped: string | undefined;
      const installs = new Set(plan.steps.slice(0, plan.agents).map(s => s.id));
      const go = (work: Promise<unknown>): Promise<"go"> => work.then(() => "go" as const);
      const graph: GraphStep<PlaceSetupStep, "gh" | "hooks" | "servers">[] = [
        {
          name: "agents",
          after: [],
          lanes: [INSTALLS],
          run: async () => {
            const agents = await step("agents", engine("agents"));
            const agentRows = agents?.rows.filter(r => installs.has(r.id)) ?? [];
            if (agentRows.length === 0 || !agentRows.every(r => r.outcome === "failed")) return "go";
            stopped = noAgentLine(agentRows);
            return "stop";
          },
        },
        { name: "signins", after: ["agents"], lanes: [], light: true, run: () => go(step("signins", () => signIns(plan))) },
        { name: "skills", after: [], lanes: [FILES], run: () => go(step("skills", engine("skills"))) },
        { name: "github", after: ghRow !== undefined ? ["gh"] : [], lanes: plan.github === undefined ? [] : [INSTALLS], run: () => go(step("github", () => github(plan))) },
        {
          name: "clis",
          after: ["agents"],
          marks: ["gh", "hooks", "servers"],
          lanes: [INSTALLS],
          run: release => {
            // Each mark goes once every row it waits on is said, and a row with a hook is said once its hook ran.
            const waits = [["gh", new Set(ghRow !== undefined ? [ghRow] : [])], ["hooks", new Set(hooks)], ["servers", new Set(plan.serverTools ?? [])]] as const;
            for (const [mark, rows] of waits) if (rows.size === 0) release(mark);
            return go(
              step("clis", async () =>
                ours(
                  await provisioner.step(machine, plan, "clis", run, (detail, at, row) => {
                    stageOf("clis")(detail, at, row);
                    if (row === undefined) return;
                    for (const [mark, rows] of waits) if (rows.delete(row.id) && rows.size === 0) release(mark);
                  }, { home }),
                ),
              ),
            );
          },
        },
        // The servers wait on the CLIs they run, since a server whose command is not there is dropped, and the plugins
        // on the servers step, where the agents' own files land: a plugin's install writes the agent's settings,
        // which a landing then never writes over.
        { name: "mcp", after: ["agents", "servers"], lanes: [FILES], run: () => go(step("mcp", engine("mcp"))) },
        { name: "configs", after: [], lanes: (plan.configTools ?? []).length > 0 ? [INSTALLS, FILES] : [FILES], run: () => go(step("configs", engine("configs"))) },
        { name: "plugins", after: ["mcp"], lanes: [], run: () => go(step("plugins", engine("plugins"))) },
        // The folders wait on every picked CLI's hook as well as GitHub: git-lfs's is what makes a clone check out its files.
        { name: "folders", after: ["github", "hooks"], lanes: [], run: () => go(step("folders", folders)) },
      ];
      await runGraph(
        graph.filter(g => !done.has(g.name)),
        setupWidth(record.report.shape.memMb),
      );
      if (stopped !== undefined) return await end(stopped);
      await step("context", engine("context"));
      await end();
    } catch (e) {
      // A computer that stopped answering leaves the setup running on its record, and a sync behind: its next link
      // takes either up again. A sync that failed before any step started put nothing on, so it is behind too.
      if (e instanceof PlaceAbsentError || (sync !== undefined && !stepped)) {
        await writing;
        if (!(e instanceof PlaceAbsentError)) log.write(firstLineOf(e));
        if (sync !== undefined) {
          await writeSetup(placeId, { sync: { ...sync.state, state: "behind" } });
          syncFrame({ placeId, sync: { ...sync.state, state: "behind" } });
        }
        return;
      }
      await end(firstLineOf(e));
    } finally {
      // A run cut off by a computer that went away writes nothing more; one still waiting on the person keeps its rows.
      if (!ended) letGo();
      void log.close(held);
    }
  };

  /** Starts the setup on one computer from its picks, given here or already on its record, and answers how it
   * stands the moment it is under way. A setup a stopped host left running resumes: the steps that ended stand and
   * a sign-in that was waiting is run again. Nothing at all on a host that wired no provisioner. */
  const startSetup = async (placeId: string, addId: string, given?: { picks: RecipeFile; recipe?: string }): Promise<{ setup?: PlaceSetup; said?: string }> => {
    if (wiring.provision === undefined) return {};
    const record = await recordOf(placeId);
    if (record === undefined) return {};
    if (setting.has(placeId)) throw Object.assign(new Error(placeProvisioningLine(record.name, record.setup?.steps.find(l => l.state === "running")?.step)), { kind: "conflict" });
    if (syncing.has(placeId)) throw Object.assign(new Error(placeSyncingLine(record.name)), { kind: "conflict" });
    const home = record.report.login["HOME"];
    // Every path the job builds comes off that home, so a computer that reported none gets nothing and says so.
    if (home === undefined) return { said: placeNoHomeLine(record.name) };
    const picks = given?.picks ?? record.picks;
    if (picks === undefined) return { said: placeNoPicksLine(record.name) };
    setting.add(placeId);
    try {
      const resuming = given === undefined && record.setup?.state === "running" ? record.setup : undefined;
      const done = new Set((resuming?.steps ?? []).filter(l => l.state === "done").map(l => l.step));
      // A sign-in left waiting is run again here only where its step ended; otherwise that step starts it itself.
      const rerun = (record.setup?.waiting ?? []).filter(w => (w.row !== GITHUB_ROW && signInOfRow(w.row) !== undefined && done.has("signins")) || (w.row === GITHUB_ROW && done.has("github")));
      const setup: PlaceSetup = { state: "running", addId, startedAt: resuming?.startedAt ?? new Date(clockNow()).toISOString(), steps: resuming?.steps.filter(l => l.state === "done") ?? [], waiting: [] };
      await writeSetup(placeId, { setup, picks, ...(given !== undefined ? { recipe: given.recipe ?? NO_RECIPE } : {}) });
      void runSetup(placeId, addId, picks, done, setup, rerun).finally(() => {
        setting.delete(placeId);
        if (again.delete(placeId)) syncSoon(placeId, 0);
      });
      return { setup };
    } catch (e) {
      setting.delete(placeId);
      throw e;
    }
  };

  /** The computers a change reached while a setup or a sync ran there, synced again once it ends. */
  const again = new Set<string>();
  /** The sync each computer has waiting to start, so a burst of changes is one sync. */
  const syncTimers = new Map<string, NodeJS.Timeout>();

  /** What moved between what a computer last applied and the recipe it follows as this computer has it now, or
   * nothing where it follows none, is mid-setup, or that recipe will not resolve. */
  const syncOf = async (record: PlaceRecord, given?: Awaited<ReturnType<RecipeResolver["resolve"]>>): Promise<{ resolved: Awaited<ReturnType<RecipeResolver["resolve"]>>; changes: RecipeChange[] } | undefined> => {
    const slug = record.recipe;
    const resolver = opts.recipes?.();
    if (slug === undefined || slug === NO_RECIPE || resolver === undefined || record.picks === undefined || record.setup?.state !== "done") return undefined;
    const resolved = given ?? (await resolver.resolve(slug).catch(() => undefined));
    if (resolved === undefined) return undefined;
    if (resolved.hash === record.applied?.hash) return { resolved, changes: [] };
    return { resolved, changes: recipeChanges(record.picks, record.applied?.items, resolved.file, resolved.items) };
  };

  /** A computer out of step reads Behind with what moved; one in step drops the word. */
  const markSync = async (placeId: string, sync: PlaceSync | undefined): Promise<void> => {
    const held = await recordOf(placeId);
    if (held === undefined || (held.sync === undefined && sync === undefined)) return;
    await writeSetup(placeId, { sync });
    syncFrame({ placeId, ...(sync !== undefined ? { sync } : {}) });
  };

  /** One sync of a computer to the recipe it follows, one at a time per computer: a change that lands meanwhile runs
   * it again once it ends. Only the difference goes: the rows the recipe took out come off, the rows it added or
   * that changed here go on, and a sync with nothing moved runs nothing there. A computer that is not linked reads
   * Behind and catches up when it dials back. */
  const syncPlace = async (placeId: string): Promise<void> => {
    if (setting.has(placeId) || syncing.has(placeId)) {
      again.add(placeId);
      return;
    }
    syncing.add(placeId);
    try {
      const record = await recordOf(placeId);
      if (record === undefined || wiring.provision === undefined) return;
      const read = await syncOf(record);
      if (read === undefined) return;
      const { resolved, changes } = read;
      if (changes.length === 0) {
        // In step, or moved in a way no row reads (the recipe's name): what it holds is what this computer has now.
        if (record.applied !== undefined && record.applied.hash !== resolved.hash) await change(placeId, now => (now.applied === undefined ? undefined : { ...now, applied: { ...now.applied, hash: resolved.hash, items: resolved.items }, picks: resolved.file }));
        await markSync(placeId, undefined);
        return;
      }
      const state: PlaceSync = { state: "running", changes: changes.map(c => c.key), since: record.sync?.since ?? new Date(clockNow()).toISOString() };
      if (!live.has(placeId) || record.report.login["HOME"] === undefined) {
        await markSync(placeId, { ...state, state: "behind" });
        return;
      }
      await markSync(placeId, state);
      const moved = new Set(changes.filter(c => c.how !== "removed").map(c => c.key));
      const started: PlaceSetup = record.setup!;
      await runSetup(placeId, started.addId, resolved.file, new Set(), started, [], { ...resolved, changes, steps: stepsFor(changes, resolved.file), moved, before: record.picks!, state });
    } finally {
      syncing.delete(placeId);
      if (again.delete(placeId)) syncSoon(placeId, 0);
    }
  };

  /** A sync of one computer after `afterMs`, the clock starting again at every ask. */
  const syncSoon = (placeId: string, afterMs: number): void => {
    clearTimeout(syncTimers.get(placeId));
    const timer = setTimeout(() => {
      syncTimers.delete(placeId);
      void syncPlace(placeId).catch((e: unknown) => console.warn(`the sync of ${kept.get(placeId)?.name ?? placeId} stopped: ${firstLineOf(e)}`));
    }, afterMs);
    timer.unref?.();
    syncTimers.set(placeId, timer);
  };

  /** The start above with its own refusal as a sentence: picks this host cannot plan are a computer that got
   * nothing, not a join or an update that failed after the daemon landed. */
  const startedOrSaid = (placeId: string, addId: string, given?: { picks: RecipeFile; recipe?: string }): Promise<{ setup?: PlaceSetup; said?: string }> =>
    startSetup(placeId, addId, given).catch((e: unknown) => ({ said: firstLineOf(e) }));

  /** The road the engine drives one place's machines over: one frame and its answer, and the loopback forward a
   * route into a machine there is taken by. A place that is not connected is PlaceAbsentError on every call, which
   * is the one answer every road on an absent place reads.
   *
   * A frame the caller named an idempotency key for is the one thing that outlives a gap: the socket under it going
   * away is waited out for `relinkWaitMs` from the first gap and the frame is sent again on the socket that computer
   * opens next. Nothing else is, since the far side runs what it is sent; a frame with no key fails on the gap as it
   * always has, and so does one whose wait ran out, with the sentence it failed with. */
  const linkTo = (placeId: string): MachineLink => ({
    request: async (op, params, o) => {
      // The bound runs from the gap, not from the ask: a frame may be in flight for minutes before the link under
      // it goes, and a frame asked into a gap that is already open has however much of the wait is left. Read once,
      // at the first gap this request meets.
      let until = 0;
      const waitingFrom = (from: number): number => (until === 0 ? (until = from + relinkWaitMs) : until);
      for (;;) {
        const held = live.get(placeId);
        if (held === undefined) {
          const absent = new PlaceAbsentError(absentComputer(kept.get(placeId)?.name ?? placeId, null).sentence);
          // A computer whose socket closed inside the wait is between sockets; one this host holds no closed socket
          // for is off, or was never here, and nothing is coming that waiting would catch.
          const closed = closedAt.get(placeId);
          if (o?.idempotencyKey === undefined || closed === undefined || !(await dialsBack(placeId, waitingFrom(closed)))) throw absent;
          continue;
        }
        try {
          return await bounded(held.reach.request(op, params), o?.timeoutMs ?? frameWaitMs, `${op} on ${kept.get(placeId)?.name ?? placeId}`);
        } catch (e) {
          // The socket this frame rode is still the one this host holds and is still open, so the place answered
          // for itself: a refusal, or a silence the frame's own bound ended. Neither is a gap to wait out. A socket
          // that is closing is already a gap, and is read as one before its close event lands.
          const now = live.get(placeId);
          if (o?.idempotencyKey === undefined || (now?.reach === held.reach && now.socket.readyState === now.socket.OPEN)) throw e;
          // A computer that dialled back while the frame was failing is here already; the rest wait for it.
          if (now !== undefined && now.reach !== held.reach && Date.now() < waitingFrom(Date.now())) continue;
          if (!(await dialsBack(placeId, waitingFrom(Date.now())))) throw e;
        }
      }
    },
    dialsBack: () => dialsBack(placeId, Date.now() + relinkWaitMs),
    forward: placePort => ctx.door.forward(placeId, placePort),
  });

  return {
    channels, waiting, closedAt, woken, setting, syncing, skippers, landers, here, settingNow, foldersOf, recipesMoved, syncFrame,
    setupFrame, startSetup, syncTimers, syncOf, markSync, syncSoon, startedOrSaid, linkTo,
  };
}
export type PlaceSetupArea = ReturnType<typeof placeSetup>;
