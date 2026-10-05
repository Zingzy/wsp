// SPDX-License-Identifier: AGPL-3.0-only
// What a bundle bakes into the host at build time, read off the building
// shell: the PostHog project key the usage counts are sent under and the host
// they go to. The release workflow sets them; every other build leaves them
// empty, and a host built with no key sends nothing. The names carry no WSP_
// prefix because they are build inputs, never read by a running wsp.
export const buildDefines = (env = process.env) => ({
  __WSP_POSTHOG_KEY__: JSON.stringify(env.POSTHOG_KEY ?? ""),
  __WSP_POSTHOG_HOST__: JSON.stringify(env.POSTHOG_HOST ?? ""),
});
