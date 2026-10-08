// Adapted from pingdotgg/t3code apps/web/src/components/ui/input-group.tsx at 57a66608 (MIT).
"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { Children, isValidElement } from "react";
import type * as React from "react";

import { cn } from "../../lib/utils";
import { Input, type InputProps } from "./input";
import { Textarea, type TextareaProps } from "./textarea";

const inputGroupVariants = cva(
  "relative inline-flex w-full min-w-0 items-center rounded-[var(--control-radius)] border text-base text-foreground transition-[border-color,box-shadow] duration-150 has-[input:focus-visible,textarea:focus-visible]:has-[input[aria-invalid],textarea[aria-invalid]]:border-destructive/64 has-[textarea]:h-auto data-[addons~=block-end]:h-auto data-[addons~=block-start]:h-auto data-[addons~=block-end]:flex-col data-[addons~=block-start]:flex-col has-[input:focus-visible,textarea:focus-visible]:border-ring has-[input[aria-invalid],textarea[aria-invalid]]:border-destructive/36 has-autofill:bg-foreground/4 has-[input:disabled,textarea:disabled]:opacity-64 has-[input:disabled,textarea:disabled,input:focus-visible,textarea:focus-visible,input[aria-invalid],textarea[aria-invalid]]:shadow-none sm:text-sm dark:has-autofill:bg-foreground/8 data-[addons~=inline-start]:**:[[data-size=sm]_input]:ps-1.5 data-[addons~=inline-end]:**:[[data-size=sm]_input]:pe-1.5 *:[[data-slot=input-control],[data-slot=textarea-control]]:contents *:[[data-slot=input-control],[data-slot=textarea-control]]:before:hidden data-[addons~=block-start]:**:[input]:h-auto data-[addons~=block-end]:**:[input]:h-auto data-[addons~=inline-start]:**:[input]:ps-2 data-[addons~=inline-end]:**:[input]:pe-2 data-[addons~=block-end]:**:[input]:pt-1.5 data-[addons~=block-start]:**:[input]:pb-1.5 **:[textarea]:min-h-20.5 **:[textarea]:resize-none **:[textarea]:py-[calc(--spacing(3)-1px)] **:[textarea]:max-sm:min-h-23.5 **:[textarea_button]:rounded-[calc(var(--control-radius)-1px)]",
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      variant: {
        default:
          "border-input bg-(--input-fill) not-dark:bg-clip-padding",
        ghost:
          "border-transparent bg-transparent shadow-none hover:bg-muted/40 has-[input:focus-visible,textarea:focus-visible]:bg-background",
      },
    },
  },
);

/** The aligns of the addons among a group's own children, which the group's classes read off data-addons: a :has()
 * asking the group restyles every element under it on each change. An addon is a direct child of its group. */
function addonAligns(children: React.ReactNode): string | undefined {
  const aligns = new Set(
    Children.toArray(children).flatMap(child =>
      isValidElement<{ align?: string | null }>(child) && child.type === InputGroupAddon ? [child.props.align ?? "inline-start"] : [],
    ),
  );
  return aligns.size === 0 ? undefined : [...aligns].join(" ");
}

function InputGroup({
  className,
  variant,
  children,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupVariants>) {
  return (
    <div
      className={cn(inputGroupVariants({ variant }), className)}
      data-slot="input-group"
      data-addons={addonAligns(children)}
      role="group"
      {...props}
    >
      {children}
    </div>
  );
}

const inputGroupAddonVariants = cva(
  "[&_svg]:-mx-0.5 flex h-auto cursor-text items-center justify-center gap-2 leading-none [&>kbd]:rounded-[calc(var(--radius)-5px)] in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4.5 sm:in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4 **:[svg:not([class*='opacity-']):not(button_svg)]:opacity-80",
  {
    defaultVariants: {
      align: "inline-start",
    },
    variants: {
      align: {
        "block-end":
          "order-last w-full justify-start px-[calc(--spacing(3)-1px)] pb-[calc(--spacing(3)-1px)] [.border-t]:pt-[calc(--spacing(3)-1px)] [[data-size=sm]+&]:px-[calc(--spacing(2.5)-1px)]",
        "block-start":
          "order-first w-full justify-start px-[calc(--spacing(3)-1px)] pt-[calc(--spacing(3)-1px)] [.border-b]:pb-[calc(--spacing(3)-1px)] [[data-size=sm]+&]:px-[calc(--spacing(2.5)-1px)]",
        "inline-end":
          "has-[>:last-child[data-slot=badge]]:-me-1.5 has-[>button]:-me-2 order-last pe-[calc(--spacing(3)-1px)] has-[>kbd:last-child]:me-[-0.35rem] [[data-size=sm]+&]:pe-[calc(--spacing(2.5)-1px)]",
        "inline-start":
          "has-[>:last-child[data-slot=badge]]:-ms-1.5 has-[>button]:-ms-2 order-first ps-[calc(--spacing(3)-1px)] has-[>kbd:last-child]:ms-[-0.35rem] [[data-size=sm]+&]:ps-[calc(--spacing(2.5)-1px)]",
      },
    },
  },
);

function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      className={cn(inputGroupAddonVariants({ align }), className)}
      data-align={align}
      data-slot="input-group-addon"
      onMouseDown={(e) => {
        const target = e.target as HTMLElement;
        const isInteractive = target.closest(
          "button, a, input, select, textarea, [role='button'], [role='combobox'], [role='listbox'], [data-slot='select-trigger']",
        );
        if (isInteractive) return;
        e.preventDefault();
        const parent = e.currentTarget.parentElement;
        const input = parent?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
          "input, textarea",
        );
        if (input && !parent?.querySelector("input:focus, textarea:focus")) {
          input.focus();
        }
      }}
      {...props}
    />
  );
}

function InputGroupText({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "[&_svg]:-mx-0.5 line-clamp-1 flex items-center gap-2 text-muted-foreground leading-none in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4.5 sm:in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupInput({ className, ...props }: InputProps) {
  return <Input className={className} unstyled {...props} />;
}

function InputGroupTextarea({ className, ...props }: TextareaProps) {
  return <Textarea className={className} unstyled {...props} />;
}

export { InputGroup, InputGroupAddon, InputGroupText, InputGroupInput, InputGroupTextarea };
