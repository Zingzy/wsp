// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";

/** Bash lines that give this computer what a Linux machine's runs lean on, for a test whose stand-in machine is this
 * computer's bash: on macOS setsid is perl's setpgrp and base64 drops -w0. Exported, so every bash a run starts
 * inherits them, the run's own script included. Empty on Linux. A backgrounded `setsid cmd &` keeps `$!` as the new
 * group's leader, since the function execs perl in the job's own process. */
export const LINUX_SHELL_PRELUDE = existsSync("/proc/1/stat")
  ? ""
  : `setsid() { exec perl -e 'setpgrp(0, 0); exec @ARGV or die $!' -- "$@"; }\nbase64() { local a=(); for x in "$@"; do [ "$x" = "-w0" ] || a+=("$x"); done; /usr/bin/base64 "\${a[@]}"; }\nexport -f setsid base64\n`;
