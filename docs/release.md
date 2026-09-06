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
4. **Version.** Bump `version` in every `package.json` under `packages/` and
   `apps/` to the same number: one tag, one `wsp --version` line, one
   package on npm.
5. **Publish the command line package.** `pnpm release` builds, packs and
   publishes the package that puts `wsp` on PATH. Then, in an empty folder
   on a shell with no `wsp` installed: `npm i -g <name>@<version>`,
   `wsp --version`, `wsp recipe --out /tmp/recipe.json`, and
   `wsp mcp install --agent claude` under a throwaway `HOME`. All four must
   work before the tag exists.
6. **Desktop bundles.** `pnpm --filter @wsp/desktop build` produces
   `apps/desktop/dist/mac-arm64/wsp.app`, `apps/desktop/dist/mac/wsp.app`
   and the Linux AppImage. Run the packaged smoke,
   `pnpm --filter @wsp/desktop smoke`, then zip each
   app (`ditto -c -k --keepParent <app> wsp-<version>-mac-<arch>.zip`).
7. **Tag and release.** `git tag v<version> && git push origin v<version>`,
   then a GitHub Release on that tag with the two zips and the AppImage
   attached. The notes say the bundles are unsigned and how to open them
   (the README's desktop section has the two lines), list what changed
   since the last tag, and quote the doctor table.
8. **Check from outside.** Download a bundle from the release page as a
   stranger would, open it on a computer that never built wsp, and reach the
   app. Read the README on GitHub once more: the install command, the
   version, and the release link must match what was just published.
