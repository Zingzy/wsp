import { DEFAULT_HOST, startDaemon } from "./main.js";

startDaemon()
  .then(d => console.log(`wsp-daemon listening on ${DEFAULT_HOST}:${d.port}`))
  .catch((e: unknown) => {
    console.error("wsp-daemon failed to start:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
