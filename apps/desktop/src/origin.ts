// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from "node:url";

/** Whether a frame's url is the host's own page: the same origin as the app url. The onboarding page (file:),
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

/** Whether a frame's url is the app's own onboarding page: the file it was loaded from, whatever query rides on it. */
export function fromOnboardingPage(frameUrl: string | undefined, pagePath: string): boolean {
  if (frameUrl === undefined) return false;
  try {
    const frame = new URL(frameUrl);
    return frame.protocol === "file:" && fileURLToPath(frame) === pagePath;
  } catch {
    return false;
  }
}
