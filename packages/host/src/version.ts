// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";

export const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
