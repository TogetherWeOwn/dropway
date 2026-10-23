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
