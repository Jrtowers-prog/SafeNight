#!/usr/bin/env bash
set -euo pipefail

git config core.hooksPath .githooks
chmod +x .githooks/pre-commit scripts/guard-artifacts.sh

echo "Installed local git hooks using core.hooksPath=.githooks"
