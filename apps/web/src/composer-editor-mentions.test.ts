// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  hostItemText,
  quoteText,
  serializeComposerMention,
  splitPromptIntoComposerSegments,
  terminalExcerptText,
} from "./composer-editor-mentions";

const kinds = (prompt: string) => splitPromptIntoComposerSegments(prompt).map(segment => segment.type);

describe("the wire forms the composer's chips are sent as", () => {
  it("sends a file as @path, quoted where the path has a space", () => {
    expect(serializeComposerMention("apps/web/src/composer-logic.ts")).toBe("@apps/web/src/composer-logic.ts");
    expect(serializeComposerMention("docs/read me.md")).toBe('@"docs/read me.md"');
  });

  it("sends a terminal excerpt as a fenced block under one header line, the fence outrunning any in the text", () => {
    expect(terminalExcerptText({ label: "Terminal 1", text: "$ ls\na.ts" })).toBe("Terminal output from Terminal 1:\n```\n$ ls\na.ts\n```");
    expect(terminalExcerptText({ label: "Terminal 2", text: "```js\nx\n```" })).toBe("Terminal output from Terminal 2:\n````\n```js\nx\n```\n````");
  });

  it("sends a quote as a Markdown blockquote under the prompt the reply answered", () => {
    expect(quoteText({ replyTo: "fix the login", text: "Safari drops the cookie.\n\nThen it logs out." })).toBe(
      'Quoting your reply to "fix the login":\n> Safari drops the cookie.\n>\n> Then it logs out.',
    );
    expect(quoteText({ replyTo: null, text: "one line" })).toBe("Quoting your reply:\n> one line");
  });

  it("sends a pull request or an issue as its title and url with its body quoted under them", () => {
    expect(hostItemText({ kind: "pull-request", number: 42, title: "Login breaks on Safari", body: "Safari drops the cookie.", url: "https://github.com/o/r/pull/42" })).toBe(
      'Pull request #42 "Login breaks on Safari" (https://github.com/o/r/pull/42):\n> Safari drops the cookie.',
    );
    expect(hostItemText({ kind: "issue", number: 7, title: "Add dark mode", body: "", url: "https://github.com/o/r/issues/7" })).toBe(
      'Issue #7 "Add dark mode" (https://github.com/o/r/issues/7):\n> (no description)',
    );
  });
});

describe("splitPromptIntoComposerSegments", () => {
  it("reads every chip back out of the text it was sent as", () => {
    const prompt = [
      `summarise ${serializeComposerMention("src/a.ts")} with $unslop please`,
      terminalExcerptText({ label: "Terminal 1", text: "ok" }),
      quoteText({ replyTo: "go", text: "done" }),
      hostItemText({ kind: "issue", number: 7, title: "t", body: "b", url: "u" }),
      "and that is all",
    ].join("\n");
    expect(kinds(prompt)).toEqual(["text", "mention", "text", "skill", "text", "terminal", "text", "citation", "text", "citation", "text"]);
    const segments = splitPromptIntoComposerSegments(prompt);
    expect(segments.map(segment => (segment.type === "text" ? segment.text : segment.source)).join("")).toBe(prompt);
    expect(segments[1]).toMatchObject({ type: "mention", path: "src/a.ts" });
    expect(segments[5]).toMatchObject({ type: "terminal", label: "Terminal 1", text: "ok" });
    expect(segments[7]).toMatchObject({ type: "citation", kind: "quote", title: "go", body: "done" });
    expect(segments[9]).toMatchObject({ type: "citation", kind: "issue", number: 7, title: "t", body: "b", url: "u" });
  });

  it("leaves a token still being typed, and a header with no block under it, as text", () => {
    expect(kinds("look at @src/a.ts")).toEqual(["text"]);
    expect(kinds("run $unslop")).toEqual(["text"]);
    expect(kinds("Terminal output from Terminal 1:\nnot fenced")).toEqual(["text"]);
    expect(kinds("Quoting your reply:\nno quote")).toEqual(["text"]);
    expect(kinds("mid-line Pull request #4 \"t\" (u):\n> b")).toEqual(["text"]);
  });

  it("reads a quoted path with a space back whole", () => {
    const segments = splitPromptIntoComposerSegments(`${serializeComposerMention("docs/read me.md")} next`);
    expect(segments[0]).toMatchObject({ type: "mention", path: "docs/read me.md" });
  });
});
