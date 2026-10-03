// SPDX-License-Identifier: AGPL-3.0-only
// The renderer and the protocol's catalog hold the same piece types, and the spec's own examples, written as the
// agent writes them and compiled by the protocol's compiler, draw with live values.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileSlate, SLATE_PIECES, type SlateJson } from "@wsp/protocol";
import { ActionRunner, StateSender, type SlateLink } from "./actions";
import { SlateEngine } from "./engine";
import { SLATE_VIEWS } from "./pieces";
import { SlateView } from "./SlateView";

afterEach(cleanup);

function drawLines(lines: string, values: Record<string, SlateJson>) {
  const compiled = compileSlate(lines);
  expect(compiled.errors).toEqual([]);
  const engine = new SlateEngine("t1", path => values[path]);
  engine.setRecord(compiled.document!, compiled.document!.state ?? {}, 1);
  const link: SlateLink = { act: vi.fn(async () => ({ outcome: "started" })), writeState: vi.fn(async () => ({})), fill: vi.fn() };
  const sender = new StateSender(engine, () => link);
  render(<SlateView engine={engine} views={SLATE_VIEWS} runner={new ActionRunner(engine, () => link, sender)} sender={sender} />);
  return { engine, link };
}

describe("compiled slates", () => {
  it("has a view for every piece type the catalog registers, and no other", () => {
    expect(Object.keys(SLATE_VIEWS).sort()).toEqual(Object.keys(SLATE_PIECES).sort());
  });

  it("draws appendix B, the pull request and its checks, cut to the core pieces", async () => {
    const { link } = drawLines(
      `slate 1 "Pull request"

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
  fix: button label="Fix the failing check" primary when={pr.number != null}
    @press send text="A check failed. Read its log and fix it." with=[pr.checks]
`,
      {
        "pr.number": 7,
        "pr.word": "checks failed",
        "pr.review": "none",
        "pr.mergeable": "mergeable",
        "pr.checks": [
          { name: "build", state: "pass", startedAt: "2026-10-04T09:00:00Z", completedAt: "2026-10-04T09:01:04Z" },
          { name: "lint", state: "fail", startedAt: "2026-10-04T09:00:00Z", completedAt: "2026-10-04T09:00:20Z" },
          { name: "test", state: "pending", startedAt: "2026-10-04T09:00:00Z", completedAt: null },
        ],
      },
    );
    expect(screen.queryByText("No pull request yet")).toBeNull();
    expect(screen.getByText("checks failed")).toBeTruthy();
    expect(screen.getByText("mergeable").className).toContain("text-success");
    expect(screen.getByText("lint").closest("tr")?.textContent).toContain("fail");
    expect(screen.getByText("fail").className).toContain("text-error-foreground");
    expect(screen.getByText("test").closest("tr")?.textContent).toContain("running");
    await act(async () => screen.getByRole("button", { name: "Fix the failing check" }).click());
    expect(link.act).toHaveBeenCalledWith(expect.objectContaining({ piece: "fix", event: "press", action: 0, version: 1 }));
  });

  it("draws appendix G, the usage view, from sources that exist", () => {
    const now = Date.now();
    drawLines(
      `slate 1 "Usage"

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
`,
      {
        "usage.account.label": "zingzy",
        "usage.account.plan": "Max",
        "thread.context.percent": 16.4,
        "thread.context.used": 164_000,
        "thread.context.window": 1_000_000,
        "thread.context.free": 836_000,
        "usage.session.percent": 85,
        "usage.session.resetsAt": now + 3 * 3_600_000,
        "usage.week.percent": 46,
        "usage.week.resetsAt": now + 3 * 86_400_000,
        "usage.note": null,
      },
    );
    expect(screen.getByText("zingzy on Max")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Context" })).toBeTruthy();
    expect(screen.getByRole("meter", { name: "This thread" }).textContent).toContain("164k");
    expect(screen.getByRole("meter", { name: "Weekly" }).getAttribute("aria-valuenow")).toBe("46");
    expect(screen.getByRole("meter", { name: "5 hour" }).querySelector("[data-slate-fill]")?.className).toContain("bg-warning");
    expect(screen.getByRole("meter", { name: "5 hour" }).textContent).toMatch(/resets in /);
  });
});
