// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DAEMON_VERSION } from "@wsp/protocol";
import type { StateWriter } from "@wsp/runtime";

export const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

/** What this build writes into a state file as the build that wrote it: the version a person reads off
 * `wsp --version`, the daemon this wsp deploys, and the binary it ran from, which is the one thing that tells two
 * wsps on a computer apart. One reading, so every store this wsp opens names the same build. */
export const stateWriterHere = (): StateWriter => ({ wsp: VERSION, daemon: DAEMON_VERSION, bin: process.argv[1] === undefined ? process.execPath : resolve(process.argv[1]) });
