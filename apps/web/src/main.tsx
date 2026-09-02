// SPDX-License-Identifier: AGPL-3.0-only
import { createRoot } from "react-dom/client";
import { AppRoot, type AppRootProps } from "./AppRoot.js";
import "./index.css";
import "./tokens.css";

// keys: presence flags only; the host never hands a value to the browser.
// builder and checklist: the machine wsp init prepared and the sign-ins chosen for it, when this page was opened by it.
const cfg = (
  window as unknown as {
    __WSP__: { wsPort: number; token: string } & Pick<AppRootProps, "keys" | "builder" | "checklist">;
  }
).__WSP__;
createRoot(document.getElementById("root")!).render(
  <AppRoot
    wsUrl={`ws://localhost:${cfg.wsPort}`}
    token={cfg.token}
    {...(cfg.keys !== undefined ? { keys: cfg.keys } : {})}
    {...(cfg.builder !== undefined ? { builder: cfg.builder } : {})}
    {...(cfg.checklist !== undefined ? { checklist: cfg.checklist } : {})}
  />,
);
