// SPDX-License-Identifier: AGPL-3.0-only
// Fixture rows for the design page of wsp-map#2031. The figures for wsp's own parts and the agent are the ones the
// research read off the owner's Mac with proc_pid_rusage (footprint, CPU over 2 s, energy in mW); the rest are shaped
// like them. Nothing here reaches the app.

const MB = 1024 * 1024;
const GB = 1024 * MB;
const MIN = 60_000;

/** What a process is to the person, named the way Chrome's task manager names a row: by what they know. */
export type ProcKind = "agent" | "tool" | "dev" | "test" | "build" | "slate" | "terminal" | "tab" | "app" | "wsp" | "other";

export interface Proc {
  readonly pid: number;
  readonly name: string;
  readonly kind: ProcKind;
  /** phys_footprint on a Mac, what Activity Monitor's Memory column shows; RSS on a box. */
  readonly mem: number;
  /** Percent of one core over the last interval; null until the second sample. */
  readonly cpu: number | null;
  /** Milliwatts of CPU energy over the interval, ri_energy_nj; a Mac alone reads it. */
  readonly energy: number | null;
  readonly ports: readonly number[];
  /** Loopback only, or every address the computer has. */
  readonly bound?: "loopback" | "all";
  readonly command: string;
  readonly agent?: string;
  /** The agent's process stays up between turns for the next send; it ends on its own at this many minutes. */
  readonly keptMin?: number;
  /** A turn runs on this agent now: ending it is the thread's stop. */
  readonly turn?: boolean;
  /** wsp needs it to run: the host, the daemon and the app's parts take no end. */
  readonly needed?: boolean;
  readonly children?: readonly Proc[];
}

export interface ThreadGroup {
  readonly id: string;
  readonly title: string;
  readonly agent: string;
  readonly project: string;
  readonly state: "working" | "resting" | "needs";
  readonly startedAt?: number;
  readonly age?: string;
  readonly procs: readonly Proc[];
}

export interface ComputerScope {
  readonly id: string;
  readonly name: string;
  readonly mac: boolean;
  readonly memTotal: number;
  readonly memUsed: number;
  readonly cores: number;
  readonly wsp: readonly Proc[];
  readonly threads: readonly ThreadGroup[];
  /** Started by wsp, its thread not known: an orphan whose group and marker say nothing, still in wsp's coalition. */
  readonly loose: readonly Proc[];
  /** Everything else the computer runs, for the Processes view's Every process. */
  readonly rest: readonly Proc[];
}

const now = Date.now();

export const MAC: ComputerScope = {
  id: "here",
  name: "zingzy's MacBook Pro",
  mac: true,
  memTotal: 36 * GB,
  memUsed: 24.1 * GB,
  cores: 10,
  wsp: [
    {
      pid: 46301,
      name: "wsp",
      kind: "app",
      mem: 70 * MB,
      cpu: 1.2,
      energy: 9,
      ports: [],
      command: "/Applications/wsp.app/Contents/MacOS/wsp",
      needed: true,
      children: [
        { pid: 50877, name: "Window", kind: "app", mem: 131 * MB, cpu: 10.4, energy: 75, ports: [], command: "wsp Helper (Renderer) --type=renderer", needed: true },
        { pid: 47195, name: "Graphics", kind: "app", mem: 168 * MB, cpu: 3.1, energy: 22, ports: [], command: "wsp Helper (GPU) --type=gpu-process", needed: true },
        { pid: 51102, name: "localhost:5173", kind: "tab", mem: 96 * MB, cpu: 2.0, energy: 14, ports: [], command: "wsp Helper (Renderer) --type=renderer --webview-tag" },
        { pid: 47196, name: "Network", kind: "app", mem: 8 * MB, cpu: 0.1, energy: 0.4, ports: [], command: "wsp Helper --type=utility --utility-sub-type=network.mojom.NetworkService", needed: true },
      ],
    },
    { pid: 46470, name: "Host", kind: "wsp", mem: 208 * MB, cpu: 1.6, energy: 0.3, ports: [7420], bound: "loopback", command: "wsp host --state ~/.wsp/state.db", needed: true },
    { pid: 50033, name: "Daemon", kind: "wsp", mem: 3.6 * MB, cpu: 0.1, energy: 0.2, ports: [7421], bound: "loopback", command: "wsp-daemon --local", needed: true },
  ],
  threads: [
    {
      id: "t_design",
      title: "Task manager design round",
      agent: "claude",
      project: "wsp",
      state: "working",
      startedAt: now - 12 * MIN,
      procs: [
        {
          pid: 40009,
          name: "Claude Code",
          kind: "agent",
          agent: "claude",
          turn: true,
          mem: 1.54 * GB,
          cpu: 15.9,
          energy: 94,
          ports: [],
          command: "claude --output-format stream-json --input-format stream-json --verbose",
          children: [
            { pid: 40112, name: "wsp", kind: "tool", mem: 92 * MB, cpu: 0.4, energy: 2, ports: [], command: "wsp mcp --thread t_design" },
            { pid: 40131, name: "playwright", kind: "tool", mem: 64 * MB, cpu: 0, energy: 0, ports: [], command: "npx @playwright/mcp@latest" },
          ],
        },
        {
          pid: 41877,
          name: "vite",
          kind: "dev",
          mem: 312 * MB,
          cpu: 2.4,
          energy: 11,
          ports: [5173],
          bound: "loopback",
          command: "node apps/web/node_modules/.bin/vite --port 5173",
          children: [{ pid: 41902, name: "esbuild", kind: "dev", mem: 38 * MB, cpu: 0.3, energy: 1, ports: [], command: "esbuild --service=0.25.0 --ping" }],
        },
        { pid: 42290, name: "python3 sampler.py", kind: "slate", mem: 18 * MB, cpu: 0.6, energy: 3, ports: [], command: "python3 $SLATE_DIR/sampler.py" },
      ],
    },
    {
      id: "t_sampler",
      title: "Daemon libproc sampler",
      agent: "claude",
      project: "wsp",
      state: "working",
      startedAt: now - 41 * MIN,
      procs: [
        { pid: 38810, name: "Claude Code", kind: "agent", agent: "claude", turn: true, mem: 1.21 * GB, cpu: 4.2, energy: 31, ports: [], command: "claude --output-format stream-json", children: [{ pid: 38851, name: "wsp", kind: "tool", mem: 88 * MB, cpu: 0.1, energy: 0.5, ports: [], command: "wsp mcp --thread t_sampler" }] },
        { pid: 43311, name: "cargo test", kind: "test", mem: 41 * MB, cpu: 0.8, energy: 4, ports: [], command: "cargo test -p wsp-daemon proc", children: [{ pid: 43390, name: "rustc", kind: "build", mem: 1.12 * GB, cpu: 96.4, energy: 3106, ports: [], command: "rustc --crate-name wsp_daemon --edition=2021" }] },
      ],
    },
    {
      id: "t_landing",
      title: "spoo landing hero copy",
      agent: "claude",
      project: "spoo-landing",
      state: "needs",
      procs: [
        { pid: 36120, name: "Claude Code", kind: "agent", agent: "claude", turn: true, mem: 980 * MB, cpu: 0.2, energy: 1, ports: [], command: "claude --output-format stream-json" },
        { pid: 36400, name: "next dev", kind: "dev", mem: 640 * MB, cpu: 1.1, energy: 6, ports: [3000], bound: "all", command: "node node_modules/.bin/next dev", children: [{ pid: 36433, name: "next-server", kind: "dev", mem: 410 * MB, cpu: 0.7, energy: 4, ports: [], command: "next-server (v16.1.0)" }] },
      ],
    },
    {
      id: "t_legend",
      title: "Fix the usage page legend",
      agent: "codex",
      project: "wsp",
      state: "resting",
      age: "8m",
      procs: [
        { pid: 35002, name: "Codex", kind: "agent", agent: "codex", keptMin: 22, mem: 410 * MB, cpu: 0, energy: 0, ports: [], command: "codex app-server" },
        {
          pid: 35510,
          name: "vitest",
          kind: "test",
          mem: 120 * MB,
          cpu: 0.4,
          energy: 2,
          ports: [],
          command: "node node_modules/.bin/vitest --watch",
          children: [
            { pid: 35521, name: "vitest worker", kind: "test", mem: 182 * MB, cpu: 0, energy: 0, ports: [], command: "node vitest/dist/workers/forks.js" },
            { pid: 35522, name: "vitest worker", kind: "test", mem: 176 * MB, cpu: 0, energy: 0, ports: [], command: "node vitest/dist/workers/forks.js" },
          ],
        },
      ],
    },
    {
      id: "t_browser",
      title: "Browser tab phase 1",
      agent: "opencode",
      project: "wsp",
      state: "resting",
      age: "2h",
      procs: [{ pid: 31877, name: "electron-vite dev", kind: "dev", mem: 451 * MB, cpu: 0.9, energy: 5, ports: [5174], bound: "loopback", command: "node node_modules/.bin/electron-vite dev" }],
    },
  ],
  loose: [
    { pid: 30212, name: "node server.js", kind: "other", mem: 84 * MB, cpu: 0.1, energy: 0.5, ports: [8080], bound: "all", command: "node server.js" },
    { pid: 30219, name: "sh", kind: "other", mem: 1.2 * MB, cpu: 0, energy: 0, ports: [], command: "/bin/sh -c while true; do sleep 5; done" },
  ],
  rest: [
    { pid: 812, name: "Instagram", kind: "other", mem: 2.31 * GB, cpu: 22.0, energy: 140, ports: [], command: "/Applications/Instagram.app/Contents/MacOS/Instagram" },
    { pid: 1204, name: "Google Chrome Helper (Renderer)", kind: "other", mem: 940 * MB, cpu: 3.2, energy: 18, ports: [], command: "Google Chrome Helper (Renderer) --type=renderer" },
    { pid: 488, name: "WindowServer", kind: "other", mem: 610 * MB, cpu: 6.8, energy: 40, ports: [], command: "/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer" },
    { pid: 2210, name: "Ghostty", kind: "other", mem: 230 * MB, cpu: 0.9, energy: 5, ports: [], command: "/Applications/Ghostty.app/Contents/MacOS/ghostty" },
  ],
};

export const BOX: ComputerScope = {
  id: "hetzner",
  name: "hetzner",
  mac: false,
  memTotal: 16 * GB,
  memUsed: 5.2 * GB,
  cores: 8,
  wsp: [{ pid: 912, name: "Daemon", kind: "wsp", mem: 11 * MB, cpu: 0.2, energy: null, ports: [7421], bound: "all", command: "/usr/local/bin/wsp-daemon", needed: true }],
  threads: [
    {
      id: "t_bot",
      title: "Discord bot rate limits",
      agent: "claude",
      project: "spoo-bot",
      state: "working",
      startedAt: now - 6 * MIN,
      procs: [
        { pid: 21880, name: "Claude Code", kind: "agent", agent: "claude", turn: true, mem: 610 * MB, cpu: 7.5, energy: null, ports: [], command: "claude --output-format stream-json" },
        { pid: 22014, name: "python bot.py", kind: "dev", mem: 96 * MB, cpu: 0.3, energy: null, ports: [8000], bound: "loopback", command: "python bot.py" },
      ],
    },
    {
      id: "t_migrate",
      title: "Postgres 17 migration dry run",
      agent: "codex",
      project: "spoo-api",
      state: "resting",
      age: "35m",
      procs: [{ pid: 19870, name: "pg_upgrade", kind: "other", mem: 220 * MB, cpu: 31.0, energy: null, ports: [], command: "pg_upgrade --check -b /usr/lib/postgresql/16/bin" }],
    },
  ],
  loose: [],
  rest: [],
};

/** Every process under a row, the row included. */
export function flat(p: Proc): Proc[] {
  return [p, ...(p.children ?? []).flatMap(flat)];
}

export function sum(procs: readonly Proc[]): { mem: number; cpu: number; energy: number | null; count: number } {
  const all = procs.flatMap(flat);
  const energies = all.map(p => p.energy).filter((e): e is number => e !== null);
  return { mem: all.reduce((n, p) => n + p.mem, 0), cpu: all.reduce((n, p) => n + (p.cpu ?? 0), 0), energy: energies.length === 0 ? null : energies.reduce((n, e) => n + e, 0), count: all.length };
}
