// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "tsup";
import { cloudDefine } from "../wspx/scripts/build-defines.mjs";
import { skillText } from "./skill-text.js";

export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts"],
  format: ["esm"],
  dts: true,
  define: cloudDefine(),
  esbuildPlugins: [skillText()],
});
