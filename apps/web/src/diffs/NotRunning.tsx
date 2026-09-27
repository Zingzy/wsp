// SPDX-License-Identifier: AGPL-3.0-only
// What the Diff pane holds while there is no daemon to read a diff over: the
// computer's own sentence and the button that puts a daemon this host started
// back, else the one line that says the workspace is not running, with the
// pane's own line for what it reads over that daemon. The Files pane holds the
// same.
import { DaemonDown } from "../components/DaemonDown.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty.js";
import { useAbsentComputer } from "../protocol/store.js";

export function NotRunning({ workspaceId, line }: { workspaceId: string; line: string }) {
  const absent = useAbsentComputer(workspaceId);
  if (absent !== null && absent.start !== undefined) {
    return (
      <Empty className="flex-1">
        <DaemonDown absent={absent} workspaceId={workspaceId} />
      </Empty>
    );
  }
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyTitle>The thread is not running.</EmptyTitle>
        <EmptyDescription>{absent?.sentence ?? line}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
