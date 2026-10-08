// SPDX-License-Identifier: AGPL-3.0-only
// A loopback link in a reply on a thread in a folder on a computer the person
// joined names that computer's port: clicking it opens that port and path in a
// Browser tab of the thread, which forwards the port while it shows it.
// Anywhere else the link opens as it is.
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChatMarkdown from "../src/components/ChatMarkdown.js";
import { LoopbackLinks, openInBrowser } from "../src/browser/loopbackLinks.js";
import type { Address } from "../src/browser/url.js";

afterEach(cleanup);

/** The reply's anchor to that address, once the markdown has drawn it. */
const linkTo = (href: string): Promise<HTMLAnchorElement> => vi.waitFor(() => document.querySelector<HTMLAnchorElement>(`a[href="${href}"]`) ?? Promise.reject(new Error(`no link to ${href}`)));

describe("a loopback link in a reply", () => {
  it("on a folder on a joined computer opens its port and path in a Browser tab", async () => {
    const opened: Address[] = [];
    render(
      <LoopbackLinks value={openInBrowser(at => opened.push(at))}>
        <ChatMarkdown text={"Up at [the app](http://localhost:8080/app?x=1) and [the docs](https://example.com/docs)."} cwd={undefined} resolvedTheme="dark" />
      </LoopbackLinks>,
    );
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(await linkTo("http://localhost:8080/app?x=1"), click);
    expect(click.defaultPrevented).toBe(true);
    expect(opened).toEqual([{ port: 8080, path: "/app?x=1" }]);
    // A link to the web opens as it is.
    const docs = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(await linkTo("https://example.com/docs"), docs);
    expect(docs.defaultPrevented).toBe(false);
    expect(opened).toHaveLength(1);
  });

  it("anywhere else opens as it is", async () => {
    render(<ChatMarkdown text={"[the app](http://localhost:8080/)"} cwd={undefined} resolvedTheme="dark" />);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(await linkTo("http://localhost:8080/"), click);
    expect(click.defaultPrevented).toBe(false);
  });
});
