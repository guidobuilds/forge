#!/bin/sh
# End-to-end trial for the pre-commit drift guard (f4). Exercises the real committed mechanism --
# .githooks/pre-commit wired via package.json's "prepare" script and core.hooksPath -- inside a
# fully isolated git clone, so it never touches this repo's own .git/config. A shared `git
# worktree` is NOT isolated enough for this: worktrees share .git/config with the main checkout,
# so `git config core.hooksPath` set inside one would leak into the primary repo (see
# .forge/lessons.md, claude-code-plugin-namespacing topic).
#
# Two-phase trial:
#   1. Stage a genuine (if harmless) change to an artifacts/ file without regenerating
#      forge-plugin/ -- assert the commit is BLOCKED by the hook.
#   2. Run `build-plugin --force` + `git add forge-plugin` -- assert the SAME commit now SUCCEEDS.
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

RUN_ID="$$-$(date +%s)"
THROWAWAY_BRANCH="drift-guard-verify-${RUN_ID}"
WORKTREE_PARENT="$(mktemp -d)"
CLONE_PARENT="$(mktemp -d)"
WORKTREE_DIR="${WORKTREE_PARENT}/worktree"
CLONE_DIR="${CLONE_PARENT}/clone"

cleanup() {
  status=$?
  echo "==> Cleaning up disposable state"
  rm -rf "$CLONE_DIR" 2>/dev/null || true
  rm -rf "$CLONE_PARENT" 2>/dev/null || true
  git worktree remove --force "$WORKTREE_DIR" >/dev/null 2>&1 || true
  rm -rf "$WORKTREE_PARENT" 2>/dev/null || true
  git branch -D "$THROWAWAY_BRANCH" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT INT TERM

echo "==> [1/7] Creating disposable worktree on throwaway branch ${THROWAWAY_BRANCH}"
git worktree add -b "$THROWAWAY_BRANCH" "$WORKTREE_DIR" HEAD >/dev/null

echo "==> [2/7] Syncing current working tree (incl. uncommitted drift-guard files) into the worktree"
rsync -a --del --exclude='.git' --exclude-from="$REPO_ROOT/.gitignore" "$REPO_ROOT/" "$WORKTREE_DIR/"

(
  cd "$WORKTREE_DIR"
  git add -A
  git commit -q -m "drift-guard verify: throwaway snapshot" --no-verify
)

echo "==> [3/7] Cloning the throwaway branch into an isolated directory (real git clone, not a local-path read)"
git clone -q --branch "$THROWAWAY_BRANCH" "file://$WORKTREE_DIR" "$CLONE_DIR"

echo "==> [4/7] pnpm install inside the isolated clone (own .git/config; installs the hook via 'prepare')"
(
  cd "$CLONE_DIR"
  pnpm install --silent
)

CLONE_HOOKS_PATH=$(cd "$CLONE_DIR" && git config core.hooksPath || true)
if [ "$CLONE_HOOKS_PATH" != ".githooks" ]; then
  echo "FAIL: expected core.hooksPath=.githooks inside the isolated clone after 'pnpm install', got '${CLONE_HOOKS_PATH:-<unset>}'"
  exit 1
fi
echo "    confirmed: clone's own .git/config has core.hooksPath=.githooks (isolated -- not this repo's config)"

echo "==> [5/7] Staging a real (if harmless) artifacts/ edit, without regenerating forge-plugin/"
PROBE_FILE="$CLONE_DIR/artifacts/forge/forge.md"
printf '\n<!-- drift-guard-verify: no-op probe %s -->\n' "$RUN_ID" >> "$PROBE_FILE"
(
  cd "$CLONE_DIR"
  git add artifacts/forge/forge.md
  if git commit -q -m "drift-guard verify: stale forge-plugin probe"; then
    echo "FAIL: commit succeeded but should have been BLOCKED (forge-plugin/ is now stale)"
    exit 1
  fi
  echo "    confirmed: commit BLOCKED while forge-plugin/ is stale (expected)"
)

echo "==> [6/7] Regenerating forge-plugin/ and staging it"
(
  cd "$CLONE_DIR"
  node bin/forge-ai.mjs build-plugin --source . --out forge-plugin --force
  git add forge-plugin
)

echo "==> [7/7] Retrying the same commit -- expected to SUCCEED now that forge-plugin/ is back in sync"
(
  cd "$CLONE_DIR"
  git commit -q -m "drift-guard verify: stale forge-plugin probe"
)
echo "    confirmed: commit SUCCEEDED once forge-plugin/ was regenerated and staged"

echo ""
echo "PASS: pre-commit drift guard blocks a stale forge-plugin/ commit and passes once regenerated."
