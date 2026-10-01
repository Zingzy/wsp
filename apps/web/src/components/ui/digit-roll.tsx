// SPDX-License-Identifier: AGPL-3.0-only
// A figure whose digits roll to their new values: each digit is a column of 0
// to 9 moved by a transform, the column drawn as content so the element's text
// is the figure itself for a reader and a test. Digits are keyed from the
// right, so a figure that gains a digit keeps its ones in place. It rolls up
// from zeros when it first appears, and stands still under reduced motion.
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils.js";

function Digit({ digit, at }: { digit: string; at: number }) {
  return (
    <span className="relative inline-block h-[1lh] overflow-hidden">
      <span className="invisible">{digit}</span>
      <span aria-hidden className="digit-strip absolute inset-x-0 top-0 text-center transition-transform duration-500 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none" style={{ transform: `translateY(${-at}lh)` }} />
    </span>
  );
}

export function DigitRoll({ value, className, ...rest }: { value: string; className?: string } & Omit<React.ComponentProps<"span">, "children">) {
  const [shown, setShown] = useState(() => value.replace(/\d/g, "0"));
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(value));
    return () => cancelAnimationFrame(frame);
  }, [value]);
  // The text is always the figure; only where each column stands lags a frame, which is what rolls.
  const chars = [...value];
  const at = [...shown];
  const offset = at.length - chars.length;
  return (
    <span {...rest} className={cn("inline-flex tabular-nums", className)}>
      {chars.map((char, i) => {
        const key = chars.length - i;
        const from = at[i + offset];
        return /\d/.test(char) ? <Digit key={key} digit={char} at={Number(from !== undefined && /\d/.test(from) ? from : char)} /> : <span key={`c${key}`}>{char}</span>;
      })}
    </span>
  );
}
