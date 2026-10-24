#!/bin/sh
# render-wait — poll a RestorffCut render until it is done (revise-safety agent, 2026-10-21; moved from
# docs/restorff/recreations/warm-moody/harness/render_wait.sh, no hard-coded paths).
#
#   sh scripts/render-wait.sh <render_id> [max_polls]        (from the repo root or anywhere; dev server on :8791)
#
# The render tool waits AT MOST 25 s per call (wait_s > 25 is refused), so this calls render {render_id, wait_s: 25}
# through scripts/mcpx.py until render.status is done / error / failed (default 20 polls). Exit 0 = done.
# Log + raw results: $RC_LOG / $RC_WORK (see scripts/mcpx.py). PYTHON overrides the interpreter (default: python).
HERE="$(cd "$(dirname "$0")" && pwd)"
exec "${PYTHON:-python}" -I "$HERE/mcpx.py" wait-render "$1" --polls "${2:-20}"
