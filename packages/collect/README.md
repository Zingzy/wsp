# @wsp/collect

Reads a developer machine and produces the manifest `wsp init` shows: identity, shell, editors, toolchains, tools, agents, logins, and the catalog below.

## Catalog data

`data/` holds three JSON files the loader reads relative to the module, so they ship with the package and work from `src/` and `dist/` alike.

- `catalog.json`: mackup's application catalog converted to one entry per app (`id`, `name`, `paths` relative to `$HOME`, `xdg` relative to `$XDG_CONFIG_HOME`). Entries whose only paths sit under `Library/` are dropped and listed in the `dropped` header field. GPL-3.0-or-later; the notice, the pinned commit and the license text are in `data/NOTICE`.
- `wsp-entries.json`: wsp's own entries, same shape, for tools mackup does not cover (gh, gcloud, wrangler, vercel, fly, supabase, doppler, railway, glab, uv, bun, atuin).
- `credential-overlay.json`: catalog paths that are credentials rather than config. A path is flagged when it, a parent, or a file inside it matches a `paths` pattern, or its basename matches a `names` pattern.

`lookup(dirName)` returns the `~/`-relative paths the catalog lists under a directory name (`.aws`, `gh`, `Code`, or a path such as `~/.config/gh`), each with a `credential` flag. A miss returns an empty array.

### Re-sync from mackup

```
git clone https://github.com/lra/mackup /tmp/mackup
pnpm --filter @wsp/collect build
node packages/collect/scripts/convert-mackup.mjs /tmp/mackup
```

The script pins the checkout's commit in the JSON header. Add `--check` to compare instead of writing; it exits 1 when `data/catalog.json` is not what the checkout converts to. After a re-sync, update the commit in `data/NOTICE` by hand and read the diff of `dropped` for CLI tools that moved under `Library/`.
