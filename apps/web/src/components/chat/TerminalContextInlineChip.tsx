// Adapted from pingdotgg/t3code apps/web/src/components/chat/TerminalContextInlineChip.tsx at 57a66608 (MIT).
// Differs from upstream: no expired look, since the chip carries its lines in
// the prompt itself and nothing it holds can go stale.
import { TerminalIcon } from "lucide-react";

import { COMPOSER_INLINE_CHIP_CLASS_NAME, COMPOSER_INLINE_CHIP_ICON_CLASS_NAME, COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME } from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function TerminalContextInlineChip(props: { label: string; tooltipText: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={COMPOSER_INLINE_CHIP_CLASS_NAME} data-composer-terminal-chip="true">
            <TerminalIcon className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
            <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{props.label}</span>
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-120 whitespace-pre-wrap font-mono text-[11px] leading-4">
        {props.tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
}
