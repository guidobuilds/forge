# Releasing

Releasing a new version is a manual flow. Follow these steps in order:

```sh
# 1. Bump package.json's "version"
# 2. Move CHANGELOG.md's "## [Unreleased]" entries under "## [X.Y.Z] - <date>"

pnpm run build

# Regenerate the plugin package so it embeds the just-bumped version/license,
# and stage it so it ships in the same release commit as the version bump:
node bin/forge-ai.mjs build-plugin --target claude --source . --out forge-plugin --force
node bin/forge-ai.mjs build-plugin --target codex --source . --out plugins/forge --force
git add forge-plugin plugins/forge .agents/plugins/marketplace.json

# 3. Commit
git add package.json CHANGELOG.md
git commit -m "Release X.Y.Z: <summary>"

# 4. Tag
git tag -a vX.Y.Z -m "Release X.Y.Z: <summary>"
git tag -a forge--vX.Y.Z -m "Forge Claude Code plugin vX.Y.Z"

# 5. Push + publish
git push origin main --tags
npm publish
```

Notes:

- **Ordering matters.** `build-plugin` must run *after* the `package.json` version bump (step 1),
  because both plugin manifests' `version`/`license` fields are read from `package.json` at build
  time. Running it earlier bakes in the previous release's version.
- **Always pass `--force`.** On a fresh checkout `forge-plugin/` won't exist yet, so `--force` is a
  no-op. On every later release `forge-plugin/` already holds the previous release's generated
  package, so `--force` is just a defensive constant that keeps the release step from having to
  reason about which case applies.
- **`forge-plugin/` and `plugins/forge/` are intentionally tracked, not gitignored build output.** Unlike `dist/`, they must
  be committed so `/plugin marketplace add` (which clones this repo) can resolve
  `.claude-plugin/marketplace.json`'s `source: "./forge-plugin"`. Running `build-plugin` locally
  just to preview output will show it as untracked changes in `git status` — expected and harmless.
- **`forge--vX.Y.Z` always mirrors `vX.Y.Z` on the same commit, every release** — not conditional on
  whether the plugin package actually changed that cycle. One rule, no judgment call. This also
  isn't an arbitrary tag format: Claude Code's plugin-dependency version-constraint resolution looks
  for tags shaped `{plugin-name}--v{version}`, so `forge--vX.Y.Z` is already in the shape it expects
  if `forge` ever becomes a dependency of another plugin.
- **The tag is not what makes `/plugin install`/update detection work day-to-day** — that's
  `plugin.json`'s `version` field, read live from `package.json` on every `build-plugin` run.
  `forge--vX.Y.Z` is release-process bookkeeping and a future pin point, not a functional
  requirement for `/plugin marketplace add` + `/plugin install` to succeed.
- **The pre-commit hook now guards this flow.** A pre-commit hook (installed automatically via
  `pnpm install`, no new dependency) enforces that `forge-plugin/` matches what `build-plugin`
  currently generates from `artifacts/`, for any commit touching `artifacts/`, `src/`,
  `package.json`, `forge-plugin/`, or `plugins/forge/`. This does not change the command sequence above — the
  documented order already regenerates and stages both plugin packages before the release
  commit, so a correctly-followed release passes the hook without any extra steps. It exists as a
  backstop: if the regen step is ever forgotten, the release commit is blocked with the exact fix
  command printed, instead of silently shipping a stale plugin package.
