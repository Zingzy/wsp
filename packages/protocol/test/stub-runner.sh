#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Runs the script writeStub kept beside the link it was started through.
body="${0%/*}/.${0##*/}.stub"
[ -f "$body" ] || { echo "stub-runner: no script at $body" >&2; exit 127; }
IFS= read -r first < "$body"
case $first in "#!"*) exec ${first#??} "$body" "$@" ;; esac
exec /bin/sh "$body" "$@"
