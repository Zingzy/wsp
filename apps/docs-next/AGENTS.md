# Docs

The docs site for usewsp.com/docs, a Scalar project. Paths are under apps/docs-next/ unless they start at the repo root.

## How it works

`scalar.config.json` holds the whole sidebar, in order, and the redirects from the old docs. Each page is one file
under `content/`, and its path on the site is its route keys joined, so `content/features/threads.mdx` is
`/features/threads`. Scalar runs no script when it builds: what is committed is what is published.

`pnpm --filter @wsp/docs-next check` validates the config and `preview` serves the site on port 7970, or the next free one. Every
`@scalar/cli` release needs Node 24 or newer, so both scripts fetch Node 24 through npx and run the CLI on it from the
repo's Node 22.

A page is written or generated. Its stub's one line says which, and names the file its facts come from, so a
change to that file tells its reviewer which page to open. Generated pages: every page under `content/reference/cli/`
(from the built binary's help), `reference/mcp-tools`, `reference/slate`, `reference/environment`,
`features/settings`, `features/shortcuts`, `agents/skill`, `project/changelog`, `project/contributing` and
`project/security`. A generated page is never edited by hand; until its script lands, it holds its stub.
A written page keeps its sources as one `{/* Written from <paths> */}` line under its h1, which readers never see.

## Writing

Every page follows the `unslop`, `simple-english` and `technical-writing` skills, loaded before writing and run
again as a last pass.

## Invariants

1. No em dash, none of unslop's banned words outside code, and no should, would, may, might or could in a page of
   steps: anything under `content/install/`, `content/start/` or `content/guides/` (`test/prose.test.ts`).
2. Every `<Image>`, `<video>` or markdown picture names a scene in `shots.json`, the shot list the brand kit's
   shooter makes; a new picture is a new scene there first (`test/prose.test.ts`).
3. Every page the config names is a file, every file is a page, and each of the old docs' 28 paths lands on a page
   (`test/redirects.test.ts`).
4. The site is dark only: `colorScheme` defaults to dark with no toggle, and every shot is taken in Tungsten.

## Traps

1. Scalar joins route keys, so two groups whose pages share no path prefix cannot both sit at the root: a second
   `/` key overwrites the first, and `//` makes that group's own route answer `/`, sending the home page to its first
   child. That is why The project's pages live under `/project/`.
2. Scalar serves these pages at its own root and writes its sidebar and asset links with the `/docs` subpath, but its scripts redraw a page's own links without it once the page loads. The usewsp.com Worker (`apps/www/worker/index.ts`) strips `/docs`, writes it back onto bare links, and sends a path the site lacks to `/docs` when Scalar has it. Publish with `scalar project publish -s wsp -c scalar.config.json` from this folder; Scalar's GitHub sync names the repo's old home.
3. Scalar keeps a JSX attribute only in its React spelling, so a `<video>` plays only with `autoPlay`, and
   `test/prose.test.ts` fails one without it.
