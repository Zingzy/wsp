// Adapted from pingdotgg/t3code apps/web/src/components/chat/ComposerCommandMenu.test.tsx at 57a66608 (MIT).
// Differs from upstream: the two skill cases are dropped with the skill arm; the one case left renders a harness command.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerCommandMenu } from "./ComposerCommandMenu";

describe("ComposerCommandMenu", () => {
  it("renders slash commands with their descriptions", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "provider-slash-command:claude:model",
            type: "provider-slash-command",
            harness: "claude",
            command: { name: "model", description: "Show or change the model for this session" },
            label: "/model",
            description: "Show or change the model for this session",
          },
        ]}
        triggerKind="slash-command"
        activeItemId="provider-slash-command:claude:model"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain("/model");
    expect(markup).toContain("Show or change the model for this session");
  });

  it("says so when nothing matches", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu items={[]} triggerKind="slash-command" activeItemId={null} onHighlightedItemChange={() => {}} onSelect={() => {}} />,
    );
    expect(markup).toContain("No matching command.");
  });
});
