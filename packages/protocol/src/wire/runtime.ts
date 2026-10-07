// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { AgentsTarget, ServerAdd, ServerAsk } from "../agents-report.js";
import { Attachment } from "../attachments.js";
import { threadWord } from "../format.js";
import { InitRoad, InitScreenId, SIGN_IN_CODE_MAX } from "../init-job.js";
import { UsageRange, UsageSplit } from "../usage.js";
import { AccessChoice, AgentSetupSet } from "../thread-defaults.js";
import { SLATE_OPS } from "../slate/wire.js";
import { RecipeFile } from "../recipe-file.js";
import { MergeMethod, PullRequestItem, PR_REPLY_BODY_MAX, ReactionContent } from "../pull-request.js";
import { WorkspaceLook } from "../workspace-look.js";
import { reqId } from "./helpers.js";
import { RelayPort } from "./limits.js";
import { type EventAsker, SeedChoice, WorkspaceAgents, WorkspaceOrigin } from "../views/workspace.js";
import { SessionOrigin, SessionView, ThreadMarks } from "../views/session.js";
import { RunStep } from "../views/session-events.js";
import { TerminalScheme } from "../views/project-bundle.js";
import { EditorId, HISTORY_PAGE_MAX, PreferencesPatch } from "../views/preferences.js";
import { IMAGE_PASSPHRASE_MIN, MachineKind } from "../views/golden-image.js";
import { PlaceSettingsAsk, PlaceSettingWord, PlaceSetupStep, SudoPassword } from "../views/place.js";
import { DaemonFrame, TicketPurpose } from "./devices.js";
import { DeviceAuthRequest, PlaceAuthRequest, PlaceJoinRequest, PlaceProveRequest, SealOpenRequest } from "./place-link.js";

/** Each slate op as a request of this table: the envelope's id and op beside the params wire.ts declares. */
function slateOps() {
  const op = <N extends keyof typeof SLATE_OPS>(name: N) => z.object({ id: reqId, op: z.literal(name) }).extend(SLATE_OPS[name].shape as (typeof SLATE_OPS)[N]["shape"]);
  return [
    op("slates.get"),
    op("slates.write"),
    op("slates.state"),
    op("slates.read"),
    op("slates.catalog"),
    op("slates.event"),
    op("slates.approve"),
    op("slates.cancel"),
    op("slates.revoke"),
    op("slates.shown"),
    op("slates.subscribe"),
    op("slates.unsubscribe"),
    op("slates.resolve"),
  ] as const;
}

const RuntimeOp = z.discriminatedUnion("op", [
  z.object({ id: reqId, op: z.literal("auth"), token: z.string() }),
  z.object({ id: reqId, op: z.literal("ticket.issue"), purpose: TicketPurpose }),
  /** Mints a one time code another computer redeems for a device token of its own. Answers `{ code, expiresAt }`.
   * Only on a socket holding the host's own token, and never on one let in by a ticket. `here` marks the code wsp
   * init mints for the browser it opens on this computer, whose device is then read as the owner. */
  z.object({ id: reqId, op: z.literal("pair.issue"), here: z.literal(true).optional() }),
  /** Spends a code for this computer's own token, as the first frame of a socket nothing has authed. Answers
   * `{ deviceId, deviceToken }` once, and the socket is authed as that device from then on. */
  z.object({ id: reqId, op: z.literal("pair.redeem"), code: z.string().max(64), name: z.string().max(200) }),
  /** Agrees the key this socket is sealed under, as its first frame and before the code or the token it came to
   * send. Answered with a SealOpenReply; it is a door frame read before auth, as a redeem is, and no token names
   * anybody who may send it. */
  SealOpenRequest,
  /** The other first frame a computer with no code sends, inside the seal: it proves a key the account admitted
   * rather than spending a code. A door frame read before auth, as a redeem is. */
  DeviceAuthRequest,
  /** What this wsp knows about the account it is signed in to, off this computer's own records. Answers
   * `{ account }`. Only on the person's own road, never on one let in by a ticket. */
  z.object({ id: reqId, op: z.literal("account.get") }),
  /** Every paired device, for the host token and for a device's own socket alike. */
  z.object({ id: reqId, op: z.literal("devices.list") }),
  /** Takes a device's token away and cuts the sockets holding it, for the host token and for a paired device's
   * own socket alike, whichever device is named. */
  z.object({ id: reqId, op: z.literal("devices.revoke"), deviceId: z.string() }),
  /** The first frame of a computer joining as a place: spends a join code for a record holding its key. Answered
   * with a PlaceJoinReply, and the socket then sends place.prove as an authed one would. */
  PlaceJoinRequest,
  /** The first frame of a place that already joined, answered with a PlaceAuthReply. */
  PlaceAuthRequest,
  /** The second frame of either road: once it verifies, this socket stops being a client's and is the place link. */
  PlaceProveRequest,
  /** Every place this host holds: this computer, the computers joined to it, and the provider it forks on, beside
   * every add over ssh still running and the last that finished. Answers `{ places: PlaceView[], adds: PlaceAddJob[] }`. */
  z.object({ id: reqId, op: z.literal("places.list") }),
  /** Puts the daemon this host deploys on one place where it is behind, over the link it holds or over the ssh road
   * the install used, and waits for that computer to dial back running it. The workspaces on it and what it was set
   * up with are kept. Answers a PlaceUpdateReply. */
  z.object({ id: reqId, op: z.literal("places.update"), placeId: z.string(), sudoPassword: SudoPassword.optional() }),
  /** Takes a place back out: sweeps wsp off that computer over its link, drops the workspaces standing on it and
   * the place record. Answers `{ removed, swept, note? }`. */
  z.object({ id: reqId, op: z.literal("places.remove"), placeId: z.string(), sudoPassword: SudoPassword.optional() }),
  /** Runs the doctor's computer road here, for a computer this host holds the link to: the six steps against that
   * link, and every line of them pushed as a doctor.line event under `doctorId` to the sockets subscribed to
   * events. The id is the caller's own, minted before the request, since the first line is said before the reply
   * lands. Answers `{ code }` once the road printed its last line. The person's own road only, as every other
   * place op is. */
  z.object({ id: reqId, op: z.literal("places.doctor"), placeId: z.string(), doctorId: z.string().max(64), project: z.string().max(200).optional() }),
  /** Dials one computer once, now: a frame over the link it holds, or a login over the road it was added on when
   * it holds none. Answers a PlaceDial: what came back, the sentence to say it in, and the row with the answer
   * written on it, so a window opened later reads the same thing. Nothing is installed and nothing is left
   * running either way. */
  z.object({ id: reqId, op: z.literal("places.dial"), placeId: z.string() }),
  /** Sets what a person may set on one place: threads at once on a computer, machines at once and spend per day on
   * a cloud, the nap after on any place that forks, and the agents switch its workspaces inherit. A key left out
   * keeps what stands, a word under `reset` takes that setting back to its default, and a key the place's kind does
   * not take is refused. `name` renames a computer the person added, `ssh` gives it a new login once that login is
   * read as the same computer, and `recipe` is what places.follow takes; this computer and a cloud take none of the
   * three. Everything is checked before anything is written. Answers `{ place: PlaceView }`, the row as it now
   * reads. The person's own road only, as every other place op is. */
  z
    .object({ id: reqId, op: z.literal("places.set"), placeId: z.string(), reset: z.array(PlaceSettingWord).optional(), name: z.string().max(200).optional(), ssh: z.string().max(300).optional(), recipe: z.string().min(1).max(200).optional() })
    .merge(PlaceSettingsAsk),
  /** The saved recipe one computer follows from now, by its name or slug, or `none`: one it follows syncs to it, and
   * one that follows none keeps what it has. Answers `{ place: PlaceView }`. The person's own road only. */
  z.object({ id: reqId, op: z.literal("places.follow"), placeId: z.string(), recipe: z.string().min(1).max(200) }),
  /** Skip for now on one row of a computer's setup: a sign-in that waits stops and the row reads skipped, and a row
   * that failed is set aside the same way; Settings finishes either later. Answers `{ place: PlaceView }`. */
  z.object({ id: reqId, op: z.literal("places.skip"), placeId: z.string(), row: z.string().min(1).max(300) }),
  /** The end of a computer's setup log, read off that computer: its last SETUP_LOG_TAIL_BYTES, a step's own lines
   * where one is named. Answers `{ lines: string[] }`. */
  z.object({ id: reqId, op: z.literal("places.setupLog"), placeId: z.string(), step: PlaceSetupStep.optional() }),
  /** What some picks weigh against a computer's room before Set up: `ref` a computer or a pending add, as setup takes
   * it. Answers `{ estimate: PlaceEstimate }`. */
  z.object({ id: reqId, op: z.literal("places.estimate"), ref: z.string().max(200), choices: z.lazy(() => RecipeFile) }),
  /** A sign-in run at a terminal on one computer landed, as the tool's own status there said: the host notes the
   * file that agent's shared login writes, as the app's own sign-in does, so the listing says signed in before
   * that computer next reports. Answers `{}`. The person's own road only, as every other place op is. */
  z.object({ id: reqId, op: z.literal("places.loginLanded"), placeId: z.string(), agent: z.string() }),
  /** Opens the door computers you own dial, when this host binds loopback alone, and answers where it is; a host
   * already bound beyond loopback answers its own port and opens nothing. Answers a PlaceDoorView. The person's
   * own road only, as every other place op is. */
  z.object({ id: reqId, op: z.literal("places.door") }),
  /** Mints a join code and answers a JoinMint: every line a computer you own can join this host by, off the door's
   * addresses and the relay's, and when the code expires. The code lets a stranger in, so only a socket holding the
   * host's own token may ask, as for pair.issue. */
  z.object({ id: reqId, op: z.literal("places.mint") }),
  /** Answers `{ hosts: SshHostSuggestion[] }`: the ssh config's hosts first, then known_hosts, less the computers
   * already added over ssh. Only a socket holding the host's own token may ask. */
  z.object({ id: reqId, op: z.literal("places.sshHosts") }),
  /** Puts the agent on a Linux computer over ssh and joins it, `address` naming it as user@host or as an alias
   * from the person's ssh config, which is dialled through that block: the host logs in as the person's own ssh would,
   * installs node and wsp there, starts the agent under that login's own service manager and waits for it to dial
   * back. Answers `{ addId, place: PlaceView }` once it has dialled; the steps ride place.stage events carrying the
   * same addId. */
  z.object({
    id: reqId,
    op: z.literal("places.add"),
    /** The stream the steps of this install ride, minted by whoever asked: the steps start before the reply names
     * the place, so a caller that wants to draw them has to know which are its own before it asks. */
    addId: z.string().max(64).optional(),
    address: z.string().max(200),
    name: z.string().max(200).optional(),
    sshPort: z.number().int().min(1).max(65535).optional(),
    keyPath: z.string().max(1024).optional(),
    /** The host key the person confirmed or pinned for a computer this one has never dialled. The install refuses
     * before a byte of wsp's leaves this computer where it is absent and the client holds no key of its own, so a
     * caller that sends none meets the same wall as one that sends a wrong one. */
    hostKey: z.string().max(200).optional(),
    /** The password the login's sudo asks for, typed by the person for this add alone: fed to sudo over the ssh
     * connection's input, never written down, never logged and gone when the add ends. One line, as sudo reads it. */
    sudoPassword: SudoPassword.optional(),
    /** The saved recipe the computer is set up from once it joins, by its name or slug. Absent, it joins and waits
     * as a pending add for the person's picks, with the base tools going on meanwhile. */
    recipe: z.string().max(200).optional(),
  }),
  /** Sets a computer up from picks: a pending add that joined and waits on its choices, or a computer already set
   * up, run again for whatever is missing. `ref` names the computer or the pending add; `recipe` names the saved
   * recipe to set it up from, `choices` the picks themselves, else the choices it holds. Answers `{ addId, place: PlaceView, setup?, said? }`; the
   * frames ride place.setup events carrying `addId`. */
  z.object({ id: reqId, op: z.literal("places.setup"), ref: z.string().max(200), recipe: z.string().max(200).optional(), choices: z.lazy(() => RecipeFile).optional(), addId: z.string().max(64).optional() }),
  /** Keeps the person's picks so far on a pending add, and the saved recipe they started from, so the add resumes
   * where it was left. Answers `{ pending: PendingComputer }`. Refused for a ref no pending add answers to. */
  z.object({ id: reqId, op: z.literal("places.choose"), ref: z.string().max(200), choices: z.lazy(() => RecipeFile), recipe: z.string().max(200).optional() }),
  /** Every recipe this host keeps, each with the line of what it holds and the computers that follow it. Answers
   * `{ recipes: RecipeView[] }`. The person's own road only, as every place op is. */
  z.object({ id: reqId, op: z.literal("recipes.list") }),
  /** One recipe by its name or slug, with the hash it resolves to on this computer now. Answers `{ recipe:
   * RecipeView, hash }`. */
  z.object({ id: reqId, op: z.literal("recipes.get"), name: z.string().max(200) }),
  /** Writes a recipe whole: `file` as given, or with `from` a computer's own picks under `name`, after which that
   * computer follows it. Refused for a name that makes no file name and for anything shaped like a secret. Answers
   * `{ recipe: RecipeView }`. */
  z.object({ id: reqId, op: z.literal("recipes.save"), name: z.string().max(200), file: z.unknown().optional(), from: z.string().max(200).optional() }),
  /** Takes a recipe's file away; the computers that followed it follow none. Answers `{ recipe: RecipeView }` as it
   * stood. */
  z.object({ id: reqId, op: z.literal("recipes.remove"), name: z.string().max(200) }),
  /** What a recipe can pick from on this computer, read now. Answers `{ options: RecipeOptions }`. */
  z.object({ id: reqId, op: z.literal("recipes.options") }),
  /** Replies with an EventsSubscribeReply, then pushes events on this socket. With `after`, the seq of the last event
   * this client saw, every retained event past it is pushed first, oldest first, before anything live; `stream` is
   * the id that came with that seq, so a runtime that is not the one that issued it answers gap instead. */
  z.object({
    id: reqId,
    op: z.literal("events.subscribe"),
    after: z.number().int().nonnegative().optional(),
    stream: z.string().optional(),
    /** Also sends, after the replay, the last workspace.creating frame of every create the host is making and of
     * every refused one it still holds: a window that connected after a create began hears of it, and a create it
     * hears nothing of is one this host is not making. */
    creates: z.boolean().optional(),
  }),
  /** Replies with a WorkspaceStatus[] snapshot and keeps the runtime's status
   * poller + cost ticker running while this socket lives; the events ride the
   * events.subscribe channel. */
  z.object({ id: reqId, op: z.literal("status.subscribe") }),
  /** Replies with a WorkspaceListing[] snapshot and keeps nothing running: the one shot a command line or a tool
   * takes to read a state, since a WorkspaceView carries neither the provider's word for the machine nor the daemon
   * reach and the state word turns on both. The listing is the status without the minted route, which only the app's
   * own socket needs, and the snapshot costs one reach probe per machine and no exec probe. */
  z.object({ id: reqId, op: z.literal("status.list") }),
  z.object({
    id: reqId,
    op: z.literal("workspaces.create"),
    /** A project image by snapshot id; absent takes the head of the project's computer's own image. A create a
     * thread asked for names none and is refused where it does: it takes the image its own workspace's project
     * runs, which is the only image a thread reaches. */
    golden: z.string().optional(),
    /** The project this workspace is made for, by id or by name. Its computer is where the workspace lands. */
    project: z.string(),
    name: z.string(),
    cpu: z.number().optional(),
    memMb: z.number().optional(),
    envs: z.record(z.string()).optional(),
    labels: z.record(z.string()).optional(),
    /** What the agents on the new workspace may ask of this host; absent, or a key left out, takes the default. */
    agents: WorkspaceAgents.partial().optional(),
    /** Auto-nap window for this workspace; absent takes the runtime default (20 min), null turns it off. */
    idleWindowMs: z.number().nullable().optional(),
    /** The workspace this one is forked out of, by id: a child of it, holding the same project and starting on the
     * branch that workspace is on right now where the remote has that branch. A workspace of another project is
     * refused, since a child starts on its parent's branch. A create a thread asked for is a child of the thread's
     * own workspace whether or not this names one, and a workspace it names here is not read. */
    parent: z.string().optional(),
    /** The workspace gets the place's container engine through the fenced socket; absent takes the image's recipe. */
    engine: z.boolean().optional(),
  }),
  /** Where a workspace of this project would land and what that computer offers. Replies with
   * { place?, name, capabilities }, `place` absent where the landing is the provider this host forks on. Refused
   * before any machine is asked for where that computer forks nothing: with NO_PROVIDER_LINE when no place here runs
   * workspaces, else naming the places that do. The one gate a create runs, read ahead so the refusal comes in one
   * sentence before any stage is streamed. */
  z.object({ id: reqId, op: z.literal("workspaces.landing"), project: z.string() }),
  /** Every workspace this caller may drive. Replies with { workspaces }. */
  z.object({ id: reqId, op: z.literal("workspaces.list") }),
  /** The workspace a person's word names, by id or by name, off the same reading workspaces.list serves: a name no
   * workspace here carries is refused as absent, and one this caller may not drive by the rule that hides it, so a
   * verb never denies a workspace the listing just showed. `verb` is exec when exec names it, so a thread's refusal
   * speaks of exec; absent, it speaks of starting children, which a run naming a project falls through to. Replies
   * with { workspace }. */
  z.object({ id: reqId, op: z.literal("workspaces.resolve"), ref: z.string(), verb: z.literal("exec").optional() }),
  z.object({ id: reqId, op: z.literal("workspaces.get"), workspaceId: z.string() }),
  z.object({ id: reqId, op: z.literal("workspaces.nap"), workspaceId: z.string() }),
  z.object({ id: reqId, op: z.literal("workspaces.wake"), workspaceId: z.string() }),
  /** Starts another daemon for a workspace whose daemon this host owns as a child of its own process, replacing
   * one that is not running. The one kind that has such a daemon is the workspace that is this computer; every
   * other kind's daemon lives on a machine this host does not hold the process of, and is refused here. Replies
   * `{}` once the new daemon has listened. */
  z.object({ id: reqId, op: z.literal("workspaces.restartDaemon"), workspaceId: z.string() }),
  /** Stops a wake that is asking the provider again on its own and replies with the record it leaves behind. */
  z.object({ id: reqId, op: z.literal("workspaces.stopWake"), workspaceId: z.string() }),
  z.object({ id: reqId, op: z.literal("workspaces.upgrade"), workspaceId: z.string() }),
  /** Moves a workspace onto the golden's head version: a fresh fork of the newer image carrying this workspace's
   * files across. The person asks for it; nothing moves a machine they are working on.
   * Refused (kind "conflict") for a workspace forked from a project golden, whose disk the move would throw away. */
  z.object({ id: reqId, op: z.literal("workspaces.updateImage"), workspaceId: z.string() }),
  /** Names the workspace and replies with its fresh { workspace }. The name is unique on this host, so one another
   * workspace holds, one a fork is landing under and a blank one are refused (kind "conflict"); a name the workspace
   * already carries comes back untouched. Threads running on the machine are untouched. */
  z.object({ id: reqId, op: z.literal("workspaces.rename"), workspaceId: z.string(), name: z.string() }),
  /** Sets the workspace's look and replies with its fresh { workspace }. A key left out keeps that fact as it is and
   * null clears it, so the colour picker and the icon picker each send their own without reading the other's. The
   * record alone changes: nothing on the machine is touched. */
  z.object({ id: reqId, op: z.literal("workspaces.look"), workspaceId: z.string() }).extend(WorkspaceLook.shape),
  /** Pushes the branch the workspace's copy is on and opens or finds its pull request, and replies with a
   * BringBackResult. The base is the branch its parent was on at the fork for a child, whatever that parent does
   * after, and the project's own base otherwise; the base branch itself is refused, since work leaves a workspace
   * as a branch of its own. */
  z.object({ id: reqId, op: z.literal("workspaces.bringBack"), workspaceId: z.string(), title: z.string().optional(), body: z.string().optional() }),
  /** A wsp worktree for a branch of a project's repo, or the worktree that already holds the branch, answered as a
   * WorktreeMade. A new branch starts from the project folder's current commit. */
  z.object({ id: reqId, op: z.literal("worktree.make"), project: z.string(), branch: z.string() }),
  /** The record of a project's folder on this computer, the one its threads share, made where no thread has made it
   * yet, and replied as { workspace }. */
  z.object({ id: reqId, op: z.literal("folder.make"), project: z.string() }),
  /** Takes a wsp worktree away with git, refused while a turn runs in it and, without force, while it holds files
   * no commit has. A worktree wsp did not make is never removed. */
  z.object({ id: reqId, op: z.literal("worktree.remove"), project: z.string(), branch: z.string(), force: z.boolean().optional() }),
  /** The copy's checkout, read again unless the host read it moments ago, and answered as a CheckoutReply. */
  z.object({ id: reqId, op: z.literal("workspaces.checkout"), workspaceId: z.string() }),
  /** Puts one changed file of the copy back as HEAD has it and answers a GitDiscardReply. */
  z.object({ id: reqId, op: z.literal("workspaces.discard"), workspaceId: z.string(), path: z.string() }),
  /** Commits the files named in the copy with the message given, hooks and all, and answers a GitCommitReply; paths
   * absent is every changed file, and an empty list is refused as nothing to commit. */
  z.object({ id: reqId, op: z.literal("workspaces.commit"), workspaceId: z.string(), message: z.string(), paths: z.array(z.string()).optional() }),
  /** A commit message for those files, or every changed file where paths is absent, drafted by the workspace's own
   * agent with no thread and no tool, answered as a CommitDraft. */
  z.object({ id: reqId, op: z.literal("workspaces.commitDraft"), workspaceId: z.string(), paths: z.array(z.string()).optional() }),
  /** The workspace's viewed marks, answered as ViewedMarks; with a path, the mark on that file is set against the
   * blob given, or taken off where the blob is null. */
  z.object({ id: reqId, op: z.literal("workspaces.viewed"), workspaceId: z.string(), path: z.string().optional(), blob: z.string().nullable().optional() }),
  /** The workspace's pull request page, read through the git host's command line on this computer, or the running
   * copy's where this computer has none, and answered as a GitPrViewReply; the host holds a read a minute, and an ask
   * with fresh reads it anew. */
  z.object({ id: reqId, op: z.literal("workspaces.pullRequestView"), workspaceId: z.string(), fresh: z.boolean().optional() }),
  /** The workspace's pull request's diff against its base, read as the page is and cut on a file's boundary at
   * GIT_DIFF_CAP_BYTES, answered as a GitPrDiffReply naming every file the cut left out. */
  z.object({ id: reqId, op: z.literal("workspaces.pullRequestDiff"), workspaceId: z.string() }),
  /** Sends items of the workspace's pull request page to its agent as one message, each with its author, its words
   * and, for a comment on a line, its file, line and the diff's lines above it, numbered where there are several;
   * the message joins the workspace's first thread as a fix's does. The host keeps what was sent, with when, and the
   * page answers it. Answered as a PullRequestSendResult. */
  z.object({ id: reqId, op: z.literal("workspaces.pullRequestSend"), workspaceId: z.string(), items: z.array(PullRequestItem).min(1) }),
  /** Posts a reply as the person through this computer's signed-in command line, never a copy's: under the comment on
   * a line replyTo names, in the thread threadId names, or a new comment in the conversation where it names none.
   * Answered as a GitPrReplyReply with the new comment. */
  z.object({
    id: reqId,
    op: z.literal("workspaces.pullRequestReply"),
    workspaceId: z.string(),
    replyTo: z.number().int().nonnegative().optional(),
    threadId: z.string().optional(),
    body: z.string().max(PR_REPLY_BODY_MAX),
  }),
  /** Resolves or unresolves a review thread by its node id as the person, through this computer's command line alone,
   * answered as a GitPrResolveReply. */
  z.object({ id: reqId, op: z.literal("workspaces.pullRequestResolve"), workspaceId: z.string(), threadId: z.string(), resolved: z.boolean() }),
  /** Adds a reaction to the item a node id names, or takes it off where on is false, as the person through this
   * computer's command line alone; answered as a GitPrReactReply with every reaction on the item now. */
  z.object({ id: reqId, op: z.literal("workspaces.pullRequestReact"), workspaceId: z.string(), subject: z.string(), content: ReactionContent, on: z.boolean() }),
  /** Asks the workspace's agent to fix a failed check, named, with its log's failed steps; with no check, updates the
   * copy from its base first and asks it to fix the conflicts where the merge had any. Answered as a FixResult at
   * once, the turn going on without the caller. */
  z.object({ id: reqId, op: z.literal("workspaces.fix"), workspaceId: z.string(), check: z.string().optional(), child: z.string().optional() }),
  /** Merges the workspace's pull request by the method named, or the repository's default, only while its head is
   * the commit named in head, which a window sends as the one it drew; absent is the head the host holds, never a
   * fresh read. whenChecksPass arms it to merge once they do. Answered as a MergeResult. */
  z.object({ id: reqId, op: z.literal("workspaces.merge"), workspaceId: z.string(), method: MergeMethod.optional(), whenChecksPass: z.boolean().optional(), head: z.string().min(1).optional() }),
  /** A workspace started off a GitHub issue or pull request link: the link matched to a project here by its remote
   * (project names one where two match), the text read on this computer, the copy made and, for a pull request, put
   * on its head branch, and a thread opened with the composed task at the agent, model, effort and access given or
   * the workspace's defaults. Answered as a StartResult. The person's act alone: no thread's token and no paired
   * computer reaches it. */
  z.object({
    id: reqId,
    op: z.literal("workspaces.start"),
    url: z.string(),
    project: z.string().optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    access: AccessChoice.optional(),
  }),
  /** A reviewer thread on a pull request, off its link or off a workspace's own pull request: a fresh copy at its
   * head, the agent at its harness's read-only word (Codex where none is named), and the diff in its task. Answered
   * as a StartResult. The person's act alone. */
  z.object({
    id: reqId,
    op: z.literal("workspaces.review"),
    url: z.string().optional(),
    workspaceId: z.string().optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
  }),
  /** A review workspace's draft, read, or edited first: its summary, its verdict and which comments stay ticked.
   * Answered as { review? }. */
  z.object({
    id: reqId,
    op: z.literal("workspaces.reviewDraft"),
    workspaceId: z.string(),
    summary: z.string().optional(),
    verdict: z.enum(["comment", "approve", "request_changes"]).optional(),
    on: z.array(z.object({ id: z.string(), on: z.boolean() })).optional(),
  }),
  /** Posts the draft on the pull request in one call as the person, pinned to the head it was written against, the
   * ticked comments alone. Answered as a ReviewPostResult. The person's act alone. */
  z.object({ id: reqId, op: z.literal("workspaces.reviewPost"), workspaceId: z.string() }),
  /** Merges the base's latest commits into the copy's branch, answered as a GitUpdateReply: the files that conflict
   * where it could not, the copy left as it was. */
  z.object({ id: reqId, op: z.literal("workspaces.update"), workspaceId: z.string() }),
  /** Merges a child's branch into the lead's copy with a merge commit through the lead's own daemon, answered as a
   * MergeInResult: merged with the commits it brought, merged nothing, or the files it stopped on with the copy left as
   * it was. Refused for a workspace that is not the lead's child and while a turn runs on the lead. */
  z.object({ id: reqId, op: z.literal("workspaces.mergeIn"), workspaceId: z.string(), child: z.string() }),
  z.object({ id: reqId, op: z.literal("workspaces.delete"), workspaceId: z.string() }),
  /** Turns the workspace's agents switch on or off and names its caps. Every key left out keeps what the record
   * holds, so the two flags a person gives on one line never clear the third. */
  z.object({ id: reqId, op: z.literal("workspaces.agents"), workspaceId: z.string() }).extend(WorkspaceAgents.partial().shape),
  /** Drops a workspace whose machine the provider no longer has: the record, its transcripts and its sessions leave the
   * store and workspace.deleted follows, once twelve reads in a row find the machine gone; nothing is asked of the
   * machine. Refused with the reason (kind "conflict") while any read still finds it: pause it or delete it at the provider first. */
  z.object({ id: reqId, op: z.literal("workspaces.forget"), workspaceId: z.string() }),
  /** Snapshots the workspace's disk as a project golden and replies with { projectGolden }. Refused when the workspace
   * is not running, holds no project, or its machine is not first-life (kind "notFirstLife"). The guest freezes for
   * about three seconds and keeps its first life. */
  z.object({ id: reqId, op: z.literal("workspaces.snapshot"), workspaceId: z.string() }),
  /** Replies with { projectGoldens: ProjectGolden[] }, every project golden this runtime took, newest last. */
  z.object({ id: reqId, op: z.literal("projectGoldens.list") }),
  /** Deletes a project golden's snapshot at the provider of the place its record names and replies with a
   * ProjectGoldenRemoved once the listing no longer holds it; the record leaves last. Refused while any workspace
   * stands on it, whatever its phase (kind "conflict"), and for an id no project golden holds (kind "not-found"). */
  z.object({ id: reqId, op: z.literal("projectGoldens.remove"), snapshotId: z.string() }),
  /** A person acted in the workspace through a road the runtime cannot see (typed into
   * a terminal over the browser's daemon link); the idle countdown starts over. */
  z.object({ id: reqId, op: z.literal("workspaces.touch"), workspaceId: z.string() }),
  /** Opens a channel to the workspace's daemon and replies with a DaemonOpenReply. The host dials the road the
   * workspace's kind answers with and sends its own token as the first frame. Refused with kind "refused" when the
   * door answered the upgrade with anything but 101 (the sentence carries the status and the body's first line),
   * with kind "reauth" when the daemon took the upgrade and closed 4401 on the token, and with the runtime's own
   * sentence and no kind when the machine has no road or no daemon yet, or the dial failed or timed out.
   *
   * With `placeId` in place of `workspaceId` the channel is to the daemon on a computer the person owns, over the
   * link that computer is holding: nothing is dialled, and it is refused where that computer is not connected.
   * HERE_PLACE_ID names the computer the host runs on, whose own daemon is dialled. One of the two, never both. */
  z.object({ id: reqId, op: z.literal("daemon.open"), workspaceId: z.string().optional(), placeId: z.string().optional() }),
  /** Pushes WorkspaceSysEvent frames for this workspace on this socket, one per poll tick, until sys.unsubscribe or
   * the socket goes. The one road for a workspace whose kind reads its Live rows in the host rather than off a daemon;
   * refused for every other kind, which reads them over its own daemon link with sys.watch. Replies `{}`. */
  z.object({ id: reqId, op: z.literal("sys.subscribe"), workspaceId: z.string() }),
  /** Stops this socket's sys.subscribe for the workspace; replies `{}` whether or not it held one. */
  z.object({ id: reqId, op: z.literal("sys.unsubscribe"), workspaceId: z.string() }),
  /** Sends one frame down a channel this socket opened and replies with a DaemonSendReply carrying the daemon's own
   * answer, ok or not. Refused (ok false, no kind) when the channel is not this socket's or died before the daemon
   * answered. */
  z.object({ id: reqId, op: z.literal("daemon.send"), channel: z.string(), frame: DaemonFrame }),
  /** Closes a channel this socket opened; no daemon.closed follows a close the page asked for. */
  z.object({ id: reqId, op: z.literal("daemon.close"), channel: z.string() }),
  /** Starts a turn and replies with a SessionStartResult. On a thread whose turn is still running the runtime never
   * starts a second one on the session: the message joins the running turn when the harness steers (the reply names
   * that turn), and otherwise waits for it to end before starting. */
  z.object({
    id: reqId,
    op: z.literal("sessions.start"),
    /** The record the thread runs on: a box's workspace, or the folder record of an existing thread. Absent on this
     * computer, where project, branch and cwd say where the thread runs; absent with none of them, a start out of a
     * thread runs beside that thread. */
    workspaceId: z.string().optional(),
    /** The project the thread runs in, by name or id: its folder, or the worktree branch names. */
    project: z.string().optional(),
    /** A branch other than the folder's: the thread runs in the worktree of the project's repo holding it, made
     * under the host's folder when none does. Refused on a folder that is not a git repo. */
    branch: z.string().optional(),
    prompt: z.string(),
    harness: z.string().optional(),
    /** The thread the message goes to, by its runtime id: its latest turn is resumed, and a thread whose harness never
     * announced a session takes the message as a first turn on that same thread. Refused when the workspace has no
     * thread with that id. Absent opens a thread. */
    thread: z.string().optional(),
    /** The folder the thread starts in, absolute; it wins over project and the rule. Absent leaves the runtime's
     * default folder rule (projectFor, then the kind's own folder) to say. */
    cwd: z.string().optional(),
    /** Values from the harness's catalog for the workspace (harnesses.list), refused with that list on a miss. A
     * start that opens a thread without a model runs the one the catalog marks default, so the app, the command line
     * and the MCP server run the same model; an absent effort or mode leaves the CLI's own. A start into a thread
     * that has run takes the model, effort and window it leaves out from the thread's own latest turns. */
    model: z.string().optional(),
    effort: z.string().optional(),
    permissionMode: z.string().optional(),
    /** The access in wsp's own word, which the harness's catalog row turns into its mode; refused where the row maps
     * the word to none. A permissionMode beside it wins. */
    access: AccessChoice.optional(),
    contextWindow: z.string().optional(),
    /** The model's faster output for this turn; refused naming the model where its catalog row offers none. */
    fast: z.boolean().optional(),
    /** Absent reads as person: the app never sends it, the command line sends cli, the MCP server sends agent. */
    startedBy: SessionOrigin.optional(),
    /** Minted by the client per send and echoed on the turn's session.start, so the client knows which start is its own. */
    requestId: z.string().optional(),
    /** Answer the moment the computer's threads at once holds the turn back, with outcome held, rather than once it
     * starts: the turn starts on its own when a slot frees, as its events say. The app leaves it out, so a send that
     * a host restart drops while it waits hands its words back. */
    answerHeld: z.boolean().optional(),
    /** The caller follows this turn to its end: a thread whose running turn asks for it lends the turn its own slot,
     * since it waits on the turn rather than working. A start without answerHeld is followed whatever this says, as
     * its answer waits for the launch. */
    followed: z.boolean().optional(),
    /** Minted by the client once for a send that opens the same message on several models, one copy each, and stamped
     * on each thread's row as SessionView.attempt. */
    attempt: z.string().optional(),
    /** Who the end of every turn on the thread this start opens is told, each a thread id or NOTIFY_ME: registered on
     * the thread, and each target gets one line (a session.notify event per target in this thread's transcript).
     * Refused when a target names no thread, and refused when one names the thread this start opens. */
    notify: z.array(z.string()).min(1).optional(),
    /** The TURN_TOKEN_ENV of the turn this request came out of, when it came out of one: what NOTIFY_ME is resolved
     * against. Refused when no turn on this host carries it, since a token nothing carries names a turn the caller
     * is not. */
    turnToken: z.string().optional(),
    /** The name the thread is opened under, as a person's: it stands in every client at once, the harness is told it
     * too so its own UI says the same, and no generated title ever replaces it. Refused when it is blank. */
    title: z.string().optional(),
    /** The files the message carries, in the order the person added them; refused with filesRefusal's line over the
     * caps, and refused naming the agent before the machine is asked when an image goes to an agent that reads none.
     * An image rides its harness's road; any other file lands in the thread's folder and the prompt names it. */
    attachments: z.array(Attachment).optional(),
  }),
  /** Replies with { harnesses: HarnessCatalog[] }, one per harness the runtime knows. With a workspace, the lists come
   * from the binaries on its machine where they answer; without one, from the runtime's table. */
  z.object({ id: reqId, op: z.literal("harnesses.list"), workspaceId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("sessions.list"), workspaceId: z.string().optional() }),
  /** Replies with the workspace's persisted SessionEvent[] (oldest first, capped by the runtime). With threadId,
   * replies with a HistoryPage of that thread instead: its newest events under `before` (every one when absent), at
   * most `limit` of them (HISTORY_PAGE_EVENTS when absent) and no more than HISTORY_PAGE_BYTES of them past the first,
   * so a client pages back by passing the pos of the oldest event it holds. Refused as usage when before or limit
   * comes without a thread. */
  z.object({
    id: reqId,
    op: z.literal("sessions.history"),
    workspaceId: z.string(),
    threadId: z.string().optional(),
    before: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(HISTORY_PAGE_MAX).optional(),
  }),
  /** Replies with the thread's ThreadHead, by its fold key as sessions.read takes it; refused as not found where the
   * caller reaches no such thread. */
  z.object({ id: reqId, op: z.literal("sessions.head"), threadId: z.string() }),
  /** Replies with { attachment: KeptAttachment }: one image a person's message carried, by the thread, the request id
   * its start carries and its place in the message, which the host keeps until the thread or its workspace goes. */
  z.object({ id: reqId, op: z.literal("sessions.attachment"), workspaceId: z.string(), threadId: z.string(), requestId: z.string(), index: z.number().int().nonnegative() }),
  /** Asks the harness to stop the session's running turn, or with task the one subagent of it the agent calls by that
   * id and nothing else; replies with a SessionInterruptResult. */
  z.object({ id: reqId, op: z.literal("sessions.interrupt"), sessionId: z.string(), task: z.string().optional() }),
  /** Sends a message into the session's running turn; replies with a SessionSteerResult. Takes the runtime's session
   * id, as sessions.interrupt does. */
  z.object({ id: reqId, op: z.literal("sessions.steer"), sessionId: z.string(), prompt: z.string(), requestId: z.string().optional() }),
  /** Answers a permission prompt the session's running turn relayed into the chat, by the prompt's id and one of its
   * options; replies with a SessionAnswerResult. Takes the session id the prompt's row carries, the agent's own, or
   * the runtime's. A deny may carry the person's reason, what the agent should do instead. */
  z.object({ id: reqId, op: z.literal("sessions.answer"), sessionId: z.string(), askId: z.string(), optionId: z.string(), reason: z.string().optional() }),
  /** Puts the session's running turn into another access mode from its next tool call on; replies with a
   * SessionAccessResult. Takes the runtime's session id, as sessions.interrupt does. */
  z.object({ id: reqId, op: z.literal("sessions.access"), sessionId: z.string(), permissionMode: z.string() }),
  /** Names the session's harness session in the harness's own store and keeps the name on the thread's rows; replies
   * with a SessionRenameResult. Takes the runtime's session id, as sessions.interrupt does. */
  z.object({ id: reqId, op: z.literal("sessions.rename"), sessionId: z.string(), title: z.string() }),
  /** Drops a thread no turn ever ran on: its rows and its transcript rows go and nothing is asked of the machine.
   * Takes the runtime's thread id, the one the rows carry, not a session id; refused with threadForgetRefusal's
   * sentence once a turn reached the agent. */
  z.object({ id: reqId, op: z.literal("sessions.forget"), threadId: z.string() }),
  /** Takes a thread away on this computer, its turns and its checkpoints with it: a thread in the project folder goes
   * alone and the folder is never touched; a thread in a worktree wsp made takes that worktree and every thread in it,
   * refused over files no commit holds. A thread on a box goes with its machine. */
  z.object({ id: reqId, op: z.literal("sessions.delete"), threadId: z.string() }),
  /** A window showed the thread, or `wsp thread read` read it: its read stamp moves to now, and every window hears
   * thread.marked. Takes the thread's fold key, as ThreadView.id carries it. */
  z.object({ id: reqId, op: z.literal("sessions.read"), threadId: z.string() }),
  /** The person settled these threads by hand, a root and every thread under it: each takes a settled stamp and a
   * read stamp of now, and every window hears thread.marked. Takes fold keys. */
  z.object({ id: reqId, op: z.literal("sessions.settle"), threadIds: z.array(z.string()).min(1) }),
  /** The person pinned, snoozed or placed these threads, or took one of those back with false or null: each moves on
   * the thread's record and every window hears thread.marked. A snooze stamps the thread read as well, since putting
   * a finish away is looking at it. Takes fold keys. */
  z.object({ id: reqId, op: z.literal("sessions.mark"), threadIds: z.array(z.string()).min(1), marks: ThreadMarks }),
  /** The person took settled threads back out of the fold: the settled stamp goes and the read stamp moves to now, so
   * the quiet the fold reads counts from the restore. Takes fold keys. */
  z.object({ id: reqId, op: z.literal("sessions.restore"), threadIds: z.array(z.string()).min(1) }),
  /** The words of every thread the caller reaches, the person's messages and the agent's replies, searched on the
   * host for the query, case aside: one hit per thread with a snippet around the words. Reads only what the host
   * still holds of each transcript. */
  z.object({ id: reqId, op: z.literal("sessions.search"), query: z.string() }),
  /** A question asked beside a thread, answered by the thread's harness on a copy of its session with no tools, off the
   * thread's latest row: its folder, its model and its agent. Replies with a SessionAsideResult. Nothing is recorded:
   * the transcript, the rows and the harness's own session are as they were. Takes any of the thread's session ids.
   * With askId, the answer's words go by as aside.text events under that id while the harness writes them. */
  z.object({ id: reqId, op: z.literal("sessions.aside"), sessionId: z.string(), question: z.string(), askId: z.string().optional() }),
  /** Rewinds a thread to the end of one of its turns: the turns after it leave the transcript and, where the harness
   * cuts its own history, the conversation, and with files the copy's tree goes back to that turn's checkpoint after
   * the tree as it stands is checkpointed. undo instead puts back the files the thread's last rewind replaced. */
  /** Records one step of a reply's block run on its thread and replies { run } with the step the thread now holds:
   * the one asked for, or the ending a run already had. The window runs the command in the workspace's own pty; the
   * host keeps what every window draws. */
  z.object({ id: reqId, op: z.literal("sessions.run") }).extend(RunStep.shape),
  z.object({ id: reqId, op: z.literal("sessions.rewind"), threadId: z.string(), turnId: z.string().optional(), files: z.boolean().optional(), undo: z.boolean().optional() }),
  z.object({ id: reqId, op: z.literal("golden.get"), name: z.string() }),
  /** Replies with the backend's Capabilities; the UI gates features on these. */
  z.object({ id: reqId, op: z.literal("capabilities.get") }),
  /** Boots a fresh builder for golden `name`; replies with a GoldenBuilderView.
   * Progress rides golden.stage events on the events channel. */
  z.object({ id: reqId, op: z.literal("golden.prepare"), name: z.string(), kind: MachineKind.optional() }),
  /** Snapshots the builder, smoke-tests a fork, appends a manifest version;
   * replies with { manifest, version }. The builder is consumed either way. */
  z.object({ id: reqId, op: z.literal("golden.seal"), builderId: z.string() }),
  /** Replies with { lineage: SnapshotLineage } for golden `name` (default "default"). */
  z.object({ id: reqId, op: z.literal("snapshots.list"), name: z.string().optional() }),
  /** Replies with { storage: SnapshotStorage | null }: every snapshot on the account by count, size and monthly
   * cost; null on a backend whose capabilities lack snapshotListing. */
  z.object({ id: reqId, op: z.literal("snapshots.storage") }),
  /** Replies with { points: WorkspaceCostEvent[] }: the workspace's cost ticks since metering began, across host
   * restarts, folded to the ticks where the rate changed plus the newest (appendCostPoint); empty before the first tick. */
  z.object({ id: reqId, op: z.literal("cost.history"), workspaceId: z.string() }),
  /** Replies with { places: PlaceSpend[] }: one row per place this host holds anything metered for, with what it
   * has taken since the first of the month and what it burns now. Refused on a socket let in on a ticket, as the
   * places list itself is: what a person's computers cost is that person's computer's to answer. */
  z.object({ id: reqId, op: z.literal("cost.spend") }),
  // What was used over a range split one way, and what each account signed in anywhere may still use: two answers,
  // never one figure.
  /** outside: the rows read from the computers' agent logs, which only the person's own page asks for. */
  z.object({ id: reqId, op: z.literal("usage.used"), range: UsageRange, split: UsageSplit, outside: z.boolean().optional() }),
  z.object({ id: reqId, op: z.literal("usage.accounts") }),
  /** Replies with a ResetAnswer: spends one of the account's banked resets on a computer of the person's that holds
   * its login, the one named where it is one, after reading the account there. The person's own road alone. */
  z.object({ id: reqId, op: z.literal("usage.reset"), account: z.string(), creditId: z.string().optional(), on: z.string().optional() }),
  // A computer's readings over a range, off its daemon: this computer, a joined one, or a workspace's own machine.
  z.object({ id: reqId, op: z.literal("places.readings"), placeId: z.string().optional(), workspaceId: z.string().optional(), range: UsageRange }),
  /** Moves the golden's head to a version already in its manifest; replies with a
   * SnapshotRollbackResult. A version outside the manifest fails with kind "missing". */
  z.object({ id: reqId, op: z.literal("snapshots.rollback"), version: z.number(), name: z.string().optional() }),
  /** Replies with { reach: PortReachView } for one guest port, cached per port
   * while fresh. A port outside the daemon's listening set still mints: the
   * user may have typed it. */
  z.object({
    id: reqId,
    op: z.literal("workspaces.portReach"),
    workspaceId: z.string(),
    port: z.number().int().min(1).max(65535),
  }),
  /** Replies with { probe: PortProbeView }: one fetch of the port's minted route
   * from the host, redirects unfollowed, the body read up to a cap. A 401 remints
   * the port's route before the reply, so the next portReach carries a fresh
   * token. Refused when the route cannot be fetched at all; the frame is the
   * only truth then. */
  z.object({
    id: reqId,
    op: z.literal("workspaces.portProbe"),
    workspaceId: z.string(),
    port: z.number().int().min(1).max(65535),
  }),
  /** Replaces the workspace's machine with a fresh golden fork, imports the
   * nap-time vault if one exists, and kills the old machine whatever it
   * reports. Replies with the WorkspaceView on its new machine; id and name
   * are kept. The way out of a zombie reach state. */
  z.object({ id: reqId, op: z.literal("workspaces.rebuild"), workspaceId: z.string() }),
  /** Replies with { forwards: PortForward[] }, the host's open forwards; empty when no host holds any. */
  z.object({ id: reqId, op: z.literal("forwards.list") }),
  /** Closes one forward; refused when none is open on that workspace and port. */
  z.object({ id: reqId, op: z.literal("forwards.stop"), workspaceId: z.string(), port: RelayPort }),
  /** Runs one command on the workspace's machine the way a harness turn is launched: detached, as the same user,
   * with the environment the harness adapter exports for a turn. argv is the command word by word; the runtime
   * quotes each for the machine's shell, so a word stays one word. Replies { execId } once launched, then pushes
   * ExecEvent frames to this socket only: exec.output per line, exec.exit last. The socket closing ends the
   * command, and so does the machine going away under it (deleted, paused, or unanswering: exec.exit then carries
   * the reason as its error); nothing else does, there is no deadline. cwd is the folder the command runs in, absolute;
   * absent, the folder the workspace's kind names, as a harness turn's is. The reply carries that folder back as its
   * own cwd, absent only where the kind names none and the machine's own home is where the shell landed. */
  z.object({ id: reqId, op: z.literal("workspaces.exec"), workspaceId: z.string(), argv: z.array(z.string()).min(1), cwd: z.string().optional() }),
  /** Replies with { listing: HostFolderListing }: one level of this computer's own folders, for the picker a browser
   * tab has instead of the desktop shell's dialog. `dir` absent lists the first root and a folder inside the roots
   * that is gone does the same; a path outside them is refused. `hidden` lists the hidden folders too, which are
   * otherwise only counted. `repos` answers every git repo under the roots instead of one level, most recent
   * first. `on` is the id of the computer whose folders are listed, off places.list: absent or this computer's is
   * this computer's; a computer you joined answers through its own daemon over its link, with its login's home and
   * its projects' folders as the roots; a provider keeps no computer and is refused. */
  z.object({ id: reqId, op: z.literal("host.folders"), dir: z.string().optional(), hidden: z.boolean().optional(), repos: z.boolean().optional(), on: z.string().optional() }),
  /** Replies with { config: TerminalConfig }: the person's Ghostty config on the computer running the host, read
   * again on every ask so a saved change reaches the next terminal opened; `scheme` picks the theme of a
   * light:...,dark:... value and is dark when absent. */
  z.object({ id: reqId, op: z.literal("host.terminalConfig"), scheme: TerminalScheme.optional() }),
  /** Replies with { editors: EditorChoice[] }: the editors installed on the computer running the host, in the
   * table's order. None where the host runs on a computer it keeps no table for. Only this computer's own window may
   * ask, as with editor.open below. */
  z.object({ id: reqId, op: z.literal("editor.list") }),
  /** Opens a file or a folder of one workspace in the person's editor on the computer running the host and replies
   * with { editor }, the one it opened in: `editor` where the window names one, else the preference's, else the
   * first installed. The path must resolve inside
   * that workspace's copy or its project folder on this computer, a link included. A workspace whose files are on
   * another computer opens over ssh, by its alias, once its ssh road is ready: refused with kind sshInclude and
   * sshIncludeLine until the person's ssh config reads wsp's, and with editorOpensHereLine by an editor with no
   * remote road or a host that carries no ssh. `line`, from 1, lands the editor on that line where it takes one. The
   * command is the host's own table's, run with the path as one argument and never through a shell. Only this
   * computer's own window may ask. */
  z.object({ id: reqId, op: z.literal("editor.open"), workspaceId: z.string(), path: z.string(), line: z.number().int().positive().optional(), editor: EditorId.optional() }),
  /** Replies with { port }: a port on this computer's loopback that carries to the workspace's own ssh server,
   * started there first with this computer's key allowed and its host key pinned under the workspace's alias before
   * the answer. A copy on this computer has none, since its folder opens here; a napping workspace is woken first.
   * What `wsp ssh` pipes an editor's ssh through. Only this computer's own window and the wsp command may ask. */
  z.object({ id: reqId, op: z.literal("ssh.port"), workspaceId: z.string() }),
  /** Puts the one Include line for wsp's own ssh config at the top of the person's ~/.ssh/config, or takes it out,
   * or with `on` absent only reads it, and replies with { sshInclude }, whether it stands. Only this computer's own
   * window may ask. */
  z.object({ id: reqId, op: z.literal("ssh.include"), on: z.boolean().optional() }),
  /** Replies with { report: AgentsReport }: the agents, skills and MCP servers standing on one computer or workspace,
   * read as the login the computer was added with and never as root. Nothing is started: no server is spawned and no
   * login file is read, only whether one is there. A napping workspace is not woken; it answers the last report read
   * while it ran, marked stale, or refuses where there is none. A cloud account's row is refused, since nothing stands
   * there between forks. */
  z.object({ id: reqId, op: z.literal("agents.read"), target: AgentsTarget }),
  /** Replies with { answer: ServerToolsAnswer }: one MCP server of one agent's config there, started once as that
   * login with its own command and variables, or asked once over its address, for its tools and its sign-in. Only on
   * the person's ask, under a deadline, the answer kept for an hour unless `refresh`. A server whose sign-in the
   * harness holds brings no list, only the harness's word where its words were measured; no login file is read. */
  z.object({ id: reqId, op: z.literal("servers.tools"), target: AgentsTarget, agent: z.string(), name: z.string(), refresh: z.boolean().optional() }),
  /** Replies with { icon: string | null }: a remote MCP server's icon by its host (the report's `transport.host`) as a
   * data url, asked of Google's favicon service by this host alone and kept 30 days, `refresh` asking again. Null
   * where there is none, where the host is an address or a private name, and always while the person's
   * `serverIcons` preference is off, when nothing is asked. */
  z.object({ id: reqId, op: z.literal("servers.icon"), host: z.string().min(1).max(260), refresh: z.boolean().optional() }),
  /** Replies with { signInId } once the agent's own sign-in runs in a pty there, as that computer's login, or joins
   * the one already running for that agent there, one per agent per target; its progress is pushed as agents.signIn
   * events to the sockets following it alone, which is what a page and its code are for, and the sign-in stops when
   * the last of them goes. Refused for a row that asks the person to pick, which runs in their terminal, for a row
   * whose login is a token or key this host keeps, and for a name holding a control character. With `terminal`, a
   * row that asks the person to pick runs too, in a pty there the page attaches to, whose id the first frame names. */
  z.object({ id: reqId, op: z.literal("agents.signIn"), target: AgentsTarget, agent: z.string(), terminal: z.boolean().optional() }),
  /** The same for one MCP server of that agent's config, by the harness's own command for it. */
  z.object({ id: reqId, op: z.literal("servers.signIn"), target: AgentsTarget, agent: z.string(), name: z.string() }),
  /** Types what a sign-in's page handed back into that sign-in's own pty, with the Enter the person would press. */
  z.object({ id: reqId, op: z.literal("agents.signInCode"), signInId: z.string(), code: z.string().min(1) }),
  /** Stops a sign-in this socket started or joined, killing its pty for everyone following it. */
  z.object({ id: reqId, op: z.literal("agents.signInStop"), signInId: z.string() }),
  /** Replies with { line: SignInLine }: the sign-in, or one server's with `name`, as the line the person's own
   * terminal runs there over its daemon channel. */
  z.object({ id: reqId, op: z.literal("agents.signInLine"), target: AgentsTarget, agent: z.string(), name: z.string().optional() }),
  /** Writes the agent's token or key into this host's vault, the variable its row names, checked against the shape
   * the row says the tool prints; only on the host's own socket. Replies with nothing of it. */
  z.object({ id: reqId, op: z.literal("agents.key"), agent: z.string(), key: z.string().min(1) }),
  /** Replies with { file }: the wsp server written into that agent's own config on this computer, the entry an
   * install writes, with the wsp skill beside it. Refused on any other computer. */
  z.object({ id: reqId, op: z.literal("agents.addTools"), target: AgentsTarget, agent: z.string() }),
  /** Sets how one agent runs on one computer, by the place id places.list gives it: on or off, the program, its config
   * folder, launch arguments and environment. Replies with { agent: AgentRow }, the row as a read of that computer
   * would give it, names only. The person's own road only; a variable's value only on the host's own socket. */
  z.object({ id: reqId, op: z.literal("agents.setup"), placeId: z.string(), agent: z.string() }).merge(AgentSetupSet),
  /** Replies with { skills: SkillHit[] }: skills.sh searched by this host, the one caller of it; an empty query is
   * refused, since skills.sh refuses it. */
  z.object({ id: reqId, op: z.literal("skills.search"), q: z.string(), limit: z.number().int().min(1).max(50).optional() }),
  /** Replies with { preview: SkillPreview }: a skill's SKILL.md off skills.sh by its `<owner>/<repo>/<skill>`, read
   * by this host and nothing installed. */
  z.object({ id: reqId, op: z.literal("skills.get"), skill: z.string() }),
  /** Replies with { preview: SkillPreview }: the SKILL.md of one skill there, by its name, the project's skill of that
   * name with `project`. */
  z.object({ id: reqId, op: z.literal("skills.preview"), target: AgentsTarget, name: z.string(), project: z.boolean().optional() }),
  /** Replies with { added: SkillAdded }: a skill off skills.sh put into the shared skills folder there, the project's
   * with `project`, with a link or a copy in the folder of each agent named that does not read that folder. Every
   * path in the download is checked first, the files land 0644 as that computer's login, and nothing in them runs. */
  z.object({ id: reqId, op: z.literal("skills.add"), target: AgentsTarget, skill: z.string(), agents: z.array(z.string()).optional(), project: z.boolean().optional() }),
  /** Replies with { removed: string[] }: every folder of that skill there and every link to it, gone. The skill wsp
   * writes and a plugin's are refused. */
  z.object({ id: reqId, op: z.literal("skills.remove"), target: AgentsTarget, name: z.string(), project: z.boolean().optional() }),
  /** Replies with { paths: string[] }: that skill turned off or on there, its SKILL.md renamed SKILL.md.off or back
   * in each of its folders. The skill wsp writes, a plugin's and a project's are refused. */
  z.object({ id: reqId, op: z.literal("skills.toggle"), target: AgentsTarget, name: z.string(), project: z.boolean().optional(), on: z.boolean() }),
  /** Replies with { file }: one MCP server written into that agent's own config there, the project's with `project`,
   * as that computer's login: a command with its arguments and variables, or an address with its headers. The values
   * go into that file and nowhere else; a name already there is refused rather than written over. */
  z.object({ id: reqId, op: z.literal("servers.add"), target: AgentsTarget, ...ServerAdd.shape }),
  /** Replies with { file }: that one server's entry taken out of that agent's config there, in the scope it was read
   * from, every other line of the file as it was. */
  z.object({ id: reqId, op: z.literal("servers.remove"), target: AgentsTarget, ...ServerAsk.shape }),
  /** Replies with { file }: that one server turned off or on in that agent's config there, by the switch the agent
   * itself reads; refused for an agent that keeps no such switch per server. */
  z.object({ id: reqId, op: z.literal("servers.toggle"), target: AgentsTarget, ...ServerAsk.shape, on: z.boolean() }),
  /** Replies with { setup: InitSetup }: the cloud setup as the modal opens on it, the init job included when one runs.
   * `on` prices the build at that place instead of the default one, by the name or id wsp places lists; once the
   * image stands, every build is priced at the image's own place whatever `on` says. */
  z.object({ id: reqId, op: z.literal("init.get"), on: z.string().optional() }),
  /** Saves keys into the wsp home's .env on the computer running the host: the provider key, put to that provider
   * before anything is written and saved under the variable its own module reads, and an agent's API key by the
   * sign-in row it answers, saved under the variable that agent's sign-in declares. `provider` is the word
   * WSP_PROVIDER holds for the provider the key belongs to, and naming one picks it; absent, the key goes to the
   * provider this host already forks on. Replies with { setup: InitSetup }, which says a key is held and never says
   * what it is. */
  z.object({ id: reqId, op: z.literal("init.keys"), provider: z.string().max(64).optional(), key: z.string().optional(), rows: z.record(z.string()).optional() }),
  /** Starts the init job on the road named, an agent's harness on the agent road; replies with { job: InitJob } and
   * every change after rides init.job events. One job runs at a time; a second start while one runs is refused. The
   * terminal road takes its answers from the recipe beside the state, which wsp init wrote from its own screens, and
   * is refused when there is none there. */
  z.object({ id: reqId, op: z.literal("init.start"), road: InitRoad, harness: z.string().optional(), on: z.string().optional() }),
  /** Answers one screen: the rows ticked, the answers chosen; replies with { job: InitJob }, its screens recomputed
   * and its step moved to the next. */
  z.object({ id: reqId, op: z.literal("init.answer"), screen: InitScreenId, ticks: z.array(z.string()).optional(), answers: z.record(z.string()).optional() }),
  /** Moves the job to a screen the person went back to, so a setup shut there reopens there; replies with { job: InitJob }. */
  z.object({ id: reqId, op: z.literal("init.step"), at: z.number().int().nonnegative() }),
  /** Keeps what a step has ticked, picked or typed and not sent, so a setup shut mid-step reopens on it; replies
   * with { job: InitJob }. `at` is a screen's id or the build question's own step; a step the job does not have is
   * refused. An empty draft is an answer of its own: a step whose every tick was taken off comes back with none on. */
  z.object({ id: reqId, op: z.literal("init.draft"), at: z.string().min(1).max(64), ticks: z.array(z.string()).optional(), answers: z.record(z.string()).optional() }),
  /** Runs a sign-in that ran out or failed again on the machine while the build goes on; replies with { job: InitJob }. */
  z.object({ id: reqId, op: z.literal("init.retry"), tool: z.string() }),
  /** Writes the recipe as answered and starts the build; replies with { job: InitJob } at once, the build riding on.
   * `yes` skips the sign-ins on the machine, as wsp init --yes does: a caller that asked for no waiting gets none.
   * `on` is the place the image is built on, by the name or id wsp places lists; absent takes the default place.
   * `on` is read for the first build alone: once the image stands, every build goes to the image's own place, so
   * no caller can move it.
   * `rebuild` seals the next version from a fresh machine rather than from the image plus the changes, which is the
   * question a run at a terminal is asked; absent takes whichever road the changes call for. */
  z.object({ id: reqId, op: z.literal("init.build"), firstWorkspace: z.string().optional(), importFolder: z.string().optional(), yes: z.boolean().optional(), on: z.string().optional(), rebuild: z.boolean().optional() }),
  /** Types the code a sign-in's page handed back into the tool waiting for it on the machine, as the person would at
   * that terminal; replies with { job: InitJob }. The code is never logged, kept or carried on the view. Refused when
   * no sign-in for that tool is waiting for one. */
  z.object({ id: reqId, op: z.literal("init.signInCode"), tool: z.string(), code: z.string().min(1).max(SIGN_IN_CODE_MAX) }),
  /** Stops the job where it is: a thread interrupted, a builder killed; replies with { job: InitJob }. */
  z.object({ id: reqId, op: z.literal("init.cancel") }),
  /** Replies with { preferences: Preferences }: the record on this host's state, the defaults until a client set something. */
  z.object({ id: reqId, op: z.literal("preferences.get") }),
  /** Lands the patch on the record, keeps it, pushes preferences.changed to every socket and replies with
   * { preferences: Preferences, notice? }, the notice a sentence on what the set kept but could not finish. */
  z.object({ id: reqId, op: z.literal("preferences.set"), patch: PreferencesPatch }),
  /** Replies with { release: ReleaseView }: the newest release as this host last read it, asking nobody. */
  z.object({ id: reqId, op: z.literal("release.get") }),
  /** Asks GitHub again unless the last ask was under ten minutes ago and replies with { release: ReleaseView }; a
   * changed view is pushed to every socket as release.changed. */
  z.object({ id: reqId, op: z.literal("release.check") }),
  /** Replies { ok } and then restarts this host on the files it was installed from, by the road it came up on;
   * refused where that road would not bring it back. The socket closes on the host's stopping code. */
  z.object({ id: reqId, op: z.literal("host.restart") }),
  /** Records a project: one word, which is a folder on this computer or a repo url a computer clones, and the
   * computer it lives on. Replies with { project, notice? }; refused with the three forms when the word names
   * none of them, and refused naming the project when that source is already recorded on that computer. */
  z.object({
    id: reqId,
    op: z.literal("projects.add"),
    source: z.string(),
    on: z.string().optional(),
    name: z.string().optional(),
    base: z.string().optional(),
    /** The folder on this computer a repo is cloned into, absent or empty; the project is then that folder. */
    into: z.string().optional(),
    /** What the person chose off the seed menu; required where the source is a folder on this computer and that
     * folder is seeding a computer that clones, since nothing of theirs leaves this computer unasked. */
    seed: SeedChoice.optional(),
  }),
  /** Replies with { plan: SeedPlan } for a folder on this computer: what a seed of it would carry, read off git's
   * own ignore listing and one size pass. No file's content is read and nothing leaves this computer. */
  z.object({ id: reqId, op: z.literal("project.seed.plan"), source: z.string() }),
  /** Every project this host holds. Replies with { projects }. */
  z.object({ id: reqId, op: z.literal("projects.list") }),
  /** What a new thread on each of those projects starts on, by project id, each value with where it came from, read
   * off the runtime's table rather than any machine. Replies with { defaults }. */
  z.object({ id: reqId, op: z.literal("projects.defaults") }),
  /** The project a word names, by id or by name. Replies with { project }. */
  z.object({ id: reqId, op: z.literal("projects.resolve"), ref: z.string() }),
  /** Drops a project's record; refused while a workspace of it stands, naming the workspaces. Replies with {}. */
  z.object({ id: reqId, op: z.literal("projects.remove"), projectId: z.string() }),
  /** Replies with { plan: ProjectPlan } for a folder on this computer; nothing is read into memory or uploaded. */
  z.object({ id: reqId, op: z.literal("project.plan"), source: z.string() }),
  /** Packs the folder and lands it at `dest` on the workspace's machine; progress rides project.import events and the
   * reply is { imported: ProjectImportResult }. `carry` names the secret-shaped paths from the plan that may travel as
   * they are; `rewrite` names the ones the plan offered a rewrite for, which land rewritten as offered and win over
   * carry; every other secret-shaped file is cut and named. `agents` names the plan's agents whose state for the
   * folder travels; nothing of an agent not named is read. An existing `dest` is refused (kind "exists") unless `replace`. */
  z.object({
    id: reqId,
    op: z.literal("project.import"),
    workspaceId: z.string(),
    source: z.string(),
    dest: z.string(),
    replace: z.boolean().optional(),
    carry: z.array(z.string()).optional(),
    rewrite: z.array(z.string()).optional(),
    agents: z.array(z.string()).optional(),
  }),
  /** The bundle's trip home: tars `source` on the workspace's machine with the bundle's cache exclusions and the
   * agent state keyed to it, lands the folder at `dest` on this computer and the state in the agents' homes here,
   * keyed to `dest`; progress rides project.export events and the reply is { exported: ProjectExportResult }.
   * `agents` narrows whose state comes home, by catalog id; absent, every agent with sessions for the folder does.
   * An existing `dest` is refused (kind "exists", the message naming it and how many files it holds) unless
   * `replace`; nothing is read from the machine before that check. */
  z.object({
    id: reqId,
    op: z.literal("project.export"),
    workspaceId: z.string(),
    source: z.string(),
    dest: z.string(),
    replace: z.boolean().optional(),
    agents: z.array(z.string()).optional(),
  }),
  /** Replies with { view: SealedImageView }. */
  z.object({ id: reqId, op: z.literal("image.get"), name: z.string().optional() }),
  /** Builds this host's image at `place` from the record: prepare there, import the vault, seal. Replies with
   * { build: SealedImageBuilt }; progress rides golden.stage frames carrying `place`. A place that already holds a
   * copy built from this record is answered with that copy and `built: false`, so asking twice costs nothing.
   * Refused (kind "missing") when no place of that name is held, and (kind "conflict") when the place is the one
   * this host forks on, when the place builds no copy at all, when no record exists, when the record was sealed
   * without the recipe it was built from, and when the record holds no vault and `force` is not set. */
  z.object({ id: reqId, op: z.literal("image.build"), place: z.string().min(1), name: z.string().optional(), force: z.boolean().optional() }),
  /** Writes the record and the vault, sealed to the passphrase, to `dest` on this computer. Replies with
   * { exported: SealedImageExport }. The passphrase is never logged and never kept. */
  z.object({ id: reqId, op: z.literal("image.export"), dest: z.string().min(1), passphrase: z.string().min(IMAGE_PASSPHRASE_MIN).max(256), name: z.string().optional() }),
  // A thread's slate: the window's ops and the slate verbs' (packages/protocol/src/slate/wire.ts).
  ...slateOps(),
]);

/** Every request carries where it reached the host from: here, this computer's own app, CLI or MCP, or relayed from
 * a machine. It rides the envelope beside the id rather than each op, so a verb added later carries it without
 * saying so. Absent reads here, and today every client on this computer is here in practice. */
export const RuntimeRequest = z.intersection(RuntimeOp, z.object({ origin: WorkspaceOrigin.optional() }));

/** Every op this host answers, read off the table itself rather than written out beside it, so an op added later
 * cannot be missing from the reading that decides which of them a thread may send. */
export const RUNTIME_OPS: readonly string[] = RuntimeOp.options.map(o => o.shape.op.value);

/** The request fields above that carry a secret: a key, a token, a code, a passphrase, or a record of logins or
 * environment values a person puts keys into. A new field that carries one is added here, beside its schema. */
export const SECRET_REQUEST_FIELDS: readonly string[] = ["token", "key", "rows", "code", "passphrase", "env", "envs", "headers", "sudoPassword"];

/** The secret values a request frame carries, read one level into a record and no deeper: a record of logins is as
 * deep as a secret field goes, and the frame may be a stranger's. */
export function requestSecrets(frame: unknown): string[] {
  if (typeof frame !== "object" || frame === null) return [];
  return SECRET_REQUEST_FIELDS.flatMap(field => {
    const v = (frame as Record<string, unknown>)[field];
    return typeof v === "string" ? [v] : typeof v === "object" && v !== null ? Object.values(v).filter((x): x is string => typeof x === "string") : [];
  });
}

/** The ops a socket holding a thread's own token may send, and the whole of them: the door is shut and these are
 * the openings, so an op added later reaches no thread until somebody puts it here on purpose. A thread opens
 * threads and forks machines under its own root and reads the tree it is in; every reach into a workspace is
 * refused again by the tree rule, and every act by the guard, so this list is the outer door and not the only one.
 * What is deliberately not here: the image, whose manifest holds every version's snapshot and every sign-in sealed
 * into it, since a fork takes the image its own workspace's project runs and names none; sealing that image and
 * rolling its snapshots, the project goldens, the person's keys and their init, their preferences, their folders,
 * importing and exporting a folder, every road that hands out or takes away access to this host, the two roads that
 * move a running turn's access mode or answer a permission prompt, which are the person's guard on an agent and not
 * an agent's to lift, and the daemon channel, which carries the panes a person types into while a thread drives its
 * workspace through workspaces.exec and the session ops. */
export const THREAD_OPS: readonly string[] = [
  "auth",
  "events.subscribe",
  "status.list",
  "status.subscribe",
  // Read ahead of every fork for whether this host forks at all and at which sizes, so the refusal for a host that
  // mints nothing comes in one sentence before any stage is streamed; the wsp command asks it under any token.
  "capabilities.get",
  "workspaces.landing",
  "workspaces.create",
  // The projects a thread may start children on, its own and its repository's on every computer that forks
  // machines, and what a thread there starts on; the host answers a thread those and no other.
  "projects.list",
  "projects.defaults",
  "workspaces.list",
  // Every verb a thread runs names its workspace as a person does, so the door that reads a name is open to the
  // same tokens the list is: the tree rule refuses the names outside it here exactly as it hides them there.
  "workspaces.resolve",
  "workspaces.get",
  "workspaces.touch",
  "workspaces.wake",
  "workspaces.exec",
  // A thread asks for a worktree of its own project's repo, and takes one wsp made away again.
  "worktree.make",
  "worktree.remove",
  // The checkout a thread's own copy is on, and a commit of its files with a message drafted or its own, under the
  // same tree rule and the same guard; a discard is not here, since an agent has git in its copy.
  "workspaces.checkout",
  "workspaces.commit",
  "workspaces.commitDraft",
  // A thread reads its own pull request's page, asks the agent of a workspace in its tree to fix a check or a
  // conflict, and updates such a copy from its base, under the tree rule and the guard; a merge is not here, since
  // merging is the person's act.
  "workspaces.pullRequestView",
  "workspaces.fix",
  "workspaces.update",
  // A lead merges a child's branch into its own copy under the tree rule and the guard, and only into its own
  // workspace: a child may not merge into its lead.
  "workspaces.mergeIn",
  "harnesses.list",
  "sessions.start",
  "sessions.list",
  "sessions.history",
  "sessions.head",
  "sessions.attachment",
  "sessions.interrupt",
  "sessions.steer",
  "sessions.rename",
  "sessions.read",
  "sessions.search",
  // A thread writes and reads its own slate, and a lead reads a child's; the window's own slate ops are not here.
  "slates.write",
  "slates.state",
  "slates.read",
  "slates.catalog",
];

/** The ops a computer the person paired may send with no role of its own, and the whole of them, for the reason
 * THREAD_OPS is a list: a deny list would let every op added later through by having been forgotten. Read at both
 * doors, the socket and the JSON routes, so a route added later is held by the op it stands for, and a route that
 * names none is held outright. What is here is listing, reading, watching and the management of wsp's own machines
 * and records, which touch no process and no computer of the person's and write this disk only where wsp's own
 * copies land: workspaces.create on a project here runs the copy verb and puts the copy beside the person's
 * folder, open by the owner's ruling. What is not: every op that starts or puts a hand on a process (a start, a
 * steer, a stop, an answer, an access change, a command, a bring back, a pane, and a thread's rename, which runs a
 * shell on the workspace's machine and writes the person's agent session file), every op that adds, changes,
 * dials, sweeps or lands a binary on a computer of the person's or clones onto one, every op that writes keys,
 * builds or seals an image, runs the sign-ins or costs money, and every op that reads or writes this computer's
 * disk outside wsp's own folders. The daemon channel's send and close ride a channel a refused open never gave
 * this socket. A role of the person's is where this list widens, per device. */
export const DEVICE_OPS: readonly string[] = [
  "auth",
  "events.subscribe",
  "status.subscribe",
  "status.list",
  "capabilities.get",
  "ticket.issue",
  "places.list",
  "account.get",
  "devices.list",
  "devices.revoke",
  "workspaces.landing",
  "workspaces.create",
  "folder.make",
  "workspaces.list",
  "workspaces.resolve",
  "workspaces.get",
  "workspaces.nap",
  "workspaces.wake",
  "workspaces.stopWake",
  "workspaces.restartDaemon",
  "workspaces.upgrade",
  "workspaces.updateImage",
  "workspaces.rename",
  "workspaces.look",
  "workspaces.agents",
  "workspaces.delete",
  "workspaces.forget",
  "workspaces.snapshot",
  "workspaces.touch",
  "workspaces.portReach",
  "workspaces.portProbe",
  "workspaces.rebuild",
  "workspaces.checkout",
  "workspaces.viewed",
  "workspaces.pullRequestView",
  "workspaces.pullRequestDiff",
  // A review draft's ticks, verdict and summary are a record on this computer, as a viewed mark is; its post is not
  // here, since posting under the person's name is the person's act.
  "workspaces.reviewDraft",
  "projects.list",
  "projects.defaults",
  "projects.resolve",
  "projects.remove",
  "projectGoldens.list",
  "projectGoldens.remove",
  "sys.subscribe",
  "sys.unsubscribe",
  "harnesses.list",
  "sessions.list",
  "sessions.history",
  "sessions.head",
  "sessions.attachment",
  "sessions.forget",
  "sessions.read",
  "sessions.settle",
  "sessions.mark",
  "sessions.restore",
  "sessions.search",
  "golden.get",
  "image.get",
  "snapshots.list",
  "snapshots.storage",
  "snapshots.rollback",
  "cost.history",
  "cost.spend",
  // The person's own usage and accounts: read on a paired device, never by a thread, which reads no one's accounts.
  "usage.used",
  "usage.accounts",
  "places.readings",
  "forwards.list",
  "forwards.stop",
  "preferences.get",
  "preferences.set",
  "release.get",
  "release.check",
  "host.terminalConfig",
  "init.get",
  // A window on a paired computer draws a slate and writes its values, which start no run and fire no reaction; a
  // press, an approval and a cancel act on the person's computer, so they are not here.
  "slates.get",
  "slates.state",
  "slates.catalog",
  "slates.shown",
  "slates.subscribe",
  "slates.unsubscribe",
  "slates.resolve",
];

/** The one sentence a thread's own token is refused an op with. It names the op rather than guessing why a caller
 * wanted it: the reasons are on the acts, and this is the door saying the op is not a thread's at all. */
export function threadOpRefusal(op: string, threadId: string): string {
  return `${op} is not a thread's to ask for; the token this request came in on is thread ${threadWord(threadId)} on a machine, which opens threads and forks machines under its own root and reads that tree`;
}

/** The workspace an event is about, for the one reading every door that hides a workspace from a caller shares: the
 * id on the event itself, else the id of the record or the status it carries. An event that names none is about
 * this host rather than about any workspace, which is why a caller that may see only its own tree is sent none. */
export function workspaceIdOf(event: unknown): string | undefined {
  const e = event as { workspaceId?: unknown; workspace?: { id?: unknown }; status?: { id?: unknown }; forward?: { workspaceId?: unknown } };
  for (const found of [e.workspaceId, e.workspace?.id, e.status?.id, e.forward?.workspaceId]) if (typeof found === "string") return found;
  return undefined;
}

/** The thread an event is on behalf of, beside the reading above and for the same door: an event about a workspace
 * that has no record yet is nobody's by the reading above, so the caller it was asked for by is named on it. */
export function askerOf(event: unknown): EventAsker | undefined {
  const asked = (event as { askedBy?: { threadId?: unknown; rootThreadId?: unknown } }).askedBy;
  if (typeof asked?.threadId !== "string" || typeof asked.rootThreadId !== "string") return undefined;
  return { threadId: asked.threadId, rootThreadId: asked.rootThreadId };
}
export type RuntimeRequest = z.infer<typeof RuntimeRequest>;

/** What a workspaces.exec pushes to the socket that asked. exitCode is null when the command was ended without
 * one (the socket closed or the launch failed); error says which. */
export const ExecEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("exec.output"), execId: z.string(), text: z.string() }),
  z.object({ type: z.literal("exec.exit"), execId: z.string(), exitCode: z.number().int().nullable(), error: z.string().optional() }),
]);
export type ExecEvent = z.infer<typeof ExecEvent>;

export const RuntimeOkResponse = z.object({ id: reqId.nullable(), ok: z.literal(true) }).passthrough();
/** `kind` carries a typed failure when the runtime has one (engine WspError
 * kinds such as "concurrency", or "notFirstLife" from a refused seal). */
export const RuntimeErrorResponse = z.object({
  id: reqId.nullable(),
  ok: z.literal(false),
  error: z.string(),
  kind: z.string().optional(),
  /** What to do about it, when the refusal was made with one; `error` already ends with it. */
  fix: z.string().optional(),
});
export const RuntimeResponse = z.union([RuntimeOkResponse, RuntimeErrorResponse]);
export type RuntimeResponse = z.infer<typeof RuntimeResponse>;

// --- session interrupt (what a stop button gets back) -------------------------

/** accepted: the harness was told to stop and the turn ends with status interrupted; for a subagent, the agent took
 * the stop and the child reads stopped once it says so.
 * not-running: the turn, or the subagent, had already ended, so there was nothing to stop.
 * not-found: this runtime holds no such session (sessions live in memory; a restart forgets them).
 * refused and unsupported answer a subagent's stop alone: the agent would not stop that one, or offers no stop of one
 * subagent at all, and `error` says which in words.
 * None of these is an error reply: a stop button has nothing to recover from. */
export const SessionInterruptOutcome = z.enum(["accepted", "not-running", "not-found", "refused", "unsupported"]);
export type SessionInterruptOutcome = z.infer<typeof SessionInterruptOutcome>;
export const SessionInterruptResult = z.object({
  outcome: SessionInterruptOutcome,
  /** The threads under this one that were running and were stopped with it, by id: a root thread and the tree its
   * agents spawned stop as one, since a lead left standing while its builders are cut is neither state. Absent
   * where the thread spawned none that were running. */
  under: z.array(z.string()).optional(),
  /** The words for a refused or unsupported stop of a subagent. */
  error: z.string().optional(),
  /** What the stop could not end on a computer the person joined, in words: processes the thread started there that
   * still run. Absent where everything it started ended, or the thread keeps no group of its own. */
  left: z.string().optional(),
});
export type SessionInterruptResult = z.infer<typeof SessionInterruptResult>;

/** What a stop of one subagent the agent refused says, in the agent's own words; the line it stands in names the task. */
export const taskStopRefusedLine = (agent: string, why: string): string => `${agent} would not stop it: ${why}`;
/** What a stop of one subagent says where the agent offers none. */
export const taskStopUnsupportedLine = (agent: string): string => `Stop is not available for ${agent} subagents; stop the thread to stop them all`;

// --- session steer (what send-now on a queued row gets back) -------------------

/** accepted: the harness took the message into the running turn and a session.steer event carries it.
 * not-running: the turn had ended, or had not started, when the message was offered; the caller starts a turn instead.
 * unsupported: the session's harness takes no message mid-turn (its catalog says steers: false).
 * not-found: this runtime holds no such session. None is an error reply. */
export const SessionSteerOutcome = z.enum(["accepted", "not-running", "unsupported", "not-found"]);
export type SessionSteerOutcome = z.infer<typeof SessionSteerOutcome>;
export const SessionSteerResult = z.object({ outcome: SessionSteerOutcome });
export type SessionSteerResult = z.infer<typeof SessionSteerResult>;

// --- session access (what a pick made while a turn runs gets back) ---------------------

/** The thread's record takes the mode on every answer but not-found, so its next turn runs at it whichever comes
 * back. set: the thread is at the mode now; on a running turn from its next tool call and on the prompt it was
 * stopped on where that mode answers one, a harness whose CLI takes the change only at launch set too by its
 * adapter answering that turn's prompts itself; on a thread between turns, from its next turn. unsupported: the
 * turn running now takes no access change and nothing could stand in for it, so it keeps the mode it started at
 * and the next turn runs at the pick. not-running: the running turn's process is gone before the pick reached it.
 * not-found: this runtime holds no such session. None is an error reply, as a mode the harness's own list does not
 * carry is. */
export const SessionAccessOutcome = z.enum(["set", "not-running", "unsupported", "not-found"]);
export type SessionAccessOutcome = z.infer<typeof SessionAccessOutcome>;
export const SessionAccessResult = z.object({ outcome: SessionAccessOutcome });
export type SessionAccessResult = z.infer<typeof SessionAccessResult>;

// --- session answer (what picking an option on a relayed permission prompt gets back) --

/** answered: the harness took the answer and the tool call it blocks ran or was refused as the option says, and a
 * session.permission.closed event carries it. gone: no such prompt is open on that session, so it was answered
 * already, withdrawn by the harness, or its turn is over; the row closes on that event, not on this reply.
 * unsupported: the session's harness raises no prompt this host can answer. not-found: this runtime holds no such
 * session. no-option: the prompt is open and carries no option by that id. None is an error reply. */
export const SessionAnswerOutcome = z.enum(["answered", "gone", "unsupported", "not-found", "no-option"]);
export type SessionAnswerOutcome = z.infer<typeof SessionAnswerOutcome>;
export const SessionAnswerResult = z.object({ outcome: SessionAnswerOutcome });
export type SessionAnswerResult = z.infer<typeof SessionAnswerResult>;

// --- session rename (what a name a person typed came to in the harness's store) -

/** renamed: the harness's store took the name, in the field the harness itself writes, and the thread's rows carry
 * it. unsupported: the session's harness keeps no name of a person's, so nothing was written and nothing would have
 * survived its next turn. no-session: the store answered and holds no such session, or the harness never announced
 * one for this thread. failed: the store was there and refused the write, and `error` is the line the machine gave
 * for it. not-found: this runtime holds no such session. None is an error reply. */
export const SessionRenameOutcome = z.enum(["renamed", "unsupported", "no-session", "failed", "not-found"]);
export type SessionRenameOutcome = z.infer<typeof SessionRenameOutcome>;
export const SessionRenameResult = z.object({ outcome: SessionRenameOutcome, error: z.string().optional() });
export type SessionRenameResult = z.infer<typeof SessionRenameResult>;

/** One thread whose words hold the query: the thread by the runtime's id and the workspace it runs on, and the words
 * around the first place they hold it, on one line. */
export const SessionSearchHit = z.object({ workspaceId: z.string(), threadId: z.string(), snippet: z.string() });
export type SessionSearchHit = z.infer<typeof SessionSearchHit>;
export const SessionSearchResult = z.object({ hits: z.array(SessionSearchHit) });
export type SessionSearchResult = z.infer<typeof SessionSearchResult>;

/** The harness's answer to a side question, which the host keeps nowhere. */
export const SessionAsideResult = z.object({ text: z.string() });
export type SessionAsideResult = z.infer<typeof SessionAsideResult>;
/** What a rewind did: how many turns left the conversation, and how many files the copy's tree wrote or removed
 * where the files went back too. */
/** What a rewind did: the turns it cut, the files it put back, and why it left the files where they stood. */
export const SessionRewindResult = z.object({ turns: z.number().int(), files: z.number().int().optional(), kept: z.string().optional() });
export type SessionRewindResult = z.infer<typeof SessionRewindResult>;

// --- session start (how the turn the caller asked for came to be) --------------

/** started: a turn of its own began. steered: the thread's turn was running and took the message mid-way, so
 * session is that turn and a session.steer event carries the message. queued: the thread's turn was running and could
 * not take a message, so this start waited for it to end and then began. The reply comes back once the turn began,
 * but for held: a start that asked with answerHeld, answered as its computer's threads at once holds it back, its
 * session carrying capped; the turn starts when a slot frees.
 * turnId is the turn's, as its events carry it: a follower keys on it, since the thread's earlier turns share the
 * session row. */
export const SessionStartOutcome = z.enum(["started", "steered", "queued", "held"]);
export type SessionStartOutcome = z.infer<typeof SessionStartOutcome>;
export const SessionStartResult = z.object({ session: SessionView, outcome: SessionStartOutcome, turnId: z.string() });
export type SessionStartResult = z.infer<typeof SessionStartResult>;
