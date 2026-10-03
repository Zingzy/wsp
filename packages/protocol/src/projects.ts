// SPDX-License-Identifier: AGPL-3.0-only
// The rules a project is recorded and read by: what one word to `wsp add`
// names, what a project is called, where its checkout sits inside a workspace
// of it, and which workspace a folder on this computer belongs to. The
// command line, the runtime and the app all read them here, so no road can
// record a project one way and read it back another.
import { THIS_COMPUTER, thisComputer } from "./format.js";
import { HERE_PLACE_ID, namesPlace } from "./place-word.js";
import type { ProjectSource, ProjectView, WorkspaceKind, WorkspaceProject } from "./index.js";
import { folderName, underProject } from "./project-path.js";
import { shellLine, shellQuote } from "./shell-quote.js";
import { kindWords } from "./workspace-state.js";

/** What a caller is told once a project is recorded: what it is called, where its code comes from, the computer it
 * lives on and where a workspace of it holds the checkout, then the line that makes one. The command line prints it
 * and the tool answers it, so both doors say the same thing about the same record. The computer is named the way
 * every table names it, off the same places reading and the same platform word; a caller with no map says the id. */
export function addedProjectLine(project: ProjectView, named: ReadonlyMap<string, string> | undefined, platform: "darwin" | "linux"): string {
  return addedProjectOn(project, computerNamed(project.computer, named, platform));
}

/** The same sentence where the computer's word is already in hand, which is the landing's road: the add says how
 * far it has got as it goes and its last stage is this line, so the terminal reads where the project is from the
 * add itself and no door says that fact a second time. */
export function addedProjectOn(project: ProjectView, computer: string): string {
  const here = copiesFolder(kindForComputer(project.computer));
  return `${project.name} ${project.id}: ${sourceWord(project.source)} on ${computer}, at ${project.path}${here ? `\nopen a thread on it with: wsp run ${shellQuote(project.name)} "<message>"` : ""}`;
}

/** What the add says before any work runs on that computer: what is being recorded and where its code comes from,
 * and, where nothing of the person's folder travels with it, that nothing is seeded. It counts nothing else: what
 * travels is the seeding's own line in the counts the menu showed, and a count of ticked files here read as the
 * whole of a seed that was also carrying a memory folder. */
export function addingProjectLine(name: string, source: ProjectSource, seeding: boolean): string {
  return `${name} from ${sourceWord(source)}${seeding ? "" : ", nothing seeded"}.`;
}

/** What one word to `wsp add` names: a computer of the person's own over ssh, a repo a computer clones by its own
 * url, `owner/repo` on a host whose signed-in command line the image carries, or a folder a computer holds. Read
 * once here, so the command line, the tool and the runtime cannot each decide for themselves what somebody typed.
 * A word that is none of them throws with the forms. */
export function sourceKind(word: string): "computer" | "git" | "github" | "gitlab" | "folder" {
  // A path is a path first: /Users/me/repo.git is a folder somebody named that way, not a url.
  if (word.startsWith("/") || word.startsWith("~") || word.startsWith(".")) return "folder";
  // A host named in front of the path is that host's, which is how gitlab is named: the bare owner/repo form is
  // github's, the same word `gh repo clone` itself takes.
  const host = /^(github|gitlab)\.com\/[^/]+\/[^/]+$/.exec(word);
  if (host !== null) return host[1] === "gitlab" ? "gitlab" : "github";
  if (word.includes("://") || /^[\w.-]+@[\w.-]+:/.test(word) || word.endsWith(".git")) return "git";
  if (/^[\w.-]+@[\w.-]+$/.test(word)) return "computer";
  if (/^[\w.-]+\/[\w.-]+$/.test(word)) return "github";
  throw new Error(ADD_FORMS_LINE);
}

/** The forms `wsp add` takes, which is what a word matching none of them is refused with. */
export const ADD_FORMS_LINE =
  "wsp add takes user@host or an ssh alias for a computer of yours, a folder on this computer for a project here, or a repo with --on <computer> for a project there: its url, owner/repo on github, or gitlab.com/owner/repo";

/** The one word a source is written as, whichever kind it is: the folder's path, the repo's url, or the
 * `owner/repo` a host's own command line takes. Read by every line that says where a project's code comes from,
 * so no road spells one kind of source two ways. */
export function sourceWord(source: ProjectSource): string {
  if (source.kind === "folder") return source.path;
  return source.kind === "git" ? source.url : source.repo;
}

/** What a project is called: the repo's last word without .git, or the folder's own name. */
export function projectNameOf(source: ProjectSource): string {
  if (source.kind === "folder") return folderName(source.path);
  const word = sourceWord(source);
  const last = word.replace(/\/+$/, "").split(/[/:]/).pop() ?? word;
  return last.replace(/\.git$/, "");
}

/** Where a project's checkout sits inside a workspace of it: the folder itself where the source is one the
 * computer holding it already has, which every workspace there is a copy of, and `<home>/<name>` where the source
 * is a repo that computer cloned into a checkout of its own. Which home is the landing road's answer, since it is the road that knows
 * which folder a copy can be bound at inside a workspace there without leaving the mount point on the computer
 * itself. A road that clones nothing names none, and a repo is refused on such a computer before this is asked. */
export function projectPathOn(source: ProjectSource, name: string, home?: string): string {
  if (source.kind === "folder") return source.path;
  if (home === undefined) throw new Error(`${name} is a repo, and that computer holds no checkout of its own to put one in`);
  return `${home}/${name}`;
}

/** The source one word names, off the kind that word is: the shape the record keeps. A word naming a computer is
 * no project's source and is refused by its caller before this. */
export function projectSourceOf(word: string, kind: Exclude<ReturnType<typeof sourceKind>, "computer">, folderPath?: string): ProjectSource {
  if (kind === "folder") return { kind, path: folderPath ?? word };
  if (kind === "git") return { kind, url: word };
  // owner/repo as the host's own command line takes it: the host in front of it and a trailing .git are the
  // person's way of writing the same repo, and neither is part of the word that command reads.
  return { kind, repo: word.replace(/^(github|gitlab)\.com\//, "").replace(/\.git$/, "") };
}

/** Why a second project on one source on one computer is refused: one source per computer is one project, and a
 * second record of it would give two names to one checkout. */
export const sameSourceRefusal = (name: string, computer: string): string =>
  `that source is already a project on ${computer}, ${name}; one source on one computer is one project`;

/** Why a repo's url with no computer and no folder named records nothing: it is cloned into a folder here or by
 * another computer that clones, and which is the person's to say, with the other computers that clone. */
export const noComputerForSourceLine = (word: string, computers: readonly string[]): string =>
  `${word} is a repo: clone it here with --into <folder>${computers.length === 0 ? "" : `, or name the computer that clones it with --on ${computers.join(" | ")}`}`;

/** Why a repo on this computer records nothing without a folder: the clone goes where the person says. */
export const cloneIntoNeeded = (word: string): string => `${word} is a repo; name the empty folder to clone it into with --into <folder>`;

/** Why a folder that holds something is no place to clone into: the clone would land among files that are not its. */
export const cloneIntoTakenLine = (folder: string): string => `${folder} is not an empty folder; clone into an empty one or one that does not exist yet`;

/** Why --into beside a computer that is not this one is refused: the folder is on the computer named, and the other
 * computer clones where it keeps its own checkouts. */
export const intoIsHereLine = (here: string): string => `--into is a folder on ${here}; drop --on to clone there, or drop --into to clone on the computer you named`;

/** Why --into beside a folder is refused: the folder is the project where it already is. */
export const INTO_TAKES_A_REPO_LINE = "--into is where a repo is cloned; a folder is a project where it already is";

const CLONE_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
/** A login ssh is handed: nothing it could read as an option, and nothing a shell or a url would have to escape. */
const CLONE_USER = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
const SCP_FORM = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*:[^\s-][^\s]*$/;
const OWNER_REPO = /^[\w.][\w.-]*\/[\w.][\w.-]*$/;

/** Why a repo word is not one this computer clones, or nothing where it is: an https url, an ssh url, git's scp form
 * or owner/repo, with no credentials in it, no login, host or path that git or ssh could read as an option, and no
 * transport of git's that runs a command or reads this computer's own files. */
export function cloneUrlRefusal(word: string): string | undefined {
  const refused = `${word} is not a repo address wsp clones; give its https or ssh url, or owner/repo`;
  if (/\s/.test(word) || word.startsWith("-")) return refused;
  let kind: ReturnType<typeof sourceKind>;
  try {
    kind = sourceKind(word);
  } catch {
    return refused;
  }
  if (kind === "github" || kind === "gitlab") return OWNER_REPO.test(word.replace(/^(github|gitlab)\.com\//, "")) ? undefined : refused;
  if (kind !== "git") return refused;
  if (SCP_FORM.test(word)) return undefined;
  let url: URL;
  try {
    url = new URL(word);
  } catch {
    return refused;
  }
  if (url.protocol !== "https:" && url.protocol !== "ssh:") return refused;
  if (url.password !== "" || (url.protocol === "https:" && url.username !== "")) return refused;
  if (url.username !== "" && !CLONE_USER.test(url.username)) return refused;
  if (!CLONE_HOST.test(url.hostname) || url.pathname.length <= 1) return refused;
  return undefined;
}

/** What a sign-in failure reads like from git, ssh and gh: a private repo answers "not found" to a clone with no
 * login rather than admitting it exists. */
const SIGN_IN_FAILURE = /authentication failed|could not read username|terminal prompts disabled|permission denied \(publickey\)|not found|could not resolve to a repository|gh auth login|HTTP 40[13]/i;

/** What a failed clone says: git's own last line, and where it failed for want of a login, how to give it one. */
export function cloneFailedLine(said: string): string {
  const last = said.trimEnd().split("\n").at(-1)?.trim() ?? "";
  if (last === "") return "the clone failed and said nothing";
  return SIGN_IN_FAILURE.test(said) ? `${last}; sign in with gh auth login, or use the repo's ssh url` : last;
}

/** Why a folder on this computer seeding a project on another computer needs the person's answer first: what git
 * ignores in that folder is theirs, and nothing of it leaves this computer until they have read the menu and
 * ticked what travels. */
export const seedChoiceNeeded = (folder: string): string =>
  `${folder} would seed the project on that computer, so what travels is yours to pick: read the menu and add it again with your ticks, or --yes for the ones the catalogue ticks itself`;

/** A start on this computer that names no project and comes from no thread: nothing says which folder it runs in. */
export const NAME_A_PROJECT_LINE = "name the project the thread runs in";

/** A branch named on a send into a thread: a thread keeps the folder it runs in. */
export const BRANCH_ON_A_THREAD_LINE = "a thread keeps its folder; start a new thread for another branch";

/** A branch named for a thread on a box: worktrees are made on this computer, for a project here. */
export const BRANCH_HERE_ONLY_LINE = "--branch takes a project on this computer, where wsp makes worktrees";

/** A start naming both a branch and a folder: the branch picks a folder of its own. */
export const BRANCH_OR_CWD_LINE = "name a branch or a folder, not both";

/** A start on this computer for a project another computer holds. */
export const notOnThisComputerLine = (project: string): string => `${project} is not on this computer, so no thread runs in its folder here`;

/** A folder a thread may not run in: only the project folder and the worktrees of its repo are a project's. */
export const cwdOutsideLine = (path: string, project: string): string => `${path} is not in ${project} or a worktree of it; wsp add it first`;

/** What taking a thread away on this computer takes, the question a delete puts first: the thread's turns and
 * checkpoints, and the worktree wsp made with every thread in it where the thread ran in one. */
export function threadDeleteQuestion(threadId: string, worktree: string | undefined): string {
  return worktree === undefined
    ? `Delete thread ${threadId}?\nIts turns and checkpoints leave this computer; the folder it worked in is left as it is.`
    : `Delete thread ${threadId}?\nThe worktree at ${worktree} is removed with every thread in it; the branch and the project folder are left as they are.`;
}

/** What a thread delete did. */
export function threadDeletedLine(threadId: string, gone: { worktree?: string; threads: number }): string {
  return gone.worktree === undefined ? `deleted thread ${threadId}` : `deleted thread ${threadId}, the worktree at ${gone.worktree} and ${gone.threads === 1 ? "its one thread" : `its ${gone.threads} threads`}`;
}

/** What a worktree removal says once git took it away. */
export const worktreeRemovedLine = (branch: string): string => `removed the worktree for ${branch}; the branch stays`;

/** A thread taken away while its turn runs. */
export const THREAD_WORKING_LINE = "this thread is working; stop its turn first";

/** A thread on a box taken away alone: it goes with its machine. */
export const threadOnMachineLine = (machine: string): string => `a thread on ${machine} goes with its machine; wsp delete ${machine} takes both`;

/** A worktree removal refused while a thread's turn runs in it. */
export const WORKTREE_BUSY_LINE = "a thread is working in that worktree; let its turn end or stop it first";

/** A forced removal asked by a thread's own token: losing files no commit holds is the person's call alone. */
export const WORKTREE_FORCE_LINE = "only the person removes a worktree over files no commit holds; commit them, or ask them to remove it";

/** A folder of a project on this computer named to delete or forget: the verbs take threads there, never the folder. */
export const localFolderRefusal = (name: string): string => `${name} is a project's folder on this computer, which delete and forget leave alone`;

/** A worktree's record on this computer named to delete or forget: a worktree goes by its own verb or with its thread. */
export const localWorktreeRefusal = (name: string): string => `${name} is a worktree of a project on this computer, which delete and forget leave alone`;

/** Why a start on a pull request runs in the worktree holding its branch as that worktree stands. */
export const PR_BEHIND_WORDS = {
  changed: (number: number, path: string): string => `this worktree is behind pull request #${number} and holds files no commit has, so it was not updated; commit them, then run git pull --ff-only in ${path}`,
  diverged: (number: number, path: string): string => `this worktree's branch and pull request #${number} have gone different ways, so it was not updated; run git pull --rebase in ${path} to bring them together`,
  fork: (number: number, path: string, remote: string): string => `this worktree is behind pull request #${number}, whose head is on a fork; run git pull --ff-only ${remote} pull/${number}/head in ${path}`,
  unread: (number: number, said: string): string => `pull request #${number} could not be read just now (${said}), so this worktree may be behind it`,
} as const;

/** A worktree removal refused over files no commit holds: they would go with it. */
export const worktreeChangedLine = (files: number): string =>
  `that worktree has ${files} ${files === 1 ? "file" : "files"} not committed; commit ${files === 1 ? "it" : "them"}, or remove it with --force to lose ${files === 1 ? "it" : "them"}`;

/** Why a settled worktree wsp made still stands: files no commit holds, a turn running in it, or a week of either,
 * after which it is the person's to remove. */
export const keptChangedLine = (files: number): string => `${files} ${files === 1 ? "file" : "files"} not committed`;
export const KEPT_RUNNING_LINE = "a thread is running";
export const KEPT_ABANDONED_LINE = "kept 7 days; remove it by hand";

/** A removal asked of a branch with no worktree wsp made: a worktree the person or an agent made is theirs to remove. */
export const notMadeWorktreeLine = (branch: string): string => `wsp made no worktree for ${branch}; git worktree remove takes one wsp did not make`;

/** Why an old copy of a project folder was left on disk when the host moved off copies; one line per copy in the
 * file the move writes. Nothing is removed that holds a change no commit has or a branch the project could not take. */
export const OLD_COPY_WORDS = {
  changed: "it has changes no commit holds",
  stashed: "it holds stashed changes",
  noProject: "its project is no longer recorded",
  isProject: "it is the project folder itself",
  noCopier: "this host has no daemon binary to remove it with",
  unread: (said: string): string => `git could not read it: ${said}`,
  fetchFailed: (said: string): string => `the fetch of its branches into the project failed: ${said}`,
  notRemoved: (said: string): string => `it could not be removed: ${said}`,
  /** Why a turn still running on an old copy ended at the move. */
  ended: "the host moved off copies, so this copy's threads end here",
  /** What the person is told once, with the file that lists each copy kept. */
  kept: (copies: number, file: string): string => `${copies} old ${copies === 1 ? "copy" : "copies"} kept with work in ${copies === 1 ? "it" : "them"}; see ${file}`,
} as const;

/** A branch asked of a project whose folder git holds no repo in. */
export const noBranchesLine = (project: string): string => `${project} is not a git repo, so it has no branches`;

/** Why a folder on a computer that is not this one records nothing: nothing carries a folder there yet, so its
 * project is the repo that computer can clone. */
export const folderOnCopyRefusal = (computer: string): string =>
  `${computer} takes a repo it can clone, not a folder on this computer; give the repo's url, or add the folder here with no --on`;

/** What a remove says on the computer the app runs on: the folder is the project, so nothing of it moves. */
export const projectRemovedHereLine = (name: string): string => `${name} is no longer a project here; its code is where it was`;

/** What a remove leaves behind on the computer that held the project: the memory sits where the agent on that
 * computer reads it, which is the agent's own work. One clause, read by the sentence the remove answers with and
 * by the words the tool is described in, so a person asking for a remove and a person reading one are told the
 * same rule. */
export const MEMORY_KEPT_CLAUSE = "the memory its agent keeps on that computer stays";

/** What a remove says on a computer the person owns: the folder wsp itself made there at the add goes with the
 * record, and nothing else on that computer is touched. The memory clause is said only where such a folder stands
 * on the computer, read by the remove itself: a project no agent ever ran on there has no memory, and naming one
 * would name a thing that is not there. */
export const projectRemovedOnComputerLine = (name: string, computer: string, folder: string, memoryStands: boolean): string =>
  `${name} is no longer a project on ${computer}; the folder wsp kept for it there, ${folder}, is gone with its checkout${memoryStands ? `, and ${MEMORY_KEPT_CLAUSE}` : ""}`;

/** What a remove says for a project a provider keeps in an image: nothing runs on any machine, and the image
 * stays where it is, since no verb deletes one yet. */
export const projectRemovedAtProviderLine = (name: string, computer: string, snapshotId?: string): string =>
  `${name} is no longer a project on ${computer}; ${snapshotId === undefined ? "nothing of it was held there" : `its project image ${snapshotId} stays at the provider`}`;

/** Why no workspace can be made of a project recorded before its computer cloned it once at the add: there is no
 * checkout on that computer for a copy to be taken of, and nothing clones one at a create any more. Recording it
 * again is the road, by the word it was added with. */
export const projectNeedsReaddLine = (name: string, computer: string, source: ProjectSource): string =>
  `${name} was recorded before a project was cloned once on its computer, so ${computer} holds no checkout for a workspace to copy; ${shellLine(["wsp", "projects", "remove", name])}, then ${shellLine(["wsp", "add", sourceWord(source), "--on", computer])}`;

/** What the seeding says where the computer already keeps this project's memory at the path its agent reads:
 * that memory is the agent's own work on that computer and stays, so the folder the seed carried is not landed
 * over it. */
export const seedMemoryKeptLine = (computer: string): string =>
  `${computer} already keeps this project's memory where its agent reads it, so what the agent has kept there stays and the memory from your folder was not landed over it`;

/** Why a project cannot be dropped yet, with the workspaces standing on it. */
export const projectInUseRefusal = (name: string, workspaces: readonly string[]): string =>
  `${name} has ${workspaces.length === 1 ? "a workspace" : "workspaces"} standing on it: ${workspaces.join(", ")}; delete ${workspaces.length === 1 ? "it" : "them"} first`;

/** The whole of what a caller held to one project reads about a word naming another: absence and nothing else,
 * since the names of what else this host holds are not a thread's to learn from a refusal. */
export const bareNoSuchProjectLine = (ref: string): string => `no project ${JSON.stringify(ref)}`;

/** Why a word names no project here, with the ones it could have named. */
export const noSuchProjectLine = (ref: string, names: readonly string[]): string =>
  `${bareNoSuchProjectLine(ref)}; ${names.length === 0 ? "wsp add <folder> records one" : `this host holds ${names.join(", ")}`}`;

/** Why a workspace cannot be made without naming its project, with the projects to name. */
export const nameTheProjectLine = (names: readonly string[]): string =>
  `name the project this work is on: ${names.join(", ")}`;

/** A path as the machine's own shell would show it: `~` for its home and anything under it, the path as given
 * elsewhere or where the home is not known. */
export function homeShortened(path: string, home: string | undefined): string {
  if (home === undefined || !underProject(path, home)) return path;
  return path === home ? "~" : `~${path.slice(home.length)}`;
}

/** What a register says as it starts: the folder is on this computer already, so its path is recorded and nothing moves. */
export const REGISTERING_LINE = "already on this computer, registering";

/** What a register says when it has landed. */
export function registeredLine(dest: string): string {
  return `${folderName(dest)} registered at ${dest}; nothing was copied.`;
}

/** Whether a project image already holds this project's checkout, so a fork of it clones and installs nothing: the
 * image records every project that was on the disk and the path each sat at, and a fork of the whole disk comes up
 * with all of them where they were. Read off the snapshot a fork names and never off the project's own record,
 * which says nothing about which image a given workspace was forked from. */
export function imageCarriesCheckout(projects: readonly WorkspaceProject[] | undefined, path: string): boolean {
  return projects !== undefined && projects.some(p => p.dest === path);
}

/** What a fork of a project golden starts with, after the created line; nothing for an image carrying none. */
export function projectsInPlace(projects: readonly WorkspaceProject[]): string {
  return projects.length === 0 ? "" : ` with ${projects.map(p => p.name).join(", ")} in place`;
}

/** The name a fork of a project golden goes by: the newest project it carries, which is also the name `new --from`
 * takes for it; the snapshot id where a manifest carries none. */
export function goldenForkName(g: { projects: readonly WorkspaceProject[]; snapshotId: string }): string {
  return g.projects.at(-1)?.name ?? g.snapshotId;
}

/** Why an import onto this computer takes no consent flags: nothing is carried, cut, sent or replaced by a register. */
export function registerTakesNoConsentLine(flags: readonly string[]): string {
  return `${flags.join(", ")} ${flags.length === 1 ? "has" : "have"} no meaning on this computer: the folder is registered at its path and nothing is carried, cut or replaced`;
}

/** The first line of a thread opened with no folder named outright: the project, where the caller named one, and the
 * folder it went to. */
export function threadOpenedLine(threadId: string, project: string | undefined, folder: string): string {
  return project === undefined ? `thread ${threadId} in ${folder}` : `thread ${threadId} on ${project} in ${folder}`;
}

/** Whether a workspace of this kind is a copy of a folder on this computer, made by directory, and forks no image:
 * the one reading of the kind table both the create and the folder rule take. */
export function copiesFolder(kind: WorkspaceKind): boolean {
  return kindWords(kind).copiesFolder;
}

/** The kind of workspace a computer makes: the computer the app runs on copies a folder of the person's own, and
 * every other computer takes a copy of its own image. The one place a computer's id is read for its kind, so no
 * road anywhere compares that id itself. */
export function kindForComputer(computer: string): WorkspaceKind {
  return computer === HERE_PLACE_ID ? "local" : "cloud";
}

/** Where a workspace of a project on this computer lands: a copy of a folder beside the app for a project here, a
 * fork on the host's own backend for a project on the provider it forks on (`wired`), and a fork on the place it
 * names for every other one. The one rule the host forks by and a computer's page reads its projects by. */
export type WorkspaceLands = { at: "here" } | { at: "wired" } | { at: "place"; place: string };

export function workspaceLands(computer: string, wired: string | undefined): WorkspaceLands {
  if (copiesFolder(kindForComputer(computer))) return { at: "here" };
  return computer === wired ? { at: "wired" } : { at: "place", place: computer };
}

/** Whether a workspace of a project on `computer` stands on this place's row. The provider the host forks on is a
 * row under its own word, so which provider that is changes nothing here. */
export function landsOn(computer: string, place: { id: string; name: string }): boolean {
  return workspaceLands(computer, undefined).at === "here" ? place.id === HERE_PLACE_ID : namesPlace(place, computer);
}

/** Why a project on this computer takes none of the words a fork takes: its threads run in its own folder, so there
 * is no image to start from, no machine to size and no engine to hand it. The words are named in the order the
 * command line lists them, so the sentence says exactly which to drop. */
export const copyTakesNone = (project: string, words: readonly string[]): string =>
  `${project} is on ${THIS_COMPUTER}, where threads run in its folder and nothing forks, so it takes no ${words.join(", ")}`;

/** What a computer is called in a row or a line: the name this wsp holds for it, and this computer's own word
 * where the record names this one. `named` is the places table by id, which every caller already reads for its
 * other columns, and `platform` is the computer the host runs on, since its own word is Mac or computer and no
 * default can know which. The one reading, so a project's row, a workspace's row and the line a recorded project
 * answers with can never print one computer three ways. */
export function computerNamed(computer: string, named: ReadonlyMap<string, string> | undefined, platform: "darwin" | "linux"): string {
  return computer === HERE_PLACE_ID ? thisComputer(platform) : (named?.get(computer) ?? computer);
}

/** Why a thread opened with no project named, from a folder that is in no project, opens nothing; `named` is the
 * caller's word for naming one (`<project>` on the command line, `project` on the tool). */
export function noThreadTargetLine(named: string): string {
  return `${named} is needed outside your projects: run from inside a project's folder, or name the project`;
}
