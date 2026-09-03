// SPDX-License-Identifier: AGPL-3.0-only
// One TerminalIo per pty for as long as the drawer shows it. The io holds the
// compose buffer, so it must survive re-renders and die with its pty.
import { useCallback, useEffect, useMemo } from "react";
import type { WorkspaceTerminals } from "../terminal/link.js";
import { composedPtyIo, type TerminalIo } from "../terminal/pty-io.js";

export function useTerminalIo(terms: WorkspaceTerminals, liveIds: readonly string[]): (terminalId: string) => TerminalIo {
  const cache = useMemo(() => new Map<string, TerminalIo>(), [terms]);
  useEffect(() => {
    for (const id of cache.keys()) if (!liveIds.includes(id)) cache.delete(id);
  }, [cache, liveIds]);
  return useCallback(
    (terminalId: string) => {
      let io = cache.get(terminalId);
      if (!io) {
        io = composedPtyIo(terms, terminalId);
        cache.set(terminalId, io);
      }
      return io;
    },
    [cache, terms],
  );
}
