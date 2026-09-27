// Adapted from pingdotgg/t3code apps/web/src/components/ui/number-field.tsx at 57a66608 (MIT).
"use client";

import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field";
import { MinusIcon, PlusIcon } from "lucide-react";
import * as React from "react";
import { cn } from "../../lib/utils";
import { Label } from "./label";

export const NumberFieldContext: React.Context<{
  fieldId: string;
} | null> = React.createContext<{
  fieldId: string;
} | null>(null);

export function NumberField({ id, className, ...props }: NumberFieldPrimitive.Root.Props): React.ReactElement {
  const generatedId = React.useId();
  const fieldId = id ?? generatedId;
  const contextValue = React.useMemo(() => ({ fieldId }), [fieldId]);

  return (
    <NumberFieldContext value={contextValue}>
      <NumberFieldPrimitive.Root
        className={cn("flex w-full flex-col items-start gap-2", className)}
        data-slot="number-field"
        id={fieldId}
        {...props}
      />
    </NumberFieldContext>
  );
}

export function NumberFieldGroup({
  className,
  ...props
}: NumberFieldPrimitive.Group.Props): React.ReactElement {
  return (
    <NumberFieldPrimitive.Group
      className={cn(
        "relative flex w-full justify-between rounded-md border border-input bg-(--input-fill) text-sm text-foreground transition-[border-color] duration-150 focus-within:border-ring has-aria-invalid:border-destructive/36 focus-within:has-aria-invalid:border-destructive/64 data-disabled:pointer-events-none data-disabled:opacity-64 [&_svg:not([class*='size-'])]:size-3.25 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      data-slot="number-field-group"
      {...props}
    />
  );
}

export function NumberFieldDecrement({
  className,
  ...props
}: NumberFieldPrimitive.Decrement.Props): React.ReactElement {
  return (
    <NumberFieldPrimitive.Decrement
      className={cn(
        "relative flex shrink-0 cursor-pointer items-center justify-center rounded-s-[7px] px-2 text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground",
        className,
      )}
      data-slot="number-field-decrement"
      {...props}
    >
      <MinusIcon />
    </NumberFieldPrimitive.Decrement>
  );
}

export function NumberFieldIncrement({
  className,
  ...props
}: NumberFieldPrimitive.Increment.Props): React.ReactElement {
  return (
    <NumberFieldPrimitive.Increment
      className={cn(
        "relative flex shrink-0 cursor-pointer items-center justify-center rounded-e-[7px] px-2 text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground",
        className,
      )}
      data-slot="number-field-increment"
      {...props}
    >
      <PlusIcon />
    </NumberFieldPrimitive.Increment>
  );
}

export function NumberFieldInput({
  className,
  ...props
}: NumberFieldPrimitive.Input.Props): React.ReactElement {
  return (
    <NumberFieldPrimitive.Input
      className={cn(
        "h-6.5 w-full min-w-0 grow bg-transparent px-1 text-center font-mono text-xs tabular-nums leading-6.5 outline-none",
        className,
      )}
      data-slot="number-field-input"
      {...props}
    />
  );
}

export function NumberFieldScrubArea({
  className,
  label,
  ...props
}: NumberFieldPrimitive.ScrubArea.Props & {
  label: string;
}): React.ReactElement {
  const context = React.use(NumberFieldContext);

  if (!context) {
    throw new Error(
      "NumberFieldScrubArea must be used within a NumberField component for accessibility.",
    );
  }

  return (
    <NumberFieldPrimitive.ScrubArea
      className={cn("flex cursor-ew-resize", className)}
      data-slot="number-field-scrub-area"
      {...props}
    >
      <Label className="cursor-ew-resize" htmlFor={context.fieldId}>
        {label}
      </Label>
      <NumberFieldPrimitive.ScrubAreaCursor className="drop-shadow-[0_1px_1px_#0008] filter">
        <CursorGrowIcon />
      </NumberFieldPrimitive.ScrubAreaCursor>
    </NumberFieldPrimitive.ScrubArea>
  );
}

export function CursorGrowIcon(props: React.ComponentProps<"svg">): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      fill="black"
      height="14"
      stroke="white"
      viewBox="0 0 24 14"
      width="26"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d="M19.5 5.5L6.49737 5.51844V2L1 6.9999L6.5 12L6.49737 8.5L19.5 8.5V12L25 6.9999L19.5 2V5.5Z" />
    </svg>
  );
}

export { NumberFieldPrimitive };
