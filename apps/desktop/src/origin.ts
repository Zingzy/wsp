// SPDX-License-Identifier: AGPL-3.0-only
/** Whether a frame's url is the host's own page: the same origin as the app url. The setup page (file:),
 * about:blank, a missing frame and anything the window navigated to elsewhere are not. */
export function fromAppPage(frameUrl: string | undefined, appUrl: string): boolean {
  if (frameUrl === undefined) return false;
  try {
    const frame = new URL(frameUrl);
    return frame.origin !== "null" && frame.origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}
