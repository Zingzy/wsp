// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from pingdotgg/t3code apps/web/src/components/ComposerPromptEditor.tsx at 57a66608 (MIT).
import { $applyNodeReplacement, DecoratorNode, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from "lexical";

import { baseName } from "../../files/entries";
import type { ComposerTokenSegment } from "../../composer-editor-mentions";
import { COMPOSER_INLINE_CHIP_CLASS_NAME, COMPOSER_INLINE_CHIP_DECORATOR_CLASS_NAME, COMPOSER_INLINE_CHIP_ICON_CLASS_NAME, COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME, SKILL_CHIP_ICON_HTML } from "../composerInlineChip";
import { FILE_TAG_CHIP_CLASS_NAME, FileTagChipContent } from "../chat/FileTagChip";
import { ComposerPendingTerminalContextChip } from "../chat/ComposerPendingTerminalContexts";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { $createComposerCitationNode, ComposerCitationNode } from "../ComposerCitationNode";

type SerializedComposerMentionNode = Spread<{ path: string; source: string; type: "composer-mention"; version: 1 }, SerializedLexicalNode>;
type SerializedComposerSkillNode = Spread<{ skillName: string; source: string; type: "composer-skill"; version: 1 }, SerializedLexicalNode>;
type SerializedComposerTerminalContextNode = Spread<{ label: string; text: string; source: string; type: "composer-terminal-context"; version: 1 }, SerializedLexicalNode>;

function ComposerMentionDecorator(props: { path: string }) {
  const chip = (
    <span className={FILE_TAG_CHIP_CLASS_NAME} contentEditable={false} spellCheck={false} data-composer-mention-chip="true">
      <FileTagChipContent path={props.path} label={baseName(props.path)} theme={resolvedThemeFromDocument()} />
    </span>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup side="top" className="max-w-120 whitespace-normal leading-tight wrap-anywhere">
        {props.path}
      </TooltipPopup>
    </Tooltip>
  );
}

export class ComposerMentionNode extends DecoratorNode<React.ReactElement> {
  __path: string;
  __source: string;

  static override getType(): string {
    return "composer-mention";
  }

  static override clone(node: ComposerMentionNode): ComposerMentionNode {
    return new ComposerMentionNode(node.__path, node.__source, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerMentionNode): ComposerMentionNode {
    return $createComposerMentionNode(serializedNode.path, serializedNode.source).updateFromJSON(serializedNode);
  }

  constructor(path: string, source: string, key?: NodeKey) {
    super(key);
    this.__path = path;
    this.__source = source;
  }

  override exportJSON(): SerializedComposerMentionNode {
    return { ...super.exportJSON(), path: this.__path, source: this.__source, type: "composer-mention", version: 1 };
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement("span");
    dom.className = COMPOSER_INLINE_CHIP_DECORATOR_CLASS_NAME;
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

  override decorate(): React.ReactElement {
    return <ComposerMentionDecorator path={this.__path} />;
  }
}

function $createComposerMentionNode(path: string, source: string): ComposerMentionNode {
  return $applyNodeReplacement(new ComposerMentionNode(path, source));
}

function ComposerSkillDecorator(props: { skillName: string }) {
  return (
    <span className={COMPOSER_INLINE_CHIP_CLASS_NAME} contentEditable={false} spellCheck={false} data-composer-skill-chip="true">
      <span aria-hidden="true" className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} dangerouslySetInnerHTML={SKILL_CHIP_ICON_HTML} />
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{props.skillName}</span>
    </span>
  );
}

export class ComposerSkillNode extends DecoratorNode<React.ReactElement> {
  __skillName: string;
  __source: string;

  static override getType(): string {
    return "composer-skill";
  }

  static override clone(node: ComposerSkillNode): ComposerSkillNode {
    return new ComposerSkillNode(node.__skillName, node.__source, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerSkillNode): ComposerSkillNode {
    return $createComposerSkillNode(serializedNode.skillName, serializedNode.source).updateFromJSON(serializedNode);
  }

  constructor(skillName: string, source: string, key?: NodeKey) {
    super(key);
    this.__skillName = skillName;
    this.__source = source;
  }

  override exportJSON(): SerializedComposerSkillNode {
    return { ...super.exportJSON(), skillName: this.__skillName, source: this.__source, type: "composer-skill", version: 1 };
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement("span");
    dom.className = COMPOSER_INLINE_CHIP_DECORATOR_CLASS_NAME;
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

  override decorate(): React.ReactElement {
    return <ComposerSkillDecorator skillName={this.__skillName} />;
  }
}

function $createComposerSkillNode(skillName: string, source: string): ComposerSkillNode {
  return $applyNodeReplacement(new ComposerSkillNode(skillName, source));
}

export class ComposerTerminalContextNode extends DecoratorNode<React.ReactElement> {
  __label: string;
  __text: string;
  __source: string;

  static override getType(): string {
    return "composer-terminal-context";
  }

  static override clone(node: ComposerTerminalContextNode): ComposerTerminalContextNode {
    return new ComposerTerminalContextNode(node.__label, node.__text, node.__source, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerTerminalContextNode): ComposerTerminalContextNode {
    return $createComposerTerminalContextNode(serializedNode.label, serializedNode.text, serializedNode.source);
  }

  constructor(label: string, text: string, source: string, key?: NodeKey) {
    super(key);
    this.__label = label;
    this.__text = text;
    this.__source = source;
  }

  override exportJSON(): SerializedComposerTerminalContextNode {
    return { ...super.exportJSON(), label: this.__label, text: this.__text, source: this.__source, type: "composer-terminal-context", version: 1 };
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement("span");
    dom.className = COMPOSER_INLINE_CHIP_DECORATOR_CLASS_NAME;
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

  override decorate(): React.ReactElement {
    return (
      <span contentEditable={false} spellCheck={false} className="inline-flex">
        <ComposerPendingTerminalContextChip label={this.__label} text={this.__text} />
      </span>
    );
  }
}

function $createComposerTerminalContextNode(label: string, text: string, source: string): ComposerTerminalContextNode {
  return $applyNodeReplacement(new ComposerTerminalContextNode(label, text, source));
}

export type ComposerInlineTokenNode = ComposerMentionNode | ComposerSkillNode | ComposerCitationNode | ComposerTerminalContextNode;

export function isComposerInlineTokenNode(candidate: unknown): candidate is ComposerInlineTokenNode {
  return (
    candidate instanceof ComposerMentionNode ||
    candidate instanceof ComposerSkillNode ||
    candidate instanceof ComposerCitationNode ||
    candidate instanceof ComposerTerminalContextNode
  );
}

export function $createTokenNode(segment: ComposerTokenSegment): LexicalNode {
  switch (segment.type) {
    case "mention":
      return $createComposerMentionNode(segment.path, segment.source);
    case "skill":
      return $createComposerSkillNode(segment.name, segment.source);
    case "terminal":
      return $createComposerTerminalContextNode(segment.label, segment.text, segment.source);
    case "citation":
      return $createComposerCitationNode({ kind: segment.kind, number: segment.number, title: segment.title, body: segment.body, url: segment.url }, segment.source);
  }
}

function resolvedThemeFromDocument(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}
