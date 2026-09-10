// SPDX-License-Identifier: AGPL-3.0-only
// The desktop shell and this page are two halves of one release that can be
// run apart: an app attached to a host it did not start may be of another
// build, and then every call over the bridge (a dropped folder, the folder
// picker, the computer's fonts, a page photograph, the native menu) works or
// fails by which half is behind, with nothing said. Read once on load and put
// in the one place the app already puts a sentence a person may be waiting on.
import { GET_THE_APP_WORD, shellVersionNotice } from "@wsp/protocol";
import { useEffect } from "react";
import { RELEASES } from "../../../../packages/wspx/scripts/bundles.mjs";
import { bootPayload } from "../boot.js";
import { desktopBridge } from "../lib/desktopShell.js";
import { useStore } from "../protocol/store.js";

/** Both halves as this page can read them: the shell holding it, when a shell does, and the host that served it.
 * The settings page shows them side by side; a browser tab has no shell half to show. */
export function shellVersions(): { app: string | undefined; host: string | undefined; inShell: boolean } {
  const bridge = desktopBridge();
  return { app: bridge?.version, host: bootPayload()?.version, inShell: bridge !== undefined };
}

/** Mounted once under the store: a shell of another release than the host that served this page takes the toast,
 * with the releases page behind its button where there is a newer app to get. */
export function useShellVersionEffect(): void {
  useEffect(() => {
    const { app, host, inShell } = shellVersions();
    if (!inShell || host === undefined) return;
    const notice = shellVersionNotice(app, host);
    if (notice === undefined) return;
    useStore.setState({
      toast: notice.line,
      toastAction: notice.update ? { for: notice.line, word: GET_THE_APP_WORD, run: () => window.open(RELEASES, "_blank", "noopener,noreferrer") } : null,
    });
  }, []);
}
