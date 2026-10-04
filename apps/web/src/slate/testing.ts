// SPDX-License-Identifier: AGPL-3.0-only
// What the renderer's tests share: a schema 2 document from its parts, a fake link to the host, and a scheduler
// whose frames run when the test says.
import { vi } from "vitest";
import type { SlateDoc } from "@wsp/protocol";
import type { SlateLink } from "./actions.js";
import type { Scheduler } from "./engine.js";

/** Frames run only when the test says so, so a test can see what one frame redraws. */
export function manualScheduler(): Scheduler & { run(): void } {
  let queue: (() => void)[] = [];
  let clock = 1_000_000;
  return {
    frame: fn => {
      queue.push(fn);
      return () => (queue = queue.filter(f => f !== fn));
    },
    later: fn => {
      queue.push(fn);
      return () => (queue = queue.filter(f => f !== fn));
    },
    now: () => (clock += 1_000),
    run() {
      const now = queue;
      queue = [];
      for (const fn of now) fn();
    },
  };
}

/** A schema 2 document from its pieces and what it declares. */
export function slate(parts: Partial<SlateDoc> & Pick<SlateDoc, "root" | "pieces">): SlateDoc {
  return { schema: 2, values: {}, derived: {}, runs: {}, reactions: [], ...parts };
}


export function fakeLink(over: Partial<SlateLink> = {}): SlateLink {
  return {
    event: vi.fn(async () => ({ outcome: "started" })),
    writeState: vi.fn(async () => ({ version: 4 })),
    approve: vi.fn(async () => ({ ok: true })),
    cancel: vi.fn(async () => ({ ok: true })),
    consent: vi.fn(),
    fill: vi.fn(),
    ...over,
  };
}

