// SPDX-License-Identifier: AGPL-3.0-only
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./tokens.css";

const cfg = (window as unknown as { __WSP__: { wsPort: number; token: string } }).__WSP__;
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App wsUrl={`ws://localhost:${cfg.wsPort}`} token={cfg.token} />
  </StrictMode>,
);
