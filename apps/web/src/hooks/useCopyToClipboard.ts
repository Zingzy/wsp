// Adapted from pingdotgg/t3code apps/web/src/hooks/useCopyToClipboard.ts at 57a66608 (MIT).
import * as React from "react";
import { noticeFailure, notCopied } from "../notices/store.js";

export class ClipboardApiUnavailableError extends Error {
  constructor(readonly target: string) {
    super(`Clipboard API is unavailable while copying ${target}.`);
    this.name = "ClipboardApiUnavailableError";
  }
}

export class ClipboardWriteError extends Error {
  constructor(
    readonly target: string,
    readonly cause: unknown,
  ) {
    super(`Failed to copy ${target} to the clipboard.`);
    this.name = "ClipboardWriteError";
  }
}

export async function writeTextToClipboard(value: string, target = "text") {
  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    !navigator.clipboard?.writeText
  ) {
    throw new ClipboardApiUnavailableError(target);
  }

  if (!value) return false;

  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch (cause) {
    throw new ClipboardWriteError(target, cause);
  }
}

export function useCopyToClipboard<TContext = void>({
  timeout = 2000,
  target = "text",
  onCopy,
  onError,
}: {
  timeout?: number;
  target?: string;
  onCopy?: (ctx: TContext) => void;
  onError?: (error: Error, ctx: TContext) => void;
} = {}): { copyToClipboard: (value: string, ctx: TContext) => void; isCopied: boolean } {
  const [isCopied, setIsCopied] = React.useState(false);
  const timeoutIdRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCopyRef = React.useRef(onCopy);
  const onErrorRef = React.useRef(onError);
  const targetRef = React.useRef(target);
  const timeoutRef = React.useRef(timeout);

  onCopyRef.current = onCopy;
  onErrorRef.current = onError;
  targetRef.current = target;
  timeoutRef.current = timeout;

  const copyToClipboard = React.useCallback((value: string, ctx: TContext): void => {
    void writeTextToClipboard(value, targetRef.current).then(
      (didCopy) => {
        if (!didCopy) return;
        if (timeoutIdRef.current) {
          clearTimeout(timeoutIdRef.current);
        }
        setIsCopied(true);

        onCopyRef.current?.(ctx);

        if (timeoutRef.current !== 0) {
          timeoutIdRef.current = setTimeout(() => {
            setIsCopied(false);
            timeoutIdRef.current = null;
          }, timeoutRef.current);
        }
      },
      (error) => {
        // A caller that says nothing of its own failure has it said for it, so a copy never fails unseen.
        if (onErrorRef.current === undefined) noticeFailure(error, notCopied);
        else onErrorRef.current(error, ctx);
      },
    );
  }, []);

  React.useEffect(() => {
    return (): void => {
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
      }
    };
  }, []);

  return { copyToClipboard, isCopied };
}
