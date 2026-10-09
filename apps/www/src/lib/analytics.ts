// SPDX-License-Identifier: AGPL-3.0-only
// The site's counts: PostHog's EU cloud in its cookieless mode, so nothing is written to the visitor's browser and no
// banner is owed. It loads once the page is idle and goes to the app's project, every event marked as the site's.
import type { PostHog } from "posthog-js";

/** The project's public key, the one the app's counts go to; it is meant to sit in a page. */
const KEY = "phc_r3YMYPxJXWMiPpmXY3ew3gdjNKV535btdrcM8rPShWQC";

let loaded: Promise<PostHog> | undefined;

export function startAnalytics(): void {
  if (import.meta.env.DEV || loaded !== undefined) return;
  loaded = new Promise(resolve => {
    const go = (): void =>
      void import("posthog-js").then(({ default: posthog }) => {
        posthog.init(KEY, {
          api_host: "https://eu.i.posthog.com",
          ui_host: "https://eu.posthog.com",
          defaults: "2026-05-30",
          cookieless_mode: "always",
          disable_session_recording: true,
          person_profiles: "never",
        });
        posthog.register({ surface: "site" });
        resolve(posthog);
      });
    if ("requestIdleCallback" in window) window.requestIdleCallback(go, { timeout: 4000 });
    else setTimeout(go, 1500);
  });
}

/** One event of the site's own, sent once the counts have loaded and dropped if they never do. */
export function track(event: string, properties?: Record<string, unknown>): void {
  void loaded?.then(posthog => posthog.capture(event, properties));
}
