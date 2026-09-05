// SPDX-License-Identifier: AGPL-3.0-only
// Why a framed dev server shows white: the frame is on another origin, so
// the pane asks the host what one fetch of the route answered and names the
// host check that refused it. Vite reads the allowance the machine's
// environment sets on start; Next.js has no environment route, only its
// config, so its sentence is the whole fix.
import { useEffect, useState } from "react";
import type { PortProbeView } from "@wsp/protocol";
import { useStore } from "../protocol/store.js";

export interface Refusal {
  readonly title: string;
  readonly detail: string;
}

const VITE_BLOCKED = /Blocked request\. This host \(.+\) is not allowed/;

export function explainRefusal(probe: PortProbeView, at: { port: number; host: string }): Refusal | null {
  if (probe.status !== 403) return null;
  const refused = `:${at.port} refused the preview host`;
  if (VITE_BLOCKED.test(probe.body)) {
    return {
      title: refused,
      detail: `Vite blocked the request because ${at.host} is not in server.allowedHosts. Restart the dev server so it picks up the allowance this machine's environment already sets, or add the host to server.allowedHosts in vite.config.`,
    };
  }
  if (probe.body.trim() === "Unauthorized") {
    return {
      title: refused,
      detail: `Next.js blocked a dev request from ${at.host}. Add the host to allowedDevOrigins in next.config and restart the dev server.`,
    };
  }
  return {
    title: `:${at.port} answered 403 through the preview route`,
    detail: `The server on :${at.port} refused ${at.host}. If it checks the Host header, allow that host in its config and restart it.`,
  };
}

/** Asks once per route and per reload; a probe that fails leaves the frame as the only truth. */
export function useRouteRefusal(workspaceId: string, port: number | null, url: string | null, reloadNonce: number): Refusal | null {
  const api = useStore(s => s.api);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  useEffect(() => {
    setRefusal(null);
    if (!api?.portProbe || port === null || url === null) return;
    let gone = false;
    api.portProbe(workspaceId, port).then(
      probe => {
        if (!gone) setRefusal(explainRefusal(probe, { port, host: new URL(url).hostname }));
      },
      () => {},
    );
    return () => {
      gone = true;
    };
  }, [api, workspaceId, port, url, reloadNonce]);

  return refusal;
}
