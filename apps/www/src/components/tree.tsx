// SPDX-License-Identifier: AGPL-3.0-only
// The recursion, drawn: an agent on your Mac starts agents on your other computers, and those start agents too.
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Each agent as a pixel sprite: "#" is the body, "." is empty. */
const SPRITES = {
  claude: ["..#####..", ".#######.", "##.###.##", "#########", ".#######.", "..#.#.#..", ".#..#..#."],
  codex: ["...###...", "..#####..", ".#######.", "#########", "#..####.#", ".#######.", "...#.#..."],
  opencode: ["#########", "#.......#", "#.#.....#", "#..#....#", "#.#.....#", "#....##.#", "#########"],
  cursor: ["##.......", "#.##.....", "#...##...", "#.....##.", "#...###..", "#.##..#..", "##....##."],
} as const;

type Kind = keyof typeof SPRITES;

const INK: Record<Kind, string> = {
  claude: "#d97757",
  codex: "#86b0e7",
  opencode: "#8fbf87",
  cursor: "#ece6dc",
};

const PX = 5;

function Agent({ kind, x, y, on, delay }: { kind: Kind; x: number; y: number; on: boolean; delay: number }) {
  const rows = SPRITES[kind];
  const w = rows[0]!.length * PX;
  const h = rows.length * PX;
  return (
    <g className={cn("transition-opacity duration-500", on ? "opacity-100" : "opacity-0")} style={{ transitionDelay: `${delay}ms` }}>
      <g transform={`translate(${x - w / 2} ${y - h / 2})`} fill={INK[kind]} shapeRendering="crispEdges">
        {rows.flatMap((row, r) => [...row].map((cell, c) => (cell === "#" ? <rect key={`${r}-${c}`} x={c * PX} y={r * PX} width={PX} height={PX} /> : null)))}
      </g>
      <text x={x} y={y + 36} textAnchor="middle" className="fill-muted-foreground font-mono text-[12px]">
        {kind}
      </text>
    </g>
  );
}

const ROOT = { x: 500, y: 60 };
const L1: { x: number; kind: Kind; on: string }[] = [
  { x: 240, kind: "codex", on: "on hetzner" },
  { x: 500, kind: "opencode", on: "on thinkpad" },
  { x: 760, kind: "claude", on: "right here" },
];
const MIX: Kind[] = ["claude", "codex", "cursor", "codex", "claude", "opencode", "cursor", "claude", "codex"];
const L2 = L1.flatMap((parent, i) => [-1, 0, 1].map((k, j) => ({ x: parent.x + k * 80, kind: MIX[i * 3 + j]!, parent: i })));
const Y1 = 230;
const Y2 = 410;

export function AgentTree({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setOn(true);
      return;
    }
    const seen = new IntersectionObserver(([entry]) => entry?.isIntersecting && setOn(true), { threshold: 0.3 });
    seen.observe(el);
    return () => seen.disconnect();
  }, []);

  const edge = cn("fill-none stroke-[#ece6dc]/30 [stroke-dasharray:3_6] transition-opacity duration-700", on ? "opacity-100" : "opacity-0");
  const word = cn("fill-muted-foreground font-mono text-[12.5px] transition-opacity duration-500", on ? "opacity-100" : "opacity-0");

  return (
    <div ref={ref} className={className}>
      <svg viewBox="0 0 1000 540" className="h-auto w-full" role="img" aria-label="Claude Code on your Mac starts Codex on hetzner, OpenCode on the thinkpad and another Claude Code on the Mac, and each of those starts three more.">
        <defs>
          <linearGradient id="tree-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0.78" stopColor="white" />
            <stop offset="1" stopColor="white" stopOpacity="0" />
          </linearGradient>
          <mask id="tree-mask">
            <rect width="1000" height="540" fill="url(#tree-fade)" />
          </mask>
        </defs>
        <g mask="url(#tree-mask)">
          {L1.map((n, i) => (
            <path key={i} d={`M${ROOT.x} ${ROOT.y + 46} C ${ROOT.x} ${ROOT.y + 120}, ${n.x} ${Y1 - 120}, ${n.x} ${Y1 - 46}`} className={edge} style={{ transitionDelay: "200ms" }} vectorEffect="non-scaling-stroke" />
          ))}
          {L2.map((n, i) => {
            const p = L1[n.parent]!;
            return <path key={i} d={`M${p.x} ${Y1 + 46} C ${p.x} ${Y1 + 110}, ${n.x} ${Y2 - 110}, ${n.x} ${Y2 - 46}`} className={edge} style={{ transitionDelay: "900ms" }} vectorEffect="non-scaling-stroke" />;
          })}
          {L2.map((n, i) => (
            <path key={`t${i}`} d={`M${n.x} ${Y2 + 46} V 540`} className={edge} style={{ transitionDelay: "1500ms" }} vectorEffect="non-scaling-stroke" />
          ))}
          <Agent kind="claude" x={ROOT.x} y={ROOT.y} on={on} delay={0} />
          {L1.map((n, i) => (
            <Agent key={i} kind={n.kind} x={n.x} y={Y1} on={on} delay={500 + i * 80} />
          ))}
          {L2.map((n, i) => (
            <Agent key={i} kind={n.kind} x={n.x} y={Y2} on={on} delay={1200 + i * 60} />
          ))}
        </g>
        <text x={ROOT.x + 42} y={ROOT.y + 5} className={word}>
          on your Mac
        </text>
        {L1.map((n, i) => (
          <text key={i} x={n.x + 38} y={Y1 + 5} className={word} style={{ transitionDelay: "700ms" }}>
            {n.on}
          </text>
        ))}
      </svg>
    </div>
  );
}
