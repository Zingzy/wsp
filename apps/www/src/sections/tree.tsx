// SPDX-License-Identifier: AGPL-3.0-only
// The recursion, drawn: an agent on your computer starts agents on machines, and those have the same tools.
import { useEffect, useRef, useState } from "react";
import { cn } from "cn";
import { SPRITES, Sprite } from "@/components/pixel";

type Kind = "claude" | "codex" | "gemini" | "pi";

const COLOR: Record<Kind, string> = {
  claude: "fill-[oklch(0.75_0.15_40)]",
  codex: "fill-sky",
  gemini: "fill-[oklch(0.72_0.16_300)]",
  pi: "fill-[oklch(0.86_0.14_92)]",
};

function Agent({ kind, x, y, delay, grown }: { kind: Kind; x: number; y: number; delay: number; grown: boolean }) {
  return (
    <g className={cn("transition-opacity duration-500", grown ? "opacity-100" : "opacity-0")} style={{ transitionDelay: `${delay}ms` }}>
      <Sprite rows={SPRITES[kind]} px={5} x={x} y={y} body={COLOR[kind]} />
      <text x={x} y={y + 34} textAnchor="middle" className="font-mono fill-muted-foreground text-[11px]">
        {kind}
      </text>
    </g>
  );
}

const ROOT = { x: 500, y: 60 };
const L1 = [
  { x: 260, y: 230, kind: "codex" as Kind, machine: "b1" },
  { x: 500, y: 230, kind: "gemini" as Kind, machine: "b2" },
  { x: 740, y: 230, kind: "claude" as Kind, machine: "b3" },
];
const MIX: Kind[] = ["pi", "claude", "codex", "claude", "codex", "gemini", "gemini", "pi", "claude"];
const L2 = L1.flatMap((parent, i) =>
  [-1, 0, 1].map((k, j) => ({
    x: parent.x + k * 78,
    y: 410,
    kind: MIX[i * 3 + j]!,
    parent: i,
  })),
);

export function Tree() {
  const ref = useRef<HTMLDivElement>(null);
  const [grown, setGrown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setGrown(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setGrown(true);
      },
      { threshold: 0.35 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const edge = cn("fill-none stroke-white/35 [stroke-dasharray:3_6] transition-opacity duration-700", grown ? "opacity-100" : "opacity-0");

  return (
    <section>
      <div className="mx-auto max-w-7xl px-5 pt-8 pb-24 sm:px-8 lg:pb-32">
        <div className="rise mx-auto max-w-3xl text-center">
          <h2 className="font-display-mid text-[clamp(2rem,5vw,3.5rem)] leading-[1.02]">All the way down.</h2>
          <p className="mt-5 text-lg text-muted-foreground">
            The Claude Code on your computer starts a Codex thread on one machine and a Gemini thread on another. Those
            agents have the same tools, so they fork and start threads too. Every one of them shows in your sidebar, and
            you can answer any of them.
          </p>
        </div>

        <div ref={ref} className="rise mx-auto mt-14 max-w-4xl">
          <svg viewBox="0 0 1000 560" className="h-auto w-full" role="img" aria-label="A tree: your Claude Code at the top, three agents on three machines below it, and nine more below those.">
            <defs>
              <linearGradient id="tree-fade" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0.75" stopColor="white" stopOpacity="1" />
                <stop offset="1" stopColor="white" stopOpacity="0" />
              </linearGradient>
              <mask id="tree-mask">
                <rect width="1000" height="560" fill="url(#tree-fade)" />
              </mask>
            </defs>

            <g mask="url(#tree-mask)">
              {L1.map((node, i) => (
                <path key={i} d={`M${ROOT.x} ${ROOT.y + 42} C ${ROOT.x} ${ROOT.y + 120}, ${node.x} ${node.y - 120}, ${node.x} ${node.y - 46}`} className={edge} style={{ transitionDelay: "200ms" }} vectorEffect="non-scaling-stroke" />
              ))}
              {L2.map((node, i) => {
                const parent = L1[node.parent]!;
                return (
                  <path key={i} d={`M${parent.x} ${parent.y + 42} C ${parent.x} ${parent.y + 110}, ${node.x} ${node.y - 110}, ${node.x} ${node.y - 46}`} className={edge} style={{ transitionDelay: "900ms" }} vectorEffect="non-scaling-stroke" />
                );
              })}
              {L2.map((node, i) => (
                <path key={`t${i}`} d={`M${node.x} ${node.y + 40} V 560`} className={edge} style={{ transitionDelay: "1500ms" }} vectorEffect="non-scaling-stroke" />
              ))}

              <Agent kind="claude" x={ROOT.x} y={ROOT.y} delay={0} grown={grown} />
              {L1.map((node, i) => (
                <Agent key={i} kind={node.kind} x={node.x} y={node.y} delay={500 + i * 80} grown={grown} />
              ))}
              {L2.map((node, i) => (
                <Agent key={i} kind={node.kind} x={node.x} y={node.y} delay={1200 + i * 60} grown={grown} />
              ))}
            </g>

            <text x={ROOT.x + 40} y={ROOT.y + 5} className="font-mono fill-muted-foreground text-[12px]">
              on your computer
            </text>
            {L1.map((node, i) => (
              <text key={i} x={node.x + 36} y={node.y + 5} className={cn("font-mono fill-muted-foreground text-[12px] transition-opacity duration-500", grown ? "opacity-100" : "opacity-0")} style={{ transitionDelay: "700ms" }}>
                on {node.machine}
              </text>
            ))}
            <text x={500} y={330} textAnchor="middle" className={cn("font-mono fill-sky text-[12px] transition-opacity duration-500", grown ? "opacity-100" : "opacity-0")} style={{ transitionDelay: "1000ms" }}>
              wsp again
            </text>
          </svg>
          <p className="mt-6 text-center font-mono text-[12.5px] text-muted-foreground">
            Claude Code and Codex today. Pi and Gemini threads are next.
          </p>
        </div>
      </div>
    </section>
  );
}
