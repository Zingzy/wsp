// SPDX-License-Identifier: AGPL-3.0-only
import { createRoot } from "react-dom/client";
import { AppRoot } from "./AppRoot.js";
import { bootPayload } from "./boot.js";
import "./index.css";

const cfg = bootPayload();
if (cfg === undefined) throw new Error("the page has no window.__WSP__ boot object");
createRoot(document.getElementById("root")!).render(<AppRoot wsUrl={`ws://localhost:${cfg.wsPort}`} token={cfg.token} />);
