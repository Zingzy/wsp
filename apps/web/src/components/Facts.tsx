// SPDX-License-Identifier: AGPL-3.0-only
import { Fragment, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/utils.js";

/** Facts side by side, the gap between them the only separator. The spaces between draw nothing in a flex row;
 * they keep the words apart in the text a plain-text read takes. An empty fact, a blank word or nothing, is left
 * out. */
export function Facts({ parts, className, ...rest }: Omit<HTMLAttributes<HTMLSpanElement>, "children"> & { parts: ReadonlyArray<ReactNode> }) {
  return (
    <span {...rest} className={cn("flex min-w-0 items-center gap-x-3", className)}>
      {parts
        .filter(part => part !== "" && part !== null && part !== undefined && part !== false)
        .map((part, at) => (
          <Fragment key={at}>
            {at === 0 ? null : " "}
            <span data-fact className="whitespace-nowrap">
              {part}
            </span>
          </Fragment>
        ))}
    </span>
  );
}
