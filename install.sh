#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEST_DIR=${XDG_CONFIG_HOME:-"$HOME/.config"}/opencode/agents

MANAGED_FILES="forge.md forge-explore.md forge-spec.md forge-plan.md forge-build.md"

for file in $MANAGED_FILES; do
  if [ ! -f "$SCRIPT_DIR/agents/$file" ]; then
    printf 'Missing required source file: %s\n' "$SCRIPT_DIR/agents/$file" >&2
    exit 1
  fi
done

mkdir -p "$DEST_DIR"

for file in $MANAGED_FILES; do
  cp -f "$SCRIPT_DIR/agents/$file" "$DEST_DIR/$file"
done

printf 'Installed Forge agents to %s\n' "$DEST_DIR"
