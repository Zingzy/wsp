// SPDX-License-Identifier: AGPL-3.0-only
import { StrictMode, startTransition } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import "./index.css";
import { startAnalytics } from "./lib/analytics";
import { App } from "./App";

const root = document.getElementById("root");
const page = (
  <StrictMode>
    <App path={location.pathname} />
  </StrictMode>
);
// The build prerenders every page; only vite's dev server hands over an empty root. Hydrating as a transition lets it
// yield to the browser between pieces, so a phone paints and scrolls while it runs.
if (root?.firstElementChild) startTransition(() => void hydrateRoot(root, page));
else if (root) createRoot(root).render(page);
startAnalytics();
