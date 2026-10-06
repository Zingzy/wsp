// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { channel } from "../wire/helpers.js";
import { WorkspaceProject } from "./workspace.js";

// --- project bundle: a folder on this computer landed on a workspace -----------

/** How the collector's credential pass decided a file is secret-shaped: by name, by owner-only mode, by the key
 * names in it, by a PEM header, by a URL with a password in it, by a gitleaks hit, by the catalog, by secret-shaped
 * exports, or by git history. */
export const CredentialSignal = z.enum(["name", "mode", "keys", "pem", "url", "gitleaks", "catalog", "exports", "history"]);
export type CredentialSignal = z.infer<typeof CredentialSignal>;
/** How a repository config lands when its rewrite is accepted: `urls` as they then read, their userinfo removed,
 * and `drop` the config keys (http.extraheader carrying an Authorization header) whose lines are left out. */
export const ProjectRewrite = z.object({ urls: z.array(z.string()), drop: z.array(z.string()) });
export type ProjectRewrite = z.infer<typeof ProjectRewrite>;
/** A secret-shaped file in the folder, by path relative to it; it travels only when the import names it in carry,
 * or in rewrite when `rewrite` is offered: then it lands rewritten as described, and the machine's own login (gh's)
 * is the credential there. Offered only when the rewrite removes every secret shape the file has. */
export const ProjectSecret = z.object({ path: z.string(), bytes: z.number(), signals: z.array(CredentialSignal), rewrite: ProjectRewrite.optional() });
export type ProjectSecret = z.infer<typeof ProjectSecret>;
/** How an agent's state for the folder travels by file: `moves` when the files carry every key and the resolver
 * re-keys them to the new path so the agent resumes there, `transcript-only` when the rows in a shared store that
 * hold or find the sessions stay behind and only the files travel, if there are any. */
export const ProjectCarry = z.enum(["moves", "transcript-only"]);
export type ProjectCarry = z.infer<typeof ProjectCarry>;
/** One agent whose home on this computer holds sessions for the folder, by catalog id: the count, the bytes of the
 * state files that would travel and the carry answer. An agent whose store could not be read keeps its row with
 * `error` saying why and zero sessions; it never travels. */
export const ProjectAgent = z.object({ agent: z.string(), name: z.string(), sessions: z.number(), bytes: z.number(), carry: ProjectCarry, error: z.string().optional() });
export type ProjectAgent = z.infer<typeof ProjectAgent>;
/** What a project import would carry, for the person to read before anything is packed: the files and their bytes,
 * the secret-shaped ones, the caches left behind (relative paths), the paths named but not carried, with why, and the
 * agents with sessions for the folder. */
export const ProjectPlan = z.object({
  /** The folder on this computer, absolute. */
  source: z.string(),
  /** Whether the folder has a .git; the repository travels whole when it does. */
  repo: z.boolean(),
  /** Regular files that would travel, the secret-shaped ones counted. */
  files: z.number(),
  bytes: z.number(),
  secrets: z.array(ProjectSecret),
  excluded: z.array(z.string()),
  skipped: z.array(z.object({ path: z.string(), note: z.string() })),
  agents: z.array(ProjectAgent),
});
export type ProjectPlan = z.infer<typeof ProjectPlan>;
/** The steps of one import in order; `failed` ends one that threw. */
export const ProjectImportStage = z.enum(["planned", "consented", "packing", "uploading", "landing", "done", "failed"]);
export type ProjectImportStage = z.infer<typeof ProjectImportStage>;
/** Progress of one import: one plain sentence per stage, the time since it began, and on uploading the bytes sent so
 * far of the archive's total. */
export const ProjectImportEvent = z.object({
  type: z.literal("project.import"),
  workspaceId: z.string(),
  source: z.string(),
  dest: z.string(),
  stage: ProjectImportStage,
  message: z.string(),
  elapsedMs: z.number(),
  bytes: z.number().optional(),
  total: z.number().optional(),
});
export type ProjectImportEvent = z.infer<typeof ProjectImportEvent>;
/** What became of one agent the import named: `moved` when the agent is on the machine and its module re-keyed every
 * file to dest, or merged its rows into its store there; `transcript-only` when it is on the machine but only its
 * files landed and the rows in its shared store that list them are still to come; `carried` when it is not there so
 * the files landed as they were, `nothing` when no file of its travelled, `failed` when the move raised and nothing of
 * that agent landed, or the merge on the machine failed after its files did; files and bytes are what landed. */
export const ProjectAgentOutcome = z.enum(["moved", "transcript-only", "carried", "nothing", "failed"]);
export type ProjectAgentOutcome = z.infer<typeof ProjectAgentOutcome>;
/** `sessions` is how many the files hold when the trip counted them; `skipped` is how many sessions the agent's own
 * index named whose transcript was not under its home (Codex keeps archived ones elsewhere), so their rows moved
 * and nothing else did. `rows` is what the merge on the machine inserted or updated in the agent's store, once it
 * ran; `note` says why the rows still wait when they could not be merged yet (the agent has not made its store
 * there), or what the merge kept as the machine had it rather than as carried. */
export const ProjectAgentResult = z.object({
  agent: z.string(),
  files: z.number(),
  bytes: z.number(),
  outcome: ProjectAgentOutcome,
  sessions: z.number().optional(),
  skipped: z.number().optional(),
  error: z.string().optional(),
  rows: z.number().optional(),
  note: z.string().optional(),
});
export type ProjectAgentResult = z.infer<typeof ProjectAgentResult>;
/** What landed: the path on the machine, the files and bytes extracted there, the upload parts, the secret-shaped
 * paths that were cut because the import did not name them, the ones that landed rewritten as the plan offered,
 * each named agent's outcome, and the project the workspace now holds, so a client shows the folder in its list the
 * moment the host answers rather than waiting for the machine to say anything about it. */
export const ProjectImportResult = z.object({ dest: z.string(), files: z.number(), bytes: z.number(), parts: z.number(), cut: z.array(z.string()), rewritten: z.array(z.string()), agents: z.array(ProjectAgentResult), project: WorkspaceProject });
export type ProjectImportResult = z.infer<typeof ProjectImportResult>;
/** The steps of one export in order; `failed` ends one that threw. */
export const ProjectExportStage = z.enum(["packing", "downloading", "landing", "done", "failed"]);
export type ProjectExportStage = z.infer<typeof ProjectExportStage>;
/** Progress of one export, the bundle's trip home: one plain sentence per stage, the time since it began, and on
 * downloading the bytes received so far of the archive's total. `source` is the folder on the machine, `dest` where
 * it lands on this computer. */
export const ProjectExportEvent = z.object({
  type: z.literal("project.export"),
  workspaceId: z.string(),
  source: z.string(),
  dest: z.string(),
  stage: ProjectExportStage,
  message: z.string(),
  elapsedMs: z.number(),
  bytes: z.number().optional(),
  total: z.number().optional(),
});
export type ProjectExportEvent = z.infer<typeof ProjectExportEvent>;
/** What came home: the folder on this computer, the files and bytes landed there, the cache roots left behind on
 * the machine (relative paths), and each agent whose state for the folder was found on the machine with what became
 * of it here: `moved` when its module keyed every file to dest, `transcript-only` when the files landed but the rows
 * in its shared store here do not list them yet, `nothing` when it had no file to bring, `failed` with the reason. */
export const ProjectExportResult = z.object({ dest: z.string(), files: z.number(), bytes: z.number(), excluded: z.array(z.string()), agents: z.array(ProjectAgentResult) });
export type ProjectExportResult = z.infer<typeof ProjectExportResult>;

// --- a computer's folders, as a folder picker browses them --------------------

/** One folder on a computer the host holds. `repo` is a folder git tracks, which a picker marks. */
export const HostFolder = z.object({
  path: z.string(),
  repo: z.boolean(),
  /** On a repo found by a repos listing: the branch its checkout is on, absent on a detached head. */
  branch: z.string().optional(),
  /** On a repo found by a repos listing: when git last wrote to it, in ms, which the list is sorted by. */
  touchedAt: z.number().optional(),
});
export type HostFolder = z.infer<typeof HostFolder>;
/** One level of a computer's disk, this one's or a box's: the folder listed, the roots every level is browsed from
 * (that computer's home folder and each of its projects' folders), the folders directly inside it, and how many
 * were left out for being hidden. No web picker can hand a page a path, so this is what a browser tab has instead of
 * the desktop shell's dialog, and the only way to see a box's folders at all. */
export const HostFolderListing = z.object({
  dir: z.string(),
  roots: z.array(z.string()),
  folders: z.array(HostFolder),
  /** Folders whose name starts with a dot, counted rather than listed unless the ask said to list them. */
  hidden: z.number().int(),
});
export type HostFolderListing = z.infer<typeof HostFolderListing>;

// --- the person's own terminal config, as the terminal pane applies it --------

export const TerminalScheme = z.enum(["light", "dark"]);
export type TerminalScheme = z.infer<typeof TerminalScheme>;

export const TerminalRgb = z.object({ r: channel, g: channel, b: channel });
export type TerminalRgb = z.infer<typeof TerminalRgb>;
/** Ghostty's cursor-style words, which libghostty takes as its default cursor style. */
export const TerminalCursorStyle = z.enum(["block", "bar", "underline", "block_hollow"]);
export type TerminalCursorStyle = z.infer<typeof TerminalCursorStyle>;
/** The keys of a Ghostty config the terminal pane honours, read off this computer with Ghostty's own lookup order
 * and its theme resolved for one scheme. Only what the files set is here: an absent key leaves the pane's default.
 * `files` is every config and theme file read, in load order; empty when the person has no Ghostty config. Every
 * key but `backgroundBlur` is applied; that one is served for the record, since the blur is the desktop window's
 * own material and a browser tab has none. */
export const TerminalConfig = z.object({
  files: z.array(z.string()),
  /** The primary face first, then the fallbacks the file names after it. */
  fontFamily: z.array(z.string()),
  fontSize: z.number().positive().optional(),
  /** The theme the file names for the scheme asked for, as it names it. */
  theme: z.string().optional(),
  background: TerminalRgb.optional(),
  foreground: TerminalRgb.optional(),
  /** Palette entries 0 to 15; null where the files set none. */
  palette: z.array(TerminalRgb.nullable()).length(16),
  selectionBackground: TerminalRgb.optional(),
  cursorColor: TerminalRgb.optional(),
  cursorStyle: TerminalCursorStyle.optional(),
  cursorStyleBlink: z.boolean().optional(),
  windowPaddingX: z.object({ left: z.number().min(0), right: z.number().min(0) }).optional(),
  windowPaddingY: z.object({ top: z.number().min(0), bottom: z.number().min(0) }).optional(),
  /** 1 is opaque; under 1 the pane paints its background over whatever sits behind it. */
  backgroundOpacity: z.number().min(0).max(1).optional(),
  /** Ghostty's blur intensity; 0 is none, true in the file is 20. Read and served, not applied by the pane. */
  backgroundBlur: z.number().int().min(0).optional(),
});
export type TerminalConfig = z.infer<typeof TerminalConfig>;
