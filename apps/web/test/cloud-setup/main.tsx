// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the cloud setup sheet over a fake api at
// each of its steps (?screen=choice|keys|keys-refused|keys-saved|agent|agent-stopped|
// reading|agents|tools|also|logins|ask|building|signing|retry|done|failed|
// failed-key|stopped|you-stopped|slot|over|sweeping), in either theme
// (?theme=light), so a test
// can lay out and photograph every state the ticket names. The screens' data
// is what the host hands over for a small laptop: three agents, the tools with
// the base locked on and the rest by calls, a manager's rows, three sign-ins.
import { createRoot } from "react-dom/client";
import { GOLDEN_STAGE_WORDS, INIT_ROW_STATES, INIT_SIGN_IN_WORDS, KEY_REFUSED, MCP_ADDED_WORD, NETWORK_LOST_LINE, SIGN_IN_OPEN_STATE, STOP_LEFT_MACHINE_LINE, initAgentNoRecipeLine, initBuildRows, MACHINE_GONE_LINE, MACHINE_ROW_LABEL, initStageCount, initStoppedAt, keyRefusedLine, snapshotStageLine, type InitJob, type InitScreen, type InitSetup } from "@wsp/protocol";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { RequestError, type Api } from "../../src/protocol/client";
import { KEY_REFUSED_LINE, KEY_REFUSED_ROWS } from "./keyRefusedJob";
import { useStore } from "../../src/protocol/store";
import { CloudSetupDialog } from "../../src/sidebar/CloudSetupDialog";
import "../../src/index.css";

const params = new URLSearchParams(window.location.search);
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");
const at = params.get("screen") ?? "choice";
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const SIGN_IN_CHOICES = [
  { value: "copy", label: "copy from this Mac" },
  { value: "machine", label: "sign in on the machine" },
  { value: "key", label: "API key" },
  { value: "skip", label: "skip" },
];

const SCREENS: InitScreen[] = [
  {
    id: "agents",
    title: "Agents",
    top: "Which agents go on the image",
    counter: "1/6",
    items: [
      { id: "claude", label: "Claude Code", size: 208 * MIB, why: "used here, 215 sessions", detail: ["on this Mac; its config (40 KB) comes along"] },
      { id: "codex", label: "Codex", size: 455 * MIB, why: "not installed here", detail: ["not on this Mac; try it on the machine, nothing here changes"] },
      { id: "gemini", label: "Gemini CLI", size: 112 * MIB, why: "installed here, never used", detail: [] },
      { id: "hermes", label: "Hermes Agent", size: 484 * MIB, why: "not installed here", detail: ["installs, but wsp cannot run its threads yet"] },
    ],
    ticks: ["claude"],
    answers: {},
    footer: [],
    tally: "agents",
  },
  {
    id: "tools",
    title: "Tools",
    top: "Tools from your usage",
    counter: "2/6",
    items: [
      { id: "node", label: "Node 22 with npm", size: 60 * MIB, group: "always on the image", detail: [], lock: "on" },
      { id: "git", label: "git", size: 12 * MIB, group: "always on the image", detail: [], lock: "on" },
      { id: "gh", label: "GitHub CLI", size: 40 * MIB, why: "29,623 calls", group: "from your usage", detail: [] },
      { id: "yq", label: "yq", size: 10 * MIB, why: "412 calls", group: "from your usage", detail: [] },
      { id: "python", label: "Python 3.13", size: 199 * MIB, why: "1,204 calls", group: "from your usage", detail: [] },
      { id: "go", label: "Go 1.24", size: 517 * MIB, why: "88 calls", group: "from your usage", detail: [] },
      { id: "ripgrep", label: "ripgrep", size: 6 * MIB, group: "from your usage", detail: [] },
      { id: "swift", label: "Swift 6.3", size: 3.3 * GIB, group: "from your usage", detail: [] },
      { id: "bun", label: "bun", size: null, group: "from your usage", detail: [] },
    ],
    ticks: ["node", "git", "gh", "yq", "python"],
    answers: {},
    footer: [],
    tally: "tools",
  },
  {
    id: "also",
    tally: "more",
    title: "Also on this Mac",
    top: "What else this Mac brings",
    counter: "3/6",
    items: [
      { id: "brew/jq", label: "jq", size: 1.2 * MIB, group: "Homebrew", detail: ["brew install jq"] },
      { id: "brew/ffmpeg", label: "ffmpeg", size: 412 * MIB, group: "Homebrew", detail: ["brew install ffmpeg"] },
      { id: "npm/turbo", label: "turbo", size: 38 * MIB, group: "npm", detail: ["npm i -g turbo"] },
    ],
    ticks: ["brew/jq"],
    answers: {},
    footer: [],
    empty: "nothing found here yet",
  },
  {
    id: "logins",
    title: "Sign-ins",
    top: "How sign-ins reach the machine",
    counter: "4/6",
    items: [
      { id: "logins/claude", label: "Claude Code login", group: "Agents", mark: "claude", why: "Keychain", detail: ["Keychain: Claude Code-credentials", "claude auth login"], choices: SIGN_IN_CHOICES, key: { name: "ANTHROPIC_API_KEY", saved: false } },
      { id: "logins/codex", label: "Codex login", group: "Agents", mark: "codex", why: "auth.json", detail: ["~/.codex/auth.json", "codex login"], choices: SIGN_IN_CHOICES, key: { name: "OPENAI_API_KEY", saved: true } },
      { id: "logins/gh", label: "GitHub CLI login", group: "Developer CLIs", mark: "gh", why: "hosts.yml, Keychain", detail: ["~/.config/gh/hosts.yml, Keychain: gh:github.com", "gh auth login"], choices: SIGN_IN_CHOICES.filter(c => c.value !== "key") },
      { id: "logins/gcloud", label: "Google Cloud login", group: "Developer CLIs", mark: "gcloud", detail: ["gcloud auth login"], choices: SIGN_IN_CHOICES.filter(c => c.value === "machine" || c.value === "skip") },
      { id: "logins/kube", label: "kubeconfig", group: "Developer CLIs", mark: "kube", why: "config", state: "not on the image", detail: ["~/.kube/config"], choices: SIGN_IN_CHOICES.filter(c => c.value === "skip") },
      { id: "agents/mcp/claude/github", label: "github", group: "MCP servers from your agents' configs", why: "Claude Code", detail: ["stdio: npx server-github; carries a secret: env GITHUB_TOKEN"], choices: SIGN_IN_CHOICES.filter(c => c.value === "copy" || c.value === "skip") },
    ],
    ticks: [],
    answers: { "logins/claude": "key", "logins/codex": "machine", "logins/gh": "copy", "logins/gcloud": "skip", "logins/kube": "skip", "agents/mcp/claude/github": "skip" },
    footer: [],
  },
  { id: "wsp", title: "wsp for your agents on this Mac", top: "Add wsp's MCP server and skill to the agents installed here, so they can drive your workspaces", counter: "5/6", items: [{ id: "wsp-tools/claude", label: "Claude Code", detail: ["writes ~/.claude.json"] }], ticks: ["wsp-tools/claude"], answers: {}, footer: [], empty: "no agent here takes the wsp tools yet" },
];

const stage = (id: keyof typeof GOLDEN_STAGE_WORDS, state: string, over: Partial<InitJob["rows"][number]> = {}): InitJob["rows"][number] => ({ id: `stage/${id}`, kind: "stage", label: GOLDEN_STAGE_WORDS[id], state, ...over });
const STAGES: InitJob["rows"] = [
  { id: "agent/claude", kind: "agent", label: "Claude Code", state: MCP_ADDED_WORD },
  stage("creating", "done", { ms: 14_000 }),
  stage("deploying-daemon", "done", { ms: 61_000 }),
  stage("applying-setup", "done", { ms: 8_000 }),
  stage("uploading-files", "done", { ms: 4_000, lines: ["~/.zshrc", "~/.gitconfig", "~/.config/starship.toml", "3 files, 5 KB"] }),
  stage("installing-harness", "running", {
    detail: "npm i -g @anthropic-ai/claude-code",
    // Terminal output as the machine sends it: a tool's prefix, its own colours, more lines than the block shows at once.
    lines: ["pnpm: fetching @anthropic-ai/claude-code@2.1.4", "npm i -g @anthropic-ai/claude-code", "\u001b[2mnpm\u001b[22m \u001b[33mWARN\u001b[39m deprecated inflight@1.0.6", "\u001b[32m✓\u001b[39m added 1 package in 41s", "claude --version", "2.1.4 (Claude Code)", "pnpm: fetching @openai/codex@0.42.0", "\u001b[32m✓\u001b[39m added 1 package in 12s", "codex --version", "codex-cli 0.42.0", "pnpm: linking binaries"],
  }),
  stage("installing-tools", "waiting"),
  stage("installing-mcp", "waiting"),
  stage("ready", "waiting"),
  stage("snapshotting", "waiting"),
  stage("promoting", "waiting"),
  stage("smoke-forking", "waiting"),
  stage("sealed", "waiting"),
  { id: "workspace/first", kind: "workspace", label: "first", state: "waiting" },
];
const done = (rows: InitJob["rows"]): InitJob["rows"] => rows.map(r => (r.kind === "stage" ? { ...r, state: "done", detail: undefined } : r));
/** The stages after the one a stopped build was on: still listed, still waiting, whatever they carry above. */
const notYet = (rows: InitJob["rows"]): InitJob["rows"] => rows.map(r => (r.kind === "stage" ? { id: r.id, kind: r.kind, label: r.label, state: INIT_ROW_STATES.waiting } : r));
/** A machine a stop could not reach the provider to kill, as the host's sweep rides it on the current job. */
const machine = (state: string, detail?: string, id = "b_dlb9oeig"): InitJob["rows"][number] => ({ id: `machine/${id}`, kind: "machine", label: MACHINE_ROW_LABEL, state, ...(detail !== undefined ? { detail } : {}) });
// Every kind of row the slide draws: a page waiting with its code, a copy (whose note names the command the machine
// ran, which no screen shows), a sign-in done, one that ran out with Retry and no mark of its own, and the row whose
// page hands a code back, with the field for it on its action line.
const signIns: InitJob["rows"] = [
  { id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "Sign in to GitHub CLI", state: SIGN_IN_OPEN_STATE, page: "https://github.com/login/device", code: "8F4A-C21B" },
  { id: "sign-in/codex", kind: "sign-in", tool: "codex", label: "Sign in to Codex", state: INIT_SIGN_IN_WORDS.copied, detail: "codex login --api-key exited 0" },
  { id: "sign-in/gemini", kind: "sign-in", tool: "gemini", label: "Sign in to Gemini CLI", state: INIT_SIGN_IN_WORDS["signed-in"] },
  { id: "sign-in/wrangler", kind: "sign-in", tool: "wrangler", label: "Sign in to Cloudflare Wrangler", state: INIT_SIGN_IN_WORDS["not-signed-in"], detail: "wrangler login exited 1; no sign-in within 16m" },
  { id: "sign-in/gcloud", kind: "sign-in", tool: "gcloud", label: "Sign in to Google Cloud", state: SIGN_IN_OPEN_STATE, page: "https://accounts.google.com/o/oauth2/auth", finish: "code" },
];

const FACTS: InitJob["rows"] = [
  { id: "fact/identity", kind: "fact", label: "Identity", state: "3 found" },
  { id: "fact/shell", kind: "fact", label: "Shell", state: "2 found" },
  { id: "fact/toolchains", kind: "fact", label: "Toolchains", state: "1 found" },
  { id: "fact/tools", kind: "fact", label: "Tools", state: "41 found" },
  { id: "fact/agents", kind: "fact", label: "Agents", state: "2 found" },
  { id: "fact/logins", kind: "fact", label: "Sign-ins", state: "6 found" },
  { id: "fact/brew", kind: "fact", label: "Homebrew", state: "sizes read" },
  { id: "fact/history/claude", kind: "fact", label: "Claude Code", state: "215 sessions, 29,623 tool calls" },
  { id: "fact/history/codex", kind: "fact", label: "Codex", state: "running", detail: "12 sessions of 40" },
];

const DISK = { fixed: 2.8 * GIB, total: 20 * GIB };
const base: InitJob = { id: "init_1", road: "manual", phase: "answering", keys: { solari: true }, step: 0, stoppable: true, disk: DISK, screens: SCREENS, rows: [], progress: { done: 0, total: 0 }, log: [] };
const screenAt = SCREENS.findIndex(s => s.id === at);
const THREAD = { id: "th_1", workspaceId: "ws_local", session: "turn_1", harness: "claude" };
const JOBS: Record<string, InitJob> = {
  reading: { ...base, phase: "reading", screens: [], rows: FACTS },
  agent: { ...base, road: "agent", phase: "agent", screens: [], line: "read /Users/zingzy/.claude/projects", thread: THREAD },
  "agent-stopped": { ...base, road: "agent", phase: "failed", screens: [], line: "Permission for Bash: wsp recipe scan --json", error: initAgentNoRecipeLine("/Users/zingzy/.wsp/recipe.json"), thread: THREAD },
  ask: { ...base, step: SCREENS.length },
  building: { ...base, phase: "building", screens: [], rows: STAGES },
  signing: {
    ...base,
    phase: "signing-in",
    screens: [],
    rows: [...done(STAGES.slice(0, 9)), ...signIns, ...STAGES.slice(9)]
  },
  // A sign-in that ran out while the seal runs: the list is back, its stage open on the sub-rows with Retry, and the cancel link disabled.
  retry: {
    ...base,
    phase: "sealing",
    stoppable: false,
    screens: [],
    rows: [...done(STAGES.slice(0, 9)), ...signIns.map(r => (r.id === "sign-in/gh" ? { id: r.id, kind: r.kind, tool: r.tool, label: r.label, state: INIT_SIGN_IN_WORDS["not-signed-in"], detail: "no sign-in within 16m" } : r.state === SIGN_IN_OPEN_STATE ? { id: r.id, kind: r.kind, tool: r.tool, label: r.label, state: INIT_SIGN_IN_WORDS["signed-in"] } : r)), stage("snapshotting", INIT_ROW_STATES.running, { lines: [snapshotStageLine(13 * GIB)], since: Date.now() - 41_000 }), ...STAGES.slice(10)]
  },
  done: {
    ...base,
    phase: "done",
    screens: [],
    rows: [...done(STAGES.slice(0, 9)), ...signIns.map(r => (r.state === SIGN_IN_OPEN_STATE ? { id: r.id, kind: r.kind, tool: r.tool, label: r.label, state: INIT_SIGN_IN_WORDS["signed-in"] } : r)), ...done(STAGES.slice(9, 13)), { id: "workspace/first", kind: "workspace", label: "first", state: "forked" }],
    golden: { version: 1 },
    workspace: { id: "ws_first", name: "first" },
  },
  failed: { ...base, phase: "failed", screens: [], rows: [...done(STAGES.slice(0, 5)), stage("installing-harness", "failed", { lines: ["npm i -g @anthropic-ai/claude-code", "npm ERR! ENOSPC: no space left on device"] })], error: "npm i -g @anthropic-ai/claude-code exited 1: ENOSPC: no space left on device" },
  // The saved key read before the first stage and refused, as the host leaves it: the first stage failed with the
  // refusal on it and every row after it never reached, so the one way on is the step that takes a key.
  "failed-key": { ...base, phase: "failed", screens: [], rows: KEY_REFUSED_ROWS, error: KEY_REFUSED_LINE, keyRefused: true },
  // A build the network stopped: the list keeps its order and every row, the failed stage's block ends on the
  // sentence the head shows, and the stages after it still read waiting.
  stopped: {
    ...base,
    phase: "failed",
    stoppable: false,
    screens: [],
    rows: [...done(STAGES.slice(1, 3)), stage("applying-setup", INIT_ROW_STATES.failed, { lines: ["applying your setup", NETWORK_LOST_LINE] }), ...notYet(STAGES.slice(4, 13)), { id: "workspace/e2e", kind: "workspace", label: "e2e", state: INIT_ROW_STATES.notMade }],
    error: NETWORK_LOST_LINE,
  },
  // A build the person stopped: the run's own line for where it was and what became of the machine.
  "you-stopped": {
    ...base,
    phase: "cancelled",
    stoppable: false,
    screens: [],
    rows: [...done(STAGES.slice(1, 2)), stage("deploying-daemon", INIT_ROW_STATES.stopped, { lines: ["deploy wsp-daemon"] }), ...notYet(STAGES.slice(3, 13)), { id: "workspace/e2e-cancel", kind: "workspace", label: "e2e-cancel", state: INIT_ROW_STATES.notMade }],
    error: `${initStoppedAt("while installing the base tools")} ${MACHINE_GONE_LINE}`,
  },
  // The stop the provider would not take: the machine's own row rides on, and it rides on the next job too.
  sweeping: {
    ...base,
    phase: "cancelled",
    stoppable: false,
    screens: [],
    rows: [...done(STAGES.slice(1, 2)), stage("deploying-daemon", INIT_ROW_STATES.stopped, { lines: ["deploy wsp-daemon"] }), ...notYet(STAGES.slice(3, 13)), { id: "workspace/e2e-cancel", kind: "workspace", label: "e2e-cancel", state: INIT_ROW_STATES.notMade }, machine(INIT_ROW_STATES.retrying, "getaddrinfo ENOTFOUND api.getsolari.com"), machine(INIT_ROW_STATES.gone, undefined, "b_dlbauaeb")],
    error: `Stopped while installing the base tools. ${STOP_LEFT_MACHINE_LINE}`,
  },
  // Everything ticked past the image's disk: the ring is full in the danger tone and Continue refuses, which is
  // what the test presses to photograph the refusal line.
  over: { ...base, step: 2, disk: { fixed: 19.4 * GIB, total: 20 * GIB }, screens: SCREENS.map(x => (x.id === "also" ? { ...x, ticks: x.items.map(i => i.id) } : x)) },
  // The account is at its machine cap: the row says what it waits on and its block carries the runtime's own line.
  slot: {
    ...base,
    phase: "building",
    screens: [],
    rows: [stage("creating", INIT_ROW_STATES.slot, { lines: ["sandbox from base", "Solari account at its machine cap; waiting 30s for a slot (5/20). Nothing is killed.", "sandbox from base", "Solari account at its machine cap; waiting 30s for a slot (5/20). Nothing is killed."] }), ...notYet(STAGES.slice(2, 13)), { id: "workspace/first", kind: "workspace", label: "first", state: INIT_ROW_STATES.waiting }],
  },
};

/** The count the host puts on the view, from the rows themselves: one rule, so no fixture can say a number the
 * screen it feeds would not. */
const withProgress = (job: InitJob): InitJob => ({ ...job, progress: initStageCount(initBuildRows(job.rows).rows) });

const setup: InitSetup = {
  // The saved-key state is the key step reached with a key in the home, one Continue past the choice like the others.
  keys: { solari: at !== "keys" && at !== "keys-refused" },
  home: "/Users/zingzy",
  agents: [
    { id: "claude", name: "Claude Code", configured: true, takesTools: true },
    { id: "codex", name: "Codex", configured: false, takesTools: false },
  ],
  pricing: { size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 },
  job: at === "reading" ? withProgress({ ...JOBS.reading!, rows: [] }) : (JOBS[at] !== undefined ? withProgress(JOBS[at]!) : screenAt >= 0 ? { ...base, step: screenAt } : null),
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
  initKeys: async () => {
    if (at === "keys-refused") throw new RequestError(keyRefusedLine("401 Unauthorized"), KEY_REFUSED);
    return setup;
  },
  initStart: async () => base,
  initAnswer: async () => base,
  initStep: async () => base,
  initBuild: async () => JOBS["building"]!,
  initSignInCode: async () => JOBS["signing"]!,
  initCancel: async () => ({ ...base, phase: "cancelled" }),
};

useStore.setState({ conn: "live", hasGolden: false, initJob: setup.job });
useStore.getState().bind(api);

// The reading step plays the read the runtime would send: a row lands every 600 ms with the spinner, then its word, and the next follows.
if (at === "reading") {
  let landed = 0;
  const land = setInterval(() => {
    landed += 1;
    const rows = FACTS.slice(0, landed).map((r, i) => (i === landed - 1 && landed < FACTS.length ? { id: r.id, kind: r.kind, label: r.label, state: INIT_ROW_STATES.running } : r));
    useStore.setState({ initJob: { ...JOBS.reading!, rows } });
    if (landed >= FACTS.length) clearInterval(land);
  }, 600);
}

// The first-workspace step shows the desktop's Choose keycap, so the fixture stands in for the bridge there.
if (at === "ask") window.wsp = { ...window.wsp, pickFolder: async () => "/Users/zingzy/code/app", droppedPath: file => `/Users/zingzy/${file.name}` };

// The key screen is one press past the choice, as it is for a person: the fixture presses Continue once the choice is drawn.
if (at === "keys" || at === "keys-refused" || at === "keys-saved") {
  const press = setInterval(() => {
    const key = document.querySelector<HTMLButtonElement>("[data-k=choice] [data-k=primary]");
    if (key !== null) {
      clearInterval(press);
      key.click();
    }
  }, 20);
}

// The refused key is two more presses: a key typed into the field and Save, which the host answers with the
// provider's own refusal. Never a real key: the field is fed a fake one and the shot shows dots anyway. The keycap
// is looked up again after the typing, because it is remounted when it stops being the disabled one.
if (at === "keys-refused") {
  const type = setInterval(() => {
    const field = document.querySelector<HTMLInputElement>("#setup-key-solari");
    if (field === null) return;
    clearInterval(type);
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(field, "slr_live_fake_wrong_key");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    const press = setInterval(() => {
      const save = document.querySelector<HTMLButtonElement>("[data-k=keys] [data-k=primary]");
      if (save === null || save.disabled) return;
      clearInterval(press);
      save.click();
    }, 20);
  }, 20);
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <CloudSetupDialog onClose={() => {}} />
  </TooltipProvider>,
);
