// SPDX-License-Identifier: AGPL-3.0-only
// One picture of the whole model, in pixel sprites. `step` lights the part the reader is on; "all" lights everything.
import { useEffect, useState } from "react";
import { cn } from "cn";
import { SPRITES, Sprite } from "./pixel";

export type Step = "seal" | "fork" | "thread" | "signin" | "agents" | "keys" | "naps";
export const STEPS: Step[] = ["seal", "fork", "thread", "signin", "agents", "keys", "naps"];

const LIT: Record<Step, ReadonlySet<string>> = {
  seal: new Set(["computer", "init", "image"]),
  fork: new Set(["image", "fork", "b1", "b2", "b3"]),
  thread: new Set(["computer", "reach", "b1"]),
  signin: new Set(["computer", "reach", "signin", "b1"]),
  agents: new Set(["computer", "agent", "mcp", "b3"]),
  keys: new Set(["computer", "boundary", "nothing", "init", "fork", "image"]),
  naps: new Set(["b1", "b2", "wake"]),
};

const TRACE = {
  init: "M226 275 H488",
  fork1: "M596 275 H680 Q690 275 690 265 V109 Q690 99 700 99 H892",
  fork2: "M596 275 H892",
  fork3: "M596 275 H680 Q690 275 690 285 V441 Q690 451 700 451 H892",
  reach: "M150 228 V44 Q150 34 160 34 H1076 Q1086 34 1086 44 V89 Q1086 99 1076 99 H1028",
  mcp: "M150 322 V538 Q150 548 160 548 H1076 Q1086 548 1086 538 V461 Q1086 451 1076 451 H1028",
};

function useMotionAllowed() {
  const [allowed, setAllowed] = useState(true);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setAllowed(!query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return allowed;
}

function Packets({ d, count = 3, dur = 2.6, back = false }: { d: string; count?: number; dur?: number; back?: boolean }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <rect key={i} width={7} height={7} x={-3.5} y={-3.5} className="fill-sky">
          <animateMotion dur={`${dur}s`} repeatCount="indefinite" begin={`${(i * dur) / count}s`} path={d} keyPoints={back ? "1;0" : "0;1"} keyTimes="0;1" calcMode="linear" />
        </rect>
      ))}
    </>
  );
}

type Props = { step: Step | "all"; className?: string };

export function SystemDiagram({ step, className }: Props) {
  const motion = useMotionAllowed();
  const on = (id: string) => step === "all" || LIT[step].has(id);
  const fade = (id: string) => cn("transition-opacity duration-500 ease-out", on(id) ? "opacity-100" : "opacity-[0.22]");
  const trace = (id: string) => cn("fill-none transition-[stroke,opacity] duration-500", on(id) ? "stroke-sky opacity-100" : "stroke-white/30 opacity-50");
  const tag = (id: string) => cn("font-mono text-[14px] transition-[fill] duration-500", on(id) ? "fill-sky" : "fill-muted-foreground");
  const title = "font-display-low fill-foreground text-[24px]";
  const note = "font-mono fill-muted-foreground text-[14px]";

  const machine = (id: string, y: number, name: string, lines: string[], running: boolean) => (
    <g className={fade(id)}>
      <Sprite rows={SPRITES.server} px={8} x={960} y={y} body="fill-foreground" light={running ? "fill-run" : "fill-muted-foreground/60"} />
      <text x={896} y={y + 54} className={title}>
        {name}
      </text>
      {lines.map((line, i) => (
        <text key={line} x={896} y={y + 76 + i * 19} className={note}>
          {line}
        </text>
      ))}
    </g>
  );

  return (
    <svg viewBox="0 0 1092 574" role="img" aria-label="How wsp fits together: your computer seals an image, machines fork from it, agents run inside as threads you reach from the app, the command line or another agent." className={cn("h-auto w-full overflow-visible", className)}>
      {/* The boundary your key crosses. */}
      <g className={fade("boundary")}>
        <line x1={363} y1={26} x2={363} y2={532} className={cn("transition-[stroke] duration-500", on("boundary") ? "stroke-sky" : "stroke-white/25")} strokeDasharray="1 7" strokeWidth={1.5} />
        <text x={351} y={16} textAnchor="end" className={note}>
          your computer
        </text>
        <text x={375} y={16} className={note}>
          the provider
        </text>
      </g>
      <text x={300} y={568} textAnchor="middle" className={cn("font-mono fill-sky text-[14px] transition-opacity duration-500", on("nothing") ? "opacity-100" : "opacity-0")}>
        nothing in between
      </text>

      {Object.entries(TRACE).map(([id, d]) => {
        const key = id.startsWith("fork") ? "fork" : id;
        return <path key={id} d={d} className={trace(key)} strokeWidth={1.5} strokeDasharray={(key === "reach" || key === "mcp") && !on(key) ? "2 7" : undefined} />;
      })}
      {motion && on("init") && <Packets d={TRACE.init} count={2} dur={1.8} />}
      {motion && on("fork") && (
        <>
          <Packets d={TRACE.fork1} count={2} dur={2.2} />
          <Packets d={TRACE.fork2} count={2} dur={1.6} />
          <Packets d={TRACE.fork3} count={2} dur={2.2} />
        </>
      )}
      {motion && on("reach") && (
        <>
          <Packets d={TRACE.reach} count={on("signin") ? 2 : 3} dur={4.2} back={on("signin")} />
          <Packets d={TRACE.reach} count={2} dur={4.2} back={!on("signin")} />
        </>
      )}
      {motion && on("mcp") && <Packets d={TRACE.mcp} count={3} dur={4.2} />}

      <text x={300} y={262} textAnchor="middle" className={tag("init")}>
        init
      </text>
      <text x={640} y={262} textAnchor="middle" className={tag("fork")}>
        fork, 20 s
      </text>
      <text x={on("signin") ? 720 : 620} y={24} textAnchor="middle" className={tag("reach")}>
        {on("signin") ? "the page opens here, the callback tunnels back" : "the app, the command line"}
      </text>
      <text x={620} y={568} textAnchor="middle" className={tag("mcp")}>
        thread_new b3 codex "Review PR #297"
      </text>

      {/* Your computer */}
      <g className={fade("computer")}>
        <Sprite rows={SPRITES.laptop} px={9} x={150} y={275} body="fill-foreground" light={on("agent") ? "fill-[oklch(0.75_0.15_40)]" : "fill-run"} />
        <text x={150} y={366} textAnchor="middle" className={title}>
          your computer
        </text>
        <text x={150} y={388} textAnchor="middle" className={note}>
          {on("agent") ? "Claude Code, over MCP" : on("signin") ? "your browser, localhost:8976" : "wsp, your key, your sign-ins"}
        </text>
      </g>

      {/* The image */}
      <g className={fade("image")}>
        <Sprite rows={SPRITES.floppy} px={8} x={542} y={275} body={on("image") ? "fill-sky" : "fill-foreground"} />
        <text x={542} y={350} textAnchor="middle" className={title}>
          the image
        </text>
        <text x={542} y={372} textAnchor="middle" className={note}>
          agents, tools, sign-ins
        </text>
      </g>

      {machine("b1", 99, "b1", on("signin") ? ["gh auth login", "waiting on localhost:8976"] : on("reach") ? ["claude, Working"] : ["$0.110/hr"], true)}
      {machine("b2", 275, "b2", on("wake") ? ["napping, RAM kept", "wakes on the next message"] : ["$0.000/hr, napping"], false)}
      {machine("b3", 451, "b3", on("mcp") ? ["codex, by your agent"] : ["$0.110/hr"], true)}
    </svg>
  );
}
