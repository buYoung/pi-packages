#!/usr/bin/env bash
# Runs every scenario of a matrix in its own node container and writes one result file per scenario.
# usage: scripts/install-check/run-matrix.sh [matrix file] [results dir] [packed tarball dir]
#   matrix lines are `<name>|<step> <step> ...`; see scenario.sh for the steps. Lines starting with # are skipped.
# Environment: JOBS (parallel containers, default 4), IMAGE (default node:24-bookworm), PI_VERSION (default 1.4.0).
set -u
here=$(cd "$(dirname "$0")" && pwd)
matrix=$(cd "$(dirname "${1:-$here/matrix.txt}")" && pwd)/$(basename "${1:-$here/matrix.txt}")
results=${2:-$here/results}
packages=${3:-}
mkdir -p "$results" && results=$(cd "$results" && pwd)
mounts=(-v "$here:/check:ro")
[ -n "$packages" ] && mounts+=(-v "$(cd "$packages" && pwd):/packages:ro")

while IFS= read -r line; do
  [ -z "$line" ] || [ "${line#\#}" != "$line" ] && continue
  name=${line%%|*}; steps=${line#*|}
  (
    # shellcheck disable=SC2086 # steps are whitespace-separated words
    docker run --rm "${mounts[@]}" -e PI_VERSION="${PI_VERSION:-1.4.0}" "${IMAGE:-node:24-bookworm}" bash /check/scenario.sh $steps > "$results/$name.txt" 2>&1
    echo "$name done"
  ) &
  while [ "$(jobs -r | wc -l)" -ge "${JOBS:-4}" ]; do sleep 3; done
done < "$matrix"
wait

# A scenario passes when the audit found nothing, Pi started, and every installed extension loaded without errors.
failed=0
for file in "$results"/*.txt; do
  name=$(basename "$file" .txt)
  if grep -q "^PROBLEMS: none" "$file" && grep -q "^STARTED: yes" "$file" && ! grep -qE "^NOT LOADED|^  START-ERR|FAIL" "$file" \
    && [ -z "$(sed -n '/^SCREEN ERRORS:/,/^RPC NOTIFY:/p' "$file" | sed '1d;$d')" ] && [ -z "$(sed -n '/^RPC NOTIFY:/,$p' "$file" | sed '1d')" ]; then
    echo "PASS $name"
  else
    echo "FAIL $name"; failed=1
  fi
done
exit $failed
