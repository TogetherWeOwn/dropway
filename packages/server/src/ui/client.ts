// @ts-nocheck
/**
 * Browser code for the app-origin pages (home, sign-in, dashboard, file viewer).
 *
 * This whole file is ONE self-contained function. ./assets.ts serves its
 * source text (Function.prototype.toString) as /__dropway/ui/app-<hash>.js, so
 * there is no build step and no bundler config for embedding apps to copy.
 * Rules for editing:
 * - Never reference anything outside dropwayClient() (no imports, no module-level values).
 * - Plain modern JavaScript; TypeScript annotations would survive into the browser.
 * - Never put API data into innerHTML: build DOM with h() / text nodes.
 * - Every action calls the public REST API (/api/v1), the same one agents use.
 *
 * Type checking is off for this file (DOM types are not loaded in this Workers
 * project). The suite checks the served script is self-contained; flows were
 * checked in a real browser (see the PR / commit notes).
 */
export function dropwayClient(motifsFactory) {
  "use strict";
  var d = document;
  // Seals and plates (./motifs.ts), passed in by ./assets.ts; null if absent.
  var M = typeof motifsFactory === "function" ? motifsFactory() : null;
  var bootEl = d.getElementById("dw-boot");
  var boot = bootEl ? JSON.parse(bootEl.textContent || "{}") : {};
  var P = boot.page || {};
  var KEY = "dropway.key";
  var ME = "dropway.me";
  // Cookie sessions from an embedding app (uiSlots.session): { signIn, signOut } or null.
  var SESSION = boot.session || null;
  var sessionOk = false;
  var TEXT_KINDS = ["html", "markdown", "svg", "json", "csv", "code", "text", "notebook"];

  // ------------------------------------------------------------------ storage

  function store(kind) {
    try {
      return kind === "local" ? window.localStorage : window.sessionStorage;
    } catch (e) {
      return null;
    }
  }
  function getKey() {
    var s = store("session");
    var l = store("local");
    return (s && s.getItem(KEY)) || (l && l.getItem(KEY)) || "";
  }
  function setKey(k, remember) {
    var s = store("session");
    var l = store("local");
    if (s) {
      s.setItem(KEY, k);
      s.removeItem(ME);
    }
    if (l) {
      if (remember) l.setItem(KEY, k);
      else l.removeItem(KEY);
    }
  }
  function clearKey() {
    var s = store("session");
    var l = store("local");
    if (s) {
      s.removeItem(KEY);
      s.removeItem(ME);
    }
    if (l) l.removeItem(KEY);
  }

  /** Signed in: an API key in this browser, or (with uiSlots.session) a live cookie session. */
  function authed() {
    return !!getKey() || sessionOk;
  }

  /** Where to send people to sign in, coming back to `next` afterwards. */
  function signInHref(next, extra) {
    var base = SESSION ? SESSION.signIn : "/login";
    var q = (next ? "next=" + encodeURIComponent(next) : "") + (extra ? (next ? "&" : "") + extra : "");
    return q ? base + (base.indexOf("?") >= 0 ? "&" : "?") + q : base;
  }

  /** End the session: forget the key, and with cookie sessions POST to the embedding app's sign-out path. */
  function signOut() {
    var hadKey = !!getKey();
    clearKey();
    if (SESSION && (sessionOk || !hadKey)) {
      var f = h("form", { method: "post", action: SESSION.signOut, hidden: true });
      d.body.appendChild(f);
      f.submit();
      return;
    }
    location.href = "/login?signedout=1";
  }

  // ------------------------------------------------------------------ API

  function apiError(status, data, fallback) {
    var e = (data && data.error) || {};
    var err = new Error(e.message || fallback || "Request failed (HTTP " + status + ").");
    err.status = status;
    err.code = e.code || null;
    err.hint = e.hint || null;
    err.details = e.details || null;
    return err;
  }

  /** Same-origin path for an absolute URL the API returned (so the CSP stays 'self'). */
  function localPath(url) {
    try {
      var u = new URL(url, location.href);
      return u.pathname + u.search;
    } catch (e) {
      return url;
    }
  }

  async function api(path, opts) {
    opts = opts || {};
    var headers = new Headers(opts.headers || {});
    var key = opts.key !== undefined ? opts.key : getKey();
    if (key) headers.set("Authorization", "Bearer " + key);
    headers.set("X-Kofra-Client", "dashboard/1");
    var body = opts.body;
    var isRaw = typeof Blob !== "undefined" && body instanceof Blob;
    if (body !== undefined && body !== null && !isRaw && typeof body !== "string") {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(body);
    }
    var url = path.charAt(0) === "/" && path.indexOf(boot.api) !== 0 && !opts.abs ? boot.api + path : path;
    var res;
    try {
      res = await fetch(url, { method: opts.method || (body !== undefined ? "POST" : "GET"), headers: headers, body: body });
    } catch (e) {
      throw apiError(0, null, "Could not reach the server. Check your connection and retry.");
    }
    if (opts.raw) {
      if (!res.ok) {
        var t = await res.text();
        var j = null;
        try {
          j = JSON.parse(t);
        } catch (e) {}
        throw apiError(res.status, j);
      }
      return res;
    }
    var text = await res.text();
    var data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {}
    if (!res.ok) {
      var err = apiError(res.status, data);
      if (res.status === 401 && key && opts.key === undefined && ["invalid_api_key", "key_expired", "unauthorized"].indexOf(err.code) >= 0) {
        clearKey();
        location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search) + "&expired=1";
      } else if (res.status === 401 && !key && sessionOk && opts.key === undefined) {
        sessionOk = false;
        location.href = signInHref(location.pathname + location.search, "expired=1");
      }
      throw err;
    }
    return data;
  }

  // ------------------------------------------------------------------ DOM helpers

  function h(tag, props) {
    var el = d.createElement(tag);
    if (props) {
      for (var k in props) {
        var v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k.indexOf("on") === 0 && typeof v === "function") el.addEventListener(k.slice(2), v);
        else if (k === "value") el.value = v;
        else if (k === "checked") el.checked = !!v;
        else if (v === true) el.setAttribute(k, "");
        else el.setAttribute(k, String(v));
      }
    }
    for (var i = 2; i < arguments.length; i++) addOne(el, arguments[i]);
    return el;
  }
  /** add(el, child, child, ...): append children (nodes, strings, arrays; null/false skipped). */
  function add(el) {
    for (var i = 1; i < arguments.length; i++) addOne(el, arguments[i]);
    return el;
  }
  function addOne(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) {
      for (var i = 0; i < c.length; i++) addOne(el, c[i]);
      return;
    }
    el.appendChild(typeof c === "object" && c.nodeType ? c : d.createTextNode(String(c)));
  }
  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }
  function $(sel, root) {
    return (root || d).querySelector(sel);
  }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || d).querySelectorAll(sel));
  }

  function bytes(n) {
    if (n === null || n === undefined) return "";
    if (n < 1024) return n + " B";
    var u = ["KB", "MB", "GB", "TB"];
    var v = n / 1024;
    var i = 0;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return v.toFixed(v < 10 ? 1 : 0) + " " + u[i];
  }
  function ago(iso) {
    if (!iso) return "";
    var t = new Date(iso).getTime();
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 45) return "just now";
    var m = Math.round(s / 60);
    if (m < 60) return m + " min ago";
    var hr = Math.round(m / 60);
    if (hr < 24) return hr + " h ago";
    var days = Math.round(hr / 24);
    if (days < 30) return days + (days === 1 ? " day ago" : " days ago");
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  function encodePath(p) {
    return p.split("/").map(encodeURIComponent).join("/");
  }
  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many || one + "s");
  }
  /** Date and time in the reader's time zone, with the zone named (DESIGN.md: times always show a zone). */
  function localTime(iso) {
    if (!iso) return "";
    try {
      // Explicit fields: dateStyle/timeStyle cannot be combined with timeZoneName (that throws a TypeError).
      return new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    } catch (e) {
      // Still name the zone if the engine rejects the options or the date.
      const d = new Date(iso);
      return isNaN(d.getTime()) ? String(iso) : d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
    }
  }
  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  /** A dashboard block: <section class="k-blk"> with a header row (serif h2, optional tools). */
  function blk(title, tools) {
    var sec = h("section", { class: "k-blk" }, h("div", { class: "k-blk-h" }, h("h2", { text: title }), tools ? h("div", { class: "k-tools" }, tools) : null));
    for (var i = 2; i < arguments.length; i++) addOne(sec, arguments[i]);
    return sec;
  }
  /**
   * A file's checksum seal (seeded with its SHA-256) beside the short hash. The mark only shows which
   * bytes were stored: it never says a file is safe.
   */
  function sealFor(path, sha, opts) {
    opts = opts || {};
    if (!M || !/^[0-9a-f]{64}$/.test(String(sha))) return null;
    var box = h("span", { class: "k-sum" + (opts.mini ? " k-mini" : "") + (opts.hideSm ? " k-hide-sm" : "") });
    // Parsed as SVG, never written as HTML; the seal holds only numbers derived from the hex checksum.
    var parsed = new DOMParser().parseFromString(M.seal("SHA256:" + sha, { size: "mini" }), "image/svg+xml").documentElement;
    var svg = parsed && parsed.nodeName === "svg" ? d.importNode(parsed, true) : null;
    if (svg) {
      svg.removeAttribute("aria-hidden");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", "Checksum seal for " + path + ", SHA-256 " + sha.slice(0, 12));
      box.appendChild(svg);
    }
    if (!opts.noText) add(box, opts.full
      ? h("details", { class: "k-checksum" }, h("summary", { text: "SHA-256 " + sha.slice(0, 12) + "…" }), h("code", { text: sha }))
      : h("span", {}, h("code", { title: "SHA-256 " + sha, text: sha.slice(0, 12) + "…" }), opts.caption ? h("span", { class: "k-small", text: opts.caption }) : null));
    return box;
  }

  function toast(msg, isError) {
    var box = d.getElementById("dw-toasts");
    if (!box) return;
    var t = h("div", { class: "k-toast" + (isError ? " k-danger" : ""), role: isError ? "alert" : null, text: msg });
    box.appendChild(t);
    setTimeout(function () {
      t.remove();
    }, isError ? 7000 : 3200);
  }

  function errorBox(err, prefix) {
    return h(
      "div",
      { class: "k-banner k-danger", role: "alert" },
      h(
        "div",
        {},
        h("strong", { text: (prefix ? prefix + ": " : "") + (err && err.message ? err.message : String(err)) }),
        err && err.hint ? h("p", { class: "k-small", text: err.hint }) : null,
        err && err.code ? h("p", { class: "k-small k-mono", text: err.code }) : null,
      ),
    );
  }

  async function copyText(text, btn) {
    var ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      var ta = h("textarea", { style: "position:fixed;opacity:0;top:0;left:0" });
      ta.value = text;
      d.body.appendChild(ta);
      ta.select();
      try {
        ok = d.execCommand("copy");
      } catch (e2) {}
      ta.remove();
    }
    if (btn) {
      var old = btn.getAttribute("data-label") || btn.textContent;
      btn.setAttribute("data-label", old);
      btn.textContent = ok ? "Copied" : "Copy failed";
      setTimeout(function () {
        btn.textContent = old;
      }, 1400);
    } else toast(ok ? "Copied" : "Copy failed", !ok);
    return ok;
  }
  function copyButton(getText, label) {
    return h("button", {
      type: "button",
      class: "k-btn k-sm k-ghost",
      "aria-label": label || "Copy",
      text: "Copy",
      onclick: function (ev) {
        copyText(typeof getText === "function" ? getText() : getText, ev.currentTarget);
      },
    });
  }

  /** Modal confirmation. typeToConfirm: the user must type this value. Resolves true or false. */
  function confirmBox(opts) {
    return new Promise(function (resolve) {
      var input = opts.typeToConfirm ? h("input", { class: "k-input k-mono", id: "dw-dlg-input", autocomplete: "off", spellcheck: "false" }) : null;
      var ok = h("button", { class: "k-btn" + (opts.danger === false ? "" : " k-danger"), value: "ok", text: opts.confirmText || "Confirm", disabled: !!input });
      var dlg = h(
        "dialog",
        { class: "k-dlg" + (opts.danger === false ? "" : " k-warn"), "aria-labelledby": "dw-dlg-title", "aria-describedby": opts.message ? "dw-dlg-msg" : null },
        h(
          "form",
          { method: "dialog" },
          h("h2", { id: "dw-dlg-title", text: opts.title }),
          opts.message ? h("p", { id: "dw-dlg-msg", text: opts.message }) : null,
          input ? h("label", { class: "k-label", for: "dw-dlg-input", text: "Type " + opts.typeToConfirm + " to confirm" }) : null,
          input,
          h("div", { class: "k-btnrow" }, h("button", { class: "k-btn k-ghost", value: "cancel", text: "Cancel" }), ok),
        ),
      );
      if (input)
        input.addEventListener("input", function () {
          ok.disabled = input.value.trim() !== opts.typeToConfirm;
        });
      dlg.addEventListener("close", function () {
        var yes = dlg.returnValue === "ok" && (!input || input.value.trim() === opts.typeToConfirm);
        dlg.remove();
        resolve(yes);
      });
      d.body.appendChild(dlg);
      dlg.showModal();
      (input || ok).focus();
    });
  }

  /** A secret shown once, with Copy. */
  function secretBlock(title, value, note) {
    return h(
      "div",
      { class: "k-keyout", role: "status" },
      h("span", { class: "k-k", text: "Shown once" }),
      h("strong", { text: title }),
      h("div", { class: "k-keyout-row" }, h("code", { text: value }), copyButton(value, "Copy key")),
      note ? h("p", { class: "k-small", text: note }) : null,
    );
  }

  function skeleton(n) {
    var out = [];
    for (var i = 0; i < (n || 3); i++) out.push(h("div", { class: "k-skel", "aria-hidden": "true" }));
    return h("div", { "aria-busy": "true" }, h("span", { class: "k-sr", text: "Loading" }), out);
  }

  function safeNext(n) {
    return n && n.charAt(0) === "/" && n.charAt(1) !== "/" && n.charAt(1) !== "\\" ? n : "/dashboard";
  }

  // ------------------------------------------------------------------ account

  async function me() {
    var s = store("session");
    var cached = getKey() && s && s.getItem(ME);
    if (cached) {
      try {
        var c = JSON.parse(cached);
        if (c.key === getKey() && Date.now() - c.at < 5 * 60 * 1000) return c.me;
      } catch (e) {}
    }
    var m = await api("/me");
    if (s && getKey()) s.setItem(ME, JSON.stringify({ key: getKey(), at: Date.now(), me: m }));
    return m;
  }

  function can(m, scope) {
    return !!(m && m.scopes && m.scopes.indexOf(scope) >= 0);
  }

  async function renderAccount() {
    var box = d.getElementById("dw-account");
    if (!box) return null;
    if (!authed()) return null;
    try {
      var m = await me();
      if (m.principal !== "member") return null;
      clear(box);
      var who = (m.member && (m.member.email || m.member.name)) || "Signed in";
      add(
        box,
        h("span", { class: "k-who", title: (m.member && m.member.role) || "", text: who }),
        h("button", {
          type: "button",
          class: "k-btn k-sm k-quiet",
          text: "Sign out",
          onclick: signOut,
        }),
      );
      return m;
    } catch (e) {
      return null;
    }
  }

  function requireAuth() {
    if (authed()) return true;
    location.replace(signInHref(location.pathname + location.search));
    return false;
  }

  /** Buttons with data-copy="#id" copy that element's text; data-copy-text copies the attribute. */
  function wireCopyButtons(root) {
    $$("[data-copy],[data-copy-text]", root).forEach(function (b) {
      b.hidden = false;
      b.addEventListener("click", function () {
        var t = b.getAttribute("data-copy-text");
        if (t === null) {
          var el = $(b.getAttribute("data-copy"));
          t = el ? el.textContent : "";
        }
        copyText(t, b);
      });
    });
  }

  /** <div role="tablist"> with buttons aria-controls=panel ids. */
  function wireTabs(root) {
    $$("[role=tablist]", root).forEach(function (list) {
      var tabs = $$("[role=tab]", list);
      function select(tab) {
        tabs.forEach(function (t) {
          var on = t === tab;
          t.setAttribute("aria-selected", on ? "true" : "false");
          t.tabIndex = on ? 0 : -1;
          var p = d.getElementById(t.getAttribute("aria-controls"));
          if (p) p.hidden = !on;
        });
      }
      tabs.forEach(function (t, i) {
        t.addEventListener("click", function () {
          select(t);
        });
        t.addEventListener("keydown", function (e) {
          var j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : -1;
          if (j < 0 && e.key !== "ArrowLeft") return;
          var n = tabs[(j + tabs.length) % tabs.length];
          n.focus();
          select(n);
        });
      });
    });
  }

  // ------------------------------------------------------------------ publisher (drag and drop)

  var IGNORE_SEGMENTS = [".git", "node_modules", "__MACOSX", ".svn", ".hg"];
  var IGNORE_NAMES = [".DS_Store", "Thumbs.db", "desktop.ini"];

  function ignored(path) {
    var segs = path.split("/");
    var name = segs[segs.length - 1];
    if (IGNORE_NAMES.indexOf(name) >= 0) return "system file";
    if (name === ".env" || name.indexOf(".env.") === 0) return "may contain secrets";
    for (var i = 0; i < segs.length - 1; i++) if (IGNORE_SEGMENTS.indexOf(segs[i]) >= 0) return segs[i] + " folder";
    return null;
  }

  /** If every path starts with the same folder, drop it (dropping "dist" publishes its contents). */
  function stripCommonRoot(items) {
    if (!items.length) return items;
    var first = items[0].path.split("/")[0];
    for (var i = 0; i < items.length; i++) {
      var p = items[i].path;
      if (p.indexOf("/") < 0 || p.split("/")[0] !== first) return items;
    }
    return items.map(function (it) {
      return { path: it.path.slice(first.length + 1), file: it.file };
    });
  }

  function readEntry(entry, prefix, out) {
    return new Promise(function (resolve) {
      if (entry.isFile) {
        entry.file(
          function (f) {
            out.push({ path: prefix + f.name, file: f });
            resolve();
          },
          function () {
            resolve();
          },
        );
      } else if (entry.isDirectory) {
        var reader = entry.createReader();
        var all = [];
        var next = function () {
          reader.readEntries(
            function (batch) {
              if (!batch.length) {
                Promise.all(
                  all.map(function (e) {
                    return readEntry(e, prefix + entry.name + "/", out);
                  }),
                ).then(function () {
                  resolve();
                });
                return;
              }
              all = all.concat(Array.prototype.slice.call(batch));
              next();
            },
            function () {
              resolve();
            },
          );
        };
        next();
      } else resolve();
    });
  }

  async function filesFromDrop(dt) {
    var entries = [];
    if (dt.items) {
      for (var i = 0; i < dt.items.length; i++) {
        var it = dt.items[i];
        var en = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
        if (en) entries.push(en);
      }
    }
    if (!entries.length) {
      return Array.prototype.map.call(dt.files || [], function (f) {
        return { path: f.name, file: f };
      });
    }
    var out = [];
    await Promise.all(
      entries.map(function (e) {
        return readEntry(e, "", out);
      }),
    );
    return out;
  }

  async function sha256Hex(file) {
    var buf = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    var b = new Uint8Array(buf);
    var s = "";
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return s;
  }

  async function pool(items, size, fn) {
    var i = 0;
    var workers = [];
    for (var w = 0; w < Math.min(size, items.length); w++) {
      workers.push(
        (async function () {
          while (i < items.length) {
            var idx = i++;
            await fn(items[idx], idx);
          }
        })(),
      );
    }
    await Promise.all(workers);
  }

  async function putBlob(item, file, key) {
    var lastErr = null;
    for (var attempt = 0; attempt < 4; attempt++) {
      var res;
      try {
        res = await fetch(localPath(item.url), {
          method: "PUT",
          headers: Object.assign(key ? { Authorization: "Bearer " + key } : {}, { "Content-Type": (item.headers && item.headers["Content-Type"]) || "application/octet-stream", "X-Kofra-Client": "dashboard/1" }),
          body: file,
        });
      } catch (e) {
        lastErr = apiError(0, null, "Upload of " + item.paths[0] + " failed: network error.");
        await new Promise(function (r) {
          setTimeout(r, 600 * (attempt + 1));
        });
        continue;
      }
      if (res.ok) return;
      var data = null;
      try {
        data = await res.json();
      } catch (e) {}
      lastErr = apiError(res.status, data, "Upload of " + item.paths[0] + " failed.");
      if (res.status !== 429 && res.status < 500) throw lastErr;
      await new Promise(function (r) {
        setTimeout(r, 800 * (attempt + 1));
      });
    }
    throw lastErr;
  }

  /**
   * Mount the publish form in `root`.
   * opts.compact: home page version. opts.site: preselected existing site.
   */
  function mountPublisher(root, opts) {
    opts = opts || {};
    var key = getKey();
    var anonymous = !authed() && boot.anonymousPublish;
    clear(root);
    if (!authed() && !anonymous) {
      add(
        root,
        h(
          "div",
          { class: "k-dropzone" },
          h("strong", { text: "Sign in to publish from the browser" }),
          h("p", { text: "This instance publishes with API keys. Agents use the API, CLI or MCP." }),
          h("a", { class: "k-btn", href: signInHref(location.pathname), text: "Sign in" }),
        ),
      );
      return;
    }
    var state = { items: [], skipped: [], busy: false };
    var siteSelect = h("select", { class: "k-input", id: "dw-pub-site", "aria-label": "Site to update" }, h("option", { value: "", text: "Loading sites…" }));
    var slugInput = h("input", { class: "k-input", id: "dw-pub-slug", placeholder: "generated if empty", autocomplete: "off", spellcheck: "false", pattern: "[a-z0-9][a-z0-9-]{1,62}" });
    var modeNew = h("input", { type: "radio", name: "dw-pub-mode", value: "new", checked: !opts.site });
    var modeUpd = h("input", { type: "radio", name: "dw-pub-mode", value: "update", checked: !!opts.site });
    var message = h("input", { class: "k-input", id: "dw-pub-msg", maxlength: "200", placeholder: "What changed (optional)" });
    var dirInput = h("input", { type: "file", webkitdirectory: true, multiple: true, hidden: true });
    var fileInput = h("input", { type: "file", multiple: true, hidden: true });
    var summary = h("div", { class: "k-small", "aria-live": "polite" });
    var chosen = h("ul", { class: "k-frows k-chosen", hidden: true, "aria-label": "Files to publish" });
    var publishBtn = h("button", { type: "button", class: "k-btn", text: "Publish", disabled: true });
    var clearBtn = h("button", { type: "button", class: "k-btn k-quiet", text: "Clear", hidden: true });
    var status = h("p", { class: "k-msgline", "aria-live": "polite" });
    var bar = h("i");
    var progress = h("div", { class: "k-prog", hidden: true, role: "progressbar", "aria-label": "Publishing", "aria-valuemin": "0", "aria-valuemax": "100" }, bar);
    var result = h("div");
    var zone = h(
      "div",
      { class: "k-dropzone", role: "group", "aria-label": "Drop zone: drop a folder, files or a .zip here, or choose them with the buttons" },
      h("strong", { text: "Drop a folder, files or a .zip" }),
      h("p", { text: "Files are hashed in your browser; only files the server does not have yet are uploaded." }),
      h(
        "div",
        { class: "k-btnrow" },
        h("button", { type: "button", class: "k-btn k-ghost", text: "Choose folder", onclick: function (e) { e.stopPropagation(); dirInput.click(); } }),
        h("button", { type: "button", class: "k-btn k-ghost", text: "Choose files", onclick: function (e) { e.stopPropagation(); fileInput.click(); } }),
      ),
      dirInput,
      fileInput,
    );

    function setItems(items) {
      var keep = [];
      var skipped = [];
      stripCommonRoot(items).forEach(function (it) {
        var why = ignored(it.path);
        if (why) skipped.push(it.path + " (" + why + ")");
        else keep.push(it);
      });
      state.items = keep;
      state.skipped = skipped;
      clear(result);
      var total = keep.reduce(function (s, it) {
        return s + it.file.size;
      }, 0);
      var zip = keep.length === 1 && /\.zip$/i.test(keep[0].path);
      var hasIndex = keep.some(function (it) {
        return /^(index\.html?|index\.md|readme\.md)$/i.test(it.path);
      });
      clear(summary);
      clear(chosen);
      chosen.hidden = !keep.length;
      if (keep.length) {
        add(
          summary,
          h("strong", { text: zip ? "1 zip file · " + bytes(total) + " (unpacked on the server)" : plural(keep.length, "file") + " · " + bytes(total) }),
          !zip && keep.length > 1 && hasIndex ? " · has an index page" : "",
          !zip && keep.length > 1 && !hasIndex ? h("p", { class: "k-fwarn", text: "No index.html: the site root will list the files." }) : null,
          skipped.length ? h("p", { class: "k-small", text: "Skipped " + plural(skipped.length, "file") + ": " + skipped.slice(0, 5).join(", ") + (skipped.length > 5 ? "…" : "") }) : null,
        );
        keep.slice(0, 6).forEach(function (it) {
          var folder = it.path.indexOf("/") > 0;
          add(
            chosen,
            h(
              "li",
              { class: "k-frow" },
              h("span", { class: "k-thumb", "aria-hidden": "true" }, h("span", { class: "k-th-doc" }, h("i"), h("b"), h("b", { class: "k-s" }))),
              h("span", {}, h("span", { class: "k-fname", text: it.path }), h("span", { class: "k-fmeta", text: bytes(it.file.size) + (folder ? " · in a folder" : "") })),
              h("span"),
            ),
          );
        });
        if (keep.length > 6) add(chosen, h("li", { class: "k-frow" }, h("span"), h("span", { class: "k-small", text: "and " + plural(keep.length - 6, "more file") }), h("span")));
      } else if (skipped.length) add(summary, "Every file was skipped: " + skipped.slice(0, 5).join(", "));
      publishBtn.disabled = !keep.length || state.busy;
      clearBtn.hidden = !keep.length;
    }

    zone.addEventListener("click", function () {
      dirInput.click();
    });
    ["dragenter", "dragover"].forEach(function (t) {
      zone.addEventListener(t, function (e) {
        e.preventDefault();
        zone.classList.add("k-over");
      });
    });
    ["dragleave", "drop"].forEach(function (t) {
      zone.addEventListener(t, function () {
        zone.classList.remove("k-over");
      });
    });
    zone.addEventListener("drop", async function (e) {
      e.preventDefault();
      setItems(await filesFromDrop(e.dataTransfer));
    });
    dirInput.addEventListener("change", function () {
      setItems(
        Array.prototype.map.call(dirInput.files, function (f) {
          return { path: f.webkitRelativePath || f.name, file: f };
        }),
      );
      dirInput.value = "";
    });
    fileInput.addEventListener("change", function () {
      setItems(
        Array.prototype.map.call(fileInput.files, function (f) {
          return { path: f.name, file: f };
        }),
      );
      fileInput.value = "";
    });
    clearBtn.addEventListener("click", function () {
      setItems([]);
      clear(status);
      progress.hidden = true;
    });

    function setProgress(fraction, text) {
      progress.hidden = false;
      var pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
      bar.style.width = pct + "%";
      progress.setAttribute("aria-valuenow", String(pct));
      status.textContent = text;
    }

    async function run() {
      if (state.busy || !state.items.length) return;
      state.busy = true;
      publishBtn.disabled = true;
      clear(result);
      var auth = key;
      var claim = null;
      try {
        var updating = !anonymous && modeUpd.checked;
        var slug = updating ? siteSelect.value : slugInput.value.trim().toLowerCase();
        if (updating && !slug) throw apiError(400, null, "Choose the site to update.");
        var msg = message.value.trim() || undefined;
        var items = state.items;
        // One .zip: the server unpacks it (one-shot publish, up to its one-shot size limit).
        if (items.length === 1 && /\.zip$/i.test(items[0].path)) {
          setProgress(0.3, "Uploading " + items[0].path + "…");
          var q = slug ? "?slug=" + encodeURIComponent(slug) + (msg ? "&message=" + encodeURIComponent(msg) : "") : msg ? "?message=" + encodeURIComponent(msg) : "";
          var out = await api("/publish" + q, { method: "POST", body: items[0].file, headers: { "Content-Type": "application/zip" }, key: auth || null });
          setProgress(1, "Published.");
          showResult({ url: out.url, slug: out.slug, version: out.version, unchanged: out.unchanged, claimToken: out.claimToken, expiresAt: out.expiresAt });
          return;
        }
        var hashed = 0;
        var manifest = [];
        var bySha = {};
        setProgress(0, "Hashing files…");
        await pool(items, 4, async function (it) {
          var sha = await sha256Hex(it.file);
          manifest.push({ path: it.path, size: it.file.size, sha256: sha });
          bySha[sha] = it.file;
          hashed++;
          setProgress((hashed / items.length) * 0.2, "Hashing " + hashed + " of " + items.length + "…");
        });
        if (!updating) {
          var created = await api("/sites", { method: "POST", body: slug ? { slug: slug } : {}, key: auth || null });
          slug = created.site.slug;
          if (created.claimToken) {
            claim = created;
            auth = created.claimToken;
          }
        }
        setProgress(0.22, "Checking which files the server already has…");
        var dep = await api("/sites/" + encodeURIComponent(slug) + "/deploys", { method: "POST", body: { files: manifest, message: msg }, key: auth });
        if (dep.unchanged) {
          setProgress(1, "Nothing changed.");
          showResult({ slug: slug, unchanged: true, version: dep.deploy });
          return;
        }
        var uploads = dep.uploads || [];
        var total = uploads.reduce(function (s, u) {
          return s + u.size;
        }, 0);
        var sent = 0;
        var done = 0;
        await pool(uploads, 4, async function (u) {
          await putBlob(u, bySha[u.sha256], auth);
          sent += u.size;
          done++;
          setProgress(0.25 + (total ? sent / total : 1) * 0.65, "Uploaded " + done + " of " + uploads.length + " new files (" + bytes(sent) + " of " + bytes(total) + ")…");
        });
        setProgress(0.95, uploads.length ? "Making it live…" : "All files were already stored. Making it live…");
        var fin = await api(localPath(dep.finalizeUrl), { method: "POST", key: auth, abs: true });
        setProgress(1, "Published " + plural(manifest.length, "file") + (uploads.length < manifest.length ? " (" + (manifest.length - uploads.length) + " reused)" : "") + ".");
        showResult({
          url: fin.url,
          slug: slug,
          version: fin.site && fin.site.currentVersion,
          warnings: fin.warnings,
          claimToken: claim && claim.claimToken,
          expiresAt: claim && claim.expiresAt,
        });
      } catch (e) {
        progress.hidden = true;
        status.textContent = "";
        add(result, errorBox(e, "Publish failed"));
      } finally {
        state.busy = false;
        publishBtn.disabled = !state.items.length;
      }
    }

    function showResult(r) {
      setItems([]);
      clear(result);
      var url = r.url || null;
      add(
        result,
        h(
          "div",
          { class: "k-keyout", role: "status" },
          h("span", { class: "k-k", text: r.unchanged ? "Unchanged" : "Published" }),
          h("strong", { text: r.unchanged ? "Nothing changed: the live version already has exactly these files." : "It's live" + (r.version && r.version.number ? " as v" + r.version.number : "") + "." }),
          url
            ? h("div", { class: "k-keyout-row" }, h("code", {}, h("a", { href: url, target: "_blank", rel: "noopener", text: url })), copyButton(url, "Copy URL"))
            : null,
          h(
            "div",
            { class: "k-btnrow" },
            url ? h("a", { class: "k-btn", href: url, target: "_blank", rel: "noopener", text: "Open site" }) : null,
            h("a", { class: "k-btn k-ghost", href: "/v/" + encodeURIComponent(r.slug) + "/", text: "Browse files" }),
            key ? h("a", { class: "k-btn k-ghost", href: "/dashboard/sites/" + encodeURIComponent(r.slug), text: "Manage" }) : null,
          ),
          r.warnings && r.warnings.length
            ? h("ul", { class: "k-small" }, r.warnings.map(function (w) {
                return h("li", { text: w.message });
              }))
            : null,
          r.claimToken
            ? h(
                "div",
                { class: "k-small" },
                h("p", { text: "Anonymous site: it expires " + (r.expiresAt ? localTime(r.expiresAt) : "soon") + ". Keep it with the claim token (shown once):" }),
                h("div", { class: "k-keyout-row" }, h("code", { text: r.claimToken }), copyButton(r.claimToken, "Copy claim token")),
              )
            : null,
        ),
      );
      if (key) {
        modeUpd.checked = true;
        slugInput.value = "";
        loadSites(r.slug);
      }
    }

    async function loadSites(select) {
      if (!key) return;
      try {
        var res = await api("/sites?limit=200");
        clear(siteSelect);
        if (!res.sites.length) add(siteSelect, h("option", { value: "", text: "No sites yet" }));
        res.sites.forEach(function (s) {
          add(siteSelect, h("option", { value: s.slug, text: s.title ? s.title + " (" + s.slug + ")" : s.slug }));
        });
        if (select) siteSelect.value = select;
      } catch (e) {
        clear(siteSelect);
        add(siteSelect, h("option", { value: "", text: "Could not load sites" }));
      }
    }

    publishBtn.addEventListener("click", run);
    var target = anonymous
      ? h("p", { class: "k-small", text: "You are not signed in: this instance allows anonymous sites. They expire unless claimed with an API key." })
      : h(
          "fieldset",
          { class: "k-plain" },
          h("legend", { class: "k-label", text: "Publish to" }),
          h("div", { class: "k-two" },
            h("div", { class: "k-group" }, h("label", { class: "k-tog" }, modeNew, h("span", { text: "A new site" })), h("label", { class: "k-sub", for: "dw-pub-slug", text: "Name (optional)" }), slugInput),
            h("div", { class: "k-group" }, h("label", { class: "k-tog" }, modeUpd, h("span", { text: "A new version of" })), h("label", { class: "k-sub", for: "dw-pub-site", text: "Site" }), siteSelect),
          ),
        );
    slugInput.addEventListener("focus", function () {
      modeNew.checked = true;
    });
    siteSelect.addEventListener("change", function () {
      modeUpd.checked = true;
    });
    add(
      root,
      target,
      opts.compact ? null : h("div", { class: "k-group" }, h("label", { class: "k-label", for: "dw-pub-msg", text: "Message" }), message),
      zone,
      chosen,
      h("div", { class: "k-pubbar" }, summary, h("div", { class: "k-btnrow" }, clearBtn, publishBtn)),
      progress,
      status,
      result,
    );
    if (key) loadSites(opts.site);
  }

  // ------------------------------------------------------------------ pages

  var pages = {};

  pages.home = async function () {
    wireTabs(d);
    var m = await renderAccount();
    var cta = d.getElementById("dw-home-cta");
    if (cta && m) {
      clear(cta);
      add(cta, h("a", { class: "k-btn", href: "/dashboard", text: "Open dashboard" }), h("a", { class: "k-btn k-ghost", href: "/dashboard/keys", text: "API keys" }));
    }
    var quick = d.getElementById("dw-quick");
    if (quick) mountPublisher(quick, { compact: true });
    // Fill the user's own key into snippets? Never: keys stay out of the page.
  };

  pages.login = async function () {
    var params = new URLSearchParams(location.search);
    var next = safeNext(params.get("next"));
    var note = d.getElementById("dw-login-note");
    if (note && params.get("expired")) add(note, errorBox({ message: "Your key was rejected (revoked or expired). Sign in again." }));
    if (note && params.get("signedout")) add(note, h("div", { class: "k-banner", role: "status", text: "Signed out. The key was removed from this browser." }));
    if (note && params.get("retry")) add(note, h("div", { class: "k-banner", role: "status", text: "The page was still loading. Nothing was sent anywhere else; please sign in again." }));
    var form = d.getElementById("dw-signin");
    if (form) {
      form.addEventListener("submit", async function (e) {
        e.preventDefault();
        var out = d.getElementById("dw-signin-out");
        clear(out);
        var k = form.elements.key.value.trim();
        if (!k) return;
        var btn = form.querySelector("button[type=submit]");
        btn.disabled = true;
        try {
          var m = await api("/me", { key: k });
          if (m.principal !== "member") {
            throw apiError(400, null, m.principal === "bootstrap" ? "That is the bootstrap secret, not an API key. Use it below to set up the instance or recover owner access." : "That is not a member API key.");
          }
          setKey(k, form.elements.remember.checked);
          location.href = next;
        } catch (err) {
          add(out, errorBox(err, "Sign-in failed"));
        } finally {
          btn.disabled = false;
        }
      });
    }
    function bootstrapForm(id, path, bodyFn, label) {
      var f = d.getElementById(id);
      if (!f) return;
      f.addEventListener("submit", async function (e) {
        e.preventDefault();
        var out = f.querySelector("[data-out]");
        clear(out);
        var btn = f.querySelector("button[type=submit]");
        btn.disabled = true;
        try {
          var res = await api(path, { method: "POST", key: f.elements.secret.value.trim(), body: bodyFn(f) });
          var k = res.apiKey.key;
          f.elements.secret.value = "";
          // The job of this form is done: leave only the key and the way on.
          $$(".k-group, .k-two, button[type=submit]", f).forEach(function (x) {
            x.hidden = true;
          });
          add(
            out,
            secretBlock(label, k, "Shown once. Store it in your password manager; agents use it as Authorization: Bearer <key>."),
            h("button", {
              type: "button",
              class: "k-btn",
              text: "I saved it. Continue",
              onclick: function () {
                setKey(k, false);
                location.href = "/dashboard";
              },
            }),
          );
        } catch (err) {
          add(out, errorBox(err));
        } finally {
          btn.disabled = false;
        }
      });
    }
    bootstrapForm(
      "dw-setup",
      "/setup",
      function (f) {
        return { email: f.elements.email.value.trim() || undefined, name: f.elements.name.value.trim() || undefined };
      },
      "Owner API key created",
    );
    bootstrapForm("dw-recover", "/setup/recover", function () {
      return undefined;
    }, "New owner API key");
  };

  function siteRow(s) {
    var v = s.currentVersion;
    var chips = [];
    if (v) chips.push(h("span", { class: "k-chip k-ok", text: "Live" }));
    else chips.push(h("span", { class: "k-chip", text: "Empty" }));
    if (s.settings && s.settings.passwordProtected) chips.push(h("span", { class: "k-chip k-warn", text: "Password" }));
    if (s.settings && s.settings.spa) chips.push(h("span", { class: "k-chip", text: "SPA" }));
    if (s.expiresAt) chips.push(h("span", { class: "k-chip k-warn", title: s.expiresAt, text: "Expires " + localTime(s.expiresAt) }));
    return h(
      "tr",
      { "data-search": [s.slug, s.title || "", s.description || ""].join(" ").toLowerCase() },
      h(
        "td",
        {},
        h("a", { class: "k-title", href: "/dashboard/sites/" + encodeURIComponent(s.slug), text: s.title || s.slug }),
        s.title ? h("span", { class: "k-sub k-mono", text: s.slug }) : null,
        h("span", { class: "k-chips k-rowchips" }, chips),
      ),
      h(
        "td",
        {},
        h("span", { class: "k-url" }, h("a", { href: s.url, target: "_blank", rel: "noopener", class: "k-small", text: s.url.replace(/^https?:\/\//, "") }), copyButton(s.url, "Copy URL of " + s.slug)),
      ),
      h("td", { class: "k-num k-small" }, v ? "v" + v.number : "–", h("span", { class: "k-sub", text: v ? plural(v.fileCount, "file") + " · " + bytes(v.totalBytes) : "" })),
      h("td", { class: "k-num k-small k-hide-sm", title: s.updatedAt, text: ago(s.updatedAt) }),
      h(
        "td",
        { class: "k-act" },
        h("a", { class: "k-btn k-sm k-ghost", href: "/v/" + encodeURIComponent(s.slug) + "/", text: "Files", "aria-label": "Files of " + s.slug }),
        h("a", { class: "k-btn k-sm k-ghost", href: s.url, target: "_blank", rel: "noopener", text: "Open", "aria-label": "Open " + s.slug }),
      ),
    );
  }

  pages.sites = async function () {
    if (!requireAuth()) return;
    renderAccount();
    var params = new URLSearchParams(location.search);
    if (params.get("deleted")) toast(params.get("deleted") + " was deleted.");
    var root = d.getElementById("dw-sites");
    var count = d.getElementById("dw-sites-count");
    var search = h("input", { class: "k-input k-find", type: "search", placeholder: "Filter by name or title", "aria-label": "Filter sites" });
    var tbody = h("tbody");
    var more = h("button", { type: "button", class: "k-btn k-ghost", text: "Load more", hidden: true });
    var nomatch = h("p", { class: "k-pad k-small", role: "status", hidden: true, text: "No site matches that filter." });
    var table = h(
      "div",
      { class: "k-table-wrap" },
      h(
        "table",
        { class: "k-table" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Site" }), h("th", { scope: "col", class: "k-hide-sm", text: "URL" }), h("th", { scope: "col", class: "k-num", text: "Live" }), h("th", { scope: "col", class: "k-num k-hide-sm", text: "Updated" }), h("th", { scope: "col" }, h("span", { class: "k-sr", text: "Actions" })))),
        tbody,
      ),
    );
    var body = h("div", {}, skeleton(4));
    clear(root);
    add(root, blk("All sites", search, body, nomatch, h("div", { class: "k-pad k-center", hidden: true }, more)));
    var cursor = null;
    var loaded = 0;
    async function load() {
      try {
        var res = await api("/sites?limit=100" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
        if (!loaded) clear(body);
        if (!loaded && !res.sites.length) {
          add(
            body,
            h(
              "div",
              { class: "k-empty", role: "status" },
              h("h3", { text: "No sites yet" }),
              h("p", { text: "Publish a folder from this browser, or let an agent publish with the API, CLI or MCP." }),
              h("a", { class: "k-btn", href: "/dashboard/publish", text: "Publish a folder" }),
            ),
          );
          search.hidden = true;
          if (count) count.textContent = "No sites yet.";
          return;
        }
        if (!loaded) add(body, table);
        res.sites.forEach(function (s) {
          tbody.appendChild(siteRow(s));
        });
        loaded += res.sites.length;
        if (count) count.textContent = plural(loaded, "site") + (res.nextCursor ? "+" : "") + ".";
        cursor = res.nextCursor;
        more.parentNode.hidden = !cursor;
        more.hidden = !cursor;
      } catch (e) {
        clear(body);
        add(body, h("div", { class: "k-pad" }, errorBox(e, "Could not load sites")));
      }
    }
    search.addEventListener("input", function () {
      var q = search.value.trim().toLowerCase();
      var shown = 0;
      $$("tr[data-search]", tbody).forEach(function (tr) {
        tr.hidden = q && tr.getAttribute("data-search").indexOf(q) < 0;
        if (!tr.hidden) shown++;
      });
      nomatch.hidden = !q || shown > 0;
    });
    more.addEventListener("click", load);
    load();
  };

  pages.site = async function () {
    if (!requireAuth()) return;
    renderAccount();
    var slug = P.slug;
    var root = d.getElementById("dw-site");
    clear(root);
    add(root, skeleton(5));
    var site, versions, files;
    try {
      var r = await Promise.all([api("/sites/" + encodeURIComponent(slug)), api("/sites/" + encodeURIComponent(slug) + "/versions?limit=100")]);
      site = r[0].site;
      versions = r[1].versions;
    } catch (e) {
      clear(root);
      add(root, errorBox(e, "Could not load " + slug), h("a", { class: "k-btn k-ghost", href: "/dashboard", text: "Back to sites" }));
      return;
    }
    d.title = (site.title || site.slug) + " · " + boot.instanceName;
    clear(root);
    var filesSection = h("section", { class: "k-blk", id: "files", "aria-label": "Files" });
    var head = h(
      "div",
      { class: "k-pagehead" },
      h(
        "div",
        {},
        h("h1", { text: site.title || site.slug }),
        h("p", {}, h("span", { class: "k-url" }, h("a", { href: site.url, target: "_blank", rel: "noopener", text: site.url }), copyButton(site.url, "Copy site URL"))),
        site.description ? h("p", { text: site.description }) : null,
      ),
      h(
        "div",
        { class: "k-btnrow" },
        h("a", { class: "k-btn k-ghost", href: "/v/" + encodeURIComponent(slug) + "/", text: "Browse files" }),
        h("a", { class: "k-btn k-ghost", href: "/dashboard/publish?site=" + encodeURIComponent(slug), text: "Publish update" }),
        h("a", { class: "k-btn", href: site.url, target: "_blank", rel: "noopener", text: "Open site" }),
      ),
    );

    var vList = h("ol", { class: "k-versions", "aria-label": "Versions, newest first" });
    versions.forEach(function (v) {
      vList.appendChild(
        h(
          "li",
          { "aria-current": v.live ? "true" : null },
          h("span", { class: "k-vn", text: "v" + v.number }),
          h(
            "div",
            { class: "k-vmsg" },
            h("span", { class: "k-chips" }, v.live ? h("span", { class: "k-chip k-ok", text: "Live" }) : null, h("span", { class: v.message ? null : "k-muted", text: v.message || "No message" })),
            h("span", { class: "k-sub", title: v.finalizedAt || v.createdAt, text: [plural(v.fileCount, "file") + " · " + bytes(v.totalBytes), ago(v.finalizedAt || v.createdAt), v.client, v.source].filter(Boolean).join(" · ") }),
          ),
          h(
            "div",
            { class: "k-act" },
            h("button", { type: "button", class: "k-btn k-sm k-ghost", text: "Files", "aria-label": "Files in version " + v.number, onclick: function () { showFiles(v); filesSection.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth" }); } }),
            v.live
              ? null
              : h("button", {
                  type: "button",
                  class: "k-btn k-sm k-ghost",
                  text: "Restore",
                  "aria-label": "Restore version " + v.number,
                  onclick: async function (ev) {
                    var btn = ev.currentTarget;
                    btn.disabled = true;
                    try {
                      await api("/sites/" + encodeURIComponent(slug) + "/versions/" + encodeURIComponent(v.id) + "/restore", { method: "POST" });
                      toast("v" + v.number + " is live again.");
                      pages.site();
                    } catch (e) {
                      toast(e.message, true);
                      btn.disabled = false;
                    }
                  },
                }),
            v.live
              ? null
              : h("button", {
                  type: "button",
                  class: "k-btn k-sm k-danger",
                  text: "Delete",
                  "aria-label": "Delete version " + v.number,
                  onclick: async function () {
                    var ok = await confirmBox({ title: "Delete v" + v.number + "?", message: "The version and its file list are removed for good (use this for a version that leaked something). Other versions are not affected.", confirmText: "Delete version" });
                    if (!ok) return;
                    try {
                      await api("/sites/" + encodeURIComponent(slug) + "/versions/" + encodeURIComponent(v.id), { method: "DELETE" });
                      toast("v" + v.number + " deleted.");
                      pages.site();
                    } catch (e) {
                      toast(e.message, true);
                    }
                  },
                }),
          ),
        ),
      );
    });
    var versionsSection = blk(
      "Versions",
      h("span", { class: "k-small", text: plural(versions.length, "version") + ". Restoring is instant: it only moves the live pointer." }),
      versions.length
        ? vList
        : h("div", { class: "k-empty" }, h("h3", { text: "Nothing published yet" }), h("p", { text: "This site exists but has no live version yet." }), h("a", { class: "k-btn", href: "/dashboard/publish?site=" + encodeURIComponent(slug), text: "Publish files" })),
    );

    async function showFiles(v) {
      clear(filesSection);
      add(filesSection, h("div", { class: "k-blk-h" }, h("h2", { text: "Files in v" + v.number + (v.live ? " (live)" : "") })), skeleton(3));
      try {
        files = await api("/sites/" + encodeURIComponent(slug) + "/files" + (v.live ? "" : "?version=" + encodeURIComponent(v.id)));
      } catch (e) {
        clear(filesSection);
        add(filesSection, h("div", { class: "k-pad" }, errorBox(e, "Could not load files")));
        return;
      }
      var filter = h("input", { class: "k-input k-find", type: "search", placeholder: "Filter files", "aria-label": "Filter files" });
      var tb = h("tbody");
      files.files.forEach(function (f) {
        tb.appendChild(
          h(
            "tr",
            { "data-search": f.path.toLowerCase() },
            h("td", { class: "k-mono" }, v.live ? h("a", { href: "/v/" + encodeURIComponent(slug) + "/" + encodePath(f.path), text: f.path }) : h("span", { text: f.path })),
            h("td", { class: "k-hide-sm" }, h("span", { class: "k-chip", text: f.kind })),
            h("td", { class: "k-hide-sm" }, sealFor(f.path, f.sha256, { mini: true })),
            h("td", { class: "k-num k-small", text: bytes(f.size) }),
            h(
              "td",
              { class: "k-act" },
              v.live ? h("a", { class: "k-btn k-sm k-ghost k-hide-sm", href: f.url, target: "_blank", rel: "noopener", text: "Open", "aria-label": "Open " + f.path }) : null,
              h("button", { type: "button", class: "k-btn k-sm k-ghost", text: "Download", "aria-label": "Download " + f.path, onclick: function (ev) { downloadFile(slug, f.path, v.live ? null : v.id, ev.currentTarget); } }),
            ),
          ),
        );
      });
      filter.addEventListener("input", function () {
        var q = filter.value.trim().toLowerCase();
        $$("tr[data-search]", tb).forEach(function (tr) {
          tr.hidden = q && tr.getAttribute("data-search").indexOf(q) < 0;
        });
      });
      clear(filesSection);
      add(
        filesSection,
        h("div", { class: "k-blk-h" }, h("h2", { text: "Files in v" + v.number + (v.live ? " (live)" : "") }), h("div", { class: "k-tools" }, h("span", { class: "k-small", text: plural(files.files.length, "file") }), filter)),
        v.live ? null : h("p", { class: "k-pad k-small", text: "Older versions are not served publicly. Restore this version to view it on the site, or download single files." }),
        h("div", { class: "k-table-wrap" }, h("table", { class: "k-table" }, h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Path" }), h("th", { scope: "col", class: "k-hide-sm", text: "Kind" }), h("th", { scope: "col", class: "k-hide-sm", text: "Checksum" }), h("th", { scope: "col", class: "k-num", text: "Size" }), h("th", { scope: "col" }, h("span", { class: "k-sr", text: "Actions" })))), tb)),
      );
    }

    var s = site.settings;
    var form = h(
      "form",
      { class: "k-pad" },
      h("div", { class: "k-two" },
        h("div", { class: "k-group" }, h("label", { class: "k-label", for: "dw-s-title", text: "Title" }), h("input", { class: "k-input", id: "dw-s-title", name: "title", maxlength: "200", value: site.title || "" })),
        h("div", { class: "k-group" }, h("label", { class: "k-label", for: "dw-s-desc", text: "Description" }), h("input", { class: "k-input", id: "dw-s-desc", name: "description", maxlength: "2000", value: site.description || "" })),
      ),
      h(
        "div",
        { class: "k-toggles" },
        h("label", { class: "k-tog" }, h("input", { type: "checkbox", name: "spa", checked: s.spa }), h("span", {}, "Single-page app", h("span", { class: "k-sub", text: "Unknown paths serve index.html (client-side routing)." }))),
        h("label", { class: "k-tog" }, h("input", { type: "checkbox", name: "renderMarkdown", checked: s.renderMarkdown }), h("span", {}, "Render Markdown", h("span", { class: "k-sub", text: "Browsers see .md files as pages; off serves the raw text." }))),
        h("label", { class: "k-tog" }, h("input", { type: "checkbox", name: "crossOriginIsolation", checked: s.crossOriginIsolation }), h("span", {}, "Cross-origin isolation", h("span", { class: "k-sub", text: "Sends COOP/COEP so threaded WebAssembly (SharedArrayBuffer) works. Cross-origin embeds then need CORP." }))),
      ),
      h("div", { class: "k-group k-pwrow" },
        h("label", { class: "k-label", for: "dw-s-pw", text: s.passwordProtected ? "Password (set; type a new one to change it)" : "Password (optional)" }),
        h("div", { class: "k-field" }, h("input", { class: "k-input", id: "dw-s-pw", name: "password", type: "password", autocomplete: "new-password", minlength: "4", maxlength: "200", "aria-describedby": "dw-s-pw-hint" }),
          s.passwordProtected ? h("button", { type: "button", class: "k-btn k-ghost", text: "Remove password", onclick: async function () { await saveSettings({ password: null }, "Password removed."); } }) : null),
        h("p", { class: "k-hint", id: "dw-s-pw-hint", text: "Visitors must enter it. Changing it signs everyone out." }),
      ),
      h("p", { class: "k-msgline k-err", id: "dw-s-error", role: "alert", hidden: true }),
      h("div", { class: "k-btnrow" }, h("button", { type: "submit", class: "k-btn", text: "Save settings" })),
    );
    async function saveSettings(body, msg) {
      var error = form.querySelector("#dw-s-error");
      error.hidden = true;
      $$("[aria-invalid]", form).forEach(function (field) { field.removeAttribute("aria-invalid"); field.removeAttribute("aria-errormessage"); });
      try {
        await api("/sites/" + encodeURIComponent(slug), { method: "PATCH", body: body });
        toast(msg || "Saved.");
        pages.site();
      } catch (e) {
        var message = e.message + (e.hint ? " " + e.hint : "");
        error.textContent = message;
        error.hidden = false;
        var fieldName = { invalid_title: "title", invalid_description: "description", invalid_password: "password" }[e.code];
        var field = fieldName && form.elements[fieldName];
        if (field) {
          field.setAttribute("aria-invalid", "true");
          field.setAttribute("aria-errormessage", "dw-s-error");
          field.focus();
        }
        toast(message, true);
      }
    }
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var f = form.elements;
      var body = { title: f.title.value.trim() || null, description: f.description.value.trim() || null, spa: f.spa.checked, renderMarkdown: f.renderMarkdown.checked, crossOriginIsolation: f.crossOriginIsolation.checked };
      if (f.password.value) body.password = f.password.value;
      saveSettings(body);
    });
    var danger = blk(
      "Delete site",
      null,
      h(
        "div",
        { class: "k-pad k-spread" },
        h("p", { class: "k-small", text: "The URL stops working at once and the name is freed. Files no other site uses are removed by the hourly cleanup." }),
        h("button", {
          type: "button",
          class: "k-btn k-danger",
          text: "Delete site",
          onclick: async function () {
            var ok = await confirmBox({ title: "Delete " + slug + "?", message: "Every version goes with it. This cannot be undone from the dashboard.", confirmText: "Delete site", typeToConfirm: slug });
            if (!ok) return;
            try {
              await api("/sites/" + encodeURIComponent(slug), { method: "DELETE" });
              location.href = "/dashboard?deleted=" + encodeURIComponent(slug);
            } catch (e) {
              toast(e.message, true);
            }
          },
        }),
      ),
    );
    add(root, head, versionsSection, filesSection, blk("Settings", null, form), danger);
    var live = versions.filter(function (v) {
      return v.live;
    })[0];
    if (live) showFiles(live);
    else filesSection.hidden = true;
  };

  async function downloadFile(slug, path, versionId, btn) {
    if (btn) btn.disabled = true;
    try {
      var res = await api("/sites/" + encodeURIComponent(slug) + "/files/" + encodePath(path) + (versionId ? "?version=" + encodeURIComponent(versionId) : ""), { raw: true });
      var blob = await res.blob();
      // Force a download: never open user bytes as a page on the app origin.
      var a = h("a", { href: URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" })), download: path.split("/").pop() });
      d.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 1000);
    } catch (e) {
      toast(e.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  pages.publish = function () {
    if (!requireAuth()) return;
    renderAccount();
    var root = d.getElementById("dw-publish");
    if (root) mountPublisher(root, { site: new URLSearchParams(location.search).get("site") });
  };

  pages.keys = async function () {
    if (!requireAuth()) return;
    var m = await renderAccount();
    var root = d.getElementById("dw-keys");
    clear(root);
    if (!m) m = await me().catch(function () {
      return null;
    });
    if (!can(m, "keys:write")) {
      add(root, errorBox({ message: "This key cannot manage API keys.", hint: "Sign in with a key that has the keys:write scope." }));
      return;
    }
    var created = h("div");
    var listBody = h("div", {}, skeleton(3));
    var showAll = can(m, "members:write") ? h("input", { type: "checkbox" }) : null;
    var scopeBoxes = m.scopes.map(function (sc) {
      return h("label", { class: "k-tog" }, h("input", { type: "checkbox", name: "scope", value: sc, checked: true }), h("span", { class: "k-mono", text: sc }));
    });
    var siteSel = h("select", { class: "k-input", name: "site", id: "dw-k-site" }, h("option", { value: "", text: m.siteRestriction ? "Same site as this key" : "All sites" }));
    var form = h(
      "form",
      { class: "k-pad" },
      h("div", { class: "k-two" },
        h("div", { class: "k-group" }, h("label", { class: "k-label", for: "dw-k-name", text: "Name" }), h("input", { class: "k-input", id: "dw-k-name", name: "name", maxlength: "120", placeholder: "e.g. claude-code on laptop", required: true })),
        h("div", { class: "k-group" }, h("label", { class: "k-label", for: "dw-k-site", text: "Limit to one site" }), siteSel),
        h("div", { class: "k-group" }, h("label", { class: "k-label", for: "dw-k-exp", text: "Expires after (days)" }), h("input", { class: "k-input", id: "dw-k-exp", name: "expires", type: "number", min: "1", max: "3650", placeholder: "never" })),
      ),
      h("fieldset", { class: "k-plain" }, h("legend", { class: "k-label", text: "Scopes" }), h("div", { class: "k-scopes" }, scopeBoxes), h("p", { class: "k-hint", text: "A key can never hold more than the key you are signed in with." })),
      h("button", { type: "submit", class: "k-btn", text: "Create key" }),
    );
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      clear(created);
      var scopes = $$("input[name=scope]:checked", form).map(function (x) {
        return x.value;
      });
      var body = { name: form.elements.name.value.trim(), scopes: scopes };
      if (form.elements.site.value) body.site = form.elements.site.value;
      if (form.elements.expires.value) body.expiresInDays = Number(form.elements.expires.value);
      try {
        var k = await api("/keys", { method: "POST", body: body });
        add(
          created,
          secretBlock("Key “" + (k.name || k.prefix) + "” created", k.key, "Shown once. Give it to the agent or person as KOFRA_API_KEY."),
          h("div", { class: "k-codeblock" }, h("div", { class: "k-codeblock-h" }, h("span", { class: "k-k", text: "Environment" })), h("pre", { tabindex: "0", text: "export KOFRA_URL=" + boot.origin + "\nexport KOFRA_API_KEY=" + k.key })),
        );
        form.reset();
        loadKeys();
      } catch (err) {
        add(created, errorBox(err, "Could not create the key"));
      }
    });
    add(
      root,
      blk("Create a key", h("span", { class: "k-small", text: "One key per agent or person makes revoking easy." }), form, h("div", { class: "k-pad k-pad-flush" }, created)),
      blk("Active keys", showAll ? h("label", { class: "k-tog" }, showAll, h("span", { text: "Every member's keys" })) : null, listBody),
    );
    if (showAll) showAll.addEventListener("change", loadKeys);
    api("/sites?limit=200")
      .then(function (r) {
        r.sites.forEach(function (s) {
          siteSel.appendChild(h("option", { value: s.slug, text: s.slug }));
        });
      })
      .catch(function () {});
    async function loadKeys() {
      try {
        var res = await api("/keys" + (showAll && showAll.checked ? "?all=1" : ""));
        clear(listBody);
        if (!res.keys.length) {
          add(listBody, h("div", { class: "k-empty", role: "status" }, h("h3", { text: "No active keys" }), h("p", { text: "Create one above for each agent or person." })));
          return;
        }
        var tb = h("tbody");
        res.keys.forEach(function (k) {
          tb.appendChild(
            h(
              "tr",
              {},
              h("td", {}, h("strong", { text: k.name || "Unnamed" }), k.current ? h("span", { class: "k-chips k-rowchips" }, h("span", { class: "k-chip k-accent", text: "This browser" })) : null, h("span", { class: "k-sub k-mono", text: k.prefix + "…" })),
              h("td", {}, h("span", { class: "k-chips" }, k.scopes.map(function (sc) {
                return h("span", { class: "k-chip", text: sc });
              })), k.siteId ? h("span", { class: "k-sub", text: "One site only" }) : null),
              h("td", { class: "k-num k-small k-hide-sm" }, h("span", { title: localTime(k.createdAt), text: "Created " + ago(k.createdAt) }), h("span", { class: "k-sub", title: k.lastUsedAt ? localTime(k.lastUsedAt) : null, text: k.lastUsedAt ? "Used " + ago(k.lastUsedAt) : "Never used" })),
              h("td", { class: "k-num k-small k-hide-sm", text: k.expiresAt ? "Expires " + localTime(k.expiresAt) : "No expiry" }),
              h(
                "td",
                { class: "k-act" },
                h("button", {
                  type: "button",
                  class: "k-btn k-sm k-danger",
                  text: "Revoke",
                  "aria-label": "Revoke key " + (k.name || k.prefix),
                  onclick: async function () {
                    var ok = await confirmBox({
                      title: "Revoke “" + (k.name || k.prefix) + "”?",
                      message: k.current ? "This is the key this browser is signed in with: you will be signed out." : "Anything using this key stops working at once.",
                      confirmText: "Revoke",
                    });
                    if (!ok) return;
                    try {
                      await api("/keys/" + encodeURIComponent(k.id), { method: "DELETE" });
                      if (k.current) {
                        clearKey();
                        location.href = "/login?signedout=1";
                        return;
                      }
                      toast("Key revoked.");
                      loadKeys();
                    } catch (e) {
                      toast(e.message, true);
                    }
                  },
                }),
              ),
            ),
          );
        });
        add(listBody, h("div", { class: "k-table-wrap" }, h("table", { class: "k-table" }, h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Key" }), h("th", { scope: "col", text: "Scopes" }), h("th", { scope: "col", class: "k-num k-hide-sm", text: "Activity" }), h("th", { scope: "col", class: "k-num k-hide-sm", text: "Expiry" }), h("th", { scope: "col" }, h("span", { class: "k-sr", text: "Actions" })))), tb)));
      } catch (e) {
        clear(listBody);
        add(listBody, h("div", { class: "k-pad" }, errorBox(e, "Could not load keys")));
      }
    }
    loadKeys();
  };

  pages.settings = async function () {
    if (!requireAuth()) return;
    var m = await renderAccount();
    var acct = d.getElementById("dw-me");
    if (acct && m && m.member) {
      clear(acct);
      add(
        acct,
        h(
          "dl",
          { class: "k-kv" },
          h("dt", { text: "Signed in as" }), h("dd", { text: m.member.email || m.member.name || m.member.id }),
          h("dt", { text: "Role" }), h("dd", { text: m.member.role }),
          h("dt", { text: "Key scopes" }), h("dd", { class: "k-mono", text: m.scopes.join(" ") }),
          h("dt", { text: "Key limited to a site" }), h("dd", { text: m.siteRestriction ? "yes" : "no" }),
        ),
      );
    }
    var mem = d.getElementById("dw-members");
    if (!mem) return;
    if (!can(m, "members:write")) {
      mem.closest("section").hidden = true;
      return;
    }
    var out = h("div");
    var list = h("div", {}, skeleton(2));
    var form = h(
      "form",
      { class: "k-inline", "aria-label": "Add a member" },
      h("div", { class: "k-group" }, h("label", { class: "k-label", for: "dw-m-email", text: "Email" }), h("input", { class: "k-input", id: "dw-m-email", name: "email", type: "email", required: true })),
      h("div", { class: "k-group" }, h("label", { class: "k-label", for: "dw-m-name", text: "Name" }), h("input", { class: "k-input", id: "dw-m-name", name: "name" })),
      h("div", { class: "k-group" }, h("label", { class: "k-label", for: "dw-m-role", text: "Role" }), h("select", { class: "k-input", id: "dw-m-role", name: "role" }, h("option", { value: "member", text: "Member" }), h("option", { value: "admin", text: "Admin" }), m.member.role === "owner" ? h("option", { value: "owner", text: "Owner" }) : null)),
      h("button", { type: "submit", class: "k-btn", text: "Add member" }),
    );
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      clear(out);
      try {
        var r = await api("/members", { method: "POST", body: { email: form.elements.email.value.trim(), name: form.elements.name.value.trim() || undefined, role: form.elements.role.value } });
        add(out, secretBlock("API key for " + (r.member.email || r.member.name), r.apiKey.key, "Shown once. Send it to them over a private channel; they sign in with it."));
        form.reset();
        loadMembers();
      } catch (err) {
        add(out, errorBox(err, "Could not add the member"));
      }
    });
    clear(mem);
    add(mem, list, h("div", { class: "k-pad" }, form, out));
    async function loadMembers() {
      try {
        var res = await api("/members");
        clear(list);
        var tb = h("tbody");
        res.members.forEach(function (x) {
          tb.appendChild(
            h(
              "tr",
              {},
              h("td", {}, h("strong", { text: x.email || x.name || x.id }), x.name && x.email ? h("span", { class: "k-sub", text: x.name }) : null),
              h("td", {}, h("span", { class: "k-chip" + (x.role === "owner" ? " k-accent" : ""), text: x.role })),
              h("td", { class: "k-num k-small k-hide-sm", title: localTime(x.createdAt), text: "Added " + ago(x.createdAt) }),
              h(
                "td",
                { class: "k-act" },
                x.id === m.member.id
                  ? h("span", { class: "k-small", text: "You" })
                  : h("button", {
                      type: "button",
                      class: "k-btn k-sm k-danger",
                      text: "Remove",
                      "aria-label": "Remove " + (x.email || x.name || x.id),
                      onclick: async function () {
                        var ok = await confirmBox({ title: "Remove " + (x.email || x.name || x.id) + "?", message: "Their API keys stop working at once. Sites they published stay.", confirmText: "Remove member" });
                        if (!ok) return;
                        try {
                          await api("/members/" + encodeURIComponent(x.id), { method: "DELETE" });
                          toast("Member removed.");
                          loadMembers();
                        } catch (e) {
                          toast(e.message, true);
                        }
                      },
                    }),
              ),
            ),
          );
        });
        add(list, h("div", { class: "k-table-wrap" }, h("table", { class: "k-table" }, h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Member" }), h("th", { scope: "col", text: "Role" }), h("th", { scope: "col", class: "k-num k-hide-sm", text: "Added" }), h("th", { scope: "col" }, h("span", { class: "k-sr", text: "Actions" })))), tb)));
      } catch (e) {
        clear(list);
        add(list, h("div", { class: "k-pad" }, errorBox(e, "Could not load members")));
      }
    }
    loadMembers();
  };

  // ------------------------------------------------------------------ file viewer (/v/:slug/*path)

  pages.viewer = async function () {
    renderAccount();
    var slug = P.slug;
    var frame = d.getElementById("dw-frame");
    var tree = d.getElementById("dw-tree");
    var tools = d.getElementById("dw-tools");
    var info = d.getElementById("dw-fileinfo");
    var current = P.path || "";
    var currentView = new URLSearchParams(location.search).get("mode") || "view";
    var manifest = null;
    // A new mode reaches the framed viewer page through ?theme= (it is on another origin).
    d.addEventListener("kofra:themechange", function () {
      go(current, currentView, false);
    });

    function fileByPath(p) {
      if (!manifest) return null;
      for (var i = 0; i < manifest.files.length; i++) if (manifest.files[i].path === p) return manifest.files[i];
      return null;
    }
    function siteUrlFor(p) {
      var f = fileByPath(p);
      if (f) return f.url;
      return P.siteUrl + encodePath(p);
    }
    /**
     * Folders, raw files and HTML pages may be the site's own bytes: in an explicit mode they open through the
     * site's __dropway/open address, which adds ?theme= only when the frame will show a page Kofra draws
     * (a listing, a viewer, the password gate), so the site's own HTML never sees it.
     */
    function openInFrame(target) {
      var pref = themePref();
      if (pref === "auto") return target;
      var u = new URL(target);
      return P.siteUrl + "__dropway/open?next=" + encodeURIComponent(u.pathname + u.search) + "&theme=" + pref;
    }
    function viewSrc(p, mode) {
      var f = fileByPath(p);
      var base = siteUrlFor(p);
      if (!p || p.charAt(p.length - 1) === "/") return openInFrame(base);
      if (mode === "source") return withViewerTheme(base + "?view=source&embed=1");
      if (mode === "raw") return openInFrame(base + "?raw=1");
      if (f && f.kind === "html") return openInFrame(base);
      return withViewerTheme(base + "?view=1&embed=1");
    }

    function renderTools(p, mode) {
      clear(tools);
      clear(info);
      var f = fileByPath(p);
      var isDir = !p || p.charAt(p.length - 1) === "/";
      var kind = f ? f.kind : null;
      var url = siteUrlFor(p);
      function tab(label, m, enabled) {
        if (!enabled) return null;
        return h("button", {
          type: "button",
          role: "tab",
          "aria-selected": mode === m ? "true" : "false",
          text: label,
          onclick: function () {
            go(p, m, true);
          },
        });
      }
      if (!isDir) {
        add(
          tools,
          h(
            "div",
            { class: "k-seg", role: "tablist", "aria-label": "View mode" },
            tab(kind === "html" ? "Page" : kind === "binary" || kind === "archive" || kind === "wasm" || kind === "model3d" ? "Info" : "Rendered", "view", true),
            tab("Source", "source", !kind || TEXT_KINDS.indexOf(kind) >= 0),
            tab("Raw", "raw", true),
          ),
        );
      }
      add(
        tools,
        h(
          "div",
          { class: "k-btnrow" },
          !isDir && f && authed() ? h("button", { type: "button", class: "k-btn k-sm k-ghost", text: "Download", onclick: function (ev) { downloadFile(slug, p, null, ev.currentTarget); } }) : !isDir ? h("a", { class: "k-btn k-sm k-ghost", href: url + "?download=1", text: "Download" }) : null,
          !isDir && f && TEXT_KINDS.indexOf(f.kind) >= 0 && f.size <= 5 * 1024 * 1024
            ? h("button", {
                type: "button",
                class: "k-btn k-sm k-ghost",
                text: "Copy text",
                onclick: async function (ev) {
                  var btn = ev.currentTarget;
                  try {
                    var res = authed() ? await api("/sites/" + encodeURIComponent(slug) + "/files/" + encodePath(p), { raw: true }) : await fetch(url + "?raw=1");
                    copyText(await res.text(), btn);
                  } catch (e) {
                    toast(e.message, true);
                  }
                },
              })
            : null,
          h("button", { type: "button", class: "k-btn k-sm k-ghost", text: "Copy link", onclick: function (ev) { copyText(url, ev.currentTarget); } }),
          h("a", { class: "k-btn k-sm k-ghost", href: url, target: "_blank", rel: "noopener", text: "Open" }),
        ),
      );
      add(
        info,
        f ? h("span", { class: "k-chip k-accent", text: f.kind }) : null,
        h("span", { class: "k-crumbs" }, h("span", { "aria-current": "page", text: p || "/" })),
        f ? h("span", { class: "k-vmeta", text: bytes(f.size) + " · " + f.contentType.split(";")[0] }) : null,
        f ? sealFor(p, f.sha256, { mini: true, full: true }) : null,
      );
    }

    function go(p, mode, push) {
      current = p;
      mode = mode || "view";
      currentView = mode;
      var src = viewSrc(p, mode);
      if (frame.src !== src) {
        // A fresh iframe instead of a new src: changing src would add a history entry
        // inside the frame, and Back would then step through the frame, not the viewer.
        var next = frame.cloneNode(false);
        next.src = src;
        next.title = "Preview of " + (p || slug);
        frame.replaceWith(next);
        frame = next;
      }
      renderTools(p, mode);
      $$("a[data-path]", tree).forEach(function (a) {
        if (a.getAttribute("data-path") === p) a.setAttribute("aria-current", "page");
        else a.removeAttribute("aria-current");
      });
      var url = "/v/" + encodeURIComponent(slug) + "/" + encodePath(p) + (mode !== "view" ? "?mode=" + mode : "");
      if (push) history.pushState({ p: p, mode: mode }, "", url);
      d.title = (p.split("/").pop() || slug) + " · " + slug + " · " + boot.instanceName;
    }

    function buildTree(files) {
      var root = { dirs: {}, files: [] };
      files.forEach(function (f) {
        var parts = f.path.split("/");
        var node = root;
        for (var i = 0; i < parts.length - 1; i++) {
          node.dirs[parts[i]] = node.dirs[parts[i]] || { dirs: {}, files: [] };
          node = node.dirs[parts[i]];
        }
        node.files.push(f);
      });
      return root;
    }
    function renderNode(node, prefix, depth) {
      var ul = h("ul");
      Object.keys(node.dirs)
        .sort()
        .forEach(function (name) {
          var path = prefix + name + "/";
          var open = smallSite || current.indexOf(path) === 0;
          ul.appendChild(h("li", {}, h("details", { open: open }, h("summary", { text: name }), renderNode(node.dirs[name], path, depth + 1))));
        });
      node.files
        .slice()
        .sort(function (a, b) {
          return a.path.localeCompare(b.path);
        })
        .forEach(function (f) {
          var name = f.path.split("/").pop();
          ul.appendChild(
            h(
              "li",
              {},
              h("a", {
                href: "/v/" + encodeURIComponent(slug) + "/" + encodePath(f.path),
                "data-path": f.path,
                "data-kind": f.kind,
                title: f.path + " · " + bytes(f.size),
                text: name,
                onclick: function (e) {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
                  e.preventDefault();
                  go(f.path, "view", true);
                },
              }),
            ),
          );
        });
      return ul;
    }

    window.addEventListener("popstate", function (e) {
      var st = e.state || {};
      go(st.p !== undefined ? st.p : P.path || "", st.mode || "view", false);
    });

    var mode = new URLSearchParams(location.search).get("mode") || "view";
    if (!authed()) {
      renderTools(current, mode);
      clear(tree);
      add(tree, h("div", { class: "k-vside-h" }, h("p", { class: "k-small", text: "Sign in to browse every file of this site." }), h("a", { class: "k-btn k-sm", href: signInHref(location.pathname + location.search), text: "Sign in" })));
      return;
    }
    // Signed in: the server-drawn toolbar stays until the file list arrives, and is then drawn once with
    // everything it shows (kind, size, seal, copy buttons), so it changes height at most once.
    try {
      manifest = await api("/sites/" + encodeURIComponent(slug) + "/files");
    } catch (e) {
      renderTools(current, mode);
      clear(tree);
      add(tree, h("div", { class: "k-vside-h" }, errorBox(e, "Could not list files")));
      return;
    }
    var smallSite = manifest.files.length <= 40;
    var filter = h("input", { class: "k-input k-find", type: "search", placeholder: "Filter files", "aria-label": "Filter files" });
    var treeBox = h("nav", { class: "k-tree", "aria-label": "Files of " + slug }, renderNode(buildTree(manifest.files), "", 0));
    filter.addEventListener("input", function () {
      var q = filter.value.trim().toLowerCase();
      $$("a[data-path]", treeBox).forEach(function (a) {
        a.parentNode.hidden = q && a.getAttribute("data-path").toLowerCase().indexOf(q) < 0;
      });
      if (q) $$("details", treeBox).forEach(function (x) { x.open = true; });
    });
    clear(tree);
    add(
      tree,
      h("div", { class: "k-vside-h" }, h("a", { class: "k-title", href: "/dashboard/sites/" + encodeURIComponent(slug), text: slug }), h("span", { class: "k-small", text: manifest.version ? "v" + manifest.version.number + " · " + plural(manifest.files.length, "file") : "No live version" })),
      filter,
      treeBox,
    );
    go(current, mode, false);
    var cur = $("a[aria-current]", tree);
    if (cur) cur.scrollIntoView({ block: "nearest" });
  };

  // ------------------------------------------------------------------ colour mode (Auto / Light / Dark)

  // The server already wrote <html data-theme> from the cookie, so there is never a flash. This only
  // upgrades the no-script switch (a form posting to /__dropway/theme) to switch in place.
  var THEME_COOKIE = "__Host-dw_theme";
  var darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function themePref() {
    var t = d.documentElement.getAttribute("data-theme");
    return t === "light" || t === "dark" ? t : "auto";
  }
  function themeMode() {
    var p = themePref();
    return p !== "auto" ? p : darkQuery && darkQuery.matches ? "dark" : "light";
  }
  /** Kofra-generated viewer pages (?view=1, ?view=source) on the sites origin take the mode as ?theme= (no cookie there). */
  function withViewerTheme(url) {
    var pref = themePref();
    if (pref === "auto" || !/[?&]view=(1|source)(&|$)/.test(url)) return url;
    return url + "&theme=" + pref;
  }
  function updateAutoTitle() {
    $$('.k-mode-switch button[value="auto"]').forEach(function (b) {
      b.title = "Follow your device setting (now " + (darkQuery && darkQuery.matches ? "dark" : "light") + ")";
    });
  }
  function applyTheme(pref) {
    var root = d.documentElement;
    if (pref === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", pref);
    var cs = $('meta[name="color-scheme"]');
    if (cs) cs.setAttribute("content", pref === "auto" ? "light dark" : "only " + pref);
    var colors = boot.themeColors || {};
    $$('meta[name="theme-color"]').forEach(function (m) {
      var mode = pref !== "auto" ? pref : (m.getAttribute("media") || "").indexOf("dark") >= 0 ? "dark" : "light";
      if (colors[mode]) m.setAttribute("content", colors[mode]);
    });
    $$(".k-mode-switch button[name=theme]").forEach(function (b) {
      b.setAttribute("aria-pressed", b.value === pref ? "true" : "false");
    });
    updateAutoTitle();
  }
  function themeChanged(pref) {
    try {
      d.dispatchEvent(new CustomEvent("kofra:themechange", { detail: { pref: pref, mode: themeMode() } }));
    } catch (e) {}
  }
  function wireThemeSwitch() {
    $$("form.k-mode-switch").forEach(function (form) {
      form.addEventListener("submit", function (e) {
        var pref = e.submitter && e.submitter.value;
        if (pref !== "auto" && pref !== "light" && pref !== "dark") return; // no submitter: let the form post
        e.preventDefault();
        d.cookie = pref === "auto" ? THEME_COOKIE + "=; Path=/; Secure; SameSite=Lax; Max-Age=0" : THEME_COOKIE + "=" + pref + "; Path=/; Secure; SameSite=Lax; Max-Age=31536000";
        applyTheme(pref);
        if (/[?&]theme=/.test(location.search)) {
          var u = new URL(location.href);
          u.searchParams.delete("theme");
          history.replaceState(history.state, "", u.pathname + u.search + u.hash);
        }
        themeChanged(pref);
      });
    });
    if (darkQuery) {
      var onOs = function () {
        updateAutoTitle();
        if (themePref() === "auto") themeChanged("auto");
      };
      if (darkQuery.addEventListener) darkQuery.addEventListener("change", onOs);
      else if (darkQuery.addListener) darkQuery.addListener(onOs);
    }
    updateAutoTitle();
  }

  // ------------------------------------------------------------------ start

  wireThemeSwitch();
  wireCopyButtons(d);
  var start = pages[d.body.getAttribute("data-page")];
  /** With uiSlots.session and no key in this browser, ask the API whether a cookie session is live first. */
  async function probeSession() {
    if (!SESSION || getKey()) return;
    try {
      var res = await fetch(boot.api + "/me", { headers: { "X-Kofra-Client": "dashboard/1" } });
      if (res.ok) {
        var m = await res.json();
        sessionOk = !!m && m.principal === "member";
      }
    } catch (e) {}
  }
  if (d.body.getAttribute("data-page") === "login" || !SESSION || getKey()) {
    // Nothing to probe (or the sign-in page, whose forms must work at once): start now.
    if (start) start();
    else renderAccount();
  } else {
    probeSession().then(function () {
      if (start) start();
      else renderAccount();
    });
  }

}
