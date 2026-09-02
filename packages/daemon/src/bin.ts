import { DEFAULT_HOST, parseDaemonArgs, startDaemon } from "./main.js";

let args: ReturnType<typeof parseDaemonArgs>;
try {
  args = parseDaemonArgs(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  console.error("usage: wsp-daemon [--host <addr>] [--port <n>] [--token-path <file>] [--root <dir>]");
  process.exit(2);
}

// Local runs have no /root token file; WSP_DAEMON_TOKEN or --token-path covers them.
const envToken = process.env["WSP_DAEMON_TOKEN"];

startDaemon({ ...args, ...(envToken ? { token: envToken } : {}) })
  .then(d => console.log(`wsp-daemon listening on ${args.host ?? DEFAULT_HOST}:${d.port}`))
  .catch((e: unknown) => {
    console.error("wsp-daemon failed to start:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
