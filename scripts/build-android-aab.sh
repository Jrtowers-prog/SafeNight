#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_DIR="$ROOT_DIR/android"
OUTPUT_AAB="$ANDROID_DIR/app/build/outputs/bundle/release/app-release.aab"

if [[ ! -d "$ANDROID_DIR" ]]; then
  echo "[error] Android directory not found at: $ANDROID_DIR"
  exit 1
fi

if [[ ! -f "$ANDROID_DIR/gradlew" ]]; then
  echo "[error] Gradle wrapper not found at: $ANDROID_DIR/gradlew"
  exit 1
fi

# Default Android SDK paths for macOS if not already set.
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
export SAFENIGHT_ENV_FILE="${SAFENIGHT_ENV_FILE:-.env.android}"

if [[ ! -d "$ANDROID_SDK_ROOT" ]]; then
  echo "[error] Android SDK not found at: $ANDROID_SDK_ROOT"
  echo "Set ANDROID_HOME / ANDROID_SDK_ROOT to your SDK path."
  exit 1
fi

echo "[build] Bumping Android version code..."
node "$ROOT_DIR/scripts/bump-android-version-code.js"

echo "[build] Building signed release AAB..."
(
  cd "$ANDROID_DIR"
  chmod +x ./gradlew
  ./gradlew --no-daemon clean :app:bundleRelease
)

if [[ -f "$OUTPUT_AAB" ]]; then
  echo "[success] Production AAB generated:"
  echo "$OUTPUT_AAB"
else
  echo "[error] Build finished but AAB was not found at expected location:"
  echo "$OUTPUT_AAB"
  exit 1
fi
