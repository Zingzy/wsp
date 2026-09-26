// SPDX-License-Identifier: AGPL-3.0-only
// The one Add: the outline keycap with the plus before its word under a list
// or in a row, and the primary where it is a sheet's Add.
import { PlusIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { Spinner } from "./spinner";

type AddButtonProps = Omit<ComponentProps<typeof Button>, "variant"> & {
  primary?: boolean;
  /** Its road is running: a spinner stands in the plus's place, and the caller says so in the word. */
  busy?: boolean;
};

function AddButton({ primary = false, busy = false, size = "default", className, children, ...props }: AddButtonProps) {
  return (
    <Button data-add-button="" variant={primary ? "default" : "outline"} size={size} className={cn(size === "default" && "gap-1.5 sm:text-[13px]", className)} {...props}>
      {busy ? <Spinner data-k="adding-spinner" aria-hidden role={undefined} className="size-3.5" /> : <PlusIcon aria-hidden className="size-3.5" />}
      {children}
    </Button>
  );
}

export { AddButton };
