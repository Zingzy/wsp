import { DEFAULT_HOST, parseDaemonArgs, startDaemon } from "./main.js";

let args: ReturnType<typeof parseDaemonArgs>;
try {
  args = parseDaemonArgs(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  console.error("usage: wsp-daemon [--host <addr>] [--port <n>] [--token-path <file>] [--root <dir>]");
  process.exit(2);
}

// The token file is the only source, read at every auth frame so the host can rotate it; local runs name theirs with --token-path.
startDaemon(args)
  .then(d => console.log(`wsp-daemon listening on ${args.host ?? DEFAULT_HOST}:${d.port}`))
  .catch((e: unknown) => {
    console.error("wsp-daemon failed to start:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
