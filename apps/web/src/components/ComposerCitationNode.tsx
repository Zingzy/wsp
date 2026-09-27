// Adapted from pingdotgg/t3code apps/web/src/components/ComposerCitationNode.tsx at 57a66608 (MIT).
// Differs from upstream: a citation is a block the agent reads as it is, a
// Markdown blockquote under one header line, so there is no citation link, no
// comment editor and no source to scroll back to; the same node carries a
// quoted reply and a pull request or issue picked from the # menu, each drawn
// as one chip with its own mark.
import { CircleDotIcon, GitPullRequestIcon, QuoteIcon } from "lucide-react";
import { $applyNodeReplacement, DecoratorNode, type NodeKey, type SerializedLexicalNode, type Spread } from "lexical";
import type { ReactElement } from "react";

import type { ComposerCitationKind } from "../composer-editor-mentions";
import { COMPOSER_INLINE_CHIP_CLASS_NAME, COMPOSER_INLINE_CHIP_DECORATOR_CLASS_NAME, COMPOSER_INLINE_CHIP_ICON_CLASS_NAME, COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME } from "./composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface ComposerCitation {
  readonly kind: ComposerCitationKind;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
}

type SerializedComposerCitationNode = Spread<{ citation: ComposerCitation; source: string; type: "composer-citation"; version: 1 }, SerializedLexicalNode>;

/** How much of a quote the chip names it by. */
const QUOTE_LABEL_CHARS = 40;

export function citationChipLabel(citation: ComposerCitation): string {
  if (citation.kind !== "quote") return `#${citation.number} ${citation.title}`;
  const said = citation.body.replace(/\s+/g, " ").trim();
  return said.length > QUOTE_LABEL_CHARS ? `${said.slice(0, QUOTE_LABEL_CHARS - 1)}…` : said;
}

const MARKS = { quote: QuoteIcon, "pull-request": GitPullRequestIcon, issue: CircleDotIcon } as const;

export function AssistantCitationChip(props: { citation: ComposerCitation }) {
  const Mark = MARKS[props.citation.kind];
  const chip = (
    <span className={`${COMPOSER_INLINE_CHIP_CLASS_NAME} max-w-80`} data-composer-citation-chip={props.citation.kind}>
      <Mark className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{citationChipLabel(props.citation)}</span>
    </span>
  );
  const hover = props.citation.kind === "quote" ? props.citation.body : props.citation.body || props.citation.url;
  if (hover.length === 0) return chip;
  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup side="top" className="max-w-120 whitespace-pre-wrap leading-tight">
        {hover}
      </TooltipPopup>
    </Tooltip>
  );
}

export class ComposerCitationNode extends DecoratorNode<ReactElement> {
  __citation: ComposerCitation;
  __source: string;

  static override getType(): string {
    return "composer-citation";
  }

  static override clone(node: ComposerCitationNode): ComposerCitationNode {
    return new ComposerCitationNode(node.__citation, node.__source, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerCitationNode): ComposerCitationNode {
    return $createComposerCitationNode(serializedNode.citation, serializedNode.source).updateFromJSON(serializedNode);
  }

  constructor(citation: ComposerCitation, source: string, key?: NodeKey) {
    super(key);
    this.__citation = citation;
    this.__source = source;
  }

  override exportJSON(): SerializedComposerCitationNode {
    return { ...super.exportJSON(), citation: this.__citation, source: this.__source, type: "composer-citation", version: 1 };
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement("span");
    dom.className = `${COMPOSER_INLINE_CHIP_DECORATOR_CLASS_NAME} max-w-full`;
    return dom;
  }

  override updateDOM(): false {
    return false;
  }

  override getTextContent(): string {
    return this.__source;
  }

  override isInline(): true {
    return true;
  }

  override decorate(): ReactElement {
    return (
      <span className="inline-flex min-w-0 max-w-full" contentEditable={false} spellCheck={false}>
        <AssistantCitationChip citation={this.__citation} />
      </span>
    );
  }
}

export function $createComposerCitationNode(citation: ComposerCitation, source: string): ComposerCitationNode {
  return $applyNodeReplacement(new ComposerCitationNode(citation, source));
}
