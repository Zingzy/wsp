#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# The node daemon as the binary under test: WSP_DAEMON_BIN names this file and
# the suite holds it to the same flags and words it holds any other daemon to.
# It runs the built bin, so pnpm build comes first.
exec node "$(dirname "$0")/../dist/bin.js" "$@"
