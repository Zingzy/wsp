// SPDX-License-Identifier: AGPL-3.0-only
// Shown while the runtime socket is closed. The page's only way back is a
// reload: the client authenticates once per socket and has no reconnect.
import { Unplug } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert.js";
import { Button } from "../components/ui/button.js";

export function DisconnectedBanner() {
  return (
    <Alert variant="warning" className="m-2 shrink-0" data-disconnected-banner>
      <Unplug />
      <AlertTitle>wsp is not running.</AlertTitle>
      <AlertDescription>Start wsp in a terminal, then reload this page.</AlertDescription>
      <AlertAction>
        <Button size="compact" variant="outline" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </AlertAction>
    </Alert>
  );
}
