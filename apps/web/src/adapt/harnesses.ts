// SPDX-License-Identifier: AGPL-3.0-only
// The client's own facts per harness: the slash commands its menu is seeded
// with before a session has announced any, and the mark drawn beside its
// models and threads. One module per harness; a harness without one gets an
// empty seed and its initials. No seed names a command the CLI runs only in
// its own terminal; those are the runtime catalog's table, read by the menu.
// Each mark is the agent's published glyph, one svg under src/assets/agents
// (its source and licence in THIRD_PARTY_NOTICES) read here for its viewBox
// and paths. The runtime's catalog answers everything else.
import claudeSvg from "../assets/agents/claude.svg?raw";
import codexSvg from "../assets/agents/codex.svg?raw";
import geminiSvg from "../assets/agents/gemini.svg?raw";
import opencodeSvg from "../assets/agents/opencode.svg?raw";
import piSvg from "../assets/agents/pi.svg?raw";
import type { ProviderSlashCommand } from "./view-model.js";

export interface HarnessGlyphPath {
  readonly d: string;
  /** Kept from the source: a hole drawn by the evenodd rule renders solid under the default nonzero rule. */
  readonly fillRule?: "evenodd";
}

/** The paths of a vendored svg on its viewBox, filled with the brand's hue where it has one, else the current colour. */
export interface HarnessGlyph {
  readonly viewBox: string;
  readonly paths: ReadonlyArray<HarnessGlyphPath>;
  /** The text class of the brand's own colour token; absent for a mark that is monochrome by design. */
  readonly tone?: string;
}

const attribute = (tag: string, name: string): string | undefined => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

/** The vendored svg as a glyph: its viewBox and every path's d, with an evenodd fill rule where the source sets one. */
export function glyphOf(svg: string, tone?: string): HarnessGlyph {
  const viewBox = attribute(svg, "viewBox");
  const paths = [...svg.matchAll(/<path\b[^>]*>/g)].map(([tag]) => {
    const d = attribute(tag, "d");
    if (d === undefined) throw new Error("a vendored mark has a path without d");
    return attribute(tag, "fill-rule") === "evenodd" ? { d, fillRule: "evenodd" as const } : { d };
  });
  if (viewBox === undefined || paths.length === 0) throw new Error("a vendored mark needs a viewBox and a path");
  return tone === undefined ? { viewBox, paths } : { viewBox, paths, tone };
}

export interface HarnessClient {
  readonly harness: string;
  readonly slashCommands: ReadonlyArray<ProviderSlashCommand>;
  readonly mark?: HarnessGlyph;
  /** One announced name as this CLI spells it. Only a harness's own module knows whether its names carry where a
   * command came from, so the reading lives here and the catalog asks for it by harness; a harness without one
   * announces bare names and its menu is one list. */
  readonly announced?: (name: string) => ProviderSlashCommand;
}

const NO_SLASH_SEED: ReadonlyArray<ProviderSlashCommand> = [];

/** This CLI names a plugin's or a scoped skill's command `<source>:<command>` and announces everything else as a
 * bare name, with nothing in it that tells one of its own commands from a skill. So the prefix is the only source
 * it names, and a menu that grouped on anything more would be grouping on a guess. */
const CLAUDE_SOURCED = /^([^:\s]+):[^:\s]+$/;

function claudeAnnounced(name: string): ProviderSlashCommand {
  const source = CLAUDE_SOURCED.exec(name)?.[1];
  return source === undefined ? { name } : { name, source };
}

export const CLAUDE_CLIENT: HarnessClient = { harness: "claude", slashCommands: NO_SLASH_SEED, announced: claudeAnnounced, mark: glyphOf(claudeSvg, "text-agent-claude") };

export const CODEX_CLIENT: HarnessClient = { harness: "codex", slashCommands: NO_SLASH_SEED, mark: glyphOf(codexSvg) };

export const GEMINI_CLIENT: HarnessClient = { harness: "gemini", slashCommands: NO_SLASH_SEED, mark: glyphOf(geminiSvg, "text-agent-gemini") };

export const OPENCODE_CLIENT: HarnessClient = { harness: "opencode", slashCommands: NO_SLASH_SEED, mark: glyphOf(opencodeSvg) };

export const PI_CLIENT: HarnessClient = { harness: "pi", slashCommands: NO_SLASH_SEED, mark: glyphOf(piSvg) };

export const HARNESS_CLIENTS: ReadonlyArray<HarnessClient> = [CLAUDE_CLIENT, CODEX_CLIENT, GEMINI_CLIENT, OPENCODE_CLIENT, PI_CLIENT];

export function harnessClient(harness: string): HarnessClient | undefined {
  return HARNESS_CLIENTS.find(c => c.harness === harness);
}
