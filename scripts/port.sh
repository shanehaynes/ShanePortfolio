#!/usr/bin/env bash
# Print this workspace's preview port. The shell face of dev/port.mjs.
#
# There is no package manager here, so this stands in for `npm run -s port`.
# It exists so documentation can say
#     lsof -i :$(scripts/port.sh)
# and be right in every checkout, instead of naming a number that is only true
# in one of them.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
common=$(git -C "$here" rev-parse --git-common-dir)
case "$common" in /*) ;; *) common="$(cd "$here" && pwd)/$common" ;; esac
primary=$(cd "$common/.." && pwd)
exec node "$primary/dev/port.mjs" "$@"
