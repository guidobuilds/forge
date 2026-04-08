#!/bin/sh

set -eu

DEST_DIR=${XDG_CONFIG_HOME:-"$HOME/.config"}/opencode/agents
MANIFEST_NAME=install-manifest.env

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
MANIFEST_PATH=$REPO_ROOT/$MANIFEST_NAME
AGENTS_DIR=$REPO_ROOT/agents

AGENTS=

err() {
  printf '%s\n' "$1" >&2
  exit 1
}

load_manifest() {
  manifest_path=$1

  AGENTS=

  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      ''|'#'*)
        continue
        ;;
      AGENTS=*)
        AGENTS=${line#AGENTS=}
        ;;
      *=*)
        ;;
      *)
        err "Invalid manifest entry in $manifest_path: $line"
        ;;
    esac
  done < "$manifest_path"

  [ -n "$AGENTS" ] || err "Missing AGENTS in $manifest_path"
}

[ -f "$MANIFEST_PATH" ] || err "Missing manifest: $MANIFEST_PATH"
[ -d "$AGENTS_DIR" ] || err "Missing agents directory: $AGENTS_DIR"

load_manifest "$MANIFEST_PATH"

mkdir -p "$DEST_DIR"

for file in $AGENTS; do
  [ -n "$file" ] || err "Encountered empty agent entry in $MANIFEST_PATH"

  source_path=$AGENTS_DIR/$file
  destination_path=$DEST_DIR/$file
  relative_source_path=agents/$file

  [ -f "$source_path" ] || err "Missing required source file: $source_path"
  cp "$source_path" "$destination_path"
  printf 'Copied %s to %s\n' "$relative_source_path" "$destination_path"
done

printf 'Installed Forge agents to %s\n' "$DEST_DIR"
