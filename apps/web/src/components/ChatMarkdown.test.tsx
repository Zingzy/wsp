// SPDX-License-Identifier: AGPL-3.0-only
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import ChatMarkdown, { orderedListGutterStyle } from "./ChatMarkdown";
import { getSyntaxHighlighterPromise } from "../lib/syntaxHighlighting";

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

describe("ChatMarkdown", () => {
  it("renders emphasis through the markdown pipeline", () => {
    const { container } = render(
      <ChatMarkdown text="Some **bold** text" cwd="/tmp/project" resolvedTheme="dark" />,
    );

    const strong = container.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong?.textContent).toBe("bold");
  });

  it("highlights a fenced code block once the highlighter resolves", async () => {
    // The highlighter resolves outside React's act scope; settle it inside one
    // so the Suspense retry commits before asserting.
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <ChatMarkdown
          text={"```ts\nconst answer: number = 42;\n```"}
          cwd="/tmp/project"
          resolvedTheme="dark"
        />,
      ));
    });
    expect(container.querySelector(".chat-markdown-codeblock")).not.toBeNull();
    await act(async () => {
      await getSyntaxHighlighterPromise("ts");
    });
    await waitFor(
      () => {
        const shiki = container.querySelector(".chat-markdown-shiki");
        expect(shiki).not.toBeNull();
        expect(shiki?.innerHTML).toContain('<span style="color:');
      },
      { timeout: 20_000 },
    );
  }, 30_000);

  it("opens external links in a new tab", () => {
    const { container } = render(
      <ChatMarkdown text="See [link](https://example.com)" cwd="/tmp/project" resolvedTheme="light" />,
    );

    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("https://example.com");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.textContent).toBe("link");
  });

  it("reports task list toggles with the marker offset", () => {
    const onTaskListChange = vi.fn();
    render(
      <ChatMarkdown
        text={"- [ ] first\n- [x] second"}
        cwd="/tmp/project"
        resolvedTheme="light"
        onTaskListChange={onTaskListChange}
      />,
    );

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    fireEvent.click(checkboxes[0]!);
    expect(onTaskListChange).toHaveBeenCalledWith({ markerOffset: 2, checked: true });
    fireEvent.click(checkboxes[1]!);
    expect(onTaskListChange).toHaveBeenCalledWith({ markerOffset: 14, checked: false });
  });

  it("turns single newlines into hard breaks when lineBreaks is set", () => {
    const { container: withBreaks } = render(
      <ChatMarkdown text={"line one\nline two"} cwd="/tmp/project" resolvedTheme="light" lineBreaks />,
    );
    const { container: withoutBreaks } = render(
      <ChatMarkdown text={"line one\nline two"} cwd="/tmp/project" resolvedTheme="light" />,
    );

    expect(withBreaks.querySelector("br")).not.toBeNull();
    expect(withoutBreaks.querySelector("br")).toBeNull();
  });

  it("renders a file link as a button that opens the file when a handler is given", () => {
    const onOpenFile = vi.fn();
    render(
      <ChatMarkdown
        text="[Source](/tmp/project/src/main.ts#L12)"
        cwd="/tmp/project"
        resolvedTheme="light"
        onOpenFile={onOpenFile}
      />,
    );

    const chip = screen.getByRole("button", { name: /main\.ts/ });
    fireEvent.click(chip);
    expect(onOpenFile).toHaveBeenCalledWith("src/main.ts", 12);
  });

  it("renders a file link as an inert chip without a handler", () => {
    const { container } = render(
      <ChatMarkdown
        text="[Source](/tmp/project/src/main.ts)"
        cwd="/tmp/project"
        resolvedTheme="light"
      />,
    );

    const chip = container.querySelector(".chat-markdown-file-link");
    expect(chip?.tagName).toBe("SPAN");
    expect(chip?.textContent).toContain("main.ts");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("orderedListGutterStyle", () => {
  it("leaves the default gutter alone for single-digit lists", () => {
    expect(orderedListGutterStyle(9, undefined)).toBeUndefined();
  });

  it("widens the gutter for two-digit lists", () => {
    expect(orderedListGutterStyle(99, undefined)).toEqual({ "--list-gutter": "3ch" });
  });

  it("uses the widest marker and includes a negative start's minus sign", () => {
    expect(orderedListGutterStyle(1001, -1000)).toEqual({ "--list-gutter": "6ch" });
    expect(orderedListGutterStyle(3, -15)).toEqual({ "--list-gutter": "4ch" });
  });
});
