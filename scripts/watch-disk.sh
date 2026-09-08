#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Samples the root disk and every process's writing once a second, so a writer
# that fills the disk and vanishes can still be named afterwards. Reads /proc,
# so it runs on the Linux boxes, not on a Mac.
#   df.log  root-disk use per second
#   fd.log  open files over min_mb, including ones unlinked while still held:
#           those keep blocks that df counts and du cannot see
#   io.log  processes whose lifetime write_bytes passed min_mb, which names a
#           writer that spreads its bytes over many small files
# Usage: scripts/watch-disk.sh <logdir> [seconds] [min_mb]

set -eu
LOGDIR=${1:?usage: watch-disk.sh <logdir> [seconds] [min_mb]}
RUN_FOR=${2:-3600}
MIN_MB=${3:-64}
mkdir -p "$LOGDIR"
DF_LOG="$LOGDIR/df.log"
FD_LOG="$LOGDIR/fd.log"
IO_LOG="$LOGDIR/io.log"
MIN_BYTES=$((MIN_MB * 1048576))

i=0
while [ "$i" -lt "$RUN_FOR" ]; do
  NOW=$(date -u +%H:%M:%S)
  df -k / | awk -v t="$NOW" 'NR==2 {print t" used_kb="$3" avail_kb="$4" pct="$5}' >> "$DF_LOG"

  # One stat per process, not one per open file: on a 2 vCPU box a fork per fd
  # costs more than the sample is worth.
  for FDDIR in /proc/[0-9]*/fd; do
    PID=${FDDIR%/fd}
    PID=${PID#/proc/}
    COMM=$(cat "/proc/$PID/comm" 2>/dev/null) || continue
    WROTE=$(awk '/^write_bytes:/ {print $2}' "/proc/$PID/io" 2>/dev/null) || WROTE=0
    if [ "${WROTE:-0}" -gt "$MIN_BYTES" ] 2>/dev/null; then
      CMD=$(tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null | cut -c1-200) || CMD=""
      echo "$NOW pid=$PID wrote_mb=$((WROTE / 1048576)) comm=$COMM cmd=$CMD" >> "$IO_LOG"
    fi
    stat -Lc '%n %s' "$FDDIR"/* 2>/dev/null | while read -r FDPATH SIZE; do
      [ "$SIZE" -gt "$MIN_BYTES" ] 2>/dev/null || continue
      TARGET=$(readlink "$FDPATH" 2>/dev/null) || TARGET="?"
      echo "$NOW pid=$PID size_mb=$((SIZE / 1048576)) comm=$COMM path=$TARGET" >> "$FD_LOG"
    done
  done

  i=$((i + 1))
  sleep 1
done
