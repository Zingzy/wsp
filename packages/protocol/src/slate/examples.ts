// SPDX-License-Identifier: AGPL-3.0-only
// The appendix slates this build can hold, in the shorthand an agent writes: G whole, and B and a tracker cut to the
// core pieces and sources (no pipes, no checklist, no open or pane action). The catalog serves them and the tests
// hold them to their stored forms.
export const PR_LINES = `slate 1 "Pull request"

root: column
  none: empty title="No pull request yet" body="This thread's branch has no pull request." when={pr.number == null}
  head: facts when={pr.number != null}
    - fact label="State" value={pr.word}
    - fact label="Review" value={pr.review}
    - fact label="Mergeable" value={pr.mergeable} tone={pr.mergeable == 'mergeable' ? 'good' : (pr.mergeable == 'conflicting' ? 'warning' : 'muted')}
  checks: table items={pr.checks} key={item.name} empty="No checks yet" when={pr.number != null}
    - col title="Check" value={item.name}
    - col title="State" value={item.state} tone={item.state == 'fail' ? 'bad' : (item.state == 'pass' ? 'good' : 'muted')}
    - col title="Took" value={item.completedAt ? duration(num(item.completedAt) - num(item.startedAt)) : 'running'} mono align=end
    - action label="Send to agent" when={item.state == 'fail'}
      @press send text="A check failed. Read its log and fix it." with=[item.name, item.link]
  summary: text value=\`\${plural(len(pr.checks), 'check')}, \${pr.additions} added, \${pr.deletions} removed\` muted when={pr.number != null}
  fix: button label="Fix the failing checks" primary when={contains(pluck(pr.checks, 'state'), 'fail')}
    @press send text="Fix the failing checks on the slate." with=[pr.checks]
`;

export const USAGE_LINES = `slate 1 "Usage"

root: column
  who: text value=\`\${usage.account.label} on \${usage.account.plan}\` muted small when={exists(usage.account.plan)}
  context: section title="Context"
    context-head: row between
      used: text value=\`\${pct(thread.context.percent)} used\` tone={thread.context.percent > 80 ? 'warning' : 'default'} placeholder="No turn has run yet."
      free: text value=\`\${tokens(thread.context.free)} free of \${tokens(thread.context.window)}\` muted mono
    context-bar: meter label="This thread" value={thread.context.used} max={thread.context.window} tokens
  limits: column tight
    session: meter label="5 hour" value={usage.session.percent} tone={usage.session.percent > 80 ? 'warning' : 'default'} note=\`resets \${until(usage.session.resetsAt)}\`
    week: meter label="Weekly" value={usage.week.percent} tone={usage.week.percent > 80 ? 'warning' : 'default'} note=\`resets \${until(usage.week.resetsAt)}, \${weekday(usage.week.resetsAt)}\`
  why: text value={usage.note} muted small when={exists(usage.note)}
`;

export const TRACKER_LINES = `slate 1 "Cart rounding fix"

state.done = 2
state.note = ""
state.total = 4

root: column
  progress: meter label="Steps" value={state.done} max={state.total} fraction note=\`\${state.done} of \${state.total} done\`
  changes: section title="Files changed" collapsible
    files: table items={thread.changes.files} key={item.path} empty="Nothing changed yet"
      - col title="File" value={item.path} mono
      - col title="Added" value={item.additions} tone=good align=end
      - col title="Removed" value={item.deletions} tone=bad align=end
  note: input label="Note for the agent" value={state.note} lines=3 placeholder="Anything to add?"
    @submit send text="A note from the slate." with=[state.note]
  next: button label="Go on to the next step" when={state.done < state.total and thread.status != 'working'}
    @press send text="Go on to the next unchecked step on the slate." with=[state.done]
    @press set path=state.note value=""
  intro: markdown
    | **The event ring.** The host keeps the last 5,000 events in one ring.
    |
    | A window that reconnects asks for events after the cursor it last saw.
`;

export const SLATE_EXAMPLES: Readonly<Record<string, string>> = { pr: PR_LINES, usage: USAGE_LINES, tracker: TRACKER_LINES };
