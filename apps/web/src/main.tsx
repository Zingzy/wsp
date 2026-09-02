// SPDX-License-Identifier: AGPL-3.0-only
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./index.css";
import "./tokens.css";

// keys: presence flags only; the host never hands a value to the browser.
const cfg = (window as unknown as { __WSP__: { wsPort: number; token: string; keys?: { anthropic: boolean } } }).__WSP__;
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App wsUrl={`ws://localhost:${cfg.wsPort}`} token={cfg.token} {...(cfg.keys !== undefined ? { keys: cfg.keys } : {})} />
  </StrictMode>,
);
