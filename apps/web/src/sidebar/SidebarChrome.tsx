// Adapted from pingdotgg/t3code apps/web/src/components/sidebar/SidebarChrome.tsx at 57a66608 (MIT).
// The router, settings and update-pill hooks are replaced by props: the
// header is the shell's frame row with the wordmark after the traffic lights
// and the sidebar toggle at the sidebar's right edge, the boundary it toggles;
// the footer the actions it lists. The stage backdrop is left out.
import type { ComponentProps, ReactNode } from "react";
import { memo } from "react";

import { Lockup } from "../brand/Brand";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../components/ui/sidebar";
import { HeaderRow } from "../shell/HeaderRow";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({ children }: { children?: ReactNode }) {
  return (
    <HeaderRow frame toggleAt="end" className="@container/sidebar-header relative pr-[var(--sidebar-content-inset)]" data-slot="sidebar-header">
      {/* At 14px tall the optical centre sits 2px above the box's middle, so the box drops 2px onto the row's centre line. */}
      <Lockup className="h-3.5 w-fit shrink-0 translate-y-0.5 text-muted-foreground" />
      {children}
    </HeaderRow>
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
  items,
}: {
  items: ReadonlyArray<SidebarUtilityAction>;
}) {
  return (
    <SidebarMenu className="flex-row items-center">
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
