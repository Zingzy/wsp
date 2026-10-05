// SPDX-License-Identifier: AGPL-3.0-only
// The centre while a workspace is being made: its setup is the content of the
// room, in the middle of it, as the Add a computer dialog's list of steps in a
// settings card, under the message that asked for it if one did; the composer
// is docked at the foot as in a conversation. A message sent now waits under
// the creation and goes to the workspace once it is up.
import { useLayoutEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChatComposer } from "../components/chat/ChatComposer.js";
import { PERSON_BUBBLE } from "../components/chat/MessagesTimeline.js";
import { SetupCard, SetupRoom } from "../components/chat/SetupCard.js";
import { useChatThread } from "../components/chat/useChatThread.js";
import { cn } from "../lib/utils.js";
import { usePlaces, useStore, type Creation } from "../protocol/store.js";
import { placeNames } from "../sidebar/workspaceRows.js";
import { RunsOn } from "./NewThreadPicks.js";
import { creationFolder } from "./creationLog.js";

/** What the composer says over a message that waits for the machine. */
export const creationWaitLine = (name: string): string => `Sends once ${name} is up`;

export function WorkspaceCreation({ creation }: { creation: Creation }) {
  const thread = useChatThread(creation.key, null, true);
  const asked = creation.asked;
  const { folder, at } = useStore(
    useShallow(s => {
      const project = s.projects.find(p => p.id === creation.project);
      return project === undefined ? { folder: "", at: creation.where } : { folder: creationFolder(project, creation.name), at: creation.where ?? project.computer };
    }),
  );
  const places = usePlaces();
  const computer = at === undefined ? undefined : placeNames(places).get(at);
  const rootRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  // ChatView's own measure, so the room above the composer is the room a conversation has.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const composer = composerRef.current;
    if (root === null || composer === null) return;
    const observer = new ResizeObserver(() => root.style.setProperty("--chat-composer-inset", `${composer.offsetHeight}px`));
    observer.observe(composer);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      data-testid="workspace-creation"
      aria-busy={creation.failed === null}
      data-creation-refused={creation.failed === null ? undefined : ""}
      className="flex min-h-0 flex-1 flex-col"
      data-terminal-beside
    >
      <div ref={rootRef} className="relative isolate h-full min-h-0 text-foreground">
        <SetupRoom
          {...(asked === undefined
            ? {}
            : {
                above: (
                  <div data-k="creation-asked" className="mx-auto flex w-full min-w-0 max-w-3xl shrink-0 flex-col items-end">
                    <div className={cn(PERSON_BUBBLE, "whitespace-pre-wrap break-words text-sm leading-relaxed")}>{asked}</div>
                  </div>
                ),
              })}
        >
          <SetupCard creation={creation} />
        </SetupRoom>
        <div ref={composerRef} data-chat-composer-dock className="pointer-events-none absolute inset-x-0 bottom-0 z-10 *:pointer-events-auto">
          <ChatComposer key={creation.key} workspaceId={creation.key} thread={thread} waiting={{ line: creationWaitLine(creation.name), folder }} where={at === undefined || computer === undefined ? undefined : <RunsOn at={at} name={computer} />} />
        </div>
      </div>
    </div>
  );
}
