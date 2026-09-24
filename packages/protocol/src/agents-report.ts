// SPDX-License-Identifier: AGPL-3.0-only
// What stands on one computer or workspace for the agents: each agent with its
// version and sign-in word, every skill with every folder it lives in, every
// MCP server with how it is reached. One report serves the app, the command
// line and the MCP tools. Names and states only: no value of a key, a token,
// a header or an env variable is ever in it.
import { z } from "zod";

/** Whether an agent on a computer can run a turn there without anybody signing anything in: its own login stands on
 * that computer, the vault this host holds has the variable that agent reads, or neither. One word per agent, worked
 * out by the host from the computer's report and the vault, since the computer knows no catalog. */
export const AgentSignInState = z.enum(["signed-in", "vault-key", "none"]);
export type AgentSignInState = z.infer<typeof AgentSignInState>;

/** What a report is read off: a computer by the id places.list gives it (this one's included), or one workspace. */
export const AgentsTarget = z.union([z.object({ placeId: z.string() }).strict(), z.object({ workspaceId: z.string() }).strict()]);
export type AgentsTarget = z.infer<typeof AgentsTarget>;

/** How the agent's binary got onto that computer: by wsp's own install under its tools folder, by the person or
 * another installer (`own`), as a wrapper another program puts in front of it (`shim`), or it is not there. */
export const AgentRoad = z.enum(["wsp", "own", "shim", "none"]);
export type AgentRoad = z.infer<typeof AgentRoad>;

/** How a person signs the agent in where it stands: a device page, a code pasted back, a key, a token minted here,
 * the agent's own terminal because it asks the person to pick, or no sign-in at all. Off the catalog's sign-in row. */
export const SignInRoad = z.enum(["device", "code", "key", "token", "terminal", "none"]);
export type SignInRoad = z.infer<typeof SignInRoad>;

export const AgentRow = z.object({
  id: z.string(),
  name: z.string(),
  /** The agent's command answers on that computer's login PATH. */
  installed: z.boolean(),
  version: z.string().optional(),
  /** The newest version its vendor publishes, read by this host. */
  latest: z.string().optional(),
  /** The version the catalog installs. */
  pinned: z.string().optional(),
  road: AgentRoad,
  /** Where the command answers from, `~`-relative under the home. */
  path: z.string().optional(),
  signIn: z.union([AgentSignInState, z.literal("unknown")]),
  signInRoad: SignInRoad,
  /** One of its MCP config files names the wsp server. */
  wspTools: z.boolean(),
});
export type AgentRow = z.infer<typeof AgentRow>;

/** One folder a skill lives in: `~`-relative, the agent whose own folder it is (none for a folder several agents
 * read), and where a link points when the folder is one. */
export const SkillPath = z.object({ path: z.string(), agent: z.string().optional(), linkTo: z.string().optional() });
export type SkillPath = z.infer<typeof SkillPath>;

export const SkillScope = z.enum(["user", "project", "plugin"]);
export type SkillScope = z.infer<typeof SkillScope>;

/** One skill by its name, with every folder it lives in. `description` is off its SKILL.md's frontmatter. */
export const SkillRow = z.object({ name: z.string(), description: z.string().optional(), paths: z.array(SkillPath).min(1), scope: SkillScope });
export type SkillRow = z.infer<typeof SkillRow>;

/** One tool a server lists, as its tools/list answers it. */
export const McpTool = z.object({ name: z.string(), description: z.string().optional() });
export type McpTool = z.infer<typeof McpTool>;

/** How a server is reached, shown and never run: the command with every value of the person's hidden, or the host
 * of its url. */
export const McpRowTransport = z.discriminatedUnion("kind", [z.object({ kind: z.literal("stdio"), line: z.string() }), z.object({ kind: z.literal("http"), host: z.string() })]);
export type McpRowTransport = z.infer<typeof McpRowTransport>;

/** A server's sign-in as its config alone says it: nothing to sign in (`open`), a saved sign-in (`signed-in`), one
 * it needs, one that failed, or no way to tell without connecting (`unknown`). */
export const McpAuth = z.enum(["open", "signed-in", "needs-sign-in", "failed", "unknown"]);
export type McpAuth = z.infer<typeof McpAuth>;

/** `home`: Claude Code's servers kept for the home folder itself; `project`: a workspace's project files. */
export const McpScope = z.enum(["user", "home", "project"]);
export type McpScope = z.infer<typeof McpScope>;

export const McpRow = z.object({
  agent: z.string(),
  name: z.string(),
  scope: McpScope,
  /** The config file it is defined in, `~`-relative under the home. */
  file: z.string(),
  transport: McpRowTransport,
  /** The variables its definition sets or reads, names only. */
  envNames: z.array(z.string()),
  auth: McpAuth,
  enabled: z.boolean(),
  /** On a computer you own: whether wsp's recipe job put it there. Absent where no recipe job keeps a record. */
  inRecipe: z.boolean().optional(),
  tools: z.array(McpTool).optional(),
});
export type McpRow = z.infer<typeof McpRow>;

export const AgentsReport = z.object({
  target: AgentsTarget,
  home: z.string(),
  /** The login every read ran as: the owner of the home. */
  user: z.string(),
  readAt: z.string(),
  /** The workspace is napping and this is the last report read while it ran; nothing was asked of it. */
  stale: z.literal("napping").optional(),
  agents: z.array(AgentRow),
  skills: z.array(SkillRow),
  servers: z.array(McpRow),
  /** One line per reader that could not answer, naming it. */
  refused: z.array(z.string()),
});
export type AgentsReport = z.infer<typeof AgentsReport>;

/** Why a cloud account's row has no report: nothing stands there between forks. */
export const providerAgentsRefusal = (name: string): string =>
  `${name} keeps no computer to read, since every workspace there is forked fresh from the image; name a workspace there, or edit the image`;

/** Why a napping workspace read nothing: a read never wakes a machine, and none was read while it ran. */
export const nappingAgentsRefusal = (name: string): string => `${name} is napping and was not read while it ran; wake it to read what stands there`;

/** Why a computer that runs every line as root refused to read: the lines would run as root in somebody's home. */
export const noRunuserRefusal = (user: string): string => `this computer runs wsp as root and has no runuser to run as ${user}, the owner of the home, so nothing was read`;
