// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { LoginChoice, LoginState } from "../init-job.js";
import { shellQuote } from "../shell-quote.js";
import { WorkspaceSize } from "../wire/capabilities.js";

// --- golden image (manifest, interactive builder, build stages) ---------------

export const MachineKind = z.enum(["sandbox", "desktop"]);
export type MachineKind = z.infer<typeof MachineKind>;

export const GoldenLogin = z.object({ name: z.string(), state: LoginState });
export type GoldenLogin = z.infer<typeof GoldenLogin>;
/** A tool the builder's import did not put on the image: set aside at plan or install time, or failed to install,
 * with the reason it gave. Forks of the version are missing it. `id` is the recipe row's, the key the machine's own
 * record of what did not install is kept by. */
export const GoldenMissingTool = z.object({ id: z.string(), name: z.string(), outcome: z.enum(["skipped", "failed"]), note: z.string() });
export type GoldenMissingTool = z.infer<typeof GoldenMissingTool>;
/** A path the pack left off the image, by the recipe row it belongs to and why: a hook whose script is not a plain
 * file under home. Forks of the version run without it. */
export const GoldenLeftBehind = z.object({ id: z.string(), path: z.string(), note: z.string() });
export type GoldenLeftBehind = z.infer<typeof GoldenLeftBehind>;
/** One base tool's command with the version read on the builder after the base stage. */
export const GoldenBaseTool = z.object({ name: z.string(), version: z.string() });
export type GoldenBaseTool = z.infer<typeof GoldenBaseTool>;
/** A row an update took out of the recipe. An update never takes anything off the image: the bytes stay where the
 * version before it put them and the row is recorded here, so the lineage says what a fork still carries but the
 * recipe no longer asks for. A row ticked again later leaves this list at the version that re-installs it. */
export const GoldenRetired = z.object({ id: z.string(), name: z.string() });
export type GoldenRetired = z.infer<typeof GoldenRetired>;

/** One file the recipe wrote into the image's home: where it sits under the guest home and the sha256 of the bytes
 * the builder had when the version sealed. The upgrade reads it to tell a file a fork never touched, whose new copy
 * comes with the new image, from one the fork changed, which travels. */
export const RecipeOwnedFile = z.object({
  path: z.string(),
  sha256: z.string(),
  /** The recipe marks this row volatile: a tool rewrites it as it runs, or the machine renders it. Its bytes differ
   * on any fork that has run anything, so an upgrade carries the fork's copy and never names it as a person's edit. */
  volatile: z.boolean().optional(),
});
export type RecipeOwnedFile = z.infer<typeof RecipeOwnedFile>;

/** One sealed image. `kind` is the machine kind the snapshot was taken from and
 * therefore restores as; entries sealed before kind was recorded were all
 * sandboxes, so readers treat a missing kind as sandbox. */
export const GoldenVersion = z.object({
  version: z.number(),
  snapshotId: z.string(),
  /** The durable template the seal, or wsp doctor after it, promoted the snapshot to; forks boot from it. Absent on
   * a backend without templates and on versions sealed before templates were recorded, whose forks boot from the
   * snapshot, which the provider may lose. */
  templateId: z.string().optional(),
  baseTemplate: z.string(),
  kind: MachineKind.optional(),
  setupSha: z.string(),
  createdAt: z.string(),
  smoke: z.object({ cmd: z.string(), exitCode: z.number() }),
  /** What the provider built the builder at; forks of this version inherit it unless told otherwise. */
  size: WorkspaceSize.optional(),
  /** The browser shim was on the machine when it was sealed, so its forks can be told BROWSER; versions sealed before it existed have no flag and get none. */
  browserShim: z.boolean().optional(),
  /** The sign-ins the builder was asked for and how each ended, so the app can say what a fork carries. */
  logins: z.array(GoldenLogin).optional(),
  /** Every tool the import skipped or failed to install, by name with the cause and reason, so a workspace can say why
   * one is missing; absent when every tool installed or the version was sealed before this was recorded. */
  missingTools: z.array(GoldenMissingTool).optional(),
  /** Commands the carried rc files call that the image does not have, each defined as a silent no-op in the file's
   * guard block so the shell comes up quiet; absent when every call has a command behind it. */
  silenced: z.array(z.string()).optional(),
  /** What the login shell printed to stderr when the builder started it interactively after the files landed, first
   * line and line count; absent when it started quiet or no shell row was ticked. */
  shellNoise: z.string().optional(),
  /** What the pack left off the image and why, by row and path; absent when everything ticked travelled or the version
   * was sealed before this was recorded. */
  leftBehind: z.array(GoldenLeftBehind).optional(),
  /** The snapshot the builder that sealed this version descends from: an update's head. Absent on a version built
   * from a fresh machine, and on versions sealed before this was recorded. */
  parentSnapshotId: z.string().optional(),
  /** Every base tool's command with the version read after the base stage on the builder this version descends from.
   * Absent on a version sealed before the base tools existed; its forks never ran them, so an update is refused. */
  base: z.array(GoldenBaseTool).optional(),
  /** Every row on this version's image that its recipe no longer asks for, carried from the version before it.
   * Absent when the recipe asks for everything the image carries. */
  retired: z.array(GoldenRetired).optional(),
  /** Every file this version's recipe wrote into the guest home, hashed on the builder at seal. Absent on a version
   * sealed before the manifest existed and on one built from no recipe; a fork of such a version upgrades under the
   * old rule, its whole home landing over the new image. */
  owned: z.array(RecipeOwnedFile).optional(),
  /** The builder's disk in use when the snapshot was taken, bytes; absent on versions sealed before it was recorded. */
  usedBytes: z.number().int().nonnegative().optional(),
  /** The image record's hash this copy of the version was built at; absent on a version sealed before records
   * existed, which no record matches. A manifest is one place's copies, so this is the copy's hash. */
  imageHash: z.string().length(64).optional(),
});
export type GoldenVersion = z.infer<typeof GoldenVersion>;

export const GoldenManifest = z.object({ head: z.number(), versions: z.array(GoldenVersion) });
export type GoldenManifest = z.infer<typeof GoldenManifest>;

/** The sealed version a manifest's head names, or nothing: a manifest without one has no golden to serve or fork. */
export function goldenHead(manifest: GoldenManifest | undefined): GoldenVersion | undefined {
  return manifest?.versions.find(v => v.version === manifest.head);
}

/** Whether a host holds nothing for the app to show: no sealed golden to fork from and no workspace record, this
 * computer's included. One rule for wsp up, which says there is no project yet, and the app, which opens on its
 * first launch screens. */
export const holdsNothing = (golden: GoldenManifest | undefined, workspaces: readonly unknown[]): boolean => goldenHead(golden) === undefined && workspaces.length === 0;

/** What a fork of a version boots from and the lineage's word for it: the durable template once one is recorded,
 * the snapshot until then. The one rule for every road that creates from a version and every row that says whether
 * the version survives the provider losing its snapshot store; a durable version gets no word, since a word every
 * row wears says nothing. */
export function goldenImage(v: Pick<GoldenVersion, "snapshotId" | "templateId">): { spec: { template: string } | { fromSnapshot: string }; marks: readonly "volatile"[] } {
  return v.templateId !== undefined ? { spec: { template: v.templateId }, marks: [] } : { spec: { fromSnapshot: v.snapshotId }, marks: ["volatile"] };
}

/** What a build recorded a row installed: the version, read back off the builder once the row ran (a release's tag,
 * a package's version), and the archive's sha256 where the road hashed one, with the arch whose file that was, since
 * a release serves each arch its own file and a sum holds for one of them. `latest` marks a row whose road installs
 * the current version wherever it runs, so the version is what that seal got and not what a copy is fixed to. The
 * one shape for the recipe row that carries it, the collector's row, the catalog road that installs at it, the tick
 * the seal writes and the record's pins. */
export const ToolPin = z.object({ tag: z.string().min(1), sha256: z.string().min(1).optional(), arch: z.enum(["x86_64", "aarch64"]).optional(), latest: z.literal(true).optional() });
export type ToolPin = z.infer<typeof ToolPin>;

/** What a golden is built from, as its builder records it: every ticked row
 * with its login answer, tool pin and install road, and every planned path
 * with a digest of the bytes that travel. Two recipes with equal digests build
 * the same golden; the hash a builder carries is this object's, so a later run
 * can say what changed instead of only that something did. */
export const RecipeDigest = z.object({
  ticks: z.array(
    z.object({
      id: z.string(),
      choice: LoginChoice.optional(),
      /** The version the row installs: the laptop's, or the one its road reads for it (a tap formula's release tag). */
      version: z.string().optional(),
      /** A tools row's install road by name, and the sha256 of the lines that road runs before any recorded pin: a
       * road that installs differently under the same id is a changed row. */
      road: z.string().optional(),
      installer: z.string().optional(),
      /** The version the row installed, as the build that ran it read back and stamped here; a copy planned from
       * the record installs at it. It never enters the recipe hash: the recipe that asked is the same recipe. */
      pin: ToolPin.optional(),
    }),
  ),
  /** The computer's login shell by name, when a shell row is ticked: it decides which shell the machine logs into. */
  login: z.string().optional(),
  /** A volatile entry (its tool rewrites it, or it is a Keychain value the machine gets rendered) is recorded but never hashed. */
  files: z.array(z.object({ id: z.string(), path: z.string(), dest: z.string(), digest: z.string(), volatile: z.boolean().optional() })),
});
export type RecipeDigest = z.infer<typeof RecipeDigest>;

/** Where a recipe row's tick comes from: the project the recipe was written for names it in its own manifests (with
 * the line saying which file said so), the entry is on this computer (what was found: its config paths and whether
 * its command is on PATH), the agents' session histories on this computer used it (in how many sessions, how many
 * calls), or nothing local says anything and the catalog's own evidence decides. */
export const RecipeSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), why: z.string().min(1) }),
  z.object({ kind: z.literal("installed"), paths: z.array(z.string()), bin: z.boolean() }),
  z.object({ kind: z.literal("used"), sessions: z.number().int().nonnegative(), calls: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("popular"), sessions: z.number().int().nonnegative(), images: z.number().int().nonnegative() }),
]);
export type RecipeSource = z.infer<typeof RecipeSource>;

/** One catalog entry in a recipe: ticked or not, why, its size on the machine when the catalog measured one, and
 * the sign-in answer the person or the agent that wrote the recipe gave; absent, the wizard's default stands. A tools
 * row this computer has that the catalog does not carry (a formula, a manager's global) is a row too, under the
 * collector's own id (`tools/<manager>/<package>`), so the file and the screens tick it like any other. */
export const RecipeRow = z.object({
  /** The catalog id, or the collector's row id for a tools row outside the catalog. */
  id: z.string().min(1),
  kind: z.enum(["agent", "tool"]),
  on: z.boolean(),
  source: RecipeSource,
  size: z.number().int().nonnegative().optional(),
  signIn: LoginChoice.optional(),
  /** What the last seal installed for this row, written after the build for `wsp recipe` to show; the next seal
   * reads its own and writes it over. A copy installs by the record's pins, never by these. */
  pin: ToolPin.optional(),
});
export type RecipeRow = z.infer<typeof RecipeRow>;

/** What one agent's session history on this computer gave: read with these counts, empty, there but unreadable, or
 * no reader for its format yet. Names and counts only; nothing a session held travels. */
export const RecipeHistory = z.object({
  agent: z.string().min(1),
  state: z.enum(["read", "empty", "unreadable", "no-reader"]),
  sessions: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
});
export type RecipeHistory = z.infer<typeof RecipeHistory>;

/** Which rule decided every tick in a recipe: what the person's agents used on this computer, what is installed on
 * it, or the catalog's own default. `wsp recipe --tick` names one; a recipe written without one (the wizard's
 * screens) carries none and its rows say for themselves where each tick came from. */
export const RecipeTick = z.enum(["used", "installed", "default"]);
export type RecipeTick = z.infer<typeof RecipeTick>;
/** The words `--tick` takes, in the order the help lists them. */
export const RECIPE_TICKS: readonly RecipeTick[] = RecipeTick.options;

/** A tool the recipe carries that the catalog does not, because an agent added it for the person's own projects:
 * the lines that install it, run as given on the builder after every catalog road, and one command that exits 0
 * once it is there. Nothing here is ever offered a sign-in: the install is the whole row. */
export const RecipeCustomRow = z.object({
  kind: z.literal("custom"),
  id: z.string().min(1),
  name: z.string().min(1),
  install: z.array(z.string().min(1)).min(1),
  check: z.string().min(1),
  /** The package manager the lines call, when the row came off a scan of one: the build brings that manager onto
   * the machine before the row runs. A row nobody named a manager for runs on what the base and the ticks left. */
  manager: z.string().min(1).optional(),
  /** Bytes on the machine, when whoever added the row measured one. */
  size: z.number().int().nonnegative().optional(),
  why: z.string().min(1),
});
export type RecipeCustomRow = z.infer<typeof RecipeCustomRow>;

/** The small recipe: catalog ids with a tick each and the source of that tick, written by wsp recipe from this
 * computer (or by hand, or by a local agent), read by wsp init --recipe, the app's pick screen and the import
 * of a project. Among them this computer's own tools rows the catalog does not carry, under the collector's ids, and
 * beside them the rows an agent added for tools the catalog has none for. Names, ticks and install lines only: never
 * a path's content, never a key. */
export const Recipe = z.object({
  version: z.literal(1),
  /** When it was written, ISO 8601. */
  at: z.string().min(1),
  /** The rule that decided the ticks, when one was named; a later --set keeps it, so the table reads the same. */
  tick: RecipeTick.optional(),
  histories: z.array(RecipeHistory),
  rows: z.array(RecipeRow),
  /** Rows outside the catalog, added on purpose; a recipe written before they existed carries none. */
  custom: z.array(RecipeCustomRow).optional(),
  /** Every workspace from this image gets the place's container engine through the fenced socket, as `wsp new
   * --engine` gives one; absent is none unless the create asks. */
  engine: z.boolean().optional(),
});
export type Recipe = z.infer<typeof Recipe>;

/** The custom rows a recipe carries: the one reading of a recipe that has none. */
export function customRows(recipe: Pick<Recipe, "custom">): readonly RecipeCustomRow[] {
  return recipe.custom ?? [];
}

/** What a row added without a check of its own is checked with: its command on PATH. */
export function commandCheck(bin: string): string {
  return `command -v ${shellQuote(bin)}`;
}

/** The why on a row an agent added without saying more. */
export const ADDED_BY_AGENT = "added by the agent";

/** The live machine a person sets up before sealing it as a golden. It is not
 * a workspace and never appears in the rail; `screen` is present when the
 * machine streams a display (desktop kind). */
export const GoldenBuilderView = z.object({
  id: z.string(),
  name: z.string(),
  kind: MachineKind,
  createdAt: z.string(),
  /** What the provider built, so a builder left running can be priced. */
  size: z.object({ cpu: z.number(), memMb: z.number() }),
  screen: z.object({ streamUrl: z.string() }).optional(),
  /** True while a seal can still be taken from this builder: the machine has never been paused, resumed or
   * restored, or the place it stands on copies a disk from any life of a machine. */
  sealable: z.boolean().optional(),
  /** The recipe this builder carries; a prepare with the same hash attaches to it instead of booting. */
  recipeHash: z.string().optional(),
  /** The parts behind recipeHash; absent on a builder recorded without them. */
  recipe: RecipeDigest.optional(),
  /** The owner label on the machine when it names another state file; absent when it is this one's or the provider reports none. */
  foreignOwner: z.string().optional(),
  /** The other live wsp process using this builder, when there is one; such a builder is listed and left alone. */
  heldBy: z.object({ host: z.string(), pid: z.number(), heartbeat: z.string() }).optional(),
  /** True while its stages still run in the process that holds it; left this way by a dead process, it can never seal. */
  building: z.boolean().optional(),
  /** Set once the builder was saved as this golden version and kept running for a short window, so one more
   * change re-snapshots it instead of forking; the sweep stops it when the window ends. */
  sealed: z.object({ at: z.string(), version: z.number() }).optional(),
});
export type GoldenBuilderView = z.infer<typeof GoldenBuilderView>;

export const GoldenStage = z.enum([
  "creating",
  "deploying-daemon",
  "applying-setup",
  "uploading-files",
  "installing-harness",
  "installing-tools",
  "installing-mcp",
  "ready",
  "snapshotting",
  "promoting",
  "smoke-forking",
  "sealed",
  "failed",
]);
export type GoldenStage = z.infer<typeof GoldenStage>;

/** The install step a frame belongs to, within its stage: what the step is called and the one line a person reads
 * for what it runs. A reader's clock for the step starts at the first frame naming it and stops at the first without. */
export const GoldenStep = z.object({ label: z.string(), command: z.string() });
export type GoldenStep = z.infer<typeof GoldenStep>;

/** Progress of a golden prepare or seal, keyed by golden name; `detail` is
 * free text for a progress line (the failure message on `failed`). */
export const GoldenStageEvent = z.object({
  type: z.literal("golden.stage"),
  name: z.string(),
  stage: GoldenStage,
  detail: z.string().optional(),
  step: GoldenStep.optional(),
  /** The machines this stage made and could not remove, because the provider could not be reached: they bill until
   * something takes them, so a client that can retry the kill retries it rather than reading the stage as over. */
  left: z.array(z.string()).optional(),
  /** The place a copy is being built at, when the stage is a copy's and not the wired provider's. */
  place: z.string().optional(),
});
export type GoldenStageEvent = z.infer<typeof GoldenStageEvent>;
// --- the image: the record the host owns, its vault and the copies built from it ---

/** What the sign-in stages left on the builder, archived at the seal: never the bytes on the wire, only their hash
 * and size. */
export const SealedVault = z.object({
  sha256: z.string().length(64),
  bytes: z.number().int().nonnegative(),
  /** How many guest paths the archive names; zero means the seal had nothing to hold and the copy will ask for sign-ins again. */
  paths: z.number().int().nonnegative(),
  /** The guest paths the seal archived, absolute, which every member of the archive is judged against before a copy
   * imports it. Absent on a record sealed before the list was kept, and such a record builds no copy. */
  held: z.array(z.string()).optional(),
  takenAt: z.string(),
});
export type SealedVault = z.infer<typeof SealedVault>;

/** One row's pin as the record keeps it: the row by the id that names its tool on every computer (the catalog id
 * where the catalog carries the tool, else the row's own id, which is the same on the computer that has it), what
 * it installed, and the road it took, so a reader can say in the road's words why a latest row is one. */
export const SealedPin = ToolPin.extend({ id: z.string().min(1), road: z.string().optional() });
export type SealedPin = z.infer<typeof SealedPin>;

/** The pins a sealed digest carries, one per tick that recorded one, in id order: what the record keeps beside the
 * recipe and what its hash covers. `key` is the id a row is known by across computers, the caller's catalog rule;
 * without one a tick keeps its own id. */
export function recipePins(digest: Pick<RecipeDigest, "ticks">, key: (id: string) => string = id => id): SealedPin[] {
  return digest.ticks
    .flatMap((t): SealedPin[] => (t.pin === undefined ? [] : [{ id: key(t.id), ...t.pin, ...(t.road !== undefined ? { road: t.road } : {}) }]))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The image the host owns: what every copy is built from. One per golden name. */
export const SealedImage = z.object({
  name: z.string(),
  version: z.number().int().positive(),
  /** sha256 over the recipe hash, the vault's sha256 and the pins; two copies with this hash were built from the same thing. */
  hash: z.string().length(64),
  recipeHash: z.string(),
  /** The small recipe as it stood at the seal, so a later edit of recipe.json changes no copy until the next
   * version. Absent on a record backfilled from a golden sealed before records existed, and on one sealed by a
   * road that carried no small recipe: a copy of such a record is refused, since there is nothing to build from. */
  recipe: Recipe.optional(),
  /** What each row installed at the seal, read back off the builder: a copy installs these versions, and a row
   * marked latest installs the current one and is named as such. Absent on a record sealed before pins were read. */
  pins: z.array(SealedPin).optional(),
  logins: z.array(GoldenLogin),
  sealedAt: z.string(),
  /** This computer's name at the seal, for the screen's "sealed from". */
  sealedFrom: z.string(),
  /** Absent on a record backfilled from a golden sealed before vaults existed: its copies ask for sign-ins again. */
  vault: SealedVault.optional(),
  /** The builder's disk in use at the snapshot, in bytes; absent on a version sealed before it was read. */
  usedBytes: z.number().int().nonnegative().optional(),
  /** The place the image's own seal stands at, by the id its copies are filed under: a joined computer's id or a
   * provider's. Absent on a record sealed before places, which stands at the provider the host forks on. */
  place: z.string().optional(),
});
export type SealedImage = z.infer<typeof SealedImage>;

/** One place's built copy of one version: the provider's artifact and when it was made. */
export const SealedImageCopy = z.object({
  place: z.string(),
  /** The version this place's own manifest gave the copy. Each place numbers its own, so a second place's first
   * copy is its v1 whatever version of the record it was built from; the hash is what says which record that was. */
  version: z.number().int().positive(),
  /** The record's hash when this copy was built; absent on a copy sealed before hashes, which no record matches. */
  hash: z.string().length(64).optional(),
  snapshotId: z.string(),
  templateId: z.string().optional(),
  builtAt: z.string(),
  /** From the provider's snapshot listing where it has one; absent elsewhere, never guessed. */
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type SealedImageCopy = z.infer<typeof SealedImageCopy>;

/** What a build at a place came to: the copy that place holds now, and whether this call built it. A place already
 * standing on the record is answered with its copy and `built: false` rather than refused, so a fork there and a
 * person typing the line twice both get the copy they asked for. */
export const SealedImageBuilt = z.object({ copy: SealedImageCopy, built: z.boolean() });
export type SealedImageBuilt = z.infer<typeof SealedImageBuilt>;

/** What an export wrote on this computer. */
export const SealedImageExport = z.object({ path: z.string(), bytes: z.number().int().nonnegative(), hash: z.string().length(64) });
export type SealedImageExport = z.infer<typeof SealedImageExport>;

/** The shortest passphrase an export is sealed to; a shorter one is refused before anything is read. */
export const IMAGE_PASSPHRASE_MIN = 12;

/** A sealed vault's header, one line of JSON a reader parses before anything else: it says how the bytes behind it
 * are keyed and carries the record in the plain, so an import can show what a file holds before asking for the
 * passphrase. The header's own bytes are the cipher's additional data, so an edited header fails to open. */
export const SealedVaultHeader = z.object({
  format: z.literal("wsp-vault-1"),
  cipher: z.literal("aes-256-gcm"),
  to: z.enum(["passphrase", "key"]),
  /** scrypt salt (passphrase) or HKDF salt (key), base64. */
  salt: z.string(),
  nonce: z.string(),
  /** The sender's ephemeral X25519 public key, base64, on `to: "key"` only. */
  ephemeral: z.string().optional(),
  image: SealedImage,
});
export type SealedVaultHeader = z.infer<typeof SealedVaultHeader>;

/** The detail a golden.stage frame carries for a step the builder already holds; a reader closes the step at once and charges it no time. */
export const ALREADY_APPLIED = "already applied";
/** Recipe rows under the agents rung that are MCP servers, not agents: `agents/mcp/<agent>/<name>`. The collector writes them, the engine's import reads them. */
export const MCP_ID_PREFIX = "agents/mcp/";
/** Recipe rows under the agents rung: `agents/<agent>`, the MCP servers' rows among them. */
const AGENTS_PREFIX = "agents/";
/** The agent an agents-rung row names, or nothing for an MCP server's row and for every other rung: the one rule
 * for that rung, beside packageOf for the tools rung. */
export const agentOfRow = (e: { id: string }): string | undefined => (e.id.startsWith(AGENTS_PREFIX) && !e.id.startsWith(MCP_ID_PREFIX) ? e.id.slice(AGENTS_PREFIX.length) : undefined);
/** Where a manager's rows sit under the tools rung: what every id of its packages starts with. It lives here, not
 * beside the engine's other row prefixes, because the collector writes these ids and cannot import the engine. */
export const toolRowPrefix = (manager: string): string => `tools/${manager}/`;
/** The id of a tools row a manager lists, the one spelling of it: what the collector writes for one, and what a scan
 * row of the same manager and package stands for. */
export const toolRowId = (manager: string, pkg: string): string => `${toolRowPrefix(manager)}${pkg}`;
/** Recipe rows under the tools rung that name a Homebrew formula. */
export const BREW_ID_PREFIX = toolRowPrefix("brew");
/** The package a tools row names: what follows its manager in the id (a tap formula keeps its slashes). Beside the
 * prefix above for the same reason: the collector writes these ids and cannot import the engine. */
export const packageOf = (e: { id: string }): string => e.id.split("/").slice(2).join("/");
