// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the cloud setup modal over a fake api at
// each of its screens (?screen=choice|keys|agents|tools|also|logins|wsp|ask|
// build|signing|done|failed), in either theme (?theme=light), so a test can
// lay out and photograph every state the ticket names. The screens' data is
// what the host hands over for a small laptop: two agents, the tools with the
// floor locked on, a manager's rows, three sign-ins, one agent for the tools.
import { createRoot } from "react-dom/client";
import { LOGIN_STATE_WORDS, MCP_ADDED_WORD, SIGN_IN_OPEN_STATE, type InitJob, type InitScreen, type InitSetup } from "@wsp/protocol";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { Api } from "../../src/protocol/client";
import { useStore } from "../../src/protocol/store";
import { CloudSetupDialog } from "../../src/sidebar/CloudSetupDialog";
import "../../src/index.css";

const params = new URLSearchParams(window.location.search);
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");
const at = params.get("screen") ?? "choice";

const SCREENS: InitScreen[] = [
  {
    id: "agents",
    title: "Agents",
    top: "Which coding agents go on your machine image.",
    counter: "1/6",
    items: [
      { id: "claude", label: "Claude Code", hint: "208.0 MB", why: "on this Mac", detail: ["on this Mac; its config (40.0 KB) comes along"] },
      { id: "codex", label: "Codex", hint: "455.0 MB", why: "not on this Mac", detail: ["not on this Mac; try it on the machine, nothing here changes"] },
      { id: "gemini", label: "Gemini CLI", hint: "112.0 MB", why: "not on this Mac", detail: [] },
    ],
    ticks: ["claude"],
    answers: {},
    footer: [{ text: "On: 1 agent, 208.0 MB" }],
  },
  {
    id: "tools",
    title: "Tools",
    top: "What installs on the image, from what you use.",
    counter: "2/6",
    items: [
      { id: "node", label: "node", hint: "60.0 MB", group: "Always on the image", detail: [], lock: "on" },
      { id: "git", label: "git", hint: "12.0 MB", group: "Always on the image", detail: [], lock: "on" },
      { id: "gh", label: "gh", hint: "40.2 MB", why: "used 412 times in 37 sessions", group: "You use these", detail: [] },
      { id: "yq", label: "yq", hint: "9.8 MB", why: "used 12 times in 4 sessions", group: "You use these", detail: [] },
      { id: "ripgrep", label: "ripgrep", hint: "5.6 MB", why: "installed here, never used", group: "Installed here, never used", detail: [] },
      { id: "bun", label: "bun", hint: "92.0 MB", why: "ships in 3 lab images; on request", group: "Also in the catalog", detail: [] },
    ],
    ticks: ["node", "git", "gh", "yq"],
    answers: {},
    footer: [{ text: "On: 4 tools, 122.0 MB" }, { text: "on when used in 3 sessions and 10 commands; heavy rows 5 and 20" }, { text: "Disk: 1.4 GB of 8 GB", tone: "yellow" }],
  },
  {
    id: "also",
    title: "Also on this Mac",
    top: "We found these installed on this Mac. Tick the ones you or your agents need on the image.",
    counter: "3/6",
    items: [
      { id: "brew/jq", label: "jq", hint: "1.2 MB", group: "Homebrew", detail: ["brew install jq"] },
      { id: "brew/ffmpeg", label: "ffmpeg", hint: "412.0 MB", group: "Homebrew", detail: ["brew install ffmpeg"] },
      { id: "npm/turbo", label: "turbo", hint: "38.0 MB", group: "npm", detail: ["npm i -g turbo"] },
    ],
    ticks: ["brew/jq"],
    answers: {},
    footer: [{ text: "Disk: 1.4 GB of 8 GB", tone: "yellow" }],
    empty: "nothing found here yet",
  },
  {
    id: "logins",
    title: "Sign-ins",
    top: "Each row is something the machine needs to be signed in to. Choose how.",
    counter: "4/6",
    items: [
      { id: "logins/claude", label: "Claude Code login", group: "Agents", why: "Keychain: Claude Code-credentials", detail: ["claude auth login"], choices: [{ value: "copy", label: "copy from this Mac" }, { value: "machine", label: "sign in on the machine" }, { value: "key", label: "API key" }, { value: "skip", label: "skip" }] },
      { id: "logins/gh", label: "GitHub CLI login", group: "Developer CLIs", why: "~/.config/gh/hosts.yml", detail: ["gh auth login"], choices: [{ value: "copy", label: "copy from this Mac" }, { value: "machine", label: "sign in on the machine" }, { value: "skip", label: "skip" }] },
      { id: "logins/gcloud", label: "Google Cloud login", group: "Developer CLIs", why: "nothing to copy here", detail: ["gcloud auth login"], choices: [{ value: "machine", label: "sign in on the machine" }, { value: "skip", label: "skip" }] },
    ],
    ticks: [],
    answers: { "logins/claude": "machine", "logins/gh": "machine", "logins/gcloud": "skip" },
    footer: [],
  },
  { id: "wsp", title: "wsp for your agents on this Mac", top: "Add wsp's MCP server and skill to the agents installed here, so they can drive your workspaces.", counter: "5/6", items: [{ id: "wsp-tools/claude", label: "Claude Code", detail: ["writes ~/.claude.json"] }], ticks: ["wsp-tools/claude"], answers: {}, footer: [], empty: "no agent here takes the wsp tools yet" },
];

const STAGES: InitJob["rows"] = [
  { id: "agent/claude", kind: "agent", label: "Claude Code", state: MCP_ADDED_WORD },
  { id: "stage/creating", kind: "stage", label: "Machine created", state: "done", ms: 14_000 },
  { id: "stage/deploying-daemon", kind: "stage", label: "Base installed", state: "done", ms: 61_000 },
  { id: "stage/applying-setup", kind: "stage", label: "Setup applied", state: "done", ms: 8_000 },
  { id: "stage/uploading-files", kind: "stage", label: "Files uploaded", state: "done", ms: 4_000 },
  { id: "stage/installing-harness", kind: "stage", label: "Installing agents", state: "running", detail: "npm i -g @anthropic-ai/claude-code" },
  { id: "stage/installing-tools", kind: "stage", label: "Installing tools", state: "waiting" },
  { id: "stage/installing-mcp", kind: "stage", label: "Installing MCP servers", state: "waiting" },
  { id: "stage/ready", kind: "stage", label: "Waiting for the machine", state: "waiting" },
  { id: "stage/snapshotting", kind: "stage", label: "Taking the snapshot", state: "waiting" },
  { id: "stage/promoting", kind: "stage", label: "Saving it as a durable template", state: "waiting" },
  { id: "stage/smoke-forking", kind: "stage", label: "Booting a fork to prove it", state: "waiting" },
  { id: "stage/sealed", kind: "stage", label: "Sealing", state: "waiting" },
  { id: "workspace/first", kind: "workspace", label: "first", state: "waiting" },
];
const done = (rows: InitJob["rows"], label: (r: InitJob["rows"][number]) => string = r => r.label): InitJob["rows"] => rows.map(r => (r.kind === "stage" ? { ...r, label: label(r), state: "done", detail: undefined } : r));

const base: InitJob = { id: "init_1", road: "manual", phase: "answering", keys: { solari: true, anthropic: false }, screens: SCREENS, rows: [], progress: { done: 0, total: 0 }, log: [] };
const JOBS: Record<string, InitJob> = {
  building: { ...base, phase: "building", screens: [], rows: STAGES, progress: { done: 5, total: 14 } },
  signing: {
    ...base,
    phase: "signing-in",
    screens: [],
    rows: [
      ...done(STAGES.slice(0, 9)),
      { id: "sign-in/claude", kind: "sign-in", tool: "claude", label: "Claude Code login", state: LOGIN_STATE_WORDS["signed-in"] },
      { id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "GitHub CLI login", state: SIGN_IN_OPEN_STATE, page: "https://github.com/login/device", code: "8F4A-C21B" },
      // The row whose page hands a code back: the field for it sits under the row.
      { id: "sign-in/gcloud", kind: "sign-in", tool: "gcloud", label: "Google Cloud login", state: SIGN_IN_OPEN_STATE, page: "https://accounts.google.com/o/oauth2/auth", finish: "code" },
      ...STAGES.slice(9),
    ],
    progress: { done: 10, total: 16 },
  },
  done: {
    ...base,
    phase: "done",
    screens: [],
    rows: [
      ...done(STAGES.slice(0, 13)).filter(r => r.id !== "stage/promoting"),
      { id: "sign-in/claude", kind: "sign-in", tool: "claude", label: "Claude Code login", state: LOGIN_STATE_WORDS["signed-in"] },
      { id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "GitHub CLI login", state: LOGIN_STATE_WORDS["signed-in"] },
      { id: "workspace/first", kind: "workspace", label: "first", state: "forked" },
    ],
    progress: { done: 15, total: 15 },
    golden: { version: 1 },
    workspace: { id: "ws_first", name: "first" },
  },
  failed: { ...base, phase: "failed", screens: [], rows: [...done(STAGES.slice(0, 5)), { ...STAGES[5]!, label: "Installing agents failed", state: "failed" }], progress: { done: 5, total: 6 }, error: "npm i -g @anthropic-ai/claude-code exited 1: ENOSPC: no space left on device" },
};

const setup: InitSetup = {
  keys: { solari: at !== "keys", anthropic: false },
  agents: [
    { id: "claude", name: "Claude Code", configured: true },
    { id: "codex", name: "Codex", configured: false },
  ],
  pricing: { size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 },
  job: JOBS[at] ?? (SCREENS.some(s => s.id === at) || at === "ask" ? base : null),
};

const api: Api = {
  listWorkspaces: async () => [],
  getWorkspace: async () => {
    throw new Error("none");
  },
  createWorkspace: async () => {
    throw new Error("none");
  },
  createFromGoldenHead: async () => {
    throw new Error("none");
  },
  watchStatuses: async () => [],
  nap: async () => {
    throw new Error("none");
  },
  wake: async () => {
    throw new Error("none");
  },
  upgrade: async () => {
    throw new Error("none");
  },
  capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: false, previewUrls: true, signedUrls: true, containers: false, callbackRelay: true, snapshotListing: true, templates: true, kept: false, sizes: [] }),
  daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
  portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
  startSession: async () => ({ id: "s1", workspaceId: "ws", harness: "claude", status: "running" }),
  listSessions: async () => [],
  sessionHistory: async () => [],
  getGolden: async () => undefined,
  listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
  snapshotStorage: async () => null,
  rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
  subscribe: () => () => {},
  initGet: async () => setup,
  initKeys: async () => setup,
  initStart: async () => base,
  initAnswer: async () => base,
  initBuild: async () => JOBS["building"]!,
  initSignInCode: async () => JOBS["signing"]!,
  initCancel: async () => ({ ...base, phase: "cancelled" }),
};

useStore.setState({ conn: "live", hasGolden: false, initJob: setup.job });
useStore.getState().bind(api);

/** Which screen index the modal opens on, for a screen named by id; the modal itself walks from the first. */
const screenAt = SCREENS.findIndex(s => s.id === at);

// The key screen is one press past the choice, as it is for a person: the fixture presses Continue once the choice is drawn.
if (at === "keys") {
  const press = setInterval(() => {
    const key = document.querySelector<HTMLButtonElement>("[data-k=choice] [data-k=primary]");
    if (key !== null) {
      clearInterval(press);
      key.click();
    }
  }, 20);
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <CloudSetupDialog onClose={() => {}} {...(screenAt >= 0 ? { openAt: screenAt } : at === "ask" ? { openAt: SCREENS.length } : {})} />
  </TooltipProvider>,
);
