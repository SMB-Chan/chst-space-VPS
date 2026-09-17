/* opencode web — injected "add project" picker (served via nginx on the VPS).
 * Browses the sandbox workspace through opencode's own /api/fs/list (same-origin,
 * already authenticated) and opens the chosen directory via opencode's deep-link
 * mechanism. Requires the page to be served from localhost/127.0.0.1 (isLocal). */
(function () {
  if (window.__ocPickerLoaded) return;
  window.__ocPickerLoaded = true;

  var ROOT = "/workspace";

  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.setAttribute("style", css);
    if (text != null) e.textContent = text;
    return e;
  }
  function join(a, b) {
    return (a.replace(/\/+$/, "") + "/" + b).replace(/\/{2,}/g, "/");
  }
  // mirrors opencode's cn(): base64url(UTF-8(dir)) without padding (URL dir segment)
  function encDir(d) {
    var bytes = new TextEncoder().encode(d);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }
  function createSessionIn(dir) {
    return fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "include",
      body: JSON.stringify({ location: { directory: dir } })
    })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (j) { var id = (j && (j.data || j)).id; if (!id) throw new Error("no session id"); return id; });
  }

  // ---- floating button ----
  var btn = el(
    "button",
    "position:fixed;right:18px;bottom:18px;z-index:2147483647;padding:10px 16px;" +
      "border-radius:12px;border:1px solid #1d4ed8;background:#2563eb;color:#fff;" +
      "font:600 13px/1 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;cursor:pointer;" +
      "box-shadow:0 4px 14px rgba(0,0,0,.35)",
    "\uD83D\uDCC1 \u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u8FFD\u52A0"
  );

  // ---- modal ----
  var overlay = el(
    "div",
    "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:none;" +
      "align-items:center;justify-content:center;font:14px system-ui,-apple-system,'Segoe UI',Roboto,sans-serif"
  );
  var box = el(
    "div",
    "width:min(680px,92vw);max-height:80vh;display:flex;flex-direction:column;background:#1e1e2e;" +
      "color:#e6e6e6;border:1px solid #3a3a4a;border-radius:14px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.5)"
  );
  var head = el("div", "padding:12px 16px;border-bottom:1px solid #3a3a4a;display:flex;align-items:center;gap:8px");
  var crumb = el("div", "flex:1;font-weight:600;white-space:nowrap;overflow:auto", ROOT);
  var upBtn = el("button", "padding:5px 10px;border-radius:8px;border:1px solid #444;background:#2a2a3a;color:#e6e6e6;cursor:pointer", "\u2191 \u4E0A\u3078");
  var closeBtn = el("button", "padding:5px 10px;border-radius:8px;border:1px solid #444;background:#2a2a3a;color:#e6e6e6;cursor:pointer", "\u2715");
  head.appendChild(crumb); head.appendChild(upBtn); head.appendChild(closeBtn);

  var list = el("div", "flex:1;overflow:auto;padding:6px");

  var foot = el("div", "padding:12px 16px;border-top:1px solid #3a3a4a;display:flex;gap:8px;justify-content:flex-end;align-items:center");
  var hint = el("div", "flex:1;color:#9aa0b3;font-size:12px", "\u30D5\u30A9\u30EB\u30C0\u3092\u9078\u3076 \u2192 \u300C\u65B0\u898F\u30BB\u30C3\u30B7\u30E7\u30F3\u300D\u3067\u3053\u306E\u30D1\u30B9\u306E\u30BB\u30C3\u30B7\u30E7\u30F3\u3092\u4F5C\u6210");
  var sessBtn = el("button", "padding:8px 14px;border-radius:10px;border:1px solid #444;background:#2a2a3a;color:#e6e6e6;cursor:pointer", "\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u3092\u958B\u304F");
  var openBtn = el("button", "padding:8px 14px;border-radius:10px;border:0;background:#2563eb;color:#fff;font-weight:600;cursor:pointer", "\u3053\u306E\u30D5\u30A9\u30EB\u30C0\u3067\u65B0\u898F\u30BB\u30C3\u30B7\u30E7\u30F3");
  foot.appendChild(hint); foot.appendChild(sessBtn); foot.appendChild(openBtn);

  box.appendChild(head); box.appendChild(list); box.appendChild(foot);
  overlay.appendChild(box);

  function mount() {
    var host = document.body || document.documentElement;
    host.appendChild(btn);
    host.appendChild(overlay);
  }

  var current = ROOT;

  function row(name, full) {
    var r = el("div", "padding:9px 12px;border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:8px");
    r.appendChild(el("span", "", "\uD83D\uDCC1"));
    r.appendChild(el("span", "flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", name));
    r.onmouseenter = function () { r.style.background = "#2a2a3a"; };
    r.onmouseleave = function () { r.style.background = "transparent"; };
    r.onclick = function () { current = full; render(); };
    return r;
  }

  function fetchDirs(dir) {
    var url = "/api/fs/list?location%5Bdirectory%5D=" + encodeURIComponent(dir);
    return fetch(url, { headers: { Accept: "application/json" }, credentials: "include" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (j) {
        return (j.data || [])
          .filter(function (x) { return x.type === "directory"; })
          .map(function (x) { var n = x.path.replace(/\/+$/, ""); return { name: n, full: join(dir, n) }; })
          .sort(function (a, b) { return a.name.localeCompare(b.name); });
      });
  }

  function render() {
    crumb.textContent = current;
    list.textContent = "";
    list.appendChild(el("div", "padding:16px;color:#9aa0b3", "\u8AAD\u307F\u8FBC\u307F\u4E2D\u2026"));
    fetchDirs(current).then(
      function (dirs) {
        list.textContent = "";
        if (!dirs.length) list.appendChild(el("div", "padding:16px;color:#9aa0b3", "(\u7A7A)"));
        dirs.forEach(function (d) { list.appendChild(row(d.name, d.full)); });
        var atRoot = (current === ROOT || current === "/");
        upBtn.disabled = atRoot;
        upBtn.style.opacity = atRoot ? ".4" : "1";
      },
      function (e) {
        list.textContent = "";
        list.appendChild(el("div", "padding:16px;color:#ff8080", "\u30A8\u30E9\u30FC: " + e.message));
      }
    );
  }

  function fire(hostname, dir, prompt) {
    var url = "opencode://" + hostname + "?directory=" + encodeURIComponent(dir);
    if (prompt) url += "&prompt=" + encodeURIComponent(prompt);
    try {
      window.__OPENCODE__ = window.__OPENCODE__ || {};
      window.__OPENCODE__.deepLinks = window.__OPENCODE__.deepLinks || [];
      window.__OPENCODE__.deepLinks.push(url);
    } catch (e) {}
    window.dispatchEvent(new CustomEvent("opencode:deep-link", { detail: { urls: [url] } }));
  }

  function openOverlay() {
    if (!current) current = ROOT;
    overlay.style.display = "flex";
    render();
  }
  function closeOverlay() { overlay.style.display = "none"; }

  btn.onclick = openOverlay;
  closeBtn.onclick = closeOverlay;
  overlay.onclick = function (e) { if (e.target === overlay) closeOverlay(); };
  upBtn.onclick = function () {
    if (current === ROOT || current === "/") return;
    var parent = current.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
    if (parent.length < ROOT.length) parent = ROOT;
    current = parent;
    render();
  };
  openBtn.onclick = function () {
    var dir = current;
    closeOverlay();
    createSessionIn(dir).then(
      function (id) { window.location.href = "/" + encDir(dir) + "/session/" + id; },
      function () { fire("new-session", dir, "pwd"); }
    );
  };
  sessBtn.onclick = function () { fire("open-project", current); closeOverlay(); };
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeOverlay(); });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
