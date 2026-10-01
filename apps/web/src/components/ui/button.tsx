// Adapted from pingdotgg/t3code apps/web/src/components/ui/button.tsx at 57a66608 (MIT).
"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "../../lib/utils";

/** The keycap's top light: a 1 px line along the inside of the top edge, in the theme's own strength. */
const KEYCAP_BEVEL = "shadow-[inset_0_1px_0_var(--keycap-top)]";

/** The ring a control takes where the accent would be a third hue on one screen: a destructive confirm, and the
 * Cancel standing beside it. A blue ring between a neutral button and a red one says nothing about either. */
const NEUTRAL_RING = "focus-visible:ring-muted-foreground";

/** The outline keycap's body: the field edge and fill, and a 5% foreground step into that fill under the pointer. */
export const OUTLINE_SURFACE = `${KEYCAP_BEVEL} border-input bg-(--input-fill) [:hover,[data-pressed]]:bg-[color-mix(in_srgb,var(--foreground)_5%,var(--input-fill))]`;

const buttonVariants = cva(
  "[--control-icon-color:currentColor] relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--control-radius)] border font-medium text-[13px] outline-none transition-[color,background-color,border-color] duration-150 pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64 [&_svg:not([class*='text-'])]:text-[var(--control-icon-color)] [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "h-8 px-3",
        icon: "size-7 [&_svg:not([class*='size-'])]:size-4",
        "icon-micro": "size-5 rounded-sm p-0 [&_svg:not([class*='size-'])]:size-3",
        "icon-xs": "size-6",
        xs: "h-6 gap-1 px-2 text-xs",
      },
      variant: {
        default: `${KEYCAP_BEVEL} border-primary bg-primary text-primary-foreground [:hover,[data-pressed]]:bg-[color-mix(in_srgb,var(--primary)_90%,var(--background))]`,
        destructive: `${KEYCAP_BEVEL} ${NEUTRAL_RING} border-destructive bg-destructive text-white [:hover,[data-pressed]]:bg-destructive/90`,
        "destructive-outline": `${OUTLINE_SURFACE} text-destructive-foreground [:hover,[data-pressed]]:border-destructive/32`,
        ghost:
          "[--control-icon-color:var(--muted-foreground)] border-transparent font-normal text-muted-foreground [:hover,[data-pressed]]:bg-accent [:hover,[data-pressed]]:text-foreground",
        glass:
          "surface-glass [--control-icon-color:var(--muted-foreground)] border-border/60 text-foreground shadow-sm [:hover,[data-pressed]]:border-border",
        link: "border-transparent underline-offset-4 [:hover,[data-pressed]]:underline",
        outline: `${OUTLINE_SURFACE} [--control-icon-color:var(--muted-foreground)] text-foreground`,
        secondary:
          "border-transparent bg-secondary text-secondary-foreground [:active,[data-pressed]]:bg-secondary/80 [:hover,[data-pressed]]:bg-secondary/90",
      },
    },
  },
);

interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
  /** A control that cannot be pressed yet, waiting on a field beside it: disabled in its own variant, at the size
   * and in the slot the live one has. The reason it waits belongs in the slot under that field, never on a hover.
   * Being busy is not this: a pressed control keeps its variant and changes its word. */
  held?: boolean;
}

function Button({ className, variant, size, held = false, render, ...props }: ButtonProps) {
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] = render
    ? undefined
    : "button";

  const defaultProps = {
    className: cn(buttonVariants({ className, size, variant })),
    "data-slot": "button",
    type: typeValue,
  };
  const heldProps = { "data-held": "", disabled: true };

  return useRender({
    defaultTagName: "button",
    // Last, so a caller that disables for its own reason cannot hand a held control back to the hand.
    props: mergeProps<"button">(defaultProps, props, held ? heldProps : {}),
    render,
  });
}

/** A door to a confirmation for something that does not come back: neutral at rest, as every other action in a
 * row's slot is, and the danger ink and edge under the pointer. The act itself is the dialog's button, which is
 * where red stands at rest, so no page carries more than one loud thing. */
const DANGER_BUTTON = "[:hover,[data-pressed]]:border-destructive/50 [:hover,[data-pressed]]:text-destructive-foreground";

export { Button, buttonVariants, DANGER_BUTTON, NEUTRAL_RING };
