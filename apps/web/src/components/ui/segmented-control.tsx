// SPDX-License-Identifier: AGPL-3.0-only
// A choice between a few words in one row: the settings page's picks and the
// theme picker's mode. One hairline box, the chosen segment on the control
// surface with the foreground ink, the rest muted; it is a radio group to the
// keyboard and to a reader.
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cn } from "../../lib/utils.js";

export interface Segment<T extends string> {
  readonly value: T;
  readonly label: string;
}

export function SegmentedControl<T extends string>({
  value,
  segments,
  onChange,
  className,
  ...props
}: Omit<RadioGroupPrimitive.Props, "value" | "onValueChange" | "onChange"> & {
  value: T;
  segments: ReadonlyArray<Segment<T>>;
  onChange: (value: T) => void;
}) {
  return (
    <RadioGroupPrimitive
      value={value}
      onValueChange={next => {
        const found = segments.find(segment => segment.value === next);
        if (found !== undefined) onChange(found.value);
      }}
      className={cn("inline-flex h-7 items-stretch rounded-md border border-border p-px", className)}
      data-slot="segmented-control"
      {...props}
    >
      {segments.map(segment => (
        <RadioPrimitive.Root
          key={segment.value}
          value={segment.value}
          data-segment={segment.value}
          className="cursor-pointer rounded-[5px] px-2.5 text-xs text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-accent data-checked:text-foreground"
        >
          {segment.label}
        </RadioPrimitive.Root>
      ))}
    </RadioGroupPrimitive>
  );
}
