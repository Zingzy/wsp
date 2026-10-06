// SPDX-License-Identifier: AGPL-3.0-only
// The slate's code loads on a thread's first use of a slate or at start where one is stored, and a host with none
// never loads it: the thread's own turns, rewinds and deletes pass it by.
import { afterEach, describe, expect, it, vi } from "vitest";
import { lazySlates, SLATES } from "../src/lazy-slates.js";
import type { Slates, SlatesDeps } from "../src/slates.js";
import { memoryStore } from "../src/store.js";

const created = vi.hoisted(() => [] as { calls: string[]; subscribed: string[][] }[]);
vi.mock("../src/slates.js", () => ({
  createSlates: (): Partial<Slates> => {
    const real = { calls: [] as string[], subscribed: [] as string[][] };
    created.push(real);
    const call = (name: string) => async () => void real.calls.push(name);
    return {
      ready: call("ready"),
      turnEnded: call("turnEnded"),
      forget: call("forget"),
      get: async () => null,
      write: async () => (real.calls.push("write"), { version: 1, sketch: "" }) as never,
      subscribe: p => {
        real.subscribed.push(p.sources);
        return () => void (real.subscribed = real.subscribed.filter(s => s !== p.sources));
      },
    };
  },
}));

afterEach(() => void created.splice(0));

const depsOver = (store = memoryStore()): SlatesDeps => ({ store }) as unknown as SlatesDeps;

describe("the slate's code", () => {
  it("is not loaded by a host with no slate, whatever its threads do", async () => {
    const slates = lazySlates(depsOver());
    await slates.ready();
    expect(await slates.get("t1")).toBeNull();
    await slates.turnEnded({ threadId: "t1", turnId: "u1" });
    await slates.rewound({ threadId: "t1", turnId: "u1", cut: [] });
    await slates.forget("t1");
    expect(slates.watchesPr("w1")).toBe(false);
    await slates.settled();
    slates.close();
    expect(created).toEqual([]);
  });

  it("loads at start where a slate is stored, so its timed runs recover then", async () => {
    const store = memoryStore();
    await store.put(SLATES, "t1", { schema: 2, threadId: "t1" });
    await lazySlates(depsOver(store)).ready();
    expect(created.map(r => r.calls)).toEqual([["ready"]]);
  });

  it("loads on a thread's first write, once, and then follows the thread's turns", async () => {
    const slates = lazySlates(depsOver());
    await slates.ready();
    await Promise.all([slates.write({ threadId: "t1", text: "<slate/>" }), slates.write({ threadId: "t1", text: "<slate/>" })]);
    await slates.turnEnded({ threadId: "t1", turnId: "u1" });
    expect(created.map(r => r.calls)).toEqual([["write", "write", "turnEnded"]]);
  });

  it("holds a window's sources once it loads, unless the window let go first", async () => {
    const slates = lazySlates(depsOver());
    const kept = slates.subscribe({ threadId: "t1", sources: ["usage"] });
    slates.subscribe({ threadId: "t1", sources: ["pr"] })();
    await vi.waitFor(() => expect(created[0]?.subscribed).toEqual([["usage"]]));
    kept();
    expect(created[0]!.subscribed).toEqual([]);
  });
});
