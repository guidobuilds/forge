#!/bin/sh

set -eu

AGENTS_DEST_DIR=${XDG_CONFIG_HOME:-"$HOME/.config"}/opencode/agents
SKILLS_DEST_DIR=${XDG_CONFIG_HOME:-"$HOME/.config"}/opencode/skills
MANIFEST_NAME=install-manifest.env
LEGACY_AGENTS="forge-spec.md forge-tech.md"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
MANIFEST_PATH=$REPO_ROOT/$MANIFEST_NAME
AGENTS_DIR=$REPO_ROOT/agents
SKILLS_DIR=$REPO_ROOT/skills

AGENTS=
SKILLS=

err() {
  printf '%s\n' "$1" >&2
  exit 1
}

load_manifest() {
  manifest_path=$1

  AGENTS=
  SKILLS=

  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      ''|'#'*)
        continue
        ;;
      AGENTS=*)
        AGENTS=${line#AGENTS=}
        ;;
      SKILLS=*)
        SKILLS=${line#SKILLS=}
        ;;
      *=*)
        ;;
      *)
        err "Invalid manifest entry in $manifest_path: $line"
        ;;
    esac
  done < "$manifest_path"

  [ -n "$AGENTS" ] || err "Missing AGENTS in $manifest_path"
  [ -n "$SKILLS" ] || err "Missing SKILLS in $manifest_path"
}

[ -f "$MANIFEST_PATH" ] || err "Missing manifest: $MANIFEST_PATH"
[ -d "$AGENTS_DIR" ] || err "Missing agents directory: $AGENTS_DIR"
[ -d "$SKILLS_DIR" ] || err "Missing skills directory: $SKILLS_DIR"

load_manifest "$MANIFEST_PATH"

mkdir -p "$AGENTS_DEST_DIR" "$SKILLS_DEST_DIR"

for file in $AGENTS; do
  [ -n "$file" ] || err "Encountered empty agent entry in $MANIFEST_PATH"

  source_path=$AGENTS_DIR/$file
  destination_path=$AGENTS_DEST_DIR/$file
  relative_source_path=agents/$file

  [ -f "$source_path" ] || err "Missing required source file: $source_path"
  mkdir -p "$(dirname -- "$destination_path")"
  cp "$source_path" "$destination_path"
  printf 'Copied %s to %s\n' "$relative_source_path" "$destination_path"
done

for file in $SKILLS; do
  [ -n "$file" ] || err "Encountered empty skill entry in $MANIFEST_PATH"

  source_path=$SKILLS_DIR/$file
  destination_path=$SKILLS_DEST_DIR/$file
  relative_source_path=skills/$file

  [ -f "$source_path" ] || err "Missing required source file: $source_path"
  mkdir -p "$(dirname -- "$destination_path")"
  cp "$source_path" "$destination_path"
  printf 'Copied %s to %s\n' "$relative_source_path" "$destination_path"
done

for file in $LEGACY_AGENTS; do
  legacy_path=$AGENTS_DEST_DIR/$file
  if [ -f "$legacy_path" ]; then
    rm -f "$legacy_path" || err "Failed to remove obsolete agent $legacy_path"
    printf 'Removed obsolete %s\n' "$legacy_path"
  fi
done

printf 'Installed Forge agents to %s\n' "$AGENTS_DEST_DIR"
printf 'Installed Forge skills to %s\n' "$SKILLS_DEST_DIR"
