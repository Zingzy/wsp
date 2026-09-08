/* SPDX-License-Identifier: AGPL-3.0-only */
// highlight.js knows shell built-ins, strings and comments, and nothing about wsp or its flags. This colors the
// command word, the flags and the <placeholders> in shell blocks, leaving the text itself untouched.
(function () {
  var SHELL = /(^|\s)language-(bash|sh|shell|zsh|console)(\s|$)/;
  var OPENERS = { "|": 1, "||": 1, "&&": 1, ";": 1, "$(": 1, sudo: 1, exec: 1, env: 1, time: 1, xargs: 1, then: 1, do: 1, else: 1 };

  function wrap(text, cls) {
    var s = document.createElement("span");
    s.className = cls;
    s.textContent = text;
    return s;
  }

  function insideToken(node) {
    for (var p = node.parentNode; p && p.nodeType === 1 && !p.classList.contains("t-code__line") && p.tagName !== "CODE"; p = p.parentNode) {
      if (/(^|\s)hljs-/.test(p.className)) return true;
    }
    return false;
  }

  function colorLine(line) {
    var expectCmd = true;
    var walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    var texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    texts.forEach(function (node) {
      if (insideToken(node)) { expectCmd = false; return; }
      var parts = node.nodeValue.split(/(\s+)/);
      var frag = document.createDocumentFragment();
      var changed = false;
      parts.forEach(function (part) {
        if (part === "" ) return;
        if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
        if (OPENERS[part]) { expectCmd = true; frag.appendChild(document.createTextNode(part)); return; }
        if (expectCmd) {
          if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(part)) { frag.appendChild(wrap(part, "wsp-hl-var")); changed = true; return; }
          expectCmd = false;
          frag.appendChild(wrap(part, "wsp-hl-cmd")); changed = true; return;
        }
        if (/^--?[A-Za-z][\w-]*(=.*)?$/.test(part)) { frag.appendChild(wrap(part, "wsp-hl-flag")); changed = true; return; }
        if (/^<[^<>]+>[,.]?$/.test(part)) { frag.appendChild(wrap(part, "wsp-hl-ph")); changed = true; return; }
        frag.appendChild(document.createTextNode(part));
      });
      if (changed) node.parentNode.replaceChild(frag, node);
    });
  }

  function colorBlock(code) {
    code.setAttribute("data-wsp-hl", "1");
    // The bash grammar reads the "in" of --in and the "do" of a path as keywords; those spans go, their text stays.
    Array.prototype.forEach.call(code.querySelectorAll(".hljs-keyword, .hljs-built_in"), function (s) {
      s.replaceWith(document.createTextNode(s.textContent));
    });
    code.normalize();
    var lines = code.querySelectorAll(".t-code__line");
    if (lines.length === 0) { colorLine(code); return; }
    Array.prototype.forEach.call(lines, colorLine);
  }

  // One ASCII glyph per sidebar section title, drawn by custom.css from the attribute.
  var GLYPHS = { "Start here": ">_", "Setup": "[]", "Working": "~", "Agents": "@", "Reference": "#", "Project": "+" };
  function glyphs() {
    Array.prototype.forEach.call(document.querySelectorAll(".group\\/sidebar-section > .group\\/button > .group\\/button-label:not([data-wsp-glyph])"), function (label) {
      var g = GLYPHS[label.textContent.trim()];
      if (g) label.setAttribute("data-wsp-glyph", g);
    });
  }

  function run() {
    glyphs();
    Array.prototype.forEach.call(document.querySelectorAll("pre code:not([data-wsp-hl])"), function (code) {
      if (SHELL.test(code.className)) colorBlock(code);
    });
  }

  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; run(); });
  }

  function start() {
    run();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  }
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
})();
