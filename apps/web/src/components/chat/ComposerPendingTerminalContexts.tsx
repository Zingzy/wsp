// Adapted from pingdotgg/t3code apps/web/src/components/chat/ComposerPendingTerminalContexts.tsx at 57a66608 (MIT).
// Differs from upstream: the chip is drawn from the excerpt's own label and
// lines, read off the prompt, with no expired state and no list of pending
// contexts beside the editor.
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";

/** How much of an excerpt the chip's hover shows before it says how many lines are left. */
const PREVIEW_LINES = 12;

export function terminalChipLabel(label: string, text: string): string {
  const lines = text.split("\n").length;
  return `${label}, ${lines} ${lines === 1 ? "line" : "lines"}`;
}

export function ComposerPendingTerminalContextChip(props: { label: string; text: string }) {
  const lines = props.text.split("\n");
  const preview = lines.length > PREVIEW_LINES ? `${lines.slice(0, PREVIEW_LINES).join("\n")}\n${lines.length - PREVIEW_LINES} more lines` : props.text;
  return <TerminalContextInlineChip label={terminalChipLabel(props.label, props.text)} tooltipText={preview} />;
}
