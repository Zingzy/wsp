// SPDX-License-Identifier: AGPL-3.0-only
// What the Diff pane holds while there is no daemon to read a diff over: the
// computer's own sentence and the button that puts a daemon this host started
// back, the word and the why of this window's link to it while that link is
// down, else the one line that says the workspace is not running, with the
// pane's own line for what it reads over that daemon. The Files pane holds the
// same.
import { DaemonDown } from "../components/DaemonDown.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty.js";
import { useAbsentComputer } from "../protocol/store.js";
import { useLinkDown } from "../terminal/paneWords.js";

export function NotRunning({ workspaceId, line }: { workspaceId: string; line: string }) {
  const absent = useAbsentComputer(workspaceId);
  const down = useLinkDown(workspaceId);
  if (absent !== null && absent.start !== undefined) {
    return (
      <Empty className="flex-1">
        <DaemonDown absent={absent} workspaceId={workspaceId} />
      </Empty>
    );
  }
  if (down !== null) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>{down.word}</EmptyTitle>
          <EmptyDescription>{down.line}</EmptyDescription>
        </EmptyHeader>
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
