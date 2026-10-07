// SPDX-License-Identifier: AGPL-3.0-only
// The skill as every bundle that inlines it reads it: the host's own build and
// the desktop app's, which compiles the host from source. A public build
// inlines it as a process with no cloud reads it, so its cloud sections never
// reach a bundle.
import { readFileSync } from "node:fs";
import type { Options } from "tsup";
import { publicBuild } from "../wspx/scripts/build-defines.mjs";
import { skillFor } from "./src/cloud-text.js";

type Plugin = NonNullable<Options["esbuildPlugins"]>[number];

export const skillText = (env: Readonly<Record<string, string | undefined>> = process.env): Plugin => ({
  name: "skill-text",
  setup(build) {
    build.onLoad({ filter: /\.md$/ }, ({ path }) => {
      const text = readFileSync(path, "utf8");
      return { contents: publicBuild(env) ? skillFor(text, false) : text, loader: "text" };
    });
  },
});
