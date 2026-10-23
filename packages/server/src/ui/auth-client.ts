// @ts-nocheck
// Self-contained browser JavaScript, served as function source like ui/client.ts.
/** Self-contained first-party script; never send a fragment on a page GET. */
export function browserSignin() {
  var status = document.getElementById("dw-auth-status");
  function notice(message) { if (status) status.textContent = message; }
  function readPending() {
    try { return JSON.parse(sessionStorage.getItem("dw_pending_claim") || "null"); } catch { return null; }
  }
  var claim = document.getElementById("dw-claim-page");
  if (location.pathname === "/dashboard/sessions" || document.getElementById("dw-claim")) {
    // Same-origin POST supplies both browser headers naturally. Session proof
    // stays HttpOnly; ordinary navigation itself never renews server authority.
    fetch("/api/v1/auth/sessions/refresh", { method: "POST", credentials: "same-origin" }).catch(function () { /* retry on the next app visit */ });
  }
  if (claim) {
    var slug = claim.dataset.slug || "";
    var token = new URLSearchParams(location.hash.slice(1)).get("token");
    if (token) {
      try { sessionStorage.setItem("dw_pending_claim", JSON.stringify({ slug: slug, token: token })); }
      catch { notice("This tab cannot remember the token. Keep the original claim link and reopen it after signing in."); }
      history.replaceState(null, "", location.pathname + location.search);
    }
    var pending = readPending();
    var field = document.querySelector('input[name="claimToken"]');
    if (field && pending && pending.slug === slug) field.value = pending.token;
    var form = document.getElementById("dw-claim");
    if (form) form.addEventListener("submit", async function (event) {
      event.preventDefault();
      var response = await fetch("/claim", { method: "POST", credentials: "same-origin", body: new URLSearchParams(new FormData(form)) });
      if (response.ok && response.redirected) {
        try { sessionStorage.removeItem("dw_pending_claim"); } catch { /* storage is optional */ }
        location.assign(response.url);
      } else { notice(await response.text()); }
    });
  } else if (location.pathname === "/dashboard/sessions") {
    var saved = readPending();
    if (saved && saved.slug && saved.token) location.replace("/claim?slug=" + encodeURIComponent(saved.slug));
  }
  document.querySelectorAll('form[action="/login/confirm"], form[action="/api/v1/auth/logout"]').forEach(function (form) {
    // Native no-referrer submits send Origin: null, which the browser-write
    // guard refuses. A deliberate submit goes out as a first-party fetch so
    // the browser supplies Origin and Fetch Metadata itself; the guarded
    // native POST stays as the no-script fallback. Mirrors the /claim form.
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      var button = form.querySelector("button");
      if (button) button.disabled = true;
      try {
        var response = await fetch(form.action, { method: "POST", credentials: "same-origin", body: new URLSearchParams(new FormData(form)) });
        if (response.ok && response.redirected) { location.assign(response.url); return; }
        if (response.ok && (response.headers.get("Content-Type") || "").indexOf("application/json") !== -1) {
          var done = null;
          try { done = await response.json(); } catch { done = null; }
          if (done && done.signedOut) { location.assign("/login"); return; }
        }
        if (response.ok) notice("The server answered without a destination. Reload and retry if your session looks wrong.");
        else notice(await response.text());
      } catch { notice("Network error. Retry signing in or out."); }
      if (button) button.disabled = false;
    });
  });
  document.querySelectorAll("[data-revoke]").forEach(function (button) {
    button.addEventListener("click", async function () {
      button.disabled = true;
      try {
        var result = await fetch("/api/v1/auth/sessions/" + encodeURIComponent(button.dataset.revoke || ""), { method: "DELETE", credentials: "same-origin" });
        if (result.ok) location.reload();
        else { notice("Could not revoke this session. Sign in again and retry."); button.disabled = false; }
      } catch { notice("Network error. Retry revoking this session."); button.disabled = false; }
    });
  });
}
