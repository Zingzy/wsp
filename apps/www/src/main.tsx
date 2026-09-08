// SPDX-License-Identifier: AGPL-3.0-only
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Analytics } from "@vercel/analytics/react";
import "./index.css";
import { App } from "./App";

const root = document.getElementById("root");
if (root) createRoot(root).render(
  <StrictMode>
    <App />
    <Analytics />
  </StrictMode>,
);
