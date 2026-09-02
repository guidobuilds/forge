# Releasing

Releasing a new version is a manual flow. Follow these steps in order:

```sh
# 1. Bump package.json's "version"
# 2. Move CHANGELOG.md's "## [Unreleased]" entries under "## [X.Y.Z] - <date>"

pnpm run build
pnpm test

# 3. Commit
git add package.json CHANGELOG.md
git commit -m "Release X.Y.Z: <summary>"

# 4. Tag
git tag -a vX.Y.Z -m "Release X.Y.Z: <summary>"

# 5. Push + publish
git push origin main --tags
npm publish
```

## Versioning policy (pre-1.0)

This project is pre-1.0 (`0.y.z`). Per SemVer §4, anything may change at any time during initial
development. Forge's actual convention: **breaking changes ship in a minor version bump**, with a
`### Removed` section in the CHANGELOG and, when relevant, a `### Migration from X.Y` section
describing what a user on the previous version needs to do. This has been the practice since
0.3.0 (which removed public exported types and moved the entire source layout in a minor bump) —
this section just writes the existing convention down so it stops being re-litigated. `1.0.0` is
reserved for when the public API (`src/index.ts`) is deliberately declared stable, not as a
side effect of any single change, however large.
