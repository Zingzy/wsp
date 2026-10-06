// SPDX-License-Identifier: AGPL-3.0-only
// Mermaid's config is one for the page: two blocks that draw at once, a chat's and a slate's, each draw under their own
// look, never the other's.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mermaid = vi.hoisted(() => {
  let css = "";
  return {
    initialize: vi.fn((config: { themeCSS?: string }) => {
      css = config.themeCSS ?? "chat";
    }),
    parse: vi.fn(async () => true),
    // Mermaid queues a render and reads its config when the render's turn comes, a turn of the event loop later.
    render: vi.fn(async (id: string) => {
      await new Promise(resolve => setTimeout(resolve, 0));
      return { svg: `<svg id="${id}"><title>${css}</title></svg>` };
    }),
  };
});
vi.mock("mermaid", () => ({ default: mermaid }));

import MermaidBlock from "./MermaidBlock";

afterEach(cleanup);

describe("Mermaid's one config", () => {
  it("draws each of two blocks mounted together under its own look", async () => {
    const { container } = render(
      <>
        <div data-k="chat">
          <MermaidBlock code={"graph TD\nA-->B"} resolvedTheme="dark" source={null} />
        </div>
        <div data-k="slate">
          <MermaidBlock code={"graph TD\nC-->D"} resolvedTheme="dark" source={null} look={{ css: "slate" }} />
        </div>
      </>,
    );
    const look = (k: string) => container.querySelector(`[data-k="${k}"] svg title`)?.textContent;
    await waitFor(() => expect([look("chat"), look("slate")]).toEqual(["chat", "slate"]));
  });
});
