/* Overnight Desk iPhone app — Plan A /api/* or Plan B #d={DATA_PATH} polling. */
(function () {
  /* FOMO hrefs come from the desk payload (built only by links.py). Never hardcode them here. */

  function stored() {
    try { return JSON.parse(localStorage.getItem("desk_link") || "null"); } catch (e) { return null; }
  }
  function saveStored(obj) { localStorage.setItem("desk_link", JSON.stringify(obj)); }

  function parseDeskLink(raw) {
    raw = (raw || "").trim();
    const hash = (raw.split("#")[1] || location.hash || "").replace(/^#/, "");
    const params = new URLSearchParams(hash.startsWith("d=") || hash.includes("d=") ? hash.replace(/^#/, "") : "");
    let dataPath = params.get("d");
    if (!dataPath && hash.startsWith("d=")) dataPath = decodeURIComponent(hash.slice(2).split("&")[0]);
    let token = null;
    try {
      const u = new URL(raw, location.origin);
      token = u.searchParams.get("token") || u.searchParams.get("APP_TOKEN");
    } catch (e) {}
    if (!token && raw && !raw.startsWith("http") && raw.length > 16 && !dataPath) token = raw;
    return { token: token, dataPath: dataPath };
  }

  const state = { tab: "home", data: null, activity: null, err: null, cfg: stored() };
  let loading = false;

  function apiUrl(path) {
    if (state.cfg && state.cfg.dataPath) {
      const base = "d/" + state.cfg.dataPath;
      if (path === "/api/state") return base + "/state.json";
      if (path === "/api/activity") return base + "/activity.json";
      return base + path.replace("/api/", "/") + ".json";
    }
    const q = state.cfg && state.cfg.token ? ((path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(state.cfg.token)) : "";
    return path.replace(/^\//, "") ? path + q : path;
  }

  function setRefreshing(on) {
    const btn = document.getElementById("refresh");
    if (!btn) return;
    btn.disabled = !!on;
    btn.classList.toggle("is-loading", !!on);
    if (on) btn.setAttribute("aria-busy", "true");
    else btn.removeAttribute("aria-busy");
  }

  async function load() {
    if (loading) return;
    loading = true;
    setRefreshing(true);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const opts = { cache: "no-store", signal: ctrl.signal };
    try {
      const settled = await Promise.allSettled([
        fetch(apiUrl("/api/state"), opts),
        fetch(apiUrl("/api/activity"), opts)
      ]);
      const stateResult = settled[0];
      const activityResult = settled[1];
      if (activityResult.status === "fulfilled" && activityResult.value.ok) {
        try { state.activity = await activityResult.value.json(); } catch (e) {}
      }
      if (stateResult.status !== "fulfilled") {
        const reason = stateResult.reason;
        const timedOut = reason && reason.name === "AbortError";
        throw timedOut ? Object.assign(new Error("timed out"), { name: "AbortError" }) : (reason || new Error("Desk offline"));
      }
      const r = stateResult.value;
      if (r.status === 401) throw new Error("unauthorized");
      if (!r.ok) throw new Error("Desk offline");
      state.data = await r.json();
      state.err = null;
    } catch (e) {
      state.err = (e && e.name === "AbortError") ? "timed out" : ((e && e.message) || "Desk offline");
    } finally {
      clearTimeout(timer);
      loading = false;
      setRefreshing(false);
      render();
    }
  }

  function activityEntries(payload) {
    const raw = !payload ? [] : Array.isArray(payload) ? payload : (
      Array.isArray(payload.events) ? payload.events :
      Array.isArray(payload.items) ? payload.items :
      Array.isArray(payload.activity) ? payload.activity : []
    );
    return raw.slice(0, 40).map((item) => {
      if (typeof item === "string") return { label: item, time: "" };
      if (!item || typeof item !== "object") return null;
      const label = item.text || item.message || item.title || item.summary || item.label || item.action || "";
      const time = item.time || item.ts || item.at || item.when || "";
      if (!label && !time) return null;
      return { label: label ? String(label) : "Update", time: time ? String(time) : "" };
    }).filter(Boolean);
  }

  function renderActivity() {
    const empty = document.getElementById("activity-empty");
    const list = document.getElementById("activity-list");
    if (!empty || !list) return;
    const entries = activityEntries(state.activity);
    list.textContent = "";
    empty.classList.toggle("hidden", entries.length > 0);
    entries.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "activity-row";
      const label = document.createElement("span");
      label.textContent = entry.label;
      const time = document.createElement("span");
      time.className = "muted";
      time.textContent = entry.time;
      row.appendChild(label);
      row.appendChild(time);
      list.appendChild(row);
    });
  }

  function render() {
    const gate = document.getElementById("gate");
    const need = !state.cfg || !(state.cfg.token || state.cfg.dataPath);
    gate.classList.toggle("hidden", !need);
    if (need) return;
    const d = state.data || {};
    const err = document.getElementById("error");
    err.classList.toggle("hidden", !state.err);
    err.textContent = state.err ? ("Desk offline · " + state.err) : "";
    document.getElementById("balance").textContent = d.balance != null ? Number(d.balance).toFixed(2) : "—";
    document.getElementById("today").textContent = d.today_pct != null ? ((d.today_pct >= 0 ? "+" : "") + Number(d.today_pct).toFixed(2) + "%") : "";
    document.getElementById("mult").textContent = d.multiplier != null ? (Number(d.multiplier).toFixed(2) + "x") : "";
    const paper = document.getElementById("paper");
    paper.classList.toggle("hidden", d.mode !== "PAPER");
    const mkt = document.getElementById("market");
    mkt.textContent = d.market === "RED" ? ("Red mode") : (d.market === "QUIET" ? "Quiet" : "Green market");
    mkt.className = "pill " + (d.market === "RED" ? "red" : "");
    if (window.DeskChart) DeskChart.drawChart(document.getElementById("chart"), (d.chart && d.chart.points) || [{ value: d.balance || 100 }, { value: d.balance || 100 }]);
    const prof = document.getElementById("profile");
    if (d.profile) { prof.href = d.profile; prof.textContent = "Your FOMO profile"; }
    if (d.signup) document.getElementById("signup").href = d.signup;
    renderActivity();
    showTab(state.tab);
  }

  function showTab(name) {
    state.tab = name;
    ["home", "bots", "activity", "account"].forEach((t) => {
      document.getElementById("tab-" + t).classList.toggle("hidden", t !== name);
      document.querySelector('[data-tab="' + t + '"]').classList.toggle("active", t === name);
    });
  }

  document.getElementById("gate-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = document.getElementById("desk-link").value;
    const parsed = parseDeskLink(raw);
    if (location.hash && location.hash.includes("d=")) {
      const fromHash = parseDeskLink(location.href);
      parsed.dataPath = parsed.dataPath || fromHash.dataPath;
    }
    saveStored(parsed);
    state.cfg = parsed;
    load();
  });
  document.getElementById("refresh").addEventListener("click", () => load());
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  if (location.hash && location.hash.includes("d=")) {
    const parsed = parseDeskLink(location.href);
    if (parsed.dataPath) { saveStored(Object.assign(stored() || {}, parsed)); state.cfg = stored(); }
  }
  if (state.cfg && (state.cfg.token || state.cfg.dataPath)) load();
  else render();
  setInterval(() => { if (state.cfg && state.cfg.dataPath) load(); }, 15000);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
