#!/usr/bin/env bash
# Start Chromium for news-publisher CDP automation.
# Run this once on the host before starting the news-publisher container.
# The session is persisted in the profile dir — only needs to run once per boot.
#
# Usage:
#   ./scripts/start-chrome.sh           # headless (default)
#   HEADLESS=false ./scripts/start-chrome.sh  # headed, for first-time X login

set -euo pipefail

CDP_PORT="${CDP_PORT:-18810}"
PROFILE_DIR="${PROFILE_DIR:-$(dirname "$0")/../data/chrome-profile}"
HEADLESS="${HEADLESS:-true}"

# Detect chromium binary
for BIN in chromium chromium-browser google-chrome google-chrome-stable; do
  if command -v "$BIN" &>/dev/null; then
    CHROMIUM="$BIN"
    break
  fi
done

if [ -z "${CHROMIUM:-}" ]; then
  echo "ERROR: No chromium/chrome binary found in PATH" >&2
  exit 1
fi

mkdir -p "$PROFILE_DIR"

# Kill any existing instance on this port
if lsof -ti tcp:"$CDP_PORT" &>/dev/null; then
  echo "Killing existing process on port $CDP_PORT"
  kill "$(lsof -ti tcp:"$CDP_PORT")" 2>/dev/null || true
  sleep 1
fi

FLAGS=(
  "--remote-debugging-port=$CDP_PORT"
  "--user-data-dir=$PROFILE_DIR"
  "--no-first-run"
  "--no-default-browser-check"
  "--disable-background-networking"
  "--disable-sync"
  "--disable-extensions"
  "--disable-default-apps"
  "--mute-audio"
  "--disable-dev-shm-usage"
  "--no-sandbox"
)

if [ "$HEADLESS" = "true" ]; then
  FLAGS+=("--headless=new")
  echo "Starting $CHROMIUM in headless mode on CDP port $CDP_PORT"
else
  echo "Starting $CHROMIUM in headed mode on CDP port $CDP_PORT"
  echo "Log into X manually, then the session will be saved to: $PROFILE_DIR"
fi

exec "$CHROMIUM" "${FLAGS[@]}" about:blank
