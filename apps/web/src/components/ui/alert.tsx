// Adapted from pingdotgg/t3code apps/web/src/components/ui/alert.tsx at 57a66608 (MIT).
import type * as React from "react";

import { cn } from "../../lib/utils";

function Alert({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-h-10 min-w-0 items-center gap-2 px-4 py-2 text-[13px] leading-5 text-foreground [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground",
        className,
      )}
      data-slot="alert"
      role="alert"
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("min-w-0 truncate", className)} data-slot="alert-title" {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("min-w-0 truncate text-muted-foreground", className)} data-slot="alert-description" {...props} />;
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("ms-auto flex shrink-0 gap-1", className)} data-slot="alert-action" {...props} />;
}

export { Alert, AlertTitle, AlertDescription, AlertAction };
