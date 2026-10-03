// SPDX-License-Identifier: AGPL-3.0-only
// The stored forms the appendix examples compile to.
import type { Slate } from "../../src/index.js";

export { PR_LINES, TRACKER_LINES, USAGE_LINES } from "../../src/slate/examples.js";


export const USAGE_STORED: Slate = {
  schema: 1,
  title: "Usage",
  root: "root",
  pieces: {
    root: { type: "column", children: ["who", "context", "limits", "why"] },
    who: { type: "text", props: { value: { format: "${usage.account.label} on ${usage.account.plan}" }, tone: "muted", size: "small" }, when: "exists(usage.account.plan)" },
    context: { type: "section", props: { title: "Context" }, children: ["context-head", "context-bar"] },
    "context-head": { type: "row", props: { align: "between" }, children: ["used", "free"] },
    used: { type: "text", props: { value: { format: "${pct(thread.context.percent)} used" }, tone: { bind: "thread.context.percent > 80 ? 'warning' : 'default'" }, placeholder: "No turn has run yet." } },
    free: { type: "text", props: { value: { format: "${tokens(thread.context.free)} free of ${tokens(thread.context.window)}" }, tone: "muted", mono: true } },
    "context-bar": { type: "meter", props: { label: "This thread", value: { bind: "thread.context.used" }, max: { bind: "thread.context.window" }, format: "tokens" } },
    limits: { type: "column", props: { gap: "tight" }, children: ["session", "week"] },
    session: { type: "meter", props: { label: "5 hour", value: { bind: "usage.session.percent" }, tone: { bind: "usage.session.percent > 80 ? 'warning' : 'default'" }, note: { format: "resets ${until(usage.session.resetsAt)}" } } },
    week: { type: "meter", props: { label: "Weekly", value: { bind: "usage.week.percent" }, tone: { bind: "usage.week.percent > 80 ? 'warning' : 'default'" }, note: { format: "resets ${until(usage.week.resetsAt)}, ${weekday(usage.week.resetsAt)}" } } },
    why: { type: "text", props: { value: { bind: "usage.note" }, tone: "muted", size: "small" }, when: "exists(usage.note)" },
  },
};


export const PR_STORED: Slate = {
  schema: 1,
  title: "Pull request",
  root: "root",
  pieces: {
    root: { type: "column", children: ["none", "head", "checks", "summary", "fix"] },
    none: { type: "empty", props: { title: "No pull request yet", body: "This thread's branch has no pull request." }, when: "pr.number == null" },
    head: {
      type: "facts", when: "pr.number != null",
      props: { facts: [
        { label: "State", value: { bind: "pr.word" } },
        { label: "Review", value: { bind: "pr.review" } },
        { label: "Mergeable", value: { bind: "pr.mergeable" }, tone: { bind: "pr.mergeable == 'mergeable' ? 'good' : (pr.mergeable == 'conflicting' ? 'warning' : 'muted')" } },
      ] },
    },
    checks: {
      type: "table", when: "pr.number != null",
      props: {
        items: { bind: "pr.checks" }, key: { bind: "item.name" }, empty: "No checks yet",
        columns: [
          { title: "Check", value: { bind: "item.name" } },
          { title: "State", value: { bind: "item.state" }, tone: { bind: "item.state == 'fail' ? 'bad' : (item.state == 'pass' ? 'good' : 'muted')" } },
          { title: "Took", value: { bind: "item.completedAt ? duration(num(item.completedAt) - num(item.startedAt)) : 'running'" }, mono: true, align: "end" },
        ],
        rowActions: [
          { label: "Send to agent", when: "item.state == 'fail'", on: { press: { do: "send", text: "A check failed. Read its log and fix it.", with: ["item.name", "item.link"] } } },
        ],
      },
    },
    summary: { type: "text", props: { value: { format: "${plural(len(pr.checks), 'check')}, ${pr.additions} added, ${pr.deletions} removed" }, tone: "muted" }, when: "pr.number != null" },
    fix: {
      type: "button", props: { label: "Fix the failing checks", variant: "primary" }, when: "contains(pluck(pr.checks, 'state'), 'fail')",
      on: { press: { do: "send", text: "Fix the failing checks on the slate.", with: ["pr.checks"] } },
    },
  },
};

