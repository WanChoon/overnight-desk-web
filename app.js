/* Overnight Desk iPhone app — Plan A /api/* or Plan B #d= polling. */
(function () {
  /* FOMO hrefs come from the desk payload (built only by links.py). Never hardcode them here. */

  function stored() {
    try { return JSON.parse(localStorage.getItem("desk_link") || "null"); } catch (e) { return null; }
  }
  function saveStored(obj) { localStorage.setItem("desk_link", JSON.stringify(obj)); }

  function parseDeskLink(raw) {
    raw = (raw || "").trim();
    const hashPart = raw.includes("#") ? raw.split("#").slice(1).join("#") : (location.hash || "");
    const hash = hashPart.replace(/^#/, "");
    const params = new URLSearchParams(hash);
    let dataPath = params.get("d");
    let base = params.get("base") || null;
    if (!dataPath && hash.startsWith("d=")) dataPath = decodeURIComponent(hash.slice(2).split("&")[0]);
    if (dataPath && /^https?:\/\//i.test(dataPath)) {
      try {
        const u = new URL(dataPath);
        base = u.origin;
        const parts = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
        if (parts[0] === "d" && parts[1]) dataPath = parts[1];
      } catch (e) {}
    } else if (base) {
      try {
        base = new URL(base, location.origin).origin;
      } catch (e) {
        base = String(base).replace(/\/+$/, "");
      }
    }
    let token = null;
    try {
      const u = new URL(raw, location.origin);
      token = u.searchParams.get("token") || u.searchParams.get("APP_TOKEN");
    } catch (e) {}
    if (!token && raw && !raw.startsWith("http") && raw.length > 16 && !dataPath) token = raw;
    return { token: token, dataPath: dataPath, base: base || null };
  }

  const state = { tab: "home", data: null, err: null, cfg: stored() };

  function apiUrl(path) {
    if (state.cfg && state.cfg.dataPath) {
      const origin = (state.cfg.base || "").replace(/\/+$/, "");
      const folder = (origin ? origin + "/" : "") + "d/" + state.cfg.dataPath;
      if (path === "/api/state") return folder + "/state.json";
      if (path === "/api/activity") return folder + "/activity.json";
      return folder + path.replace("/api/", "/") + ".json";
    }
    const q = state.cfg && state.cfg.token ? ((path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(state.cfg.token)) : "";
    return path.replace(/^\//, "") ? path + q : path;
  }

  async function load() {
    try {
      const r = await fetch(apiUrl("/api/state"), { cache: "no-store" });
      if (r.status === 401) throw new Error("unauthorized");
      if (!r.ok) throw new Error("Desk offline");
      state.data = await r.json();
      state.err = null;
    } catch (e) {
      state.err = e.message || "Desk offline";
    }
    render();
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
      parsed.base = parsed.base || fromHash.base;
    }
    saveStored(parsed);
    state.cfg = parsed;
    load();
  });
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
