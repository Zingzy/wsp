// SPDX-License-Identifier: AGPL-3.0-only
// Find in thread's model: what each row kind gives the search, by default and with Include tool calls on, on a
// Claude Code thread and a Codex thread; the options and the cap; and the regex worker's limit.
import { describe, expect, it, vi } from "vitest";
import { deriveSession } from "../src/adapt/index.js";
import { MATCH_CAP, needleOf, spansIn, type FindOptions, type Needle } from "../src/components/chat/find/match.js";
import { regexSearch, REGEX_LIMIT_MS, type RegexAsk, type RegexReply, type WorkerLike } from "../src/components/chat/find/regex.js";
import { searchDocs } from "../src/components/chat/find/search.js";
import { docOf, FindTextCache, markdownSegments, parsedSegments, type FindDoc } from "../src/components/chat/find/text.js";
import { FIND_WORDS } from "../src/components/chat/find/words.js";
import { claudeThread, codexThread } from "./fixtures/find-threads.js";

const PLAIN: FindOptions = { matchCase: false, wholeWord: false, regex: false };

const docsOf = (events: ReturnType<typeof claudeThread>): FindDoc[] => {
  const cache = new FindTextCache();
  return deriveSession(events).timeline.flatMap(entry => docOf(entry, "/w", cache) ?? []);
};
const needle = (query: string, o: Partial<FindOptions> = {}): Needle => needleOf(query, { ...PLAIN, ...o }) as Needle;
const count = (docs: FindDoc[], query: string, tools: boolean, o: Partial<FindOptions> = {}): number => searchDocs(docs, needle(query, o), tools).matches.length;

describe("find in thread: what each row gives the search", () => {
  const claude = docsOf(claudeThread());
  const codex = docsOf(codexThread());

  it.each([
    ["the person's message", "promptword"],
    ["a reply folded in a settled turn", "commentword"],
    ["the proposed plan", "planword"],
    ["a subagent's own words", "subword"],
    ["a reply's bold text", "boldword"],
    ["a reply's link text", "linkword"],
    ["a reply's code fence", "fenceword"],
    ["a long message the bubble clamps", "longword"],
  ])("Claude Code: %s is searched by default", (_kind, word) => {
    expect(count(claude, word, false)).toBe(1);
  });

  it.each([
    ["the Bash description", "descword"],
    ["the command", "cmdword"],
    ["the path an edit touched", "pathword"],
    ["the output's first line", "outword"],
    ["the Thinking row", "thinkword"],
    ["a subagent's tool line", "subtoolword"],
  ])("Claude Code: %s is searched only with Include tool calls", (_kind, word) => {
    expect(count(claude, word, false)).toBe(0);
    expect(count(claude, word, true)).toBeGreaterThan(0);
  });

  it("Claude Code: output past its first line and a link's address are never searched", () => {
    expect(count(claude, "hiddenword", true)).toBe(0);
    expect(count(claude, "example.com", true)).toBe(0);
  });

  it("Claude Code: a diagram and math count nothing, and the markdown marks are not text", () => {
    expect(count(claude, "mermaidword", true)).toBe(0);
    expect(count(claude, "mathword", true)).toBe(0);
    expect(count(claude, "**", true)).toBe(0);
    expect(count(claude, "```", true)).toBe(0);
    expect(count(claude, "replyword", false)).toBe(3);
  });

  it.each([
    ["the person's message", "cxprompt"],
    ["the reply", "cxreply"],
    ["a subagent's own words", "cxsub"],
  ])("Codex: %s is searched by default", (_kind, word) => {
    expect(count(codex, word, false)).toBeGreaterThan(0);
  });

  it.each([
    ["the command", "cxcmd"],
    ["the path a file change touched", "cxpath"],
    ["the output's first line", "cxout"],
    ["the reasoning row", "cxthink"],
  ])("Codex: %s is searched only with Include tool calls", (_kind, word) => {
    expect(count(codex, word, false)).toBe(0);
    expect(count(codex, word, true)).toBeGreaterThan(0);
  });

  it("Codex: output past its first line is never searched", () => {
    expect(count(codex, "cxhidden", true)).toBe(0);
  });
});

describe("find in thread: the reading of markdown", () => {
  it("reads a reply's bold, link and fence as the page shows them, a segment per block", () => {
    expect(markdownSegments("**bold** and [a link](https://x.y/z)\n\n```ts\nconst a = 1;\n```\n\n- one\n- two", { breaks: false, rawHtml: true, cwd: "/w" })).toEqual([
      "bold and a link",
      "const a = 1;",
      "one",
      "two",
    ]);
  });

  it("reads a file chip as it shows: its name, the folder that tells two of one name apart, and its line", () => {
    const reply = "Changed `src/auth/session.ts`, [the store](src/links/store.ts) and `src/api/session.ts:12`.";
    expect(markdownSegments(reply, { breaks: false, rawHtml: true, cwd: "/w" })).toEqual(["Changed session.ts src/auth, store.ts and session.ts src/api L12."]);
  });

  it("reads a reply cut at its insight block as the row draws it, without the block's star and dashes", () => {
    const reply = "Before.\n\n`★ Insight ─────────`\nThe aside.\n`─────────`\n\nAfter.";
    expect(markdownSegments(reply, { breaks: false, rawHtml: true, cwd: undefined, reply: { streaming: false } })).toEqual(["Before.", "The aside.", "After."]);
  });

  it.each(["one line", "two\nlines", "a paragraph\n\nand another", "  indented by two\nnext", "what? yes, fine.", "trailing space \nnext line"])(
    "reads plain text %j the way the parser does, with breaks on and off",
    text => {
      for (const breaks of [true, false]) expect(markdownSegments(text, { breaks, rawHtml: false, cwd: undefined })).toEqual(parsedSegments(text, { breaks, rawHtml: false, cwd: undefined }).filter(s => s.trim().length > 0));
    },
  );
});

describe("find in thread: the options and the cap", () => {
  const docs: FindDoc[] = [{ entryId: "e", parts: [{ part: 0, segments: ["Refresh the refresh_token, refreshed refresh."], tool: false }] }];

  it("ignores case unless Match case is on", () => {
    expect(count(docs, "refresh", false)).toBe(4);
    expect(count(docs, "Refresh", false, { matchCase: true })).toBe(1);
  });

  it("matches whole words with Match whole word", () => {
    expect(count(docs, "refresh", false, { wholeWord: true })).toBe(2);
  });

  it("matches a pattern with Use regular expression, and refuses one that does not parse", () => {
    expect(count(docs, "refresh\\w*", false, { regex: true })).toBe(4);
    expect(needleOf("(a", { ...PLAIN, regex: true })).toHaveProperty("invalid");
  });

  it("stops counting at 9,999 and says so", () => {
    const many: FindDoc[] = [{ entryId: "e", parts: [{ part: 0, segments: ["a ".repeat(MATCH_CAP + 50)], tool: false }] }];
    const result = searchDocs(many, needle("a"), false);
    expect(result.matches).toHaveLength(MATCH_CAP);
    expect(result.capped).toBe(true);
    expect(FIND_WORDS.count(MATCH_CAP, MATCH_CAP, result.capped)).toBe("9,999 of 9,999+");
  });

  it("keeps the matches nearest the reader when the count passes the cap, walking out from where they read", () => {
    const docs: FindDoc[] = Array.from({ length: 10 }, (_, i) => ({ entryId: `e${i}`, parts: [{ part: 0, segments: ["a a"], tool: false }] }));
    const named = (result: ReturnType<typeof searchDocs>) => result.matches.map(m => `${m.entryId}:${m.ordinal}`);
    const atEnd = searchDocs(docs, needle("a"), false, { cap: 4 });
    expect(atEnd.capped).toBe(true);
    expect(named(atEnd)).toEqual(["e8:0", "e8:1", "e9:0", "e9:1"]);
    // Read up to e4: what is above the reader comes before what is below.
    expect(named(searchDocs(docs, needle("a"), false, { cap: 4, anchor: 4 }))).toEqual(["e3:0", "e3:1", "e4:0", "e4:1"]);
    expect(named(searchDocs(docs, needle("a"), false, { cap: 5, anchor: 0 }))).toEqual(["e0:0", "e0:1", "e1:0", "e1:1", "e2:0"]);
    expect(searchDocs(docs, needle("a"), false, { cap: 20, anchor: 4 })).toMatchObject({ capped: false, matches: { length: 20 } });
  });

  it("names each match by its entry, part and place in the part, which is how the page finds it again", () => {
    const two: FindDoc[] = [{ entryId: "e", parts: [{ part: 0, segments: ["x y x"], tool: false }, { part: 1, segments: ["x"], tool: true }] }];
    expect(searchDocs(two, needle("x"), true).matches).toEqual([
      { entryId: "e", part: 0, ordinal: 0 },
      { entryId: "e", part: 0, ordinal: 1 },
      { entryId: "e", part: 1, ordinal: 0 },
    ]);
    expect(spansIn("x y x", needle("x"), 10)).toEqual([[0, 1], [4, 5]]);
  });
});

describe("find in thread: a pattern runs in a worker it can end", () => {
  /** A worker that answers with the search itself, or never, as a runaway pattern does. */
  const fakeWorker = (answers: boolean) => {
    const made: { ended: boolean; asks: RegexAsk[] }[] = [];
    const make = (): WorkerLike => {
      const record = { ended: false, asks: [] as RegexAsk[] };
      made.push(record);
      let docs: ReadonlyArray<FindDoc> = [];
      const worker: WorkerLike = {
        onmessage: null,
        postMessage(ask) {
          record.asks.push(ask);
          if (ask.docs !== undefined) docs = ask.docs;
          if (!answers) return;
          const found = needleOf(ask.query, { ...ask.options, regex: true }) as Needle;
          const reply: RegexReply = { id: ask.id, result: searchDocs(docs, found, ask.tools) };
          queueMicrotask(() => worker.onmessage?.({ data: reply } as MessageEvent<RegexReply>));
        },
        terminate() {
          record.ended = true;
        },
      };
      return worker;
    };
    return { make, made };
  };
  const docs: FindDoc[] = [{ entryId: "e", parts: [{ part: 0, segments: ["aaaa b aaaa"], tool: false }] }];

  it("answers a pattern's matches, sending the thread's text once while it is unchanged", async () => {
    const { make, made } = fakeWorker(true);
    const search = regexSearch(make);
    expect(await search.search(docs, "a+", { matchCase: false, wholeWord: false }, false)).toMatchObject({ result: { matches: [{ ordinal: 0 }, { ordinal: 1 }] } });
    await search.search(docs, "b", { matchCase: false, wholeWord: false }, false);
    expect(made[0]!.asks.map(a => a.docs !== undefined)).toEqual([true, false]);
    search.dispose();
  });

  it("ends a worker that runs past the limit and says the pattern was slow", async () => {
    vi.useFakeTimers();
    try {
      const { make, made } = fakeWorker(false);
      const search = regexSearch(make);
      const answer = search.search(docs, "(a+)+$", { matchCase: false, wholeWord: false }, false);
      vi.advanceTimersByTime(REGEX_LIMIT_MS);
      expect(await answer).toBe("slow");
      expect(made[0]!.ended).toBe(true);
      search.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
