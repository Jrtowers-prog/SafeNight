#!/usr/bin/env bash
set -euo pipefail

mode="staged"
if [[ "${1:-}" == "--ci" ]]; then
  mode="ci"
fi

blocked_patterns=$(cat <<'EOF'
^coverage/
^backend/coverage/
^\.nyc_output/
^test-results/
^playwright-report/
(^|/)junit\.xml$
(^|/)jest-junit\.xml$
(^|/)coverage-final\.json$
EOF
)

candidates=()
if [[ "$mode" == "staged" ]]; then
  while IFS= read -r line; do
    [[ -n "$line" ]] && candidates+=("$line")
  done < <(git diff --cached --name-only --diff-filter=ACMR)
else
  while IFS= read -r line; do
    [[ -n "$line" ]] && candidates+=("$line")
  done < <(git ls-files)
fi

if [[ ${#candidates[@]} -eq 0 ]]; then
  echo "Artifact guard: no files to validate."
  exit 0
fi

violations=()
for file in "${candidates[@]}"; do
  while IFS= read -r pattern; do
    [[ -z "$pattern" ]] && continue
    if [[ "$file" =~ $pattern ]]; then
      violations+=("$file")
      break
    fi
  done <<< "$blocked_patterns"
done

if [[ ${#violations[@]} -gt 0 ]]; then
  echo "Artifact guard failed. Remove generated test/coverage artifacts from git changes:"
  printf ' - %s\n' "${violations[@]}"
  echo "Allowed: source tests in src/**, tests/**, backend/tests/** and other source-controlled code."
  exit 1
fi

echo "Artifact guard passed."
