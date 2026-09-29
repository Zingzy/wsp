// SPDX-License-Identifier: AGPL-3.0-only
// What a reply's shell block shows under it once it was run: a live terminal while the command runs, taking the
// person's keys, and the text it printed with how it ended once it is over. The live terminal is disposed at the
// exit, so a long thread holds none it does not need.
import { createContext, use, useEffect, useState } from "react";
import { RUN_MOVE_AFTER_MS, RUN_WORDS, runEndedWords, runOutputMessage, type SessionRunEvent } from "@wsp/protocol";
import { useStore } from "../../protocol/store.js";
import { useTerminalDrawerStore } from "../../terminal/drawerStore.js";
import { getTerminals } from "../../terminal/link.js";
import { TerminalViewport } from "../ThreadTerminalDrawer.js";
import { Button } from "../ui/button.js";
import { heldPty, moveRun, resumeRun } from "./replyRun.js";

/** The reply a block sits in, so the block can name itself and find its run: set by the timeline around an agent's
 * reply and nowhere else, so a person's own message and a file's markdown get no Run. */
export interface ReplyRunScope {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly messageId: string;
  /** The thread's folder on its computer, where a run starts. */
  readonly cwd: string | undefined;
  readonly runs: ReadonlyMap<string, SessionRunEvent>;
}

export const ReplyRunContext = createContext<ReplyRunScope | null>(null);

/** The live box's height: RUN_ROWS of the terminal's lines and its padding. It scrolls. */
const LIVE_BOX_PX = 232;
const NO_CONFIG = {};
/** A footer action is a quiet word until pointed at, as every ghost action in the app is. */
const FOOTER_ACTION = "h-6 px-2 text-[12px] font-normal text-muted-foreground hover:text-foreground";

export function InlineRun({ run }: { run: SessionRunEvent | undefined }) {
  if (run === undefined) return null;
  if (run.state === "running") return <LiveRun run={run} />;
  return <EndedRun run={run} />;
}

function LiveRun({ run }: { run: SessionRunEvent }) {
  const api = useStore(s => s.api);
  const [ptyId, setPtyId] = useState<string | null>(() => heldPty(run.runId));
  const [movable, setMovable] = useState(false);
  // A run another window started, or this one before a reload, is taken back off the record.
  useEffect(() => {
    if (ptyId !== null || api === null) return;
    let stale = false;
    void resumeRun(api, run).then(() => {
      if (!stale) setPtyId(heldPty(run.runId));
    });
    return () => {
      stale = true;
    };
  }, [api, ptyId, run]);
  useEffect(() => {
    const timer = window.setTimeout(() => setMovable(true), RUN_MOVE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, []);
  const wt = getTerminals(run.workspaceId);
  // A full-screen program belongs in a tab: it goes there by itself, still running.
  useEffect(() => {
    if (ptyId === null || wt === null || api === null) return;
    return wt.onAltScreen(ptyId, () => void moveRun(api, run));
  }, [api, ptyId, run, wt]);
  return (
    <div data-reply-run="running" className="flex flex-col">
      <div className="bg-[var(--terminal-background)]" style={{ height: LIVE_BOX_PX }}>
        {ptyId !== null && wt !== null ? (
          <TerminalViewport terminalId={ptyId} io={wt.io(ptyId)} config={NO_CONFIG} focusRequestId={0} autoFocus resizeEpoch={0} drawerHeight={LIVE_BOX_PX} />
        ) : null}
      </div>
      <RunFooter words={RUN_WORDS.running}>
        {movable && api !== null ? (
          <Button type="button" variant="ghost" size="compact" className={FOOTER_ACTION} data-reply-run-move onClick={() => void moveRun(api, run)}>
            {RUN_WORDS.move}
          </Button>
        ) : null}
      </RunFooter>
    </div>
  );
}

function EndedRun({ run }: { run: SessionRunEvent }) {
  const api = useStore(s => s.api);
  const scope = use(ReplyRunContext);
  const open = (): void => {
    if (run.ptyId === undefined) return;
    const drawer = useTerminalDrawerStore.getState();
    drawer.setOpen(run.workspaceId, true);
    drawer.activate(run.workspaceId, run.ptyId);
    getTerminals(run.workspaceId)?.setActive(run.ptyId);
  };
  const send = (): void => {
    if (api === null || scope === null) return;
    void api.startSession({ workspaceId: scope.workspaceId, thread: scope.threadId, prompt: runOutputMessage(run.command, run, run.output ?? ""), requestId: crypto.randomUUID() });
  };
  const output = run.output ?? "";
  return (
    <div data-reply-run={run.state} className="flex flex-col">
      {run.state === "exited" && output !== "" ? (
        <pre data-reply-run-output className="m-0 max-h-[232px] overflow-auto bg-[var(--terminal-background)] px-3 py-2 font-mono text-[12px] leading-[18px] whitespace-pre-wrap text-foreground tabular-nums">
          {output}
        </pre>
      ) : null}
      <RunFooter words={runEndedWords(run)}>
        {run.state === "exited" && scope !== null ? (
          <Button type="button" variant="ghost" size="compact" className={FOOTER_ACTION} data-reply-run-send onClick={send}>
            {RUN_WORDS.send}
          </Button>
        ) : null}
        {run.state === "moved" ? (
          <Button type="button" variant="ghost" size="compact" className={FOOTER_ACTION} data-reply-run-open onClick={open}>
            {RUN_WORDS.openTab}
          </Button>
        ) : null}
      </RunFooter>
    </div>
  );
}

function RunFooter({ words, children }: { words: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 py-1 pr-1.5 pl-3 text-[12px] leading-4 text-muted-foreground tabular-nums">
      <span data-reply-run-state>{words}</span>
      <span className="flex items-center gap-1">{children}</span>
    </div>
  );
}
