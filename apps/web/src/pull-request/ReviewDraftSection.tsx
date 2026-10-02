// SPDX-License-Identifier: AGPL-3.0-only
// A review workspace's draft in its Pull request pane: the verdict the reviewer picked, the summary, one row per
// comment with its place, its words and a tick, and one Post. Every tick, verdict and summary is saved on the host as it
// changes, so another window and the command line post the same review. Nothing reaches GitHub until Post.
import { useEffect, useState } from "react";
import { START_WORDS, isReviewRead, type PullRequestFact, type ReviewVerdict } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { Checkbox } from "../components/ui/checkbox.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { Textarea } from "../components/ui/textarea.js";
import { GROUP_LABEL } from "../lib/microLabel.js";
import { cn } from "../lib/utils.js";
import { sendToThread } from "../diffs/sendToThread.js";
import { formatRelativeTimeLabel } from "../lib/timestampFormat.js";
import { addNotice, noticeFailure } from "../notices/store.js";
import { useStore } from "../protocol/store.js";
import { SEND_TO_THREAD } from "../diffs/words.js";
import { PrMarkdown } from "./parts.js";

const ROW = "flex min-w-0 items-start gap-3 rounded-[var(--control-radius)] px-2 py-2 transition-colors duration-150 hover:bg-accent";
const NOTE = "text-[11px] leading-[14px] text-muted-foreground";
const QUIET = "px-2 py-2 text-[13px] text-muted-foreground";
const VERDICTS: readonly ReviewVerdict[] = ["comment", "approve", "request_changes"];

export function ReviewDraftSection({ workspaceId, name, fact, head }: { workspaceId: string; name: string; fact: PullRequestFact | null; head: string }) {
  const draft = useStore(s => s.reviews[workspaceId]);
  const loadReview = useStore(s => s.loadReview);
  const [summary, setSummary] = useState(isReviewRead(draft) ? draft.summary : "");
  const [posting, setPosting] = useState(false);

  useEffect(() => void loadReview(workspaceId), [loadReview, workspaceId]);
  const drafted = isReviewRead(draft) ? draft.summary : undefined;
  useEffect(() => {
    if (drafted !== undefined) setSummary(drafted);
  }, [drafted]);

  const edit = async (edits: { summary?: string; verdict?: ReviewVerdict; on?: { id: string; on: boolean }[] }): Promise<void> => {
    const save = useStore.getState().api?.reviewDraft;
    if (save === undefined) return;
    try {
      const { review } = await save(workspaceId, edits);
      if (review !== undefined) useStore.setState(s => ({ reviews: { ...s.reviews, [workspaceId]: review } }));
    } catch (e) {
      noticeFailure(e, said => said, { where: name });
    }
  };

  const post = async (): Promise<void> => {
    const send = useStore.getState().api?.reviewPost;
    if (send === undefined) return;
    setPosting(true);
    try {
      if (isReviewRead(draft) && summary !== draft.summary) await edit({ summary });
      const done = await send(workspaceId);
      addNotice({ kind: "done", text: START_WORDS.posted(name, done.number, done.comments, done.folded), where: name });
      await loadReview(workspaceId);
    } catch (e) {
      noticeFailure(e, said => said, { where: name });
    } finally {
      setPosting(false);
    }
  };

  const body = ((): React.ReactNode => {
    if (draft === undefined) return <p className={QUIET}>{START_WORDS.stillWorking}</p>;
    if (!isReviewRead(draft)) return <p className={QUIET}>{draft.note}</p>;
    const ticked = draft.comments.some(c => c.on);
    return (
      <>
        {fact !== null && fact.headOid !== draft.headOid ? <p className={QUIET}>{START_WORDS.movedOn}</p> : null}
        <div className="flex flex-col gap-3 px-2 py-2">
          <SegmentedControl
            aria-label="Verdict"
            value={draft.verdict}
            segments={VERDICTS.map(v => ({ value: v, label: START_WORDS.verdicts[v] }))}
            onChange={verdict => void edit({ verdict })}
            className="self-start"
          />
          <Textarea aria-label="Summary" value={summary} onChange={e => setSummary(e.target.value)} onBlur={() => (summary !== draft.summary ? void edit({ summary }) : undefined)} />
        </div>
        {draft.comments.map(c => (
          <div key={c.id} data-pr-draft-comment={c.id} className={ROW}>
            <Checkbox className="mt-0.5" checked={c.on} aria-label={`Keep ${c.path}:${c.line}`} onCheckedChange={on => void edit({ on: [{ id: c.id, on: on === true }] })} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="min-w-0 truncate font-mono text-[13px] text-foreground tabular-nums">{`${c.path}:${c.line}`}</span>
              <PrMarkdown text={c.body} said line />
              {c.inSummary === true ? <span className={NOTE}>{START_WORDS.toSummary}</span> : null}
              <span className="mt-1">
                <Button type="button" size="xs" variant="ghost" onClick={() => sendToThread(workspaceId, `About ${c.path}:${c.line} in your review: ${c.body}`)}>
                  {SEND_TO_THREAD}
                </Button>
              </span>
            </div>
          </div>
        ))}
        <div className="flex items-center gap-3 px-2 pt-3">
          {draft.posted !== undefined ? (
            <>
              <a data-pr-draft-posted href={draft.posted.url} target="_blank" rel="noopener noreferrer" className="text-[13px] text-foreground hover:underline">
                {`Posted ${formatRelativeTimeLabel(new Date(draft.posted.at).toISOString())}`}
              </a>
              {draft.posted.folded.length > 0 ? <span className={NOTE}>{`${draft.posted.folded.length} went into the summary`}</span> : null}
            </>
          ) : (
            <Button type="button" disabled={posting || (!ticked && summary.trim() === "")} onClick={() => void post()}>
              {START_WORDS.post}
            </Button>
          )}
        </div>
      </>
    );
  })();

  return (
    <section data-pr-section={head.toLowerCase()} data-pr-draft className="mt-8 flex flex-col gap-0.5">
      <span className={cn(GROUP_LABEL, "flex h-6 items-center px-2 text-muted-foreground")}>{head}</span>
      {body}
    </section>
  );
}
