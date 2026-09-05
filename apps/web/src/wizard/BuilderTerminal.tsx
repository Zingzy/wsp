// SPDX-License-Identifier: AGPL-3.0-only
// The first-run builder's shell on the libghostty surface: one pty over the
// builder's own daemon link, which the wizard provides under the builder id.
// The pty opens once the link is live and never again after that first open,
// so a shell that exits does not respawn under the person.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { TerminalViewport } from "../components/ThreadTerminalDrawer.js";
import { getTerminals, onTerminals, type WorkspaceTerminals } from "../terminal/link.js";

const VIEWPORT_CONFIG = {};

export function BuilderTerminal({ builderId }: { builderId: string }) {
  const terms = useSyncExternalStore(onTerminals, () => getTerminals(builderId));
  if (!terms) return <Notice>No terminal link for this machine.</Notice>;
  return <LinkedTerminal terms={terms} />;
}

function LinkedTerminal({ terms }: { terms: WorkspaceTerminals }) {
  const status = useSyncExternalStore(fn => terms.onStatus(fn), () => terms.status());
  const tabs = useSyncExternalStore(fn => terms.onTabs(fn), () => terms.tabs());
  const activeId = useSyncExternalStore(fn => terms.onTabs(fn), () => terms.activeId());
  const [refused, setRefused] = useState<string | null>(null);

  useEffect(() => {
    if (status !== "live" || tabs.length > 0 || terms.everOpened()) return;
    terms.ensureOpen().catch((error: unknown) => setRefused(error instanceof Error ? error.message : String(error)));
  }, [terms, status, tabs.length]);

  return (
    <div data-terminal-owner="builder" className="flex h-full min-h-0 flex-col bg-[var(--terminal-background)]">
      {status === "reauth-needed" ? (
        <Notice>The machine refused a stale daemon token. The terminal reconnects with the one wsp holds now.</Notice>
      ) : null}
      {activeId ? (
        <div className="min-h-0 flex-1 p-2">
          <TerminalViewport terminalId={activeId} io={terms.io(activeId)} config={VIEWPORT_CONFIG} focusRequestId={0} autoFocus resizeEpoch={0} drawerHeight={0} />
        </div>
      ) : (
        <Notice>{refused ?? (status !== "live" ? "Waiting for the machine" : terms.everOpened() ? "The terminal was closed" : "Opening a terminal")}</Notice>
      )}
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center px-6 py-4 text-center text-sm text-muted-foreground">{children}</div>;
}
