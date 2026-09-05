#!/bin/sh
cd "$(dirname "$0")"
set -a; . /Users/zingzy/wsp/.env; set +a
echo "START $(date -u +%FT%TZ)"
pnpm canary > canary.log 2>&1 && echo CANARY_OK || echo CANARY_FAIL
grep -E "Tests |Test Files |✓|×|FAIL|Error" canary.log | head -40
echo "END $(date -u +%FT%TZ)"
