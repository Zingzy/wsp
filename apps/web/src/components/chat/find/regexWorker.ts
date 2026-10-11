// SPDX-License-Identifier: AGPL-3.0-only
// Runs a find in thread pattern off the page: a pattern like (a+)+$ can run for minutes on one line, and only a
// worker can be stopped from outside while it does.
import { needleOf } from "./match";
import { searchDocs } from "./search";
import type { RegexAsk, RegexReply } from "./regex";
import type { FindDoc } from "./text";

/** The worker's own scope, which the page's DOM types do not describe. */
const scope = self as unknown as { onmessage: ((event: MessageEvent<RegexAsk>) => void) | null; postMessage(reply: RegexReply): void };

let docs: ReadonlyArray<FindDoc> = [];

scope.onmessage = event => {
  const ask = event.data;
  if (ask.docs !== undefined) docs = ask.docs;
  const needle = needleOf(ask.query, { ...ask.options, regex: true });
  const reply: RegexReply =
    needle === null ? { id: ask.id, result: { matches: [], capped: false } } : "invalid" in needle ? { id: ask.id, invalid: needle.invalid } : { id: ask.id, result: searchDocs(docs, needle, ask.tools, ask.at) };
  scope.postMessage(reply);
};
