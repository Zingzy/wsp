// SPDX-License-Identifier: AGPL-3.0-only
// The localhost status shell: one static page that renders /api/workspaces
// client-side every 5s. The full tabs UI is Plan 3; this page only has to be
// an honest live view, so it stays dependency-free and inline.

export const SHELL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>wsp</title>
<style>
  :root {
    --bg: #09090b;
    --surface: #101013;
    --raise: #1a1a1f;
    --line: rgba(255, 255, 255, 0.05);
    --edge: rgba(255, 255, 255, 0.1);
    --text: #e4e4e7;
    --muted: #8f8f98;
    --ok: #4ade80;
    --bad: #f87171;
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font: 13px/1.5 ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    font-variant-numeric: tabular-nums;
    min-height: 100vh;
    display: flex;
    justify-content: center;
  }
  main {
    width: min(820px, 100%);
    min-height: 100vh;
    border-left: 1px solid var(--line);
    border-right: 1px solid var(--line);
    padding: 0 28px;
  }
  header {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 22px 0 18px;
    border-bottom: 1px solid var(--line);
  }
  header .name { font-size: 15px; font-weight: 600; letter-spacing: 0.02em; }
  header .tag { color: var(--muted); font-size: 12px; }
  header .clock { margin-left: auto; color: var(--muted); font-size: 12px; }
  .zone {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 18px 0 12px;
  }
  .zone .label {
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .zone .count { font-size: 10px; color: var(--muted); }
  form { margin-left: auto; display: flex; gap: 8px; }
  input {
    background: transparent;
    border: 1px solid var(--edge);
    border-radius: 6px;
    color: var(--text);
    font: inherit;
    font-size: 12px;
    padding: 4px 9px;
    width: 150px;
  }
  input:focus-visible { outline: none; border-color: rgba(255, 255, 255, 0.28); }
  input::placeholder { color: var(--muted); }
  button {
    background: #ececef;
    color: #0a0a0c;
    border: 1px solid transparent;
    border-radius: 6px;
    box-shadow: inset 0 0.7px 0 rgba(255, 255, 255, 0.6);
    font: inherit;
    font-size: 12px;
    padding: 4px 11px;
    cursor: pointer;
    transition: background 160ms ease;
  }
  button:hover { background: #ffffff; }
  button:active { background: #d9d9de; }
  button:disabled { opacity: 0.55; cursor: default; }
  .error { color: var(--bad); font-size: 12px; padding: 0 0 10px; min-height: 18px; }
  .head, .row {
    display: grid;
    grid-template-columns: minmax(7rem, 1.1fr) 5.5rem 10.5rem minmax(6rem, 1fr) 4rem;
    gap: 14px;
    align-items: center;
  }
  .head {
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
    padding: 6px 0;
    border-bottom: 1px solid var(--edge);
  }
  .row { height: 40px; border-bottom: 1px solid var(--line); }
  .row .id { color: var(--muted); font-size: 11px; }
  .row .cell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .dim { color: var(--muted); }
  .reach { display: flex; align-items: center; gap: 7px; }
  .reach .dot {
    width: 6px; height: 6px; border-radius: 999px;
    background: var(--ok);
    box-shadow: 0 0 6px rgba(74, 222, 128, 0.55);
  }
  .empty {
    height: 180px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    background-image: radial-gradient(rgba(255, 255, 255, 0.05) 1px, transparent 1px);
    background-size: 14px 14px;
  }
  .empty .ghost {
    border: 1px dashed var(--edge);
    border-radius: 6px;
    padding: 5px 12px;
    font-size: 12px;
    color: var(--muted);
  }
  .empty .hint { font-size: 12px; color: var(--muted); }
  footer { padding: 16px 0 24px; color: var(--muted); font-size: 11px; }
</style>
</head>
<body>
<main>
  <header>
    <span class="name">wsp</span>
    <span class="tag">local workspaces</span>
    <span class="clock" id="clock"></span>
  </header>
  <div class="zone">
    <span class="label">Workspaces</span>
    <span class="count" id="count"></span>
    <form id="create">
      <input id="name" placeholder="name" autocomplete="off" spellcheck="false" maxlength="40">
      <button id="submit" type="submit">new workspace</button>
    </form>
  </div>
  <div class="error" id="error"></div>
  <div id="list"></div>
  <footer>runtime __WS_ENDPOINT__ · keys never leave this machine</footer>
</main>
<script>
  const $ = id => document.getElementById(id);
  const REACH_WORDS = {
    reachable: "reachable",
    "no-daemon": "no daemon",
    unreachable: "unreachable",
    napping: "napping",
    unsupported: "unsupported",
    gone: "gone",
  };

  function cell(cls, text, title) {
    const el = document.createElement("span");
    el.className = "cell " + cls;
    el.textContent = text;
    if (title) el.title = title;
    return el;
  }

  function age(iso) {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 90) return Math.round(s) + "s";
    if (s < 5400) return Math.round(s / 60) + "m";
    if (s < 129600) return Math.round(s / 3600) + "h";
    return Math.round(s / 86400) + "d";
  }

  function reachCell(reach) {
    const el = document.createElement("span");
    el.className = "cell reach";
    if (reach.state === "reachable") {
      const dot = document.createElement("span");
      dot.className = "dot";
      el.append(dot);
      const mins = Math.max(0, Math.round((reach.expiresAt - Date.now()) / 60000));
      el.append(cell("", "reachable · " + mins + "m", reach.url));
    } else {
      el.append(cell("dim", REACH_WORDS[reach.state] || reach.state));
    }
    return el;
  }

  function render(workspaces) {
    const list = $("list");
    list.replaceChildren();
    $("count").textContent = String(workspaces.length);
    if (workspaces.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      const ghost = document.createElement("span");
      ghost.className = "ghost";
      ghost.textContent = "no workspaces yet";
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = "fork one from the golden image to get started";
      empty.append(ghost, hint);
      list.append(empty);
      return;
    }
    const head = document.createElement("div");
    head.className = "head";
    for (const h of ["name", "state", "reach", "machine", "age"]) head.append(cell("", h));
    list.append(head);
    for (const w of workspaces) {
      const row = document.createElement("div");
      row.className = "row";
      const name = cell("", w.name);
      const id = document.createElement("span");
      id.className = "id";
      id.textContent = " " + w.id;
      name.append(id);
      row.append(
        name,
        cell("dim", w.machineState),
        reachCell(w.reach),
        cell("dim", w.machineId, w.machineId),
        cell("dim", age(w.createdAt)),
      );
      list.append(row);
    }
  }

  async function load() {
    try {
      const res = await fetch("/api/workspaces");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "HTTP " + res.status);
      render(body.workspaces);
      const now = new Date();
      $("clock").textContent = "updated " + now.toTimeString().slice(0, 8);
      $("error").textContent = "";
    } catch (e) {
      $("error").textContent = String(e.message || e);
    }
  }

  $("create").addEventListener("submit", async e => {
    e.preventDefault();
    const name = $("name").value.trim();
    if (!name) return;
    $("submit").disabled = true;
    try {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "HTTP " + res.status);
      $("name").value = "";
      $("error").textContent = "";
      await load();
    } catch (e2) {
      $("error").textContent = String(e2.message || e2);
    } finally {
      $("submit").disabled = false;
    }
  });

  load();
  setInterval(load, 5000);
</script>
</body>
</html>
`;
