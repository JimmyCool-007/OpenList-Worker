// Small, self-contained enhancement for the unmodified upstream OpenList SPA.
// The widget is attached above the "Home" breadcrumb (.body .nav) on '/'.
// The existing S3 quota route is admin-only; anonymous/regular users see nothing.
export const R2_HOME_WIDGET_PATH = "/ol-r2-home-widget.js"

export function injectR2HomeWidget(html: string): string {
  if (!html.includes("OPENLIST_CONFIG") || !/<\/body\s*>/i.test(html) ||
      html.includes('data-ol-r2-home-widget')) return html
  return html.replace(
    /<\/body\s*>/i,
    '<script defer src="' + R2_HOME_WIDGET_PATH + '" data-ol-r2-home-widget></script></body>',
  )
}

// This script runs on the same origin, with no third-party dependencies.
// Only the existing frontend JWT from localStorage is sent to the same-origin
// admin-only /s3/?openlist-quota endpoint. The JWT is never shown in the DOM.
export const R2_HOME_WIDGET_JAVASCRIPT = String.raw`(() => {
  "use strict";
  if (window.__olR2HomeWidgetInstalled) return;
  window.__olR2HomeWidgetInstalled = true;

  const ENDPOINT = "/s3/?openlist-quota";
  const WIDGET_ID = "ol-r2-home-quota";
  const REFRESH_MS = 60000;
  let widget = null;
  let lastRequest = 0;
  let currentToken = "";
  let lastQuota = null;
  let inFlight = false;
  let syncPending = false;

  const onHome = () => location.pathname === "/" || location.pathname === "/index.html";

  function token() {
    try { return localStorage.getItem("token") || ""; } catch { return ""; }
  }

  function formatGB(bytes) {
    return (bytes / 1000000000).toFixed(2) + " GB";
  }

  function removeWidget() {
    if (widget) widget.remove();
    widget = null;
  }

  function mountWidget() {
    if (!onHome()) return null;
    const nav = document.querySelector(".body .nav");
    if (!nav || !nav.parentElement) return null;

    if (!widget) {
      widget = document.createElement("section");
      widget.id = WIDGET_ID;
      widget.setAttribute("aria-label", "R2 暂存容量");
      widget.innerHTML = '<div class="ol-r2-title">R2 暂存剩余</div>' +
        '<div class="ol-r2-amount" aria-live="polite"></div>' +
        '<div class="ol-r2-track"><div class="ol-r2-fill"></div></div>' +
        '<div class="ol-r2-detail"></div>';
    }
    if (widget.nextSibling !== nav) nav.parentElement.insertBefore(widget, nav);
    return widget;
  }

  function render(quota) {
    const total = quota.limitBytes;
    const used = quota.reserved + quota.externalObjects + quota.externalMultipart + (quota.releaseReserve || 0);
    if (![total, used].every(Number.isFinite) || total <= 0 || used < 0) return;
    const remaining = Math.max(0, total - used);
    const element = mountWidget();
    if (!element) return;
    element.querySelector(".ol-r2-amount").textContent = formatGB(remaining) + " / " + formatGB(total);
    element.querySelector(".ol-r2-detail").textContent =
      "已使用及预留 " + formatGB(used) + " · 自动每分钟刷新";
    const fill = element.querySelector(".ol-r2-fill");
    fill.style.width = (100 * Math.min(1, remaining / total)).toFixed(1) + "%";
    fill.style.backgroundColor = remaining / total < 0.1 ? "#ef4444" : "#16a34a";
  }

  async function refresh() {
    const savedToken = token();
    if (!savedToken || !onHome() || inFlight || document.hidden) return;
    inFlight = true;
    lastRequest = Date.now();
    try {
      const response = await fetch(ENDPOINT, {
        headers: { Authorization: savedToken, Accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin"
      });
      if (!response.ok) {
        lastQuota = null;
        // Access is strictly admin-only. Do not show stale admin data after
        // logout, account downgrade, expiry, or temporary authorization errors.
        removeWidget();
        return;
      }
      const result = await response.json();
      if (savedToken !== token() || !onHome()) return;
      lastQuota = result;
      if (!Number.isSafeInteger(result.auditedAt) || result.auditedAt <= 0) {
        // Avoid claiming a false "9 GB free" while the inventory audit is incomplete.
        const el = mountWidget();
        if (el) {
          el.querySelector(".ol-r2-amount").textContent = "容量统计中";
          el.querySelector(".ol-r2-detail").textContent = "正在清点 R2 对象";
          el.querySelector(".ol-r2-fill").style.width = "0%";
        }
        return;
      }
      render(result);
    } catch {
      // Never block normal file browsing due to a quota metrics failure.
      lastQuota = null;
      removeWidget();
    } finally {
      inFlight = false;
    }
  }

  function sync() {
    syncPending = false;
    const savedToken = token();
    if (!onHome() || !savedToken) {
      removeWidget();
      currentToken = savedToken;
      return;
    }
    if (savedToken !== currentToken) {
      removeWidget();
      lastQuota = null;
      currentToken = savedToken;
      lastRequest = 0;
    }
    if (widget && widget.isConnected) mountWidget();
    if (!widget && lastQuota && lastQuota.auditedAt > 0) render(lastQuota);
    if (Date.now() - lastRequest >= REFRESH_MS) void refresh();
  }

  function scheduleSync() {
    if (syncPending) return;
    syncPending = true;
    requestAnimationFrame(sync);
  }

  function start() {
    if (!document.getElementById("ol-r2-home-style")) {
      const style = document.createElement("style");
      style.id = "ol-r2-home-style";
      style.textContent = '#ol-r2-home-quota{box-sizing:border-box;width:100%;padding:12px 14px;margin-bottom:8px;' +
        'border:1px solid rgba(127,127,127,.25);border-radius:12px;background:rgba(127,127,127,.08);' +
        'color:inherit;font-family:inherit;font-size:13px}' +
        '#ol-r2-home-quota .ol-r2-title{font-weight:650;opacity:.85;margin-bottom:4px}' +
        '#ol-r2-home-quota .ol-r2-amount{font-weight:700;font-size:16px;line-height:1.5}' +
        '#ol-r2-home-quota .ol-r2-track{height:6px;border-radius:99px;background:rgba(127,127,127,.23);' +
        'overflow:hidden;margin:8px 0 5px}' +
        '#ol-r2-home-quota .ol-r2-fill{height:100%;width:0%;background:#16a34a;transition:width .2s}' +
        '#ol-r2-home-quota .ol-r2-detail{opacity:.68;font-size:12px}';
      document.head.appendChild(style);
    }
    new MutationObserver(scheduleSync).observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", scheduleSync);
    window.addEventListener("hashchange", scheduleSync);
    document.addEventListener("visibilitychange", scheduleSync);
    window.setInterval(() => { if (!document.hidden) scheduleSync(); }, REFRESH_MS);
    scheduleSync();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();`;
