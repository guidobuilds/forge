#!/bin/sh

set -eu

DEST_DIR=${XDG_CONFIG_HOME:-"$HOME/.config"}/opencode/agents
MANIFEST_NAME=install-manifest.env
BOOTSTRAP_MANIFEST_URL=${FORGE_MANIFEST_URL:-"https://raw.githubusercontent.com/guidobuilds/forge/refs/heads/main/$MANIFEST_NAME"}

OWNER=
REPO=
DEFAULT_REF=
AGENTS=
SELECTED_REF=
RAW_BASE_URL=

err() {
  printf '%s\n' "$1" >&2
  exit 1
}

fetch_to_file() {
  url=$1
  destination=$2

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$destination" || err "Failed to download $url"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -qO "$destination" "$url" || err "Failed to download $url"
    return
  fi

  err "Forge installer requires curl or wget to download $url"
}

load_manifest() {
  manifest_path=$1

  OWNER=
  REPO=
  DEFAULT_REF=
  AGENTS=

  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      ''|'#'*)
        continue
        ;;
      *=*)
        key=${line%%=*}
        value=${line#*=}
        case $key in
          OWNER) OWNER=$value ;;
          REPO) REPO=$value ;;
          DEFAULT_REF) DEFAULT_REF=$value ;;
          AGENTS) AGENTS=$value ;;
        esac
        ;;
      *)
        err "Invalid manifest entry in $manifest_path: $line"
        ;;
    esac
  done < "$manifest_path"

  [ -n "$OWNER" ] || err "Missing OWNER in $manifest_path"
  [ -n "$REPO" ] || err "Missing REPO in $manifest_path"
  [ -n "$DEFAULT_REF" ] || err "Missing DEFAULT_REF in $manifest_path"
  [ -n "$AGENTS" ] || err "Missing AGENTS in $manifest_path"
}

SCRIPT_PATH=
SCRIPT_DIR=
if [ -n "${0:-}" ] && [ -f "$0" ]; then
  SCRIPT_PATH=$0
  SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd)
fi

LOCAL_MODE=false
LOCAL_MANIFEST=
LOCAL_AGENTS_DIR=

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/$MANIFEST_NAME" ] && [ -d "$SCRIPT_DIR/agents" ]; then
  LOCAL_MODE=true
  LOCAL_MANIFEST=$SCRIPT_DIR/$MANIFEST_NAME
  LOCAL_AGENTS_DIR=$SCRIPT_DIR/agents
fi

TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t forge-install)
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

MANIFEST_PATH=$TMP_DIR/$MANIFEST_NAME

if [ "$LOCAL_MODE" = true ]; then
  cp "$LOCAL_MANIFEST" "$MANIFEST_PATH"
else
  fetch_to_file "$BOOTSTRAP_MANIFEST_URL" "$MANIFEST_PATH"
fi

load_manifest "$MANIFEST_PATH"

SELECTED_REF=${FORGE_REF:-$DEFAULT_REF}
RAW_BASE_URL="https://raw.githubusercontent.com/$OWNER/$REPO/$SELECTED_REF"

mkdir -p "$DEST_DIR"

for file in $AGENTS; do
  [ -n "$file" ] || err "Encountered empty agent entry in $MANIFEST_PATH"

  staged_path=$TMP_DIR/$file
  destination_path=$DEST_DIR/$file

  if [ "$LOCAL_MODE" = true ]; then
    source_path=$LOCAL_AGENTS_DIR/$file
    [ -f "$source_path" ] || err "Missing required source file: $source_path"
    cp "$source_path" "$staged_path"
  else
    source_url=$RAW_BASE_URL/agents/$file
    fetch_to_file "$source_url" "$staged_path"
  fi

  mv -f "$staged_path" "$destination_path" || err "Failed to install $destination_path"
done

printf 'Installed Forge agents to %s\n' "$DEST_DIR"
