// SPDX-License-Identifier: AGPL-3.0-only
import { createRoot } from "react-dom/client";
import { BootGate } from "./BootGate.js";
import { GlassGround } from "./components/GlassGround.js";
import { MaterialPanel } from "./components/MaterialPanel.js";
import { bootPayload } from "./boot.js";
import "./index.css";
import "./themes/index.js";

const cfg = bootPayload();
if (cfg === undefined) throw new Error("the page has no window.__WSP__ boot object");
// React's dev build writes a performance measure per component render and nothing clears them; a window left open
// for hours held millions.
if (import.meta.env.DEV) setInterval(() => performance.clearMeasures(), 60_000);

createRoot(document.getElementById("root")!).render(
  <>
    <GlassGround />
    {import.meta.env.DEV ? <MaterialPanel /> : null}
    <BootGate boot={cfg} at={window.location} agent={navigator.userAgent} storage={window.localStorage} />
  </>,
);
