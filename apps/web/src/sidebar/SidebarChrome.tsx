// Adapted from pingdotgg/t3code apps/web/src/components/sidebar/SidebarChrome.tsx at 57a66608 (MIT).
// The router, settings and update-pill hooks are replaced by props: the
// header takes its title, the footer the actions it lists. The stage
// backdrop and the wordmark are left out.
import type { ComponentProps, ReactNode } from "react";
import { memo } from "react";

import { cn } from "../lib/utils";
import {
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from "../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  title,
  isElectron = false,
  children,
}: {
  title: string;
  isElectron?: boolean;
  children?: ReactNode;
}) {
  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center px-3 py-0 md:px-0",
        isElectron && "drag-region",
      )}
    >
      <SidebarTrigger className="relative z-10 md:hidden" />
      <span className="relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center gap-1 overflow-hidden rounded-md text-foreground md:flex">
        <span className="-translate-y-px truncate text-sm font-medium tracking-tight text-muted-foreground">
          {title}
        </span>
      </span>
      {children}
    </SidebarHeader>
  );
});

export interface SidebarUtilityAction {
  readonly icon: ReactNode;
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}

function SidebarUtilityItem({ icon, label, onClick, disabled = false }: SidebarUtilityAction) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon" disabled={disabled}>
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

export const SidebarUtilityMenu = memo(function SidebarUtilityMenu({
  primary,
  items,
}: {
  primary?: SidebarUtilityAction | undefined;
  items: ReadonlyArray<SidebarUtilityAction>;
}) {
  return (
    <SidebarMenu className="flex-row items-center">
      {primary ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton onClick={primary.onClick} disabled={primary.disabled ?? false}>
            {primary.icon}
            <span>{primary.label}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : null}
      {items.map((item) => (
        <SidebarUtilityItem key={item.label} {...item} />
      ))}
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter({
  children,
  ...menu
}: { children?: ReactNode } & ComponentProps<typeof SidebarUtilityMenu>) {
  return (
    <SidebarFooter className="p-[var(--sidebar-content-inset)]">
      {children}
      <SidebarUtilityMenu {...menu} />
    </SidebarFooter>
  );
});
