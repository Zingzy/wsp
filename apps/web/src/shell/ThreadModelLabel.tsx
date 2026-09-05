// SPDX-License-Identifier: AGPL-3.0-only
// The header's note of what the workspace's latest session runs with: the
// model the CLI announced and the effort asked of it. Sessions live in the
// runtime's memory, so a restarted runtime shows nothing until the next turn.
import { useLatestSession } from "../protocol/store.js";

export function ThreadModelLabel({ workspaceId }: { workspaceId: string }) {
  const session = useLatestSession(workspaceId);
  if (session === null || (session.model === undefined && session.effort === undefined)) return null;
  return (
    <span data-thread-model className="flex min-w-0 shrink items-center gap-2 truncate font-mono text-xs text-muted-foreground">
      {session.model !== undefined ? <span className="truncate">{session.model}</span> : null}
      {session.model !== undefined && session.effort !== undefined ? <span aria-hidden>·</span> : null}
      {session.effort !== undefined ? <span>{session.effort}</span> : null}
    </span>
  );
}
