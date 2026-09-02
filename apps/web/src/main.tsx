// SPDX-License-Identifier: AGPL-3.0-only
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { GoldenBuilderView } from "@wsp/protocol";
import { App } from "./App.js";
import "./tokens.css";

// keys: presence flags only; the host never hands a value to the browser.
// builder and checklist: the machine wsp init prepared and the sign-ins chosen for it, when this page was opened by it.
const cfg = (
  window as unknown as {
    __WSP__: { wsPort: number; token: string; keys?: { anthropic: boolean }; builder?: GoldenBuilderView; checklist?: { label: string; command: string }[] };
  }
).__WSP__;
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App
      wsUrl={`ws://localhost:${cfg.wsPort}`}
      token={cfg.token}
      {...(cfg.keys !== undefined ? { keys: cfg.keys } : {})}
      {...(cfg.builder !== undefined ? { builder: cfg.builder } : {})}
      {...(cfg.checklist !== undefined ? { checklist: cfg.checklist } : {})}
    />
  </StrictMode>,
);
