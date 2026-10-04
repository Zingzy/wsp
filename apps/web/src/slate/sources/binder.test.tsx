// SPDX-License-Identifier: AGPL-3.0-only
// The window's sources against a fake store and host: pr, git and cost off the workspace's status, usage off the
// account rows with the host naming the account, the turn figures through slates.resolve, the clock ticking only
// while time.now is drawn, and host holds taken while bound and given back after.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountRow, SessionView, SlateDoc, SlateJson, WorkspaceStatus } from "@wsp/protocol";
import { ActionRunner, StateSender } from "../actions";
import { fakeLink, slate, startsOf } from "../testing";
import { SlateEngine, type Scheduler } from "../engine";
import { SLATE_VIEWS } from "../pieces";
import { SlateView } from "../SlateView";
import type { SlateApi } from "../wire";
import { bindSources } from "./binder";
import type { AppState } from "./source";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const immediate: Scheduler = {
  frame: fn => {
    const id = setTimeout(fn, 0);
    return () => clearTimeout(id);
  },
  later: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
  now: () => Date.now(),
};

const ROW = { id: "s1", workspaceId: "ws", harness: "claude", status: "completed", threadId: "t1", costUsd: 0.5, model: "opus" } as SessionView;
const ACCOUNT: AccountRow = { key: "acct-1", agent: "claude", label: "zingzy", computers: ["mac"], plan: "Max", windows: [{ kind: "week", usedPercent: 46, resetsAt: 1 }] };

function fakeApp(over: Partial<AppState> = {}) {
  let state = {
    sessions: { ws: [ROW] },
    statuses: {
      ws: {
        id: "ws",
        checkout: { branch: "feat/login", ahead: 2, behind: 0, changed: 3, readAt: 1 },
        pr: { number: 7, url: "https://github.com/o/r/pull/7", state: "open", host: "github.com", draft: false, base: "main", branch: "feat/login", headOid: "abc", headSubject: "Fix login", mergeable: "mergeable", mergeState: "clean", review: "none", checks: [{ name: "lint", state: "pending" }], additions: 1, deletions: 2, changedFiles: 1, commits: 1, readAt: 1 },
      } as unknown as WorkspaceStatus,
    },
    costs: { ws: { rateUsdPerHour: 0, accruedUsd: 1.25, at: "" } },
    usageAccounts: null as Record<string, AccountRow> | null,
    loadUsageAccounts: vi.fn(),
    ...over,
  } as unknown as AppState;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<AppState>) {
      state = { ...state, ...patch } as AppState;
      for (const l of listeners) l();
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

function fakeHost(values: Record<string, SlateJson>): SlateApi {
  return {
    get: vi.fn(),
    state: vi.fn(),
    event: vi.fn(),
    shown: vi.fn(),
    undo: vi.fn(),
    clear: vi.fn(),
    subscribe: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
    resolve: vi.fn(async (_t: string, paths: readonly string[]) => Object.fromEntries(paths.map(p => [p, values[p] ?? null]))),
  } as unknown as SlateApi;
}

function drawBound(doc: SlateDoc, app: ReturnType<typeof fakeApp>, api: SlateApi) {
  const engine = new SlateEngine("t1", () => undefined, immediate);
  engine.setRecord(doc, startsOf(doc), 1);
  const link = fakeLink();
  const sender = new StateSender(engine, () => link);
  const unbind = bindSources(engine, "t1", {
    app: app.get,
    subscribeApp: app.subscribe,
    slates: () => ({ lastTurn: {}, record: null }),
    subscribeSlates: () => () => {},
    api: () => api,
  });
  const view = render(<SlateView engine={engine} views={SLATE_VIEWS} runner={new ActionRunner(engine, () => link)} sender={sender} />);
  return { engine, unbind, view };
}

const text = (id: string, format: string) => ({ [id]: { type: "text", props: { value: { format } } } });

describe("the window's sources", () => {
  it("reads pr, git, cost and the thread off the store, and holds pr and git on the host while drawn", async () => {
    const app = fakeApp();
    const api = fakeHost({});
    const doc = slate({
      root: "root",
      pieces: {
        root: { type: "column", children: ["a", "b", "c", "d"] },
        ...text("a", "#${pr.number} ${pr.word}, ${len(pr.checks)} check"),
        ...text("b", "on ${git.branch}, ${git.changed} changed"),
        ...text("c", "spent ${cost.accruedUsd} and ${thread.cost.usd} by ${thread.agent}"),
        ...text("d", "state ${pr.checks[0].state}"),
      },
    });
    const { unbind } = drawBound(doc, app, api);
    expect(await screen.findByText("#7 checks running, 1 check")).toBeTruthy();
    expect(screen.getByText("on feat/login, 3 changed")).toBeTruthy();
    expect(screen.getByText("spent 1.25 and 0.5 by claude")).toBeTruthy();
    await act(async () => {});
    expect(api.subscribe).toHaveBeenCalledWith("t1", expect.arrayContaining(["pr", "git"]));
    // A status push moves the pull request: the pieces reading pr redraw.
    const statuses = app.get().statuses;
    act(() => app.set({ statuses: { ws: { ...statuses["ws"]!, pr: { ...(statuses["ws"]!.pr as object), checks: [{ name: "lint", state: "pass" }] } } as WorkspaceStatus } }));
    expect(await screen.findByText("state pass")).toBeTruthy();
    unbind();
    await act(async () => {});
    expect(api.unsubscribe).toHaveBeenCalledWith("t1", expect.arrayContaining(["pr", "git"]));
  });

  it("says pr.number is null while the workspace has no pull request", async () => {
    const app = fakeApp();
    const statuses = app.get().statuses;
    app.set({ statuses: { ws: { ...statuses["ws"]!, pr: undefined } as WorkspaceStatus } });
    const doc = slate({ root: "none", pieces: { none: { type: "empty", props: { title: "No pull request yet" }, when: "pr.number == null" } } });
    drawBound(doc, app, fakeHost({}));
    expect(await screen.findByText("No pull request yet")).toBeTruthy();
  });

  it("asks the host for the turn figures and draws them as they come", async () => {
    const api = fakeHost({ "thread.context.used": 164_000, "thread.context.window": 1_000_000 });
    const doc = slate({ root: "m", pieces: { m: { type: "meter", props: { label: "Context", value: { bind: "thread.context.used" }, max: { bind: "thread.context.window" }, format: "tokens" } } } });
    drawBound(doc, fakeApp(), api);
    expect(screen.getByText("not read yet")).toBeTruthy();
    await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
    expect(api.resolve).toHaveBeenCalledWith("t1", expect.arrayContaining(["thread.context.used", "thread.context.window"]));
    expect(screen.getByRole("meter", { name: "Context" }).getAttribute("aria-valuenow")).toBe("164000");
  });

  it("reads usage off the account the host names, and moves with a usage.account push", async () => {
    const app = fakeApp();
    const api = fakeHost({ "usage.account.key": "acct-1" });
    const doc = slate({ root: "w", pieces: { w: { type: "meter", props: { label: "Weekly", value: { bind: "usage.week.percent" } } } } });
    drawBound(doc, app, api);
    await act(async () => {});
    expect(app.get().loadUsageAccounts).toHaveBeenCalled();
    act(() => app.set({ usageAccounts: { "acct-1": ACCOUNT } }));
    await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
    expect(screen.getByRole("meter", { name: "Weekly" }).getAttribute("aria-valuenow")).toBe("46");
    act(() => app.set({ usageAccounts: { "acct-1": { ...ACCOUNT, windows: [{ kind: "week", usedPercent: 52 }] } } }));
    await act(async () => new Promise(resolve => setTimeout(resolve, 150)));
    expect(screen.getByRole("meter", { name: "Weekly" }).getAttribute("aria-valuenow")).toBe("52");
  });

  it("ticks the clock once a second only while a drawn piece reads time.now", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-04T09:00:00Z"));
    const doc = slate({ root: "t", pieces: { t: { type: "text", props: { value: { bind: "time.now" } } } } });
    drawBound(doc, fakeApp(), fakeHost({}));
    await act(async () => {});
    const first = Number(screen.getByText(/^\d+$/).textContent);
    await act(async () => vi.advanceTimersByTime(1_100));
    const second = Number(screen.getByText(/^\d+$/).textContent);
    expect(second - first).toBeGreaterThanOrEqual(1_000);
  });
});
