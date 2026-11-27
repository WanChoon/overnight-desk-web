/* Overnight Desk iPhone app — Plan A /api/* or Plan B #d= polling.
   Links are parsed from the paste. Never hardcode data paths or worker URLs. */
(function () {
  /* FOMO hrefs come from the desk payload (built only by links.py). Never hardcode them here. */
  const DEFAULT_BOTS = ["Scanner", "Analyst", "Brain", "Executor", "Risk"].map((name) => ({ name: name }));
  const BOT_COLORS = ["#64d2ff", "#bf5af2", "#ffd60a", "#00d35a", "#ff9f0a"];
  const NAMED_COLORS = {
    cyan: "#64d2ff", green: "#00d35a", red: "#ff453a", orange: "#ff9f0a",
    yellow: "#ffd60a", blue: "#0a84ff", pink: "#ff6b9a", purple: "#bf5af2", white: "#ffffff"
  };
  const FETCH_TIMEOUT_MS = 10000;

  function stored() {
    try { return JSON.parse(localStorage.getItem("desk_link") || "null"); } catch (e) { return null; }
  }
  function saveStored(obj) { localStorage.setItem("desk_link", JSON.stringify(obj)); }

  function stripPaste(raw) {
    let s = String(raw == null ? "" : raw).replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, " ");
    s = s.replace(/[\r\n\t\f\v]+/g, "");
    s = s.replace(/[\u0000-\u0008\u000e-\u001f\u007f]/g, "");
    s = s.trim();
    let prev;
    do {
      prev = s;
      s = s.replace(/^[\s"'`<>\u201c\u201d\u2018\u2019]+|[\s"'`<>\u201c\u201d\u2018\u2019]+$/g, "").trim();
    } while (s !== prev);
    if (/https?:\/\//i.test(s) || /%3A%2F%2F/i.test(s)) s = s.replace(/\s+/g, "");
    return s;
  }

  function pathFromDataUrl(u) {
    const parts = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    const at = parts.indexOf("d");
    if (at < 0 || !parts[at + 1]) return null;
    let rest = parts.slice(at + 1);
    if (/\.json$/i.test(rest[rest.length - 1])) rest = rest.slice(0, -1);
    if (!rest.length || rest.some((seg) => seg === "." || seg === "..")) return null;
    return { base: u.origin, dataPath: rest.join("/") };
  }

  function decodeOnce(value) {
    if (!value || !/%[0-9A-Fa-f]{2}/.test(value)) return value;
    try {
      const next = decodeURIComponent(value).trim();
      return next || value;
    } catch (e) {
      return value;
    }
  }

  function parseOnce(text) {
    let dataPath = null;
    let base = null;
    let token = null;
    const hashAt = text.indexOf("#");
    const before = hashAt >= 0 ? text.slice(0, hashAt) : text;
    const hash = hashAt >= 0 ? text.slice(hashAt + 1) : "";
    if (hash || /(?:^|[?&])d=/.test(text)) {
      const source = hash || text.replace(/^[?#]/, "").split("#")[0];
      const params = new URLSearchParams(source);
      dataPath = params.get("d");
      base = params.get("base");
    }
    if (dataPath) dataPath = decodeOnce(String(dataPath).trim());
    if (base) base = decodeOnce(String(base).trim());
    if (dataPath && /^https?:\/\//i.test(dataPath)) {
      try {
        const u = new URL(dataPath);
        const hit = pathFromDataUrl(u);
        if (hit) {
          base = u.origin === location.origin ? null : hit.base;
          dataPath = hit.dataPath;
        } else {
          dataPath = null;
        }
      } catch (e) {
        dataPath = null;
      }
    } else if (base) {
      try {
        base = new URL(base, location.origin).origin;
      } catch (e) {
        base = String(base).replace(/\/+$/, "");
      }
    }
    try {
      const u = new URL(/^https?:\/\//i.test(text) ? text : (before || text), location.origin);
      token = u.searchParams.get("token") || u.searchParams.get("APP_TOKEN");
      if (!dataPath && /^https?:\/\//i.test(text)) {
        const direct = pathFromDataUrl(u);
        if (direct) {
          dataPath = direct.dataPath;
          base = u.origin === location.origin ? null : direct.base;
        }
      }
    } catch (e) {}
    if (!token && text && !/^https?:\/\//i.test(text) && text.length > 16 && !dataPath && !/\s/.test(text) && !/%[0-9A-Fa-f]{2}/.test(text) && !/(?:^|[?&#])d=/.test(text)) {
      token = text;
    }
    if (dataPath) {
      const parts = String(dataPath).replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
      dataPath = parts.some((seg) => seg === "." || seg === "..") ? null : parts.join("/");
    }
    return { token: token || null, dataPath: dataPath || null, base: base || null };
  }

  function parseDeskLink(raw) {
    let text = stripPaste(raw);
    let parsed = parseOnce(text);
    for (let i = 0; i < 2 && !(parsed.token || parsed.dataPath); i++) {
      if (!/%[0-9A-Fa-f]{2}/.test(text)) break;
      try {
        const next = stripPaste(decodeURIComponent(text));
        if (!next || next === text) break;
        text = next;
        parsed = parseOnce(text);
      } catch (e) {
        break;
      }
    }
    return parsed;
  }

  const state = { tab: "home", data: null, err: null, activity: [], cfg: stored(), query: "" };
  let loadSeq = 0;
  let inflight = null;
  let opening = false;

  function apiUrl(path) {
    if (state.cfg && state.cfg.dataPath) {
      const origin = (state.cfg.base || "").replace(/\/+$/, "");
      const folder = String(state.cfg.dataPath).split("/").filter(Boolean).map(encodeURIComponent).join("/");
      const root = (origin ? origin + "/" : "") + "d/" + folder;
      if (path === "/api/state") return root + "/state.json";
      if (path === "/api/activity") return root + "/activity.json";
      return root + path.replace("/api/", "/") + ".json";
    }
    const q = state.cfg && state.cfg.token ? ((path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(state.cfg.token)) : "";
    return path.replace(/^\//, "") ? path + q : path;
  }

  async function readActivity(activityPromise, seq) {
    try {
      const res = await activityPromise;
      if (!res || seq !== loadSeq) return;
      if (res.status === 404) {
        state.activity = [];
        return;
      }
      if (!res.ok) return;
      const body = await res.json();
      if (seq !== loadSeq) return;
      const rows = Array.isArray(body) ? body : (body && body.rows);
      state.activity = Array.isArray(rows) ? rows : [];
    } catch (e) {
      if (seq !== loadSeq) return;
    }
  }

  async function load() {
    const seq = ++loadSeq;
    if (inflight) inflight.abort();
    const ctrl = new AbortController();
    inflight = ctrl;
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const opts = { cache: "no-store", signal: ctrl.signal };
    const activityPromise = fetch(apiUrl("/api/activity"), opts).catch(() => null);
    try {
      const res = await fetch(apiUrl("/api/state"), opts);
      if (seq !== loadSeq) return;
      if (res.status === 401) throw new Error("unauthorized");
      if (!res.ok) throw new Error("Desk offline");
      let body;
      try { body = await res.json(); } catch (e) { throw new Error("Desk offline"); }
      if (seq !== loadSeq) return;
      state.data = body;
      state.err = null;
      await readActivity(activityPromise, seq);
    } catch (e) {
      if (seq !== loadSeq) return;
      state.err = (e && e.name === "AbortError") ? "timed out" : ((e && e.message) || "Desk offline");
      await activityPromise;
    } finally {
      clearTimeout(timer);
      if (inflight === ctrl) inflight = null;
    }
    if (seq !== loadSeq) return;
    render();
    return !state.err;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null && text !== "") node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function fillText(node, text, query) {
    const value = text == null ? "" : String(text);
    const needle = query ? String(query).toLowerCase() : "";
    if (!needle) {
      node.textContent = value;
      return;
    }
    const hay = value.toLowerCase();
    let from = 0;
    let at = hay.indexOf(needle);
    if (at < 0) {
      node.textContent = value;
      return;
    }
    while (at >= 0) {
      if (at > from) node.appendChild(document.createTextNode(value.slice(from, at)));
      const mark = document.createElement("mark");
      mark.textContent = value.slice(at, at + needle.length);
      node.appendChild(mark);
      from = at + needle.length;
      at = hay.indexOf(needle, from);
    }
    if (from < value.length) node.appendChild(document.createTextNode(value.slice(from)));
  }

  function safeColor(value) {
    if (typeof value !== "string") return "";
    const s = value.trim();
    if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) return s;
    if (/^(?:rgb|hsl)a?\(\s*[\d.%\s,/]+\)$/i.test(s)) return s;
    return NAMED_COLORS[s.toLowerCase()] || "";
  }

  function titleName(name) {
    const raw = String(name || "Bot").trim() || "Bot";
    return raw.replace(/(^|[\s\-_/])([a-z])/g, (match, sep, ch) => sep + ch.toUpperCase());
  }

  function ageText(age) {
    if (age == null || age === "") return "";
    const n = Number(age);
    if (!isFinite(n) || n < 0) return "";
    return Math.round(n) + "s";
  }

  function epochMs(value) {
    if (value == null || value === "") return NaN;
    if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
    const s = String(value).trim();
    if (/^\d+(?:\.\d+)?$/.test(s)) {
      const n = Number(s);
      return n < 1e12 ? n * 1000 : n;
    }
    return Date.parse(s);
  }

  function formatWhen(value) {
    const ms = epochMs(value);
    if (isNaN(ms)) return value == null ? "" : String(value);
    const d = new Date(ms);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function newestFirst(rows) {
    return rows.map((row, i) => ({ row: row, i: i, t: epochMs(row && row.time) })).sort((a, b) => {
      const at = isNaN(a.t) ? -Infinity : a.t;
      const bt = isNaN(b.t) ? -Infinity : b.t;
      if (bt !== at) return bt - at;
      return a.i - b.i;
    }).map((item) => item.row);
  }

  function botSource(data) {
    const bots = data && Array.isArray(data.bots) ? data.bots : [];
    return bots.length ? bots : DEFAULT_BOTS;
  }

  function botHit(bot, q) {
    return [bot && bot.name, bot && bot.summary, bot && bot.status].some((v) => String(v || "").toLowerCase().includes(q));
  }

  function activityHit(row, q) {
    return [row && row.symbol, row && row.mint, row && row.kind, row && row.detail, row && row.time, row && row.score].some((v) => String(v == null ? "" : v).toLowerCase().includes(q));
  }

  function kindClass(kind) {
    const k = String(kind || "").toLowerCase();
    if (k === "skip" || k === "pass" || k === "buy" || k === "sell" || k === "regime" || k === "scan") return k;
    return "other";
  }

  function trimNum(x, digits) {
    return x.toFixed(digits).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  }

  function fmtPrice(n) {
    const x = Number(n);
    if (!isFinite(x)) return "—";
    const abs = Math.abs(x);
    if (abs === 0) return "0";
    if (abs >= 100) return trimNum(x, 2);
    if (abs >= 1) return trimNum(x, 4);
    return trimNum(x, 8);
  }

  function usd(n) {
    const x = Number(n);
    if (!isFinite(x)) return "";
    const sign = x < 0 ? "-" : "";
    const abs = Math.abs(x);
    const body = Number.isInteger(abs) ? String(abs) : (abs >= 100 ? abs.toFixed(0) : abs.toFixed(2));
    return sign + "$" + body;
  }

  function safeHttp(url) {
    try {
      const u = new URL(url, location.origin);
      if (u.protocol === "https:" || u.protocol === "http:") return u.href;
    } catch (e) {}
    return "";
  }

  function liveMeta(data) {
    const bits = [];
    const clock = formatWhen(data && data.updated_at);
    if (data && data.updated_at && /^\d{2}:\d{2}$/.test(clock)) bits.push("Updated " + clock);
    const stats = data && data.stats;
    if (stats && stats.scanned != null) bits.push(stats.scanned + " scanned");
    if (stats && stats.rejected != null) bits.push(stats.rejected + " blocked");
    if (stats && stats.open != null) bits.push(stats.open + " open");
    return bits.join(" · ");
  }

  function buildBotCard(bot, index, query, stacked) {
    const card = el("div", "bot-card");
    const color = safeColor(bot && bot.color) || BOT_COLORS[index % BOT_COLORS.length];
    if (stacked) card.style.borderLeftColor = color;
    const top = el("div", "bot-top");
    const dot = el("span", "status-dot");
    dot.style.background = color;
    dot.setAttribute("aria-hidden", "true");
    const status = String((bot && bot.status) || "").toLowerCase();
    if (status === "stale") dot.classList.add("stale");
    top.appendChild(dot);
    const name = el("span", "bot-name");
    fillText(name, titleName(bot && bot.name), query);
    top.appendChild(name);
    if (status === "live" || status === "stale") {
      top.appendChild(el("span", "pill mini " + (status === "live" ? "live" : "stale"), status === "live" ? "LIVE" : "STALE"));
    }
    const age = ageText(bot && bot.age_s);
    if (age) top.appendChild(el("span", "age", age));
    card.appendChild(top);
    if (bot && bot.summary) {
      const summary = el("p", "bot-summary muted");
      fillText(summary, bot.summary, query);
      card.appendChild(summary);
    }
    return card;
  }

  function renderBots(data) {
    const query = state.query || "";
    const q = query.toLowerCase();
    const all = botSource(data);
    const heading = document.getElementById("bots-heading");
    if (heading) heading.textContent = "Bots · " + all.length;
    const carousel = document.getElementById("bot-carousel");
    const list = document.getElementById("bot-list");
    if (carousel) clear(carousel);
    if (list) clear(list);
    let shown = 0;
    all.forEach((bot, i) => {
      if (q && !botHit(bot, q)) return;
      shown += 1;
      if (carousel) carousel.appendChild(buildBotCard(bot, i, query, false));
      if (list) list.appendChild(buildBotCard(bot, i, query, true));
    });
    if (list && !shown) list.appendChild(el("p", "muted", "No matches"));
  }

  function renderPositions(data) {
    const box = document.getElementById("open-positions");
    const list = document.getElementById("open-list");
    if (!box || !list) return;
    const positions = data && Array.isArray(data.open_positions) ? data.open_positions : [];
    clear(list);
    if (!positions.length) {
      box.classList.add("hidden");
      return;
    }
    box.classList.remove("hidden");
    positions.forEach((p) => {
      const row = el("div", "pos-row");
      if (p && p.mint) row.title = String(p.mint);
      const left = el("div", "pos-main");
      left.appendChild(el("div", "pos-symbol", (p && p.symbol) || "—"));
      const bits = [];
      if (p && (p.entry_price != null || p.current_price != null)) bits.push(fmtPrice(p.entry_price) + " → " + fmtPrice(p.current_price));
      if (p && p.size_usd != null && usd(p.size_usd)) bits.push(usd(p.size_usd));
      if (bits.length) left.appendChild(el("div", "pos-sub muted", bits.join(" · ")));
      row.appendChild(left);
      const pnl = Number(p && p.pnl_pct);
      if (isFinite(pnl)) row.appendChild(el("div", "pnl " + (pnl < 0 ? "down" : "up"), (pnl >= 0 ? "+" : "") + pnl.toFixed(2) + "%"));
      list.appendChild(row);
    });
  }

  function renderActivity() {
    const empty = document.getElementById("activity-empty");
    const list = document.getElementById("activity-list");
    if (!empty || !list) return;
    const query = state.query || "";
    const q = query.toLowerCase();
    const all = newestFirst(state.activity || []);
    const rows = q ? all.filter((row) => activityHit(row, q)) : all;
    clear(list);
    if (!rows.length) {
      empty.textContent = q && all.length ? "No matches" : "Nothing yet tonight";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    rows.forEach((row) => {
      const wrap = el("div", "activity-row");
      const kind = String((row && row.kind) || "").toLowerCase();
      const top = el("div", "activity-top");
      const symbol = el("span", "activity-symbol");
      const label = row && row.symbol ? String(row.symbol) : (kind ? kind.toUpperCase() : "—");
      fillText(symbol, label, query);
      top.appendChild(symbol);
      if (kind) top.appendChild(el("span", "pill mini kind " + kindClass(kind), kind.toUpperCase()));
      wrap.appendChild(top);
      const sub = el("div", "activity-sub");
      const detail = el("span", "activity-detail muted");
      fillText(detail, row && row.detail ? String(row.detail) : "", query);
      sub.appendChild(detail);
      sub.appendChild(el("span", "activity-time muted", formatWhen(row && row.time)));
      wrap.appendChild(sub);
      list.appendChild(wrap);
    });
  }

  function paintChart() {
    if (typeof window === "undefined" || !window.DeskChart || state.tab !== "home") return;
    const d = state.data || {};
    window.DeskChart.drawChart(document.getElementById("chart"), (d.chart && d.chart.points) || [{ value: d.balance || 100 }, { value: d.balance || 100 }]);
  }

  function showTab(name) {
    state.tab = name;
    ["home", "bots", "activity", "account"].forEach((t) => {
      const section = document.getElementById("tab-" + t);
      if (section) section.classList.toggle("hidden", t !== name);
      const btn = document.querySelector('[data-tab="' + t + '"]');
      if (btn) btn.classList.toggle("active", t === name);
    });
    if (name === "home") {
      const schedule = (typeof requestAnimationFrame === "function") ? requestAnimationFrame : (fn) => fn();
      schedule(paintChart);
    }
  }

  function render() {
    const gate = document.getElementById("gate");
    const need = !state.cfg || !(state.cfg.token || state.cfg.dataPath);
    if (gate) gate.classList.toggle("hidden", !need);
    if (need) return;
    const d = state.data || {};
    const err = document.getElementById("error");
    if (err) {
      err.classList.toggle("hidden", !state.err);
      err.textContent = state.err ? ("Desk offline · " + state.err) : "";
    }
    const gateErr = document.getElementById("gate-error");
    if (!state.err && gateErr) {
      gateErr.textContent = "";
      gateErr.classList.add("hidden");
    }
    document.getElementById("balance").textContent = d.balance != null ? Number(d.balance).toFixed(2) : "—";
    document.getElementById("today").textContent = d.today_pct != null ? ((d.today_pct >= 0 ? "+" : "") + Number(d.today_pct).toFixed(2) + "%") : "";
    document.getElementById("mult").textContent = d.multiplier != null ? (Number(d.multiplier).toFixed(2) + "x") : "";
    const paper = document.getElementById("paper");
    paper.classList.toggle("hidden", d.mode !== "PAPER");
    const mkt = document.getElementById("market");
    mkt.textContent = d.market === "RED" ? "Red mode" : (d.market === "QUIET" ? "Quiet" : "Green market");
    mkt.className = "pill " + (d.market === "RED" ? "red" : "");
    const meta = document.getElementById("live-meta");
    if (meta) {
      const line = liveMeta(d);
      meta.textContent = line;
      meta.classList.toggle("hidden", !line);
    }
    renderBots(d);
    renderPositions(d);
    renderActivity();
    const prof = document.getElementById("profile");
    const profileUrl = d.profile ? safeHttp(d.profile) : "";
    if (profileUrl) { prof.href = profileUrl; prof.textContent = "Your FOMO profile"; }
    const signupUrl = d.signup ? safeHttp(d.signup) : "";
    if (signupUrl) document.getElementById("signup").href = signupUrl;
    showTab(state.tab);
  }

  function showGateError(message) {
    const gateErr = document.getElementById("gate-error");
    if (!gateErr) return;
    gateErr.textContent = message;
    gateErr.classList.remove("hidden");
  }

  const gateForm = document.getElementById("gate-form");
  gateForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (opening) return;
    const raw = document.getElementById("desk-link").value;
    const parsed = parseDeskLink(raw);
    if (location.hash && location.hash.includes("d=")) {
      const fromHash = parseDeskLink(location.href);
      if (!parsed.dataPath && fromHash.dataPath) {
        parsed.dataPath = fromHash.dataPath;
        parsed.base = parsed.base || fromHash.base;
      }
      if (!parsed.token) parsed.token = fromHash.token;
    }
    if (!(parsed.token || parsed.dataPath)) {
      showGateError("Paste a full desk link with a data path or token.");
      return;
    }
    const gateErr = document.getElementById("gate-error");
    if (gateErr) {
      gateErr.textContent = "";
      gateErr.classList.add("hidden");
    }
    const btn = gateForm.querySelector("button");
    const prevLabel = btn ? btn.textContent : "";
    opening = true;
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Opening…";
    }
    saveStored(parsed);
    state.cfg = parsed;
    try {
      const ok = await load();
      if (ok) {
        const err = document.getElementById("error");
        if (err) {
          err.textContent = "";
          err.classList.add("hidden");
        }
      }
    } finally {
      opening = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = prevLabel || "Open desk";
      }
    }
  });

  const linkInput = document.getElementById("desk-link");
  if (linkInput) {
    linkInput.addEventListener("input", () => {
      const gateErr = document.getElementById("gate-error");
      if (gateErr) gateErr.classList.add("hidden");
    });
  }

  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

  const search = document.getElementById("search");
  if (search) {
    search.addEventListener("input", () => {
      state.query = search.value.trim();
      if (state.query) {
        const q = state.query.toLowerCase();
        const act = (state.activity || []).some((row) => activityHit(row, q));
        const bots = botSource(state.data).some((bot) => botHit(bot, q));
        state.tab = (act || !bots) ? "activity" : "bots";
      }
      if (state.cfg && (state.cfg.token || state.cfg.dataPath)) render();
    });
  }

  if (location.hash && location.hash.includes("d=")) {
    const parsed = parseDeskLink(location.href);
    if (parsed.dataPath) { saveStored(Object.assign(stored() || {}, parsed)); state.cfg = stored(); }
  }
  if (state.cfg && (state.cfg.token || state.cfg.dataPath)) load();
  else render();
  setInterval(() => { if (state.cfg && (state.cfg.token || state.cfg.dataPath)) load(); }, 15000);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
