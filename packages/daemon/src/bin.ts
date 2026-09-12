import { DAEMON_DEFAULT_HOST, daemonListeningLine } from "@wsp/protocol";
import { DAEMON_USAGE, daemonOptions, parseDaemonArgs, type DaemonArgs } from "./args.js";
import { startDaemon } from "./main.js";

let args: DaemonArgs;
try {
  args = parseDaemonArgs(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  console.error(DAEMON_USAGE);
  process.exit(2);
}

// The token file is the only source, read at every auth frame so the host can rotate it; local runs name theirs with --token-path.
// The port goes on stdout as the one line whoever started this reads; everything else the daemon says goes to stderr.
startDaemon(daemonOptions(args, { log: line => console.error(line) }))
  .then(d => console.log(daemonListeningLine(args.host ?? DAEMON_DEFAULT_HOST, d.port)))
  .catch((e: unknown) => {
    console.error("wsp-daemon failed to start:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
