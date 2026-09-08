// SPDX-License-Identifier: AGPL-3.0-only
// Sprites drawn on a pixel grid: "#" is the body, "@" is a light, "." is empty.
import { cn } from "cn";

export type SpriteProps = {
  rows: readonly string[];
  /** Size of one pixel in user units. */
  px: number;
  /** Center of the sprite. */
  x: number;
  y: number;
  body: string;
  light?: string;
  className?: string;
  style?: React.CSSProperties;
};

export function spriteSize(rows: readonly string[], px: number) {
  return { w: (rows[0]?.length ?? 0) * px, h: rows.length * px };
}

export function Sprite({ rows, px, x, y, body, light = body, className, style }: SpriteProps) {
  const { w, h } = spriteSize(rows, px);
  return (
    <g className={className} style={style} transform={`translate(${x - w / 2} ${y - h / 2})`}>
      {rows.flatMap((row, r) =>
        [...row].map((cell, c) =>
          cell === "." ? null : <rect key={`${r}-${c}`} x={c * px} y={r * px} width={px} height={px} className={cell === "@" ? light : body} />,
        ),
      )}
    </g>
  );
}

/** A sprite as an inline icon, sized by CSS; `body` is a fill class. */
export function SpriteIcon({ rows, body, className }: { rows: readonly string[]; body: string; className?: string }) {
  const { w, h } = spriteSize(rows, 1);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className={className} shapeRendering="crispEdges">
      <Sprite rows={rows} px={1} x={w / 2} y={h / 2} body={body} />
    </svg>
  );
}

export const SPRITES = {
  claude: ["..#####..", ".#######.", "##.###.##", "#########", ".#######.", "..#.#.#..", ".#..#..#."],
  codex: ["...###...", "..#####..", ".#######.", "#########", "#..####.#", ".#######.", "...#.#..."],
  gemini: ["....#....", "...###...", "..#####..", "#########", "..#####..", "...###...", "....#...."],
  pi: [".#######.", "#..#..#..", "...#..#..", "...#..#..", "...#..#..", "..#...#..", "..#....##"],
  opencode: ["#########", "#.......#", "#.#.....#", "#..#....#", "#.#.....#", "#....##.#", "#########"],
  laptop: [
    ".##############.",
    ".#............#.",
    ".#.@..........#.",
    ".#............#.",
    ".#............#.",
    ".#............#.",
    ".##############.",
    "################",
    "#..............#",
    ".##############.",
  ],
  floppy: [
    ".##########.",
    ".#.#######.#",
    ".#.#######.#",
    ".#.#######.#",
    ".##########.",
    ".##########.",
    ".#........#.",
    ".#.######.#.",
    ".#.######.#.",
    ".#.######.#.",
    "############",
  ],
  server: [
    "################",
    "#.@............#",
    "################",
    "#.@............#",
    "################",
    "#.@............#",
    "################",
  ],
} as const;
