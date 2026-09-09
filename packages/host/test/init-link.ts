// SPDX-License-Identifier: AGPL-3.0-only
// The builder's daemon link as the sign-in tests script it: a login prints its
// page and exits, or waits for Ctrl-C when held; a status check answers with a
// quiet line. Shared by the terminal run's tests and the init job's.
import { fakePtyLink, type FakePtyLink } from "./fake-pty-link.js";

export const DEVICE_URL = "https://github.com/login/device";
export const CLAUDE_URL = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";

/** Ptys on the fake builder: a login prints its page's URL and exits (or waits for Ctrl-C when held). */
export function scriptedLink(state: { signedIn: boolean; hold: boolean; missing: boolean }): FakePtyLink {
  const link = fakePtyLink();
  link.script = (pty, line) => {
    // The secrets step's quiet runs: nothing set on the machine yet, no fish.
    if (line.includes("WSP_STATUS")) {
      link.data(pty, "\r\nWSP_STATUS 0\r\n");
      link.exit(pty, 0);
      return;
    }
    if (state.missing && line.startsWith("exec ")) {
      link.data(pty, `bash: exec: ${line.split(" ")[1]}: not found\r\n`);
      link.exit(pty, 127);
      return;
    }
    if (line.includes("exec claude")) link.data(pty, `Opening browser to sign in...\r\nIf the browser didn't open, visit: \x1b]8;;${CLAUDE_URL}\x1b\\${CLAUDE_URL}\x1b]8;;\x1b\\\r\nPaste code here if prompted > `);
    else link.data(pty, `Press Enter to open ${DEVICE_URL} in your browser...\r\n`);
    if (!state.hold) link.exit(pty, state.signedIn ? 0 : 1);
  };
  const op = link.op.bind(link);
  link.op = async (name, extra = {}) => {
    const r = await op(name, extra);
    if (name === "pty.write" && extra["data"] === "\x03") link.exit(link.ptys.find(x => x.id === extra["ptyId"])!, 130);
    return r;
  };
  return link;
}
