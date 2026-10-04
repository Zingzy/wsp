// SPDX-License-Identifier: AGPL-3.0-only
// A figure that rests as plain text and rolls its digits only while a new value lands: for the length of one roll
// each changed digit is a column of 0 to 9 moved by a transform over its own glyph, inked transparent, so the text
// never stops being the figure for a reader, a copy and a test. A timer ends the roll, not the transition or a
// frame, so a roll the window never finished painting cannot stay drawn. Digits are keyed from the right, so a
// figure that gains a digit keeps its ones in place. It stands still under reduced motion and in a hidden window.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils.js";

const ROLL_MS = 500;

const still = (): boolean =>
  (typeof document !== "undefined" && document.hidden) || (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true);

/** A roll's start: the figure it leaves, and whether its columns have been placed there for the transition to start from. */
interface Roll {
  from: string;
  placed: boolean;
}

export function DigitRoll({ value, rollIn = false, className, ...rest }: { value: string; rollIn?: boolean; className?: string } & Omit<React.ComponentProps<"span">, "children">) {
  const [roll, setRoll] = useState<Roll | null>(() => (rollIn && !still() ? { from: value.replace(/\d/g, "0"), placed: false } : null));
  const [prev, setPrev] = useState(value);
  const host = useRef<HTMLSpanElement>(null);
  if (prev !== value) {
    setPrev(value);
    if (!still()) setRoll(r => r ?? { from: prev, placed: false });
  }
  useLayoutEffect(() => {
    if (roll === null || roll.placed) return;
    // The columns stand on the old digits for one style pass, so moving them is a transition rather than a jump.
    void host.current?.offsetHeight;
    setRoll({ ...roll, placed: true });
  }, [roll]);
  const rolling = roll !== null;
  useEffect(() => {
    if (!rolling) return;
    const end = setTimeout(() => setRoll(null), ROLL_MS + 100);
    return () => clearTimeout(end);
  }, [rolling, value]);
  const chars = [...value];
  const from = roll === null ? [] : [...roll.from];
  const offset = from.length - chars.length;
  return (
    <span ref={host} {...rest} className={cn("whitespace-nowrap tabular-nums", className)}>
      {chars.map((char, i) => {
        const key = chars.length - i;
        if (roll === null || !/\d/.test(char)) return <span key={key}>{char}</span>;
        const was = from[i + offset];
        const at = roll.placed || was === undefined || !/\d/.test(was) ? Number(char) : Number(was);
        return (
          <span key={key} className="relative inline-block h-[1lh] overflow-hidden align-top">
            <span className="text-transparent">{char}</span>
            <span
              aria-hidden
              className="digit-strip absolute inset-x-0 top-0 text-center transition-transform duration-500 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
              style={{ transform: `translateY(${-at}lh)` }}
            />
          </span>
        );
      })}
    </span>
  );
}
