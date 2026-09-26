// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentMark } from "../catalog.js";

/** A company's published mark, drawn in a glyph frame for the CLIs and MCP servers it makes; one inline svg, never
 * fetched. A mark without inks takes the row's ink. */
export interface BrandMark extends AgentMark {
  id: string;
  /** Catalog CLI ids it marks. */
  tools: readonly string[];
  /** Domains that serve a remote MCP server of the company's, matched as the host or a host under it. */
  hosts: readonly string[];
  /** Packages or images a command server runs, matched as a word of its line, a version after it or not. */
  packages: readonly string[];
}
