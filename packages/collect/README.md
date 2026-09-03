# @wsp/collect

Reads a developer machine and produces the manifest `wsp init` shows: identity, shell, editors, toolchains, tools, agents, logins, and the catalog below.

## Catalog data

`data/` holds three JSON files the loader reads relative to the module, so they ship with the package and work from `src/` and `dist/` alike.

- `catalog.json`: mackup's application catalog converted to one entry per app (`id`, `name`, `paths` relative to `$HOME`, `xdg` relative to `$XDG_CONFIG_HOME`). Entries whose only paths sit under `Library/` are dropped and listed in the `dropped` header field. GPL-3.0-or-later; the notice, the pinned commit and the license text are in `data/NOTICE`.
- `wsp-entries.json`: wsp's own entries, same shape: tools mackup does not cover (gcloud, wrangler, vercel, fly, supabase, doppler, railway, glab, uv, bun, atuin), files it misses for tools it lists (gh's `hosts.yml`), and Linux paths for tools it only knows under `Library/` (aerc, lazydocker, mkcert). When two entries list the same path, the first one's app name is kept.
- `credential-overlay.json`: catalog paths that are credentials rather than config. A path is flagged when it, a parent, or a file inside it matches a `paths` pattern, or its basename matches a `names` pattern.

`lookup(dirName)` returns the `~/`-relative paths the catalog lists under a directory name, each with a `credential` flag. A bare name (`.aws`, `gh`, `Code`) returns every path the catalog keys under that name wherever it lives, so `atuin` returns both `~/.config/atuin/config.toml` and `~/.local/share/atuin/key`. A name with a slash (`~/.config/atuin`, `.local/share/atuin`, `Library/Application Support/Code`) is a location and returns only the paths at or under it. Names are case-sensitive and match what `readdir` reports (`Code`, not `code`). A miss returns an empty array.

### Re-sync from mackup

```
git clone https://github.com/lra/mackup /tmp/mackup
pnpm --filter @wsp/collect build
node packages/collect/scripts/convert-mackup.mjs /tmp/mackup
```

The script pins the checkout's commit in the JSON header, so a plain run re-pins to whatever is checked out. Add `--check` to compare instead of writing; it exits 1 when `data/catalog.json` is not what the checkout converts to. To verify the shipped file rather than update it, check out the pinned commit first:

```
git -C /tmp/mackup checkout "$(node -p 'require("./packages/collect/data/catalog.json").commit')"
node packages/collect/scripts/convert-mackup.mjs /tmp/mackup --check
```

After a re-sync, update the commit and the "Converted on" date in `data/NOTICE` by hand and read the diff of `dropped` for CLI tools that moved under `Library/`.
