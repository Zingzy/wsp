// SPDX-License-Identifier: AGPL-3.0-only
import { createRoot } from "react-dom/client";
import { AppRoot } from "./AppRoot.js";
import "./index.css";

const cfg = (window as unknown as { __WSP__: { wsPort: number; token: string } }).__WSP__;
createRoot(document.getElementById("root")!).render(<AppRoot wsUrl={`ws://localhost:${cfg.wsPort}`} token={cfg.token} />);
