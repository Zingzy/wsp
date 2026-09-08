# Cutting a release

A release is a version tag, the command line package on npm, and the desktop
bundles on the GitHub Release for that tag. Every step is run from a clean
checkout of `main` on a computer with the Solari key in `.env`.

1. **Gate.** `pnpm install --frozen-lockfile && pnpm build`, then
   `pnpm test`, `pnpm -r exec tsc --noEmit`, and `pnpm --filter @wsp/web
   build`. All green, no key set.
2. **Canary.** `pnpm canary` against the real provider. A red case means a
   create body has to change on purpose; do not release over it. See
   [canary.md](canary.md).
3. **Doctor.** `pnpm wsp doctor` once, and keep its table for the release
   notes.
4. **Publish the command line package.** `pnpm release <version>` renumbers
   every `package.json` under `packages/` and `apps/` that carries a version
   (one tag, one `wsp --version` line, one package on npm), builds everything
   but the desktop bundle, packs `packages/wspx` and publishes it. A bump
   name works too: `pnpm release patch`. It rewrites the manifests in place
   and commits nothing, naming each file it touched on its own output.
   Between the build and the publish it runs `pnpm --filter @zingzy/wsp smoke`,
   which installs the tarball into an empty folder on a clean environment and
   runs `wsp --version`, `wsp recipe --out` and `wsp mcp install --agent
   claude` under a throwaway `HOME`, so nothing reaches npm that has not been
   installed and run. `--pack-only` stops after the tarball. Once it is
   published, do the same from outside: `npm i -g @zingzy/wsp@<version>` in an empty
   folder on a shell with no `wsp` installed.
5. **Commit the version.** The renumbered manifests are still only in the
   working tree. Stage them by the paths step 4 printed, never `-A`, and
   commit: `git commit -m "chore: v<version>" <those paths>`. The tag in
   step 6 then names a commit whose `package.json` files say the number that
   is now on npm.
6. **Tag.** `git tag v<version> && git push origin v<version>`. A pushed
   `v*` tag is the only thing that starts
   [the release workflow](../.github/workflows/release.yml), and it is the
   whole desktop road: it checks the tag against every `package.json` that
   carries a version and stops with both numbers in the line when they
   disagree, so a tag pushed before step 5 fails here instead of shipping the
   wrong number. Then a macOS runner builds `apps/desktop` for arm64 and x64,
   signs each app (see [Signing the mac bundles](#signing-the-mac-bundles)),
   checks its signature and its packaged tree, and zips it as
   `wsp-<version>-mac-<arch>.zip`; a Linux runner builds
   `wsp-<version>.AppImage`. All three land on a draft release on the tag,
   whose notes are the commits since the previous tag plus the README's lines
   on opening a downloaded bundle. Nothing else on the workflow reaches npm:
   step 4 stays a person's, because of the one time password.
7. **Publish the draft.** Read the notes, paste the doctor table from step 3
   under them, and press publish. Nothing publishes itself. If a runner is
   down, the same bundles come from a Mac by hand:
   `pnpm --filter @wsp/desktop build`, then
   `pnpm --filter @wsp/desktop smoke`, then
   `ditto -c -k --keepParent apps/desktop/dist/mac-arm64/wsp.app wsp-<version>-mac-arm64.zip`
   and the same for `dist/mac` as `-mac-x64`, attached to the draft by hand.
   A Mac whose login keychain holds the Developer ID Application certificate
   signs them with it, and notarizes when `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` are set in the shell;
   any other Mac signs them ad hoc.
8. **Check from outside.** Download a bundle from the release page as a
   stranger would, open it on a computer that never built wsp, and reach the
   app. Read the README on GitHub once more: the install command, the
   version, and the release link must match what was just published.

## Signing the mac bundles

Without a certificate the workflow signs each `wsp.app` ad hoc, under the
hardened runtime and the entitlements in
`apps/desktop/build/entitlements.mac.plist`. A download of that opens after a
right-click Open, which the README's paragraph between the `unsigned` markers
says, and the notes carry that paragraph. With the five secrets below the same
workflow signs with the Developer ID, has Apple notarize each bundle, staples
the ticket into it, and leaves the paragraph out of the notes. Nothing else
changes: the next pushed tag ships notarized bundles. Set all five or none: a
certificate without the Apple account fails the release, because the check
step insists on a notarized, stapled bundle once a certificate is present.
The owner does this once:

1. **Enroll** in the Apple Developer Program at developer.apple.com. The
   ten-character team id is on the membership page.
2. **Create a Developer ID Application certificate.** In Xcode: Settings,
   Accounts, the team, Manage Certificates, the plus button, Developer ID
   Application. Or on developer.apple.com under Certificates, then download
   it and open it so it lands in the login keychain.
3. **Export it as a `.p12`.** Keychain Access, My Certificates, right-click
   the certificate, Export, the `.p12` format, and a password for the file.
4. **Make an app-specific password** at appleid.apple.com under Sign-In and
   Security, App-Specific Passwords. This is what the workflow hands
   `notarytool`, never the account's own password.
5. **Set the repository secrets** at github.com/Zingzy/wsp, Settings,
   Secrets and variables, Actions:
   - `CSC_LINK`: the `.p12` as base64, `base64 -i wsp.p12 | pbcopy` and
     paste.
   - `CSC_KEY_PASSWORD`: the password from step 3.
   - `APPLE_ID`: the Apple account's email.
   - `APPLE_APP_SPECIFIC_PASSWORD`: the password from step 4.
   - `APPLE_TEAM_ID`: the team id from step 1.
6. **Push the next tag.** The mac job signs, notarizes and checks; its check
   step is what says whether the bundles are notarized, and the draft's notes
   leave out the right-click Open paragraph. Then do step 8 above as always:
   a downloaded bundle opens on a double click with no dialog.
7. **Delete the paragraph** between the `unsigned:start` and `unsigned:end`
   markers in the README, markers included, once a notarized release is out.
   The notes read those lines from the README, so nothing else is edited.
