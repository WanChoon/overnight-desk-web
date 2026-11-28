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
  const POLL_MS = 15000;
  const COIN_PRICE_MS = 60000;
  const BOT_KEYS = ["scanner", "analyst", "brain", "executor", "risk"];
  const SETTINGS_GROUPS = ["Scanner", "Analyst", "Brain", "Executor", "Risk", "Market mode", "Copy picks", "Vault", "Repos", "Desk"];
  /* 12.5 range switch. LIVE = last 30 min, ALL = everything the desk published. */
  const RANGE_MS = { LIVE: 30 * 60000, "1H": 3600000, "4H": 4 * 3600000, "1D": 24 * 3600000, "1W": 7 * 24 * 3600000, ALL: null };
  const FRAME_LIVE_MS = 5000;
  /* Asia/Kuala_Lumpur is UTC+8 all year (no DST), so decision times need no Intl time zone data. */
  const KL_OFFSET_MS = 8 * 3600000;
  const BELL_KEY = "desk_bell_seen";

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

  const state = {
    tab: "home", data: null, err: null, activity: [], cfg: stored(), query: "",
    coins: {}, coinsA: {}, chartRange: "ALL", chartA: null, lastGoodAt: 0, nextPollAt: 0, screens: [],
    decisionsA: {}, decOpen: {}, botNotes: {}, botBusy: {}, settingNotes: {}, settingsSig: "", settingsDirty: false
  };
  /* LIVE CHART frame, double buffered: a new Image() loads off screen and is swapped in on load. */
  const frame = { name: "", src: "", loadedAt: 0, requestedAt: 0, pending: false };
  let loadSeq = 0;
  let inflight = null;
  let opening = false;
  let coinPricesAt = 0;

  function isPlanB() {
    return !!(state.cfg && state.cfg.dataPath);
  }

  function dataRoot() {
    const origin = (state.cfg.base || "").replace(/\/+$/, "");
    const folder = String(state.cfg.dataPath).split("/").filter(Boolean).map(encodeURIComponent).join("/");
    return (origin ? origin + "/" : "") + "d/" + folder;
  }

  function apiUrl(path) {
    if (state.cfg && state.cfg.dataPath) {
      const root = dataRoot();
      if (path === "/api/state") return root + "/state.json";
      if (path === "/api/activity") return root + "/activity.json";
      if (path === "/api/coins") return root + "/coins.json";
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

  /* Plan B coins.json: 404 = no coins yet (not an error); any other failure keeps the last good coins. */
  async function readCoins(coinsPromise, seq) {
    if (!coinsPromise) return;
    try {
      const res = await coinsPromise;
      if (!res || seq !== loadSeq) return;
      if (res.status === 404) {
        state.coins = {};
        return;
      }
      if (!res.ok) return;
      const body = await res.json();
      if (seq !== loadSeq) return;
      const coins = body && body.coins;
      state.coins = coins && typeof coins === "object" && !Array.isArray(coins) ? coins : {};
    } catch (e) {}
  }

  /* Plan A only: /api/chart?range= for the picked range (ALL uses state.chart). */
  async function loadChartA() {
    const range = state.chartRange;
    if (isPlanB() || range === "ALL") return;
    try {
      const res = await fetch(apiUrl("/api/chart?range=" + encodeURIComponent(range)), { cache: "no-store" });
      if (!res.ok) return;
      const body = await res.json();
      if (range !== state.chartRange || !body) return;
      state.chartA = { range: range, points: body.points, marks: body.marks };
      paintChart();
    } catch (e) {}
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
    const seq = ++loadSeq;
    if (inflight) inflight.abort();
    const ctrl = new AbortController();
    inflight = ctrl;
    setRefreshing(true);
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const opts = { cache: "no-store", signal: ctrl.signal };
    const activityPromise = fetch(apiUrl("/api/activity"), opts).catch(() => null);
    const coinsDue = isPlanB() && Date.now() - coinPricesAt >= COIN_PRICE_MS;
    if (coinsDue) coinPricesAt = Date.now();
    const coinsPromise = coinsDue ? fetch(apiUrl("/api/coins"), opts).catch(() => null) : null;
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
      state.lastGoodAt = Date.now();
      await readActivity(activityPromise, seq);
      await readCoins(coinsPromise, seq);
      if (!isPlanB()) {
        loadChartA();
        refreshOpenScreenA();
      }
    } catch (e) {
      if (seq !== loadSeq) return;
      state.err = (e && e.name === "AbortError") ? "timed out" : ((e && e.message) || "Desk offline");
      await activityPromise;
      await coinsPromise;
    } finally {
      clearTimeout(timer);
      if (inflight === ctrl) inflight = null;
    }
    if (seq !== loadSeq) return;
    setRefreshing(false);
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
    /* Desk timestamps carry microseconds ("…18.759750Z"); trim to ms so every Safari parses them. */
    return Date.parse(s.replace(/(\.\d{3})\d+/, "$1"));
  }

  function klClock(value) {
    const ms = epochMs(value);
    if (isNaN(ms)) return "—";
    const d = new Date(ms + KL_OFFSET_MS);
    return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
  }

  function formatWhen(value) {
    const ms = epochMs(value);
    if (isNaN(ms)) return value == null ? "" : String(value);
    const d = new Date(ms);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function newestFirst(rows, field) {
    const key = field || "time";
    return rows.map((row, i) => ({ row: row, i: i, t: epochMs(row && row[key]) })).sort((a, b) => {
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
    return [row && row.symbol, row && row.mint, row && row.kind, row && row.verdict, row && row.detail, row && row.reason_text, row && row.rule, row && row.time, row && row.score].some((v) => String(v == null ? "" : v).toLowerCase().includes(q));
  }

  function kindClass(kind) {
    const k = String(kind || "").toLowerCase();
    if (k === "skip" || k === "pass" || k === "buy" || k === "sell" || k === "regime" || k === "scan") return k;
    return "other";
  }

  function pillInfo(row) {
    const kind = String((row && row.kind) || "").toLowerCase();
    let label = String((row && (row.verdict || row.pill)) || "").trim();
    if (!label) {
      if (kind === "skip" || kind === "kill") label = "REJECT";
      else if (kind) label = kind.toUpperCase();
    }
    if (!label) return null;
    return { label: label, className: "pill mini " + pillClass(label, row, kind) };
  }

  function pillClass(label, row, kind) {
    const v = String(label || "").toUpperCase();
    if (v === "REJECT" || v === "SKIP" || v === "KILL") return "kind reject";
    if (v === "STOP") return "kind stop";
    if (v === "TAKE PROFIT" || v.indexOf("TP ") === 0) return "kind tp";
    if (v === "TRAIL") {
      const pnl = Number(row && row.pnl_usd);
      return (isFinite(pnl) && pnl > 0) ? "kind tp" : "kind trail-down";
    }
    if (v === "DEAD MONEY") return "kind dead";
    if (v === "PULLED" || v === "DEV DUMPING" || v === "NO PRICE") return "kind danger";
    if (v === "FOMO WARNS" || v === "SOLD THE NEWS" || v === "LOCK") return "kind warn";
    if (v === "PASS" || v === "BUY") return "kind pass";
    if (v === "SELL") return "kind sell";
    if (v === "WAIT") return "kind wait";
    return "kind " + kindClass(kind || v.toLowerCase());
  }

  function rowDetail(row) {
    return (row && (row.reason_text || row.detail)) ? String(row.reason_text || row.detail) : "";
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

  function money2(n) {
    const x = Number(n);
    if (!isFinite(x)) return "—";
    return "$" + x.toFixed(2);
  }

  function equityView(d) {
    const start = d.start_cash != null ? Number(d.start_cash) : 100;
    const cash = d.cash != null ? Number(d.cash) : (d.balance != null ? Number(d.balance) : null);
    const posVal = d.positions_value != null ? Number(d.positions_value) : 0;
    const equity = d.equity != null ? Number(d.equity) : (cash != null && isFinite(cash) ? cash + (isFinite(posVal) ? posVal : 0) : null);
    const pct = d.equity_pct != null ? Number(d.equity_pct) : (equity != null && isFinite(equity) && start > 0 ? (equity / start - 1) * 100 : (d.today_pct != null ? Number(d.today_pct) : null));
    const mult = d.equity_x != null ? Number(d.equity_x) : (equity != null && isFinite(equity) && start > 0 ? equity / start : (d.multiplier != null ? Number(d.multiplier) : null));
    return { cash: cash, positions: posVal, equity: equity, pct: pct, mult: mult };
  }

  function safeHttp(url) {
    try {
      const u = new URL(url, location.origin);
      if (u.protocol === "https:" || u.protocol === "http:") return u.href;
    } catch (e) {}
    return "";
  }

  function linkOf(value) {
    return typeof value === "string" && value.trim() ? safeHttp(value.trim()) : "";
  }

  /* null/""/missing stays null (shown as "—"), never 0. */
  function num(value) {
    if (value == null || value === "" || typeof value === "boolean") return null;
    const x = Number(value);
    return isFinite(x) ? x : null;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function shortMint(mint) {
    const s = mint ? String(mint) : "";
    return s.length > 10 ? s.slice(0, 4) + "…" + s.slice(-4) : s;
  }

  function reducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (e) {
      return false;
    }
  }

  function compactUsd(value) {
    const x = num(value);
    if (x == null) return "—";
    const abs = Math.abs(x);
    if (abs >= 1e9) return "$" + trimNum(x / 1e9, 1) + "B";
    if (abs >= 1e6) return "$" + trimNum(x / 1e6, 1) + "M";
    if (abs >= 1e3) return "$" + trimNum(x / 1e3, 1) + "K";
    return "$" + trimNum(x, abs >= 100 ? 0 : 2);
  }

  function countText(value) {
    const x = num(value);
    return x == null ? "—" : Math.round(x).toLocaleString("en-US");
  }

  function ageHours(h) {
    return h >= 10 ? String(Math.round(h)) : trimNum(h, 1);
  }

  function boolOf(value) {
    if (value === true || value === false) return value;
    const s = String(value == null ? "" : value).trim().toLowerCase();
    if (s === "1" || s === "true" || s === "on" || s === "yes") return true;
    if (s === "0" || s === "false" || s === "off" || s === "no") return false;
    return null;
  }

  function accountOf(d) {
    return d && d.account && typeof d.account === "object" ? d.account : {};
  }

  function modeOf(d) {
    return (d && d.mode) || accountOf(d).mode || "";
  }

  function setMsg(node, text, isErr) {
    if (!node) return;
    node.textContent = text || "";
    node.classList.toggle("hidden", !text);
    node.classList.toggle("err", !!text && !!isErr);
    node.classList.toggle("ok", !!text && !isErr);
  }

  /* Clipboard first; else select the text (in `input` when given) and try execCommand. */
  async function copyText(text, input) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {}
    const node = input || document.createElement("textarea");
    if (!input) {
      node.value = text;
      node.setAttribute("readonly", "");
      node.style.position = "fixed";
      node.style.opacity = "0";
      document.body.appendChild(node);
    }
    let ok = false;
    try {
      node.focus();
      node.select();
      if (node.setSelectionRange) node.setSelectionRange(0, String(text).length);
      ok = document.execCommand("copy");
    } catch (e) {}
    if (!input) node.remove();
    return ok;
  }

  /* Plan A only. Plan B files are static, so nothing is ever POSTed there. */
  async function postJson(path, payload) {
    if (isPlanB()) return { ok: false, status: 0, body: null };
    try {
      const res = await fetch(apiUrl(path), {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {})
      });
      let body = null;
      try { body = await res.json(); } catch (e) {}
      return { ok: res.ok, status: res.status, body: body };
    } catch (e) {
      return { ok: false, status: 0, body: null };
    }
  }

  function errText(out) {
    const b = out && out.body;
    if (b && typeof b.error === "string" && b.error) return b.error;
    if (b && b.errors && typeof b.errors === "object") {
      const first = Object.keys(b.errors).map((k) => b.errors[k]).find((v) => typeof v === "string" && v);
      if (first) return first;
    }
    if (b && typeof b.detail === "string" && b.detail) return b.detail;
    return out && out.status ? "Desk said HTTP " + out.status : "Desk offline";
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
    if (bot && bot.card && typeof bot.card === "object") appendBotDetail(card, String(bot.name || "").toLowerCase(), bot.card);
    if (stacked) appendBotControls(card, bot);
    return card;
  }

  /* 12.6 BOT CARDS: Scanner feed, Analyst 4x2 strips + score ring, Brain sizing, Executor dip bar, Risk pills. */
  function appendBotDetail(card, key, c) {
    const box = el("div", "bot-detail");
    const pctNum = (v) => { const n = num(v); return n == null ? null : n; };
    if (key === "scanner") {
      box.appendChild(el("div", "bot-big", countText(c.pools) + (num(c.pools) === 1 ? " pool" : " pools")));
      (Array.isArray(c.feed) ? c.feed : []).slice(0, 5).forEach((f) => {
        const row = el("div", "feed-row" + (f.passed ? "" : " killed"));
        row.appendChild(el("span", "feed-sym", f.symbol || shortMint(f.mint) || "—"));
        row.appendChild(el("span", "feed-why", f.passed ? "→ Analyst" : String(f.reason || "killed")));
        box.appendChild(row);
      });
    } else if (key === "analyst") {
      box.appendChild(el("div", "bot-big", countText(c.taken) + " taken apart"));
      const last = c.last;
      if (last && typeof last === "object") {
        const wrap = el("div", "an-wrap");
        const strips = el("div", "strips");
        (Array.isArray(last.layers) ? last.layers : []).slice(0, 8).forEach((L) => {
          const s = el("span", "strip " + (L && L.pass === true ? "ok" : (L && L.pass === false ? "bad" : "na")));
          s.title = (L && L.name) ? ("Layer " + L.n + " · " + L.name) : ("Layer " + (L && L.n));
          strips.appendChild(s);
        });
        wrap.appendChild(strips);
        const sc = pctNum(last.score);
        const ring = el("div", "ring" + (sc != null && sc >= (num(c.pass_score) || 70) ? " green" : ""));
        ring.style.setProperty("--p", String(sc == null ? 0 : Math.max(0, Math.min(100, sc))));
        ring.appendChild(el("span", "", sc == null ? "—" : String(Math.round(sc))));
        wrap.appendChild(ring);
        box.appendChild(wrap);
        const sub = [last.symbol || shortMint(last.mint)];
        if (num(last.social_pts)) sub.push("Social +" + trimNum(num(last.social_pts), 0));
        box.appendChild(el("p", "bot-note muted", sub.filter(Boolean).join(" · ")));
      }
    } else if (key === "brain") {
      box.appendChild(el("div", "bot-big", "Sizing"));
      const last = c.last;
      if (last && typeof last === "object" && num(last.usd) != null) {
        const pc = num(last.pct_cash);
        box.appendChild(el("p", "bot-line", money2(last.usd) + (pc != null ? " · " + trimNum(pc, 1) + "% of cash" : "") + " · " + (last.symbol || shortMint(last.mint))));
        const full = num(c.full_score) || 80;
        if (last.full != null) box.appendChild(el("span", "pill mini " + (last.full ? "pass" : "wait"), last.full ? trimNum(full, 0) + "+ = full size" : "under " + trimNum(full, 0) + " = half size"));
      } else {
        box.appendChild(el("p", "bot-note muted", "No order sized yet"));
      }
    } else if (key === "executor") {
      box.appendChild(el("div", "bot-big", countText(c.trades) + (num(c.trades) === 1 ? " trade" : " trades")));
      const now = c.now;
      if (now && now.state === "clicking") {
        box.appendChild(el("p", "bot-line", "Clicking Buy… · " + (now.symbol || shortMint(now.mint))));
      } else if (now && now.state === "waiting") {
        const bar = el("div", "dip-bar");
        bar.appendChild(el("span", "", "Waiting for a dip -" + trimNum(num(c.dip_pct) || 15, 0) + "% · " + (now.symbol || shortMint(now.mint))));
        box.appendChild(bar);
      }
      const last = c.last;
      if (last && typeof last === "object") {
        const verb = last.side === "sell" ? "Sold" : "Bought";
        box.appendChild(el("p", "bot-line" + (last.verified ? " ok" : " err"),
          (last.verified ? "✓ " + verb + " · verified" : verb + " · " + String(last.status || "")) + " · " + (last.symbol || shortMint(last.mint))));
      }
    } else if (key === "risk") {
      box.appendChild(el("div", "bot-big", "Guarding" + (num(c.guarding) ? " " + countText(c.guarding) : "")));
      const pills = el("div", "row");
      pills.appendChild(el("span", "pill mini kill", "stop -" + trimNum(num(c.stop_pct) || 25, 0) + "%"));
      pills.appendChild(el("span", "pill mini pass", "trail " + trimNum(num(c.trail_pct) || 40, 0) + "%"));
      box.appendChild(pills);
      (Array.isArray(c.positions) ? c.positions : []).slice(0, 3).forEach((p) => {
        box.appendChild(el("p", "bot-note muted", (p.symbol || shortMint(p.mint)) + (p.trail_on ? " · trail on" : " · stop")));
      });
    }
    if (box.childNodes.length) card.appendChild(box);
  }

  /* 12.7 Bots tab card: pause switch (Risk locked while a position is open), last 20 decisions, Settings shortcut. */
  function appendBotControls(card, bot) {
    const d = state.data || {};
    const key = String((bot && bot.name) || "").toLowerCase();
    if (BOT_KEYS.indexOf(key) < 0) return;
    const paused = d.paused && typeof d.paused[key] === "boolean" ? d.paused[key] : null;
    if (paused !== null) {
      const positions = Array.isArray(d.open_positions) ? d.open_positions : [];
      const locked = key === "risk" && positions.length > 0 && !paused;
      const row = el("div", "bot-control");
      row.appendChild(el("span", "bot-control-text muted", locked ? "Locked · position open" : (paused ? "Paused" : "Running")));
      const sw = el("button", "switch");
      sw.type = "button";
      sw.setAttribute("role", "switch");
      sw.setAttribute("aria-checked", String(!paused));
      sw.setAttribute("aria-label", titleName(key) + (paused ? " paused" : " running"));
      if (locked || state.botBusy[key]) {
        sw.disabled = true;
      } else if (isPlanB()) {
        sw.classList.add("read-only");
        sw.addEventListener("click", () => openCommandSheet((paused ? "resume " : "pause ") + key));
      } else {
        sw.addEventListener("click", () => toggleBot(key, paused));
      }
      const hit = el("span", "switch-hit");
      hit.appendChild(sw);
      row.appendChild(hit);
      card.appendChild(row);
      const note = state.botNotes[key];
      if (note && note.text) card.appendChild(el("p", "bot-note " + (note.err ? "err" : "muted"), note.text));
    }
    const rows = decisionsFor(key, d);
    const det = el("details", "decisions");
    det.open = !!state.decOpen[key];
    det.appendChild(el("summary", "", "Last 20 decisions"));
    if (rows) {
      if (!rows.length) det.appendChild(el("p", "bot-note muted", "No decisions yet"));
      rows.slice(0, 20).forEach((row) => det.appendChild(decisionRow(row)));
    } else {
      const a = state.decisionsA[key];
      det.appendChild(el("p", "bot-note muted", isPlanB() ? "—" : (a === "error" ? "Couldn't load decisions" : "Loading…")));
    }
    det.addEventListener("toggle", () => {
      state.decOpen[key] = det.open;
      if (det.open && !rows && !isPlanB() && state.decisionsA[key] === undefined) loadDecisionsA(key);
    });
    card.appendChild(det);
    const settings = el("button", "link-btn", "Settings");
    settings.type = "button";
    settings.addEventListener("click", () => openSettingsGroup(titleName(key)));
    card.appendChild(settings);
  }

  function decisionsFor(key, d) {
    if (d && d.decisions && Array.isArray(d.decisions[key])) return d.decisions[key];
    const a = state.decisionsA[key];
    return Array.isArray(a) ? a : null;
  }

  async function loadDecisionsA(key) {
    state.decisionsA[key] = "loading";
    try {
      const res = await fetch(apiUrl("/api/bots/" + encodeURIComponent(key) + "/decisions"), { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const body = await res.json();
      const rows = Array.isArray(body) ? body : (body && (Array.isArray(body.rows) ? body.rows : body.decisions));
      state.decisionsA[key] = Array.isArray(rows) ? rows : "error";
    } catch (e) {
      state.decisionsA[key] = "error";
    }
    renderBots(state.data);
  }

  function decisionRow(row) {
    const mint = row && row.mint;
    const link = linkOf(row && (row.coin_url || row.link));
    let node;
    if (mint && hasCoin(mint)) {
      node = el("button", "dec-row");
      node.type = "button";
      node.addEventListener("click", () => openScreen({ type: "coin", mint: mint, hint: { symbol: row.symbol, link: link } }));
    } else if (link) {
      node = el("a", "dec-row");
      node.href = link;
      node.target = "_blank";
      node.rel = "noopener";
    } else {
      node = el("div", "dec-row");
    }
    node.appendChild(el("span", "dec-time", klClock(row && row.ts)));
    node.appendChild(el("span", "dec-symbol", (row && row.symbol) || shortMint(mint) || "—"));
    const verdict = row && row.verdict != null ? String(row.verdict) : "";
    const text = row && row.text != null ? String(row.text) : "";
    node.appendChild(el("span", "dec-text", [verdict, text !== verdict ? text : ""].filter(Boolean).join(" · ")));
    return node;
  }

  async function toggleBot(key, paused) {
    if (state.botBusy[key]) return;
    state.botBusy[key] = true;
    state.botNotes[key] = { text: paused ? "Resuming…" : "Pausing…" };
    renderBots(state.data);
    const out = await postJson("/api/bots/" + encodeURIComponent(key) + "/" + (paused ? "resume" : "pause"), {});
    state.botBusy[key] = false;
    const message = out.body && typeof out.body.message === "string" ? out.body.message : "";
    state.botNotes[key] = out.ok ? { text: message } : { text: errText(out), err: true };
    if (out.ok) await load();
    else renderBots(state.data);
  }

  function openSettingsGroup(group) {
    closeAllScreens();
    showTab("account");
    const target = byId(groupId(group));
    if (target && target.scrollIntoView) target.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
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
    if (!state.data) {
      for (let i = 0; i < all.length; i++) {
        if (carousel) carousel.appendChild(el("div", "bot-card sk-block"));
        if (list) list.appendChild(el("div", "bot-card sk-block"));
      }
      return;
    }
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
      if (p && p.mint && hasCoin(p.mint)) {
        // 12.10: a position opens its Coin screen (Sell now lives there).
        row.classList.add("tappable");
        row.setAttribute("role", "button");
        row.tabIndex = 0;
        row.addEventListener("click", () => openScreen({ type: "coin", mint: p.mint, hint: { symbol: p.symbol, link: linkOf(p.link || p.coin_url) } }));
      }
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
    if (!state.data) {
      empty.classList.add("hidden");
      skeletonRows(list, 5);
      return;
    }
    if (!rows.length) {
      empty.textContent = q && all.length ? "No matches" : "Nothing yet tonight";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    rows.forEach((row) => list.appendChild(buildActivityRow(row, query)));
  }

  /* 12.5 Home block: last 5 rows + "See all". */
  function renderHomeActivity() {
    const list = byId("home-activity");
    const empty = byId("home-activity-empty");
    if (!list || !empty) return;
    clear(list);
    if (!state.data) {
      empty.classList.add("hidden");
      skeletonRows(list, 5);
      return;
    }
    const rows = newestFirst(state.activity || []).slice(0, 5);
    empty.classList.toggle("hidden", rows.length > 0);
    rows.forEach((row) => list.appendChild(buildActivityRow(row, "")));
  }

  function skeletonRows(list, n) {
    for (let i = 0; i < n; i++) list.appendChild(el("div", "sk-block sk-row"));
  }

  function buildActivityRow(row, query) {
    const wrap = el("div", "activity-row");
    const kind = String((row && row.kind) || "").toLowerCase();
    const top = el("div", "activity-top");
    const head = el("span", "activity-head");
    const symbol = el("span", "activity-symbol");
    const label = row && row.symbol ? String(row.symbol) : (kind ? kind.toUpperCase() : "—");
    fillText(symbol, label, query);
    head.appendChild(symbol);
    const pill = pillInfo(row);
    if (pill) head.appendChild(el("span", pill.className, pill.label));
    top.appendChild(head);
    const link = linkOf(row && (row.coin_url || row.link));
    if (row && row.mint && link) {
      const a = el("a", "fomo-link", "Open on FOMO");
      a.href = link;
      a.target = "_blank";
      a.rel = "noopener";
      a.addEventListener("click", (e) => e.stopPropagation());
      top.classList.add("has-link");
      top.appendChild(a);
    }
    wrap.appendChild(top);
    const sub = el("div", "activity-sub");
    const detail = el("span", "activity-detail muted");
    fillText(detail, rowDetail(row), query);
    sub.appendChild(detail);
    sub.appendChild(el("span", "activity-time muted", formatWhen(row && row.time)));
    wrap.appendChild(sub);
    const open = activityTarget(row, link);
    if (open) {
      wrap.classList.add("tap");
      wrap.setAttribute("role", "button");
      wrap.tabIndex = 0;
      wrap.addEventListener("click", open);
      wrap.addEventListener("keydown", (e) => {
        if (e.target !== wrap || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        open();
      });
    }
    return wrap;
  }

  /* 12.8 trades open Coin, rejects open Audit; a coin we have no data for opens its FOMO link. */
  function activityTarget(row, link) {
    const mint = row && row.mint;
    if (!mint) return null;
    const kind = String(row.kind || "").toLowerCase();
    const verdict = String(row.verdict || "").toUpperCase();
    const hint = { symbol: row.symbol, link: link };
    let type = "";
    if (kind === "buy" || kind === "sell") type = "coin";
    else if (kind === "skip" || verdict === "REJECT") type = "audit";
    if (!type) return null;
    const have = type === "coin" ? hasCoin(mint) : hasAudit(mint);
    if (have) return () => openScreen({ type: type, mint: mint, hint: hint });
    return link ? () => window.open(link, "_blank", "noopener") : null;
  }

  /* Points inside the range; the last earlier point is carried to the window start so the line is real. */
  function rangeSlice(points, marks, range, nowMs) {
    const pts = (Array.isArray(points) ? points : []).filter((p) => p && num(p.value) != null);
    const mk = Array.isArray(marks) ? marks : [];
    const span = RANGE_MS[range];
    if (!span || !pts.length) return { points: pts, marks: mk };
    const times = pts.map((p) => epochMs(p.ts));
    if (times.some((t) => isNaN(t))) return { points: pts, marks: mk };
    const cutoff = nowMs - span;
    const out = pts.filter((p, i) => times[i] >= cutoff);
    const before = pts.filter((p, i) => times[i] < cutoff);
    if (before.length) out.unshift({ ts: new Date(cutoff).toISOString(), value: before[before.length - 1].value });
    if (out.length === 1) out.push({ ts: new Date(nowMs).toISOString(), value: out[0].value });
    return { points: out, marks: mk.filter((m) => epochMs(m && m.ts) >= cutoff) };
  }

  function paintChart() {
    if (typeof window === "undefined" || !window.DeskChart || state.tab !== "home" || !state.data) return;
    const d = state.data || {};
    const ev = equityView(d);
    const fallback = (ev.equity != null && isFinite(ev.equity)) ? ev.equity : (d.balance || 100);
    const useA = !isPlanB() && state.chartA && state.chartA.range === state.chartRange;
    const src = useA ? state.chartA : (d.chart || {});
    const view = rangeSlice(src.points, src.marks, state.chartRange, Date.now());
    const points = view.points.length ? view.points : [{ value: fallback }, { value: fallback }];
    if (points.length === 1) points.push(Object.assign({}, points[0]));
    window.DeskChart.drawChart(document.getElementById("chart"), points, view.marks);
  }

  function renderRanges() {
    document.querySelectorAll("#ranges button").forEach((b) => {
      const on = b.dataset.range === state.chartRange;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }

  /* 12.5 LIVE CHART card. state.screen null = placeholder; nothing is fetched until the desk names a frame. */
  function screenName(d) {
    const name = d && typeof d.screen === "string" ? d.screen.trim() : "";
    if (!name || name.charAt(0) === "/" || !/^[A-Za-z0-9._\-\/]+$/.test(name)) return "";
    return name.split("/").some((seg) => !seg || seg === "." || seg === "..") ? "" : name;
  }

  function frameUrl(name) {
    const file = name.split("/").map(encodeURIComponent).join("/");
    const url = isPlanB() ? dataRoot() + "/" + file : apiUrl("/" + file);
    return url + (url.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now();
  }

  function refreshFrame(force) {
    const name = screenName(state.data);
    if (!name) {
      frame.name = "";
      frame.src = "";
      frame.loadedAt = 0;
      return;
    }
    const top = state.screens[state.screens.length - 1];
    const watching = top ? top.type === "frame" : state.tab === "home";
    if (frame.pending || !watching || document.hidden) return;
    if (name !== frame.name) {
      frame.name = name;
      force = true;
    }
    if (!force && Date.now() - frame.requestedAt < (isPlanB() ? 15000 : 1000)) return;
    const url = frameUrl(name);
    const img = new Image();
    frame.pending = true;
    frame.requestedAt = Date.now();
    img.onload = () => {
      frame.pending = false;
      if (screenName(state.data) !== name) return;
      frame.src = url;
      frame.loadedAt = Date.now();
      paintLiveFrame();
    };
    img.onerror = () => { frame.pending = false; };
    img.src = url;
  }

  function liveStatus() {
    if (!screenName(state.data)) return { on: false, text: isPlanB() ? "No frames yet · Plan B" : "No frames yet" };
    if (!frame.src) return { on: false, text: "No frames yet" };
    if (Date.now() - frame.loadedAt < FRAME_LIVE_MS) return { on: true, text: "Live · Bot's computer" };
    return { on: false, text: "Last frame " + formatWhen(frame.loadedAt) };
  }

  function paintLiveFrame() {
    const has = !!(screenName(state.data) && frame.src);
    document.querySelectorAll(".live-frame").forEach((img) => {
      if (has) {
        if (img.getAttribute("src") !== frame.src) img.setAttribute("src", frame.src);
        img.classList.remove("hidden");
      } else {
        img.removeAttribute("src");
        img.classList.add("hidden");
      }
    });
    paintLiveStatus();
  }

  function paintLiveStatus() {
    const s = liveStatus();
    document.querySelectorAll(".live-dot").forEach((dot) => dot.classList.toggle("on", s.on));
    document.querySelectorAll(".live-status-text").forEach((node) => { node.textContent = s.text; });
  }

  function botColor(d, key) {
    const bots = d && Array.isArray(d.bots) ? d.bots : [];
    const hit = bots.find((b) => String((b && b.name) || "").toLowerCase() === key);
    return safeColor(hit && hit.color) || BOT_COLORS[Math.max(0, BOT_KEYS.indexOf(key)) % BOT_COLORS.length];
  }

  function laneInfo(d) {
    const lane = d && d.lane;
    if (!lane || typeof lane !== "object") return { text: "", color: "" };
    const key = String(lane.bot || "").toLowerCase();
    const text = lane.text ? String(lane.text) : (key ? titleName(key) : "Idle");
    return { text: text, color: key ? botColor(d, key) : "var(--secondary)" };
  }

  function checksNode(checks) {
    const box = el("span", "checks");
    const c = checks && typeof checks === "object" ? checks : {};
    ["screen", "api", "chain"].forEach((k) => {
      const v = c[k];
      const node = el("span", "check" + (v === true ? " yes" : (v === false ? " no" : "")), (v === true ? "✓ " : (v === false ? "✗ " : "– ")) + k);
      node.setAttribute("aria-label", k + (v === true ? " verified" : (v === false ? " failed" : " not checked")));
      box.appendChild(node);
    });
    return box;
  }

  /* "Bought X · $N · verified" + the screen / api / chain checks. */
  function renderLastOrder(box, d) {
    if (!box) return;
    clear(box);
    if (!d || !("last_order" in d)) return;
    const o = d.last_order;
    if (!o || typeof o !== "object") {
      box.appendChild(el("span", "muted", "No orders yet"));
      return;
    }
    const side = String(o.side || "").toLowerCase();
    const verb = side === "sell" ? "Sold" : (side === "buy" ? "Bought" : "Order");
    const bits = [(verb + " " + (o.symbol || shortMint(o.mint) || "")).trim()];
    const amount = num(o.fill_usd) != null ? num(o.fill_usd) : num(o.usd);
    if (amount != null) bits.push(usd(amount));
    const status = String(o.status || "").toLowerCase();
    if (status) bits.push(status === "done" ? "verified" : status);
    box.appendChild(el("span", "", bits.join(" · ")));
    box.appendChild(checksNode(o.checks));
  }

  function renderLive(d) {
    paintLiveFrame();
    const lane = byId("live-lane");
    if (lane) {
      const info = laneInfo(d);
      lane.textContent = info.text;
      lane.style.color = info.color;
    }
    renderLastOrder(byId("last-order"), d);
  }

  /* 12.5 bell: dot when activity is newer than the last time the bell was opened. */
  function newestActivityMs() {
    let best = 0;
    (state.activity || []).forEach((row) => {
      const t = epochMs(row && row.ts);
      if (!isNaN(t) && t > best) best = t;
    });
    return best;
  }

  function bellSeen() {
    try {
      const v = Number(localStorage.getItem(BELL_KEY));
      return isFinite(v) ? v : 0;
    } catch (e) {
      return 0;
    }
  }

  function renderBell() {
    const fresh = newestActivityMs() > bellSeen();
    const dot = byId("bell-dot");
    if (dot) dot.classList.toggle("hidden", !fresh);
    const bell = byId("bell");
    if (bell) bell.setAttribute("aria-label", fresh ? "Notifications, new activity" : "Notifications");
  }

  function openBell() {
    const newest = newestActivityMs();
    try {
      if (newest) localStorage.setItem(BELL_KEY, String(newest));
    } catch (e) {}
    closeAllScreens();
    showTab("activity");
    renderBell();
  }

  function renderError() {
    const err = byId("error");
    if (!err) return;
    err.classList.toggle("hidden", !state.err);
    err.textContent = state.err ? offlineText() : "";
    err.title = state.err || "";
  }

  /* 12.4 "Desk offline · retrying in {n}s · last update {time}"; the last good numbers stay on screen. */
  function offlineText() {
    const n = Math.max(0, Math.ceil((state.nextPollAt - Date.now()) / 1000));
    const d = state.data || {};
    const at = !isNaN(epochMs(d.updated_at)) ? d.updated_at : (state.lastGoodAt || null);
    const clock = at ? formatWhen(at) : "";
    return "Desk offline · retrying in " + n + "s · last update " + (/^\d{2}:\d{2}$/.test(clock) ? clock : "—");
  }


  function poolData(d) {
    const raw = d && d.pool ? d.pool : {};
    return {
      counts: raw.counts || {},
      candidates: Array.isArray(raw.candidates) ? raw.candidates : [],
      finals: Array.isArray(raw.finals) ? raw.finals : [],
      minAge: raw.min_pool_age_min != null ? Number(raw.min_pool_age_min) : 10,
      dropAfter: raw.drop_after_min != null ? Number(raw.drop_after_min) : 60,
    };
  }

  function poolHit(row, q) {
    return [row && row.symbol, row && row.mint, row && row.mint_short, row && row.status, row && row.source, row && row.reason, row && row.verdict].some((v) => String(v == null ? "" : v).toLowerCase().includes(q));
  }

  function poolAgeNow(row, nowMs, minAge, dropAfter) {
    let age = null;
    const ref = epochMs(row && row.age_as_of);
    if (row && row.age_min != null && isFinite(Number(row.age_min)) && !isNaN(ref)) {
      age = Number(row.age_min) + (nowMs - ref) / 60000;
    } else {
      const seen = epochMs(row && row.first_seen);
      if (!isNaN(seen)) age = (nowMs - seen) / 60000;
    }
    if (age == null || !isFinite(age)) return { age: null, left: null, drop: null };
    return { age: age, left: Math.max(0, minAge - age), drop: Math.max(0, dropAfter - age) };
  }

  function fmtLeft(minutes) {
    if (minutes == null || !isFinite(minutes)) return "";
    if (minutes >= 1.5) return Math.round(minutes) + " min";
    if (minutes >= 1) return "1 min";
    const s = Math.max(0, Math.round(minutes * 60));
    return s + "s";
  }

  function countdownText(row, nowMs, minAge, dropAfter) {
    const status = String((row && row.status) || "");
    if (status.indexOf("waiting DexScreener pair") === 0) return "";
    const t = poolAgeNow(row, nowMs, minAge, dropAfter);
    if (status === "waiting pool age") {
      if (t.left != null && t.left > 0) return "⏱ " + fmtLeft(t.left) + " left";
      if (t.drop != null && t.drop > 0) return "⏱ drop in " + fmtLeft(t.drop);
      return "";
    }
    return "";
  }

  function statusPillClass(status, verdict) {
    const s = String(status || verdict || "");
    if (s.indexOf("waiting DexScreener pair") === 0) return "pill mini pair";
    if (s === "waiting pool age") return "pill mini wait";
    if (s === "in Analyst" || s === "passed → Brain") return "pill mini review";
    if (s === "waiting dip") return "pill mini dip";
    if (s === "pass" || s === "bought") return "pill mini pass";
    if (s === "kill") return "pill mini kill";
    return "pill mini";
  }

  function sourceLabel(source) {
    const s = String(source || "").toLowerCase();
    if (s === "pumpportal") return "pumpportal";
    if (s === "dex" || s === "dex_search") return "dex";
    return s;
  }

  function renderPool() {
    const chips = document.getElementById("pool-chips");
    const empty = document.getElementById("pool-empty");
    const list = document.getElementById("pool-list");
    const finalsBox = document.getElementById("pool-finals");
    const finalsHead = document.getElementById("pool-finals-heading");
    if (!chips || !list) return;
    const view = poolData(state.data || {});
    const q = (state.query || "").toLowerCase();
    const counts = view.counts;
    const chipDefs = [
      [counts.in_pool, "in pool"],
      [counts.waiting_age, "waiting age"],
      [counts.waiting_pair, "waiting pair"],
      [counts.in_review, "in review"],
      [counts.passed_tonight, "passed"],
      [counts.killed_tonight, "killed"],
    ];
    clear(chips);
    chipDefs.forEach((item) => {
      const n = item[0] == null ? 0 : item[0];
      const chip = el("span", "pill");
      chip.textContent = n + " " + item[1];
      chips.appendChild(chip);
    });
    const rows = q ? view.candidates.filter((row) => poolHit(row, q)) : view.candidates;
    clear(list);
    if (empty) empty.classList.toggle("hidden", rows.length > 0 || (q && view.candidates.length > 0));
    if (empty && q && !rows.length && view.candidates.length) empty.classList.add("hidden");
    const nowMs = Date.now();
    rows.forEach((row) => {
      const wrap = el("div", "pool-row");
      const top = el("div", "pool-top");
      const symbol = el("span", "pool-symbol");
      const label = (row && row.symbol) || (row && row.mint_short) || "TOKEN";
      fillText(symbol, label, q);
      top.appendChild(symbol);
      const pill = el("span", statusPillClass(row && row.status));
      pill.textContent = (row && row.status) || "";
      top.appendChild(pill);
      wrap.appendChild(top);
      const sub = el("div", "pool-sub");
      const src = el("span", "pool-source muted");
      const bits = [];
      if (row && row.mint_short) bits.push(row.mint_short);
      const srcLabel = sourceLabel(row && row.source);
      if (srcLabel) bits.push(srcLabel);
      fillText(src, bits.join(" · "), q);
      sub.appendChild(src);
      const cd = countdownText(row, nowMs, view.minAge, view.dropAfter);
      if (cd) sub.appendChild(el("span", "pool-countdown", cd));
      wrap.appendChild(sub);
      list.appendChild(wrap);
    });
    const finals = q ? view.finals.filter((row) => poolHit(row, q)) : view.finals;
    if (finalsHead) finalsHead.classList.toggle("hidden", !finals.length);
    if (finalsBox) {
      clear(finalsBox);
      finals.forEach((row) => {
        const wrap = el("div", "pool-row");
        const top = el("div", "pool-top");
        const symbol = el("span", "pool-symbol");
        fillText(symbol, (row && row.symbol) || (row && row.mint_short) || "TOKEN", q);
        top.appendChild(symbol);
        const info = pillInfo(row);
        if (info) top.appendChild(el("span", info.className, info.label));
        wrap.appendChild(top);
        const sub = el("div", "pool-sub");
        const detail = el("span", "pool-source muted");
        const bits = [];
        const why = rowDetail(row) || (row && row.reason) || "";
        if (why) bits.push(why);
        if (row && row.mint_short) bits.push(row.mint_short);
        fillText(detail, bits.join(" · "), q);
        sub.appendChild(detail);
        if (row && row.ts) sub.appendChild(el("span", "activity-time muted", formatWhen(row.ts)));
        wrap.appendChild(sub);
        finalsBox.appendChild(wrap);
      });
    }
  }

  function tickPoolCountdowns() {
    if (state.tab !== "pool") return;
    const list = document.getElementById("pool-list");
    if (!list) return;
    const view = poolData(state.data || {});
    const nowMs = Date.now();
    const nodes = list.querySelectorAll(".pool-row");
    const rows = (state.query ? view.candidates.filter((row) => poolHit(row, (state.query || "").toLowerCase())) : view.candidates);
    nodes.forEach((node, i) => {
      const row = rows[i];
      if (!row) return;
      const text = countdownText(row, nowMs, view.minAge, view.dropAfter);
      let cd = node.querySelector(".pool-countdown");
      if (!text) {
        if (cd) cd.remove();
        return;
      }
      if (!cd) {
        const sub = node.querySelector(".pool-sub") || node;
        cd = el("span", "pool-countdown");
        sub.appendChild(cd);
      }
      cd.textContent = text;
    });
  }

  /* ---------- Full-screen views: Coin (12.10), Audit (12.9), LIVE frame (12.5) ---------- */

  function coinEntry(mint) {
    const src = isPlanB() ? state.coins : state.coinsA;
    const hit = src && mint ? src[mint] : null;
    return hit && typeof hit === "object" ? hit : null;
  }

  /* Plan B can only show coins that are in coins.json; Plan A asks /api/coin and /api/audit. */
  function hasCoin(mint) {
    if (!mint) return false;
    const hit = coinEntry(mint);
    return !isPlanB() || !!(hit && hit.coin);
  }

  function hasAudit(mint) {
    if (!mint) return false;
    const hit = coinEntry(mint);
    return !isPlanB() || !!(hit && hit.audit);
  }

  function openScreen(view) {
    if (!isPlanB() && view.type !== "frame") view.loading = true;
    state.screens.push(view);
    renderScreen(true);
    if (view.loading) fetchCoinA(view);
    if (view.type === "frame") refreshFrame(true);
  }

  function closeScreen() {
    state.screens.pop();
    renderScreen(true);
  }

  function closeAllScreens() {
    if (!state.screens.length) return;
    state.screens = [];
    renderScreen(true);
  }

  function topScreen() {
    return state.screens[state.screens.length - 1] || null;
  }

  async function fetchCoinA(view) {
    if (view.fetching || isPlanB()) return;
    view.fetching = true;
    try {
      const res = await fetch(apiUrl("/api/" + view.type + "/" + encodeURIComponent(view.mint)), { cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 404 ? "not found" : "HTTP " + res.status);
      const body = await res.json();
      const entry = state.coinsA[view.mint] || (state.coinsA[view.mint] = {});
      entry[view.type] = body;
      view.error = "";
    } catch (e) {
      view.error = (e && e.message) || "Desk offline";
    }
    view.fetching = false;
    view.loading = false;
    if (topScreen() === view) renderScreen(false);
  }

  function refreshOpenScreenA() {
    if (Date.now() - coinPricesAt < COIN_PRICE_MS) return;
    const top = topScreen();
    if (top && top.type === "coin") {
      coinPricesAt = Date.now();
      fetchCoinA(top);
    }
  }

  /* Coin screen prices refresh every 60s. Plan B re-reads coins.json; Plan A re-asks /api/coin. */
  async function refreshCoinPrices() {
    if (!state.cfg || !(state.cfg.token || state.cfg.dataPath)) return;
    if (Date.now() - coinPricesAt < COIN_PRICE_MS) return;
    coinPricesAt = Date.now();
    if (isPlanB()) {
      try {
        const res = await fetch(apiUrl("/api/coins"), { cache: "no-store" });
        if (res && res.status === 404) state.coins = {};
        else if (res && res.ok) {
          const body = await res.json();
          const coins = body && body.coins;
          if (coins && typeof coins === "object" && !Array.isArray(coins)) state.coins = coins;
        }
      } catch (e) {}
      const top = topScreen();
      if (top && top.type === "coin") renderScreen(false);
      return;
    }
    const top = topScreen();
    if (top && top.type === "coin") fetchCoinA(top);
  }

  /* Poll refresh: Coin and frame views redraw; Audit only until its data arrives (its beam runs once). */
  function refreshScreen() {
    const top = topScreen();
    if (top && (top.type !== "audit" || top.waiting)) renderScreen(false);
  }

  function renderScreen(fresh) {
    const box = byId("screen");
    const body = byId("screen-body");
    if (!box || !body) return;
    const top = topScreen();
    document.body.classList.toggle("has-screen", !!top);
    if (!top) {
      box.classList.add("hidden");
      clear(body);
      return;
    }
    const keep = fresh ? 0 : box.scrollTop;
    box.classList.remove("hidden");
    const back = byId("screen-back");
    if (back) back.textContent = top.type === "frame" ? "Close" : "‹ Back";
    const title = byId("screen-title");
    if (title) title.textContent = "";
    clear(body);
    if (top.type === "coin") renderCoinScreen(top, body, title);
    else if (top.type === "audit") renderAuditScreen(top, body, title);
    else renderFrameScreen(body, title);
    box.scrollTop = keep;
  }

  function fomoButton(link) {
    const a = el("a", "btn plain", "Open on FOMO");
    a.href = link;
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  }

  function buttonRow(nodes) {
    const row = el("div", "btn-row");
    nodes.forEach((n) => row.appendChild(n));
    return row;
  }

  function screenPlaceholder(body, view, what, link) {
    if (view.loading) {
      body.appendChild(el("div", "sk-block sk-row"));
      body.appendChild(el("div", "sk-block coin-sk"));
      body.appendChild(el("div", "sk-block sk-row"));
    } else {
      body.appendChild(el("p", "muted", view.error ? "Couldn't load the " + what + " · " + view.error : "No " + what + " data for this coin yet"));
    }
    if (link) body.appendChild(buttonRow([fomoButton(link)]));
  }

  function renderCoinScreen(view, body, title) {
    const d = state.data || {};
    const entry = coinEntry(view.mint) || {};
    const hint = view.hint || {};
    const c = entry.coin && typeof entry.coin === "object" ? entry.coin : null;
    const symbol = (c && c.symbol) || hint.symbol || "";
    if (title) title.textContent = symbol || "Coin";
    const link = linkOf(c && c.link) || linkOf(hint.link);
    if (!c) {
      screenPlaceholder(body, view, "coin", link);
      return;
    }
    const head = el("div", "coin-head");
    head.appendChild(el("h1", "coin-name", c.name || symbol || shortMint(view.mint)));
    if (symbol && c.name) head.appendChild(el("span", "coin-ticker", symbol));
    if ((c.mode || modeOf(d)) === "PAPER") head.appendChild(el("span", "pill orange", "PAPER"));
    body.appendChild(head);
    const price = num(c.price);
    const age = num(c.age_h);
    const sub = el("div", "coin-sub");
    sub.appendChild(el("span", "muted", [price != null ? "$" + fmtPrice(price) : "—", "Solana", age != null ? ageHours(age) + "h old" : "— old"].join(" · ")));
    const passed = num(c.audit_passed);
    const shield = el("button", "shield" + (passed == null ? "" : (passed >= 8 ? " good" : " bad")), (passed != null ? Math.round(passed) : "—") + "/8");
    shield.type = "button";
    shield.setAttribute("aria-label", "Audit " + shield.textContent + " layers passed");
    if (hasAudit(view.mint)) shield.addEventListener("click", () => openScreen({ type: "audit", mint: view.mint, hint: { symbol: symbol, link: link } }));
    else shield.disabled = true;
    sub.appendChild(shield);
    body.appendChild(sub);
    body.appendChild(el("div", "coin-price", price != null ? "$" + fmtPrice(price) : "—"));
    const pos = c.position && typeof c.position === "object" ? c.position : null;
    const x = pos ? num(pos.x_since_entry) : null;
    if (x != null) body.appendChild(el("div", "coin-x " + (x >= 1 ? "up" : "down"), "x" + trimNum(x, 2) + " since entry"));
    const card = el("div", "card");
    const canvas = el("canvas", "candles");
    canvas.width = 360;
    canvas.height = 200;
    card.appendChild(canvas);
    body.appendChild(card);
    const drawn = window.DeskChart && window.DeskChart.drawCandles
      ? window.DeskChart.drawCandles(canvas, c.candles, { stop: pos ? num(pos.stop_price) : null })
      : false;
    if (!drawn) {
      canvas.classList.add("hidden");
      card.appendChild(el("p", "muted", "No candles yet"));
    }
    const stats = el("div", "stats3");
    [["Market cap", compactUsd(c.market_cap)], ["Liquidity", compactUsd(c.liquidity_usd)], ["Holders", countText(c.holders)]].forEach((pair) => {
      const cell = el("div", "stat");
      cell.appendChild(el("div", "stat-label", pair[0]));
      cell.appendChild(el("div", "stat-value", pair[1]));
      stats.appendChild(cell);
    });
    body.appendChild(stats);
    if (pos) {
      const size = num(pos.size_usd);
      const bits = ["Your position", (size != null ? usd(size) : "—") + " in"];
      if (pos.bot) bits.push(titleName(pos.bot));
      body.appendChild(el("p", "coin-pos", bits.join(" · ")));
    }
    const buttons = [];
    if (link) buttons.push(fomoButton(link));
    if (pos) {
      const sell = el("button", "btn danger", "Sell now");
      sell.type = "button";
      sell.addEventListener("click", () => openSellSheet(view.mint, symbol));
      buttons.push(sell);
    }
    if (buttons.length) body.appendChild(buttonRow(buttons));
  }

  function passState(v) {
    if (v === true || v === 1 || v === "1") return "pass";
    if (v === false || v === 0 || v === "0") return "fail";
    return "none";
  }

  function layerNo(layer, fallback) {
    const n = num(layer && (layer.layer != null ? layer.layer : layer.n));
    return n != null ? Math.round(n) : fallback;
  }

  function renderAuditScreen(view, body, title) {
    const entry = coinEntry(view.mint) || {};
    const hint = view.hint || {};
    const a = entry.audit && typeof entry.audit === "object" ? entry.audit : null;
    const coin = entry.coin && typeof entry.coin === "object" ? entry.coin : {};
    const symbol = (a && a.symbol) || coin.symbol || hint.symbol || "";
    if (title) title.textContent = (symbol ? symbol + " · " : "") + "Audit";
    const link = linkOf(a && a.link) || linkOf(coin.link) || linkOf(hint.link);
    if (!a) {
      view.waiting = true;
      screenPlaceholder(body, view, "audit", link);
      return;
    }
    view.waiting = false;
    const animate = !view.animated && !reducedMotion();
    view.animated = true;
    const layers = (Array.isArray(a.layers) ? a.layers : []).filter((l) => l && typeof l === "object");
    const byNo = {};
    layers.forEach((l, i) => {
      const n = layerNo(l, i + 1);
      if (!byNo[n]) byNo[n] = l;
    });
    const discs = el("div", "discs");
    for (let n = 1; n <= 8; n++) {
      const l = byNo[n];
      const s = l ? passState(l.pass) : "none";
      const disc = el("div", "disc" + (s === "none" ? "" : " " + s), s === "pass" ? "✓" : (s === "fail" ? "✗" : "–"));
      disc.setAttribute("role", "img");
      disc.setAttribute("aria-label", "Layer " + n + (l && l.name ? " " + l.name : "") + ": " + (s === "none" ? "no data" : s));
      if (animate) disc.style.animationDelay = (0.1 + (n - 1) * 0.2).toFixed(2) + "s";
      else disc.style.animation = "none";
      discs.appendChild(disc);
    }
    if (animate) {
      const beam = el("div", "beam");
      beam.setAttribute("aria-hidden", "true");
      beam.addEventListener("animationend", () => beam.remove());
      discs.appendChild(beam);
    }
    body.appendChild(discs);
    layers.slice().sort((x, y) => layerNo(x, 99) - layerNo(y, 99)).forEach((l) => {
      const s = passState(l.pass);
      const row = el("div", "layer-row");
      const n = layerNo(l, null);
      row.appendChild(el("span", "layer-n", n != null ? "L" + n : "—"));
      row.appendChild(el("span", "layer-name", l.name ? String(l.name) : "—"));
      const value = l.text != null && l.text !== "" ? l.text : l.value;
      row.appendChild(el("span", "layer-value", value != null && value !== "" && typeof value !== "object" ? String(value) : "—"));
      const mark = el("span", "layer-mark " + s, s === "pass" ? "✓" : (s === "fail" ? "✗" : "–"));
      mark.setAttribute("aria-label", s === "none" ? "no data" : s);
      row.appendChild(mark);
      body.appendChild(row);
    });
    if (!layers.length) body.appendChild(el("p", "muted", "No layers recorded yet"));
    if (typeof a.social_line === "string" && a.social_line.trim()) body.appendChild(el("div", "social-line", a.social_line));
    if (link) body.appendChild(buttonRow([fomoButton(link)]));
  }

  function renderFrameScreen(body, title) {
    const d = state.data || {};
    if (title) title.textContent = "Bot's computer";
    const card = el("div", "live-card frame-card");
    const img = el("img", "live-frame full hidden");
    img.alt = "Bot's computer";
    card.appendChild(img);
    const bar = el("div", "live-top");
    const status = el("span", "live-status");
    status.appendChild(el("span", "live-dot"));
    status.appendChild(el("span", "live-status-text"));
    bar.appendChild(status);
    const info = laneInfo(d);
    const lane = el("span", "live-lane", info.text);
    lane.style.color = info.color;
    bar.appendChild(lane);
    card.appendChild(bar);
    body.appendChild(card);
    const order = el("div", "last-order");
    renderLastOrder(order, d);
    body.appendChild(order);
    paintLiveFrame();
  }

  /* ---------- Sheets ---------- */

  function openSheet(build) {
    const sheet = byId("sheet");
    const body = byId("sheet-body");
    if (!sheet || !body) return;
    clear(body);
    build(body);
    sheet.classList.remove("hidden");
    const backdrop = byId("sheet-backdrop");
    if (backdrop) backdrop.classList.remove("hidden");
  }

  function closeSheet() {
    const sheet = byId("sheet");
    if (sheet) sheet.classList.add("hidden");
    const backdrop = byId("sheet-backdrop");
    if (backdrop) backdrop.classList.add("hidden");
    const body = byId("sheet-body");
    if (body) clear(body);
  }

  function commandRow(cmd, placeholder) {
    const row = el("div", "cmd");
    const input = el("input");
    input.type = "text";
    input.readOnly = true;
    input.placeholder = placeholder || "";
    input.setAttribute("aria-label", "Telegram command");
    const btn = el("button", "", "Copy");
    btn.type = "button";
    const set = (text) => {
      input.value = text || "";
      btn.disabled = !text;
      btn.textContent = "Copy";
    };
    btn.addEventListener("click", async () => {
      const ok = await copyText(input.value, input);
      btn.textContent = ok ? "Copied" : "Select";
    });
    row.appendChild(input);
    row.appendChild(btn);
    set(cmd);
    return { node: row, set: set };
  }

  function openCommandSheet(cmd) {
    openSheet((box) => {
      box.appendChild(el("h3", "", "Plan B: send this in Telegram"));
      box.appendChild(commandRow(cmd).node);
    });
  }

  /* options: [{value, label}]; onPick null = read-only. */
  function segmented(options, current, disabled, onPick) {
    const seg = el("div", "seg");
    seg.setAttribute("role", "radiogroup");
    const buttons = options.map((o) => {
      const b = el("button", "", o.label);
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(current != null && String(o.value).toLowerCase() === String(current).toLowerCase()));
      b.disabled = !!disabled;
      if (!disabled && onPick) {
        b.addEventListener("click", () => {
          buttons.forEach((x) => x.setAttribute("aria-checked", String(x === b)));
          onPick(o.value);
        });
      }
      seg.appendChild(b);
      return b;
    });
    return seg;
  }

  /* 12.10 Sell sheet. Plan A queues /api/sell (Executor sells on its PAPER path); Plan B shows the Telegram command. */
  function openSellSheet(mint, symbol) {
    const name = symbol || mint;
    openSheet((box) => {
      box.appendChild(el("h3", "", "Sell now · " + name));
      const msg = el("p", "sheet-msg hidden");
      let pct = null;
      let onPick = () => {};
      box.appendChild(segmented([25, 50, 100].map((n) => ({ value: n, label: n + "%" })), null, false, (v) => {
        pct = v;
        onPick();
      }));
      if (isPlanB()) {
        box.appendChild(el("p", "", "Plan B: send this in Telegram"));
        const cmd = commandRow("", "Pick 25%, 50% or 100%");
        box.appendChild(cmd.node);
        box.appendChild(el("p", "muted", "The desk sells it through the Executor's PAPER path after you confirm \"yes\" in Telegram."));
        onPick = () => cmd.set("sell now " + name + " " + pct);
      } else {
        const confirm = el("button", "btn danger", "Confirm sell");
        confirm.type = "button";
        confirm.disabled = true;
        onPick = () => { confirm.disabled = false; setMsg(msg, "", false); };
        confirm.addEventListener("click", async () => {
          if (pct == null) return;
          const sent = pct;
          confirm.disabled = true;
          const out = await postJson("/api/sell/" + encodeURIComponent(mint), { pct: sent, confirm: true });
          if (out.ok) {
            setMsg(msg, "Queued · Executor sells " + sent + "% on the next Risk poll (PAPER)", false);
          } else {
            setMsg(msg, errText(out), true);
            confirm.disabled = false;
          }
        });
        box.appendChild(buttonRow([confirm]));
      }
      box.appendChild(msg);
    });
  }


  /* 12.11 LIVE needs the word LIVE typed; this build answers that LIVE is locked. */
  function openLiveSheet() {
    const d = state.data || {};
    openSheet((box) => {
      box.appendChild(el("h3", "", "Switch to LIVE"));
      const warn = accountOf(d).live_warning || d.live_warning;
      if (typeof warn === "string" && warn) box.appendChild(el("p", "muted", warn));
      const form = el("form", "sheet-form");
      const input = el("input", "acct-input");
      input.type = "text";
      input.placeholder = "Type LIVE";
      input.autocomplete = "off";
      input.setAttribute("autocapitalize", "characters");
      input.setAttribute("aria-label", "Type LIVE to switch");
      const go = el("button", "btn danger", "Switch to LIVE");
      go.type = "submit";
      const msg = el("p", "sheet-msg hidden");
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (input.value.trim() !== "LIVE") {
          setMsg(msg, "Type LIVE to switch", true);
          return;
        }
        if (isPlanB()) {
          setMsg(msg, "LIVE is locked", true);
          return;
        }
        go.disabled = true;
        const out = await postJson("/api/mode", { mode: "LIVE" });
        go.disabled = false;
        if (out.ok) {
          setMsg(msg, (out.body && typeof out.body.message === "string" && out.body.message) || "Mode change sent", false);
          load();
        } else {
          setMsg(msg, errText(out), true);
        }
      });
      form.appendChild(input);
      form.appendChild(go);
      form.appendChild(msg);
      box.appendChild(form);
    });
  }

  /* ---------- Account (12.11) ---------- */

  function renderAccount(d) {
    const acct = accountOf(d);
    const mode = modeOf(d);
    const pill = byId("acct-mode");
    if (pill) {
      pill.textContent = mode || "—";
      pill.className = "pill" + (mode === "PAPER" ? " orange" : (mode === "LIVE" ? " red" : ""));
    }
    const warn = byId("live-warning");
    const warnText = acct.live_warning || d.live_warning;
    if (warn && typeof warnText === "string" && warnText) warn.textContent = warnText;
    renderCash(d);
    const prof = byId("profile");
    const profileUrl = linkOf(acct.profile) || linkOf(d.profile);
    if (prof) {
      prof.classList.toggle("hidden", !profileUrl);
      if (profileUrl) prof.href = profileUrl;
    }
    const signup = byId("signup");
    if (signup) signup.classList.toggle("hidden", !(linkOf(acct.signup) || linkOf(d.signup)));
    const vault = acct.vault;
    /* PDF 16.8: "Vault: plugin | files"; with no plugin the row says "files · not on iPhone". */
    const vaultText = typeof acct.vault_text === "string" && acct.vault_text ? acct.vault_text
      : (typeof vault === "string" && vault ? (vault === "files" ? "files · not on iPhone" : vault)
      : (vault && typeof vault === "object" && (vault.mode || vault.kind) ? String(vault.mode || vault.kind) : "—"));
    const vaultNode = byId("acct-vault");
    if (vaultNode) vaultNode.textContent = vaultText;
    const pushes = acct.pushes && typeof acct.pushes === "object" ? acct.pushes : null;
    const tg = byId("push-telegram");
    if (tg) tg.textContent = !pushes || pushes.telegram == null ? "—" : (pushes.telegram ? "connected" : "not connected");
    const web = byId("push-web");
    if (web) {
      let text = "—";
      if (pushes && String(pushes.plan || "").toUpperCase() === "B") text = "Plan B — Telegram only";
      else if (pushes && pushes.webpush != null) text = pushes.webpush ? "connected" : "not connected";
      web.textContent = text;
    }
  }

  function renderCash(d) {
    const box = byId("acct-cash");
    if (!box) return;
    const acct = accountOf(d);
    const plan = isPlanB() ? "B" : "A";
    if (box.dataset.plan !== plan) {
      box.dataset.plan = plan;
      clear(box);
      [["Cash", "acct-cash-now"], ["Start cash", "acct-cash-start"]].forEach((pair) => {
        const row = el("div", "acct-row");
        row.appendChild(el("span", "", pair[0]));
        const value = el("span", "muted", "—");
        value.id = pair[1];
        row.appendChild(value);
        box.appendChild(row);
      });
      if (plan === "A") {
        const form = el("form", "setting-controls");
        const input = el("input", "acct-input");
        input.type = "number";
        input.inputMode = "decimal";
        input.step = "any";
        input.placeholder = "New cash";
        input.setAttribute("aria-label", "Cash");
        const save = el("button", "small-btn", "Save");
        save.type = "submit";
        const msg = el("p", "setting-msg hidden");
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const x = num(input.value);
          if (x == null || x < 0) {
            setMsg(msg, "cash must be a number", true);
            return;
          }
          save.disabled = true;
          const out = await postJson("/api/account", { cash: x });
          save.disabled = false;
          if (out.ok) {
            input.value = "";
            setMsg(msg, "Saved", false);
            load();
          } else {
            setMsg(msg, errText(out), true);
          }
        });
        form.appendChild(input);
        form.appendChild(save);
        box.appendChild(form);
        box.appendChild(msg);
      }
    }
    const cash = num(acct.cash) != null ? num(acct.cash) : num(d.cash);
    const start = num(acct.start_cash) != null ? num(acct.start_cash) : num(d.start_cash);
    const now = byId("acct-cash-now");
    if (now) now.textContent = cash != null ? money2(cash) : "—";
    const startNode = byId("acct-cash-start");
    if (startNode) startNode.textContent = start != null ? money2(start) : "—";
  }

  async function invite() {
    const d = state.data || {};
    const url = linkOf(accountOf(d).signup) || linkOf(d.signup);
    const note = byId("invite-note");
    if (!url) return;
    if (navigator.share) {
      try {
        await navigator.share({ url: url });
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
      }
    }
    const ok = await copyText(url);
    if (note) {
      note.textContent = ok ? "Link copied" : url;
      note.classList.remove("hidden");
    }
  }

  function groupId(group) {
    return "set-" + String(group || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function groupRank(group) {
    const i = SETTINGS_GROUPS.indexOf(group);
    return i < 0 ? SETTINGS_GROUPS.length : i;
  }

  function fmtNum(x) {
    return x == null ? "?" : String(x);
  }

  function cmdValue(v) {
    if (v === true || v === false) return v ? "on" : "off";
    return String(v == null ? "" : v).trim();
  }

  /* Every catalog row, grouped per bot. Rebuilt only when the catalog changes and nothing is being edited. */
  function renderSettings(d) {
    const box = byId("settings");
    if (!box) return;
    const catalog = Array.isArray(d.settings_catalog) ? d.settings_catalog.filter((r) => r && typeof r === "object" && r.key) : null;
    const sig = JSON.stringify([isPlanB(), !!state.data, catalog, Array.isArray(d.picks) ? d.picks : null]);
    if (sig === state.settingsSig || state.settingsDirty) return;
    state.settingsSig = sig;
    clear(box);
    if (!catalog) {
      if (state.data) box.appendChild(el("p", "muted", "Settings not published yet"));
      return;
    }
    const groups = [];
    catalog.forEach((r) => {
      const g = String(r.group || "Other");
      if (groups.indexOf(g) < 0) groups.push(g);
    });
    if (groups.indexOf("Copy picks") < 0) groups.push("Copy picks");
    groups.sort((a, b) => groupRank(a) - groupRank(b));
    groups.forEach((g) => {
      const card = el("div", "group-card");
      const head = el("h3", "", g);
      head.id = groupId(g);
      card.appendChild(head);
      const rows = catalog.filter((r) => String(r.group || "Other") === g);
      if (g === "Copy picks") appendPicks(card, rows, d);
      rows.forEach((r) => {
        if (g === "Copy picks" && (r.key === "picks.every" || r.key === "picks.time")) return;
        card.appendChild(settingRow(r));
      });
      box.appendChild(card);
    });
  }

  /* 12.11 / P3 Copy picks: schedule (Plan B: the Telegram `set` command), one #1c1c1e card per trader of the
     newest list (7d / 30d in green, Profile button, last buy row, "Copy on desk" switch), then the last 7 lists. */
  function appendPicks(card, rows, d) {
    const every = rows.find((r) => r.key === "picks.every") || {};
    const time = rows.find((r) => r.key === "picks.time") || {};
    const wrap = el("div", "setting");
    const top = el("div", "setting-top");
    top.appendChild(el("span", "setting-key", "picks.every"));
    wrap.appendChild(top);
    const choices = Array.isArray(every.choices) && every.choices.length ? every.choices.map(String) : ["off", "24h", "12h", "6h"];
    const cur = every.value == null ? null : String(every.value);
    wrap.appendChild(segmented(choices.map((c) => ({ value: c, label: c === "off" ? "Off" : c })), cur, false,
      (v) => openCommandSheet("set picks.every " + v)));
    const timeRow = el("div", "setting-top");
    timeRow.appendChild(el("span", "setting-key", "picks.time"));
    const tIn = el("input");
    tIn.type = "time";
    tIn.value = /^\d{2}:\d{2}$/.test(String(time.value)) ? String(time.value) : "";
    tIn.setAttribute("aria-label", "picks.time");
    tIn.addEventListener("change", () => { if (/^\d{2}:\d{2}$/.test(tIn.value)) openCommandSheet("set picks.time " + tIn.value); });
    timeRow.appendChild(tIn);
    wrap.appendChild(timeRow);
    wrap.appendChild(el("p", "acct-note muted", cur && cur !== "off"
      ? "The copy-picks routine sends the list every " + cur + " from " + (time.value || "21:30") + " (Telegram)."
      : "Off: no list is sent."));
    card.appendChild(wrap);
    const picks = Array.isArray(d.picks) ? d.picks.filter((p) => p && typeof p === "object") : [];
    if (!picks.length) {
      card.appendChild(el("p", "acct-note muted", "No picks yet"));
      return;
    }
    const lists = {};
    picks.forEach((p) => { const k = String(p.ts || ""); (lists[k] = lists[k] || []).push(p); });
    const stamps = Object.keys(lists).sort().reverse();
    const newest = (lists[stamps[0]] || []).slice().sort((a, b) => (num(a.rank) || 99) - (num(b.rank) || 99));
    card.appendChild(el("p", "acct-note muted", "Grok Bot · " + newest.length + " traders worth copying · " + formatWhen(stamps[0])));
    newest.forEach((p) => card.appendChild(traderCard(p)));
    if (stamps.length > 1) {
      const det = el("details", "decisions");
      det.appendChild(el("summary", "", "Last " + Math.min(7, stamps.length) + " lists"));
      stamps.slice(0, 7).forEach((ts) => {
        const row = el("div", "picks-row");
        row.appendChild(el("span", "", (lists[ts] || []).slice().sort((a, b) => (num(a.rank) || 99) - (num(b.rank) || 99))
          .map((p) => "@" + String(p.handle || "").replace(/^@/, "")).join(" · ")));
        row.appendChild(el("span", "muted", formatWhen(ts)));
        det.appendChild(row);
      });
      card.appendChild(det);
    }
  }

  function signedUsd(v) {
    const n = num(v);
    if (n == null) return "—";
    return (n >= 0 ? "+$" : "-$") + compactUsd(Math.abs(n)).replace(/^\$/, "");
  }

  function traderCard(p) {
    const c = el("div", "trader-card");
    const handle = String(p.handle || "").replace(/^@/, "");
    const head = el("div", "trader-top");
    head.appendChild(el("span", "trader-name", (p.rank != null ? "#" + p.rank + " " : "") + "@" + handle));
    const prof = linkOf(p.profile);
    if (prof) {
      const a = el("a", "pill mini", "Profile");
      a.href = prof;
      a.target = "_blank";
      a.rel = "noopener";
      head.appendChild(a);
    }
    c.appendChild(head);
    const nums = el("div", "trader-nums");
    const n7 = num(p.pnl_7d), n30 = num(p.pnl_30d);
    nums.appendChild(el("span", n7 != null && n7 >= 0 ? "up" : "down", "7d " + signedUsd(p.pnl_7d)));
    nums.appendChild(el("span", n30 != null && n30 >= 0 ? "up" : "down", "30d " + signedUsd(p.pnl_30d)));
    if (p.trades != null) nums.appendChild(el("span", "muted", countText(p.trades) + " trades"));
    c.appendChild(nums);
    const lb = linkOf(p.last_buy);
    const lastRow = lb ? el("a", "trader-last fomo-link") : el("div", "trader-last muted");
    if (lb) { lastRow.href = lb; lastRow.target = "_blank"; lastRow.rel = "noopener"; }
    lastRow.textContent = "Last buy: " + (p.last_buy_mint ? shortMint(p.last_buy_mint) : "—") + (p.last_trade_at ? " · " + formatWhen(p.last_trade_at) : "");
    c.appendChild(lastRow);
    const row = el("div", "bot-control");
    row.appendChild(el("span", "bot-control-text", "Copy on desk"));
    const sw = el("button", "switch");
    sw.type = "button";
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-checked", String(!!p.copy_on));
    sw.setAttribute("aria-label", "Copy @" + handle + " on desk");
    const cmd = typeof p.copy_command === "string" && p.copy_command ? p.copy_command : ("copy " + handle + (p.copy_on ? " off" : " on"));
    sw.classList.add("read-only");
    sw.addEventListener("click", () => openCommandSheet(cmd));
    const hit = el("span", "switch-hit");
    hit.appendChild(sw);
    row.appendChild(hit);
    c.appendChild(row);
    return c;
  }

  function settingRow(r) {
    const ro = isPlanB();
    const key = String(r.key);
    const kind = String(r.kind || "text");
    const wrap = el("div", "setting");
    const top = el("div", "setting-top");
    top.appendChild(el("span", "setting-key", key));
    wrap.appendChild(top);
    const controls = el("div", "setting-controls");
    const note = state.settingNotes[key];
    const msg = el("p", "setting-msg hidden");
    setMsg(msg, note && note.text, note && note.err);
    const touch = () => {
      if (ro) return;
      state.settingsDirty = true;
      delete state.settingNotes[key];
      setMsg(msg, "", false);
    };
    let read = null;
    let check = () => "";
    let parse = (v) => v;
    if (kind === "number") {
      const v = num(r.value);
      const lo = num(r.min);
      const hi = num(r.max);
      const step = num(r.step);
      const exact = el("input");
      exact.type = "number";
      exact.inputMode = "decimal";
      exact.step = step != null ? String(step) : "any";
      if (lo != null) exact.min = String(lo);
      if (hi != null) exact.max = String(hi);
      exact.value = v != null ? String(v) : "";
      exact.placeholder = "—";
      exact.setAttribute("aria-label", key);
      let range = null;
      if (v != null && lo != null && hi != null && hi > lo) {
        range = el("input");
        range.type = "range";
        range.min = String(lo);
        range.max = String(hi);
        range.step = exact.step;
        range.value = String(v);
        range.setAttribute("aria-label", key + " slider");
        range.addEventListener("input", () => { exact.value = range.value; touch(); });
        controls.appendChild(range);
      }
      exact.addEventListener("input", () => {
        const x = num(exact.value);
        if (range && x != null && x >= lo && x <= hi) range.value = String(x);
        touch();
      });
      controls.appendChild(exact);
      if (ro) {
        exact.disabled = true;
        if (range) range.disabled = true;
      }
      read = () => exact.value.trim();
      check = (val) => {
        const x = num(val);
        if (lo != null && hi != null && (x == null || x < lo || x > hi)) return key + " must be " + fmtNum(lo) + " to " + fmtNum(hi);
        return x == null ? key + " needs a number" : "";
      };
      parse = (val) => num(val);
    } else if (kind === "choice") {
      const choices = Array.isArray(r.choices) ? r.choices.map(String) : [];
      let current = r.value == null || r.value === "" ? null : String(r.value);
      if (choices.length && choices.length <= 4) {
        controls.appendChild(segmented(choices.map((c) => ({ value: c, label: c })), current, ro, (val) => { current = val; touch(); }));
      } else {
        const select = el("select");
        select.setAttribute("aria-label", key);
        choices.forEach((c) => {
          const opt = el("option", "", c);
          opt.value = c;
          select.appendChild(opt);
        });
        select.value = current != null ? current : "";
        select.disabled = ro;
        select.addEventListener("change", () => { current = select.value; touch(); });
        controls.appendChild(select);
      }
      read = () => current;
      check = (val) => (val == null || choices.indexOf(String(val)) < 0) ? key + " must be one of: " + choices.join(", ") : "";
    } else if (kind === "time") {
      const input = el("input");
      input.type = "time";
      input.value = /^\d{2}:\d{2}$/.test(String(r.value)) ? String(r.value) : "";
      input.disabled = ro;
      input.setAttribute("aria-label", key);
      input.addEventListener("input", touch);
      controls.appendChild(input);
      read = () => input.value;
      check = (val) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(val)) ? "" : key + " must be a time HH:MM (00:00 to 23:59)";
    } else if (kind === "bool") {
      let on = boolOf(r.value);
      const sw = el("button", "switch");
      sw.type = "button";
      sw.setAttribute("role", "switch");
      sw.setAttribute("aria-checked", String(on === true));
      sw.setAttribute("aria-label", key);
      if (ro) {
        sw.disabled = true;
      } else {
        sw.addEventListener("click", () => {
          on = !on;
          sw.setAttribute("aria-checked", String(on));
          touch();
        });
      }
      controls.appendChild(sw);
      if (on === null) controls.appendChild(el("span", "muted", "—"));
      read = () => on;
      check = (val) => (val === true || val === false) ? "" : key + " must be on or off";
    } else if (r.masked) {
      controls.appendChild(el("span", "muted", r.value ? "set" : "not set"));
    } else {
      const input = el("input");
      input.type = "text";
      input.maxLength = 100;
      input.value = r.value == null ? "" : String(r.value);
      input.disabled = ro;
      input.setAttribute("aria-label", key);
      input.autocomplete = "off";
      input.addEventListener("input", touch);
      controls.appendChild(input);
      read = () => input.value.trim();
      check = (val) => String(val).length > 100 ? key + " must be plain text up to 100 characters" : "";
    }
    wrap.appendChild(controls);
    if (read) {
      const actions = el("div", "setting-actions");
      if (ro) {
        const copy = el("button", "small-btn", "Copy Telegram command");
        copy.type = "button";
        copy.addEventListener("click", async () => {
          const cmd = "set " + key + " to " + cmdValue(read());
          const ok = await copyText(cmd);
          setMsg(msg, (ok ? "Copied: " : "Copy this: ") + cmd, false);
        });
        actions.appendChild(copy);
      } else {
        const save = el("button", "small-btn", "Save");
        save.type = "button";
        save.addEventListener("click", async () => {
          const val = read();
          const bad = check(val);
          if (bad) {
            setMsg(msg, bad, true);
            return;
          }
          const update = {};
          update[key] = parse(val);
          save.disabled = true;
          const out = await postJson("/api/settings", { settings: update });
          save.disabled = false;
          const errs = out.body && out.body.errors;
          const err = (errs && typeof errs[key] === "string" && errs[key]) || (out.ok ? "" : errText(out));
          state.settingNotes[key] = { text: err || "Saved", err: !!err };
          setMsg(msg, err || "Saved", !!err);
          if (!err) {
            state.settingsDirty = false;
            load();
          }
        });
        actions.appendChild(save);
      }
      actions.appendChild(msg);
      wrap.appendChild(actions);
    } else {
      wrap.appendChild(msg);
    }
    return wrap;
  }


  function showTab(name) {
    state.tab = name;
    if (name !== "account") state.settingsDirty = false;
    ["home", "pool", "bots", "activity", "account"].forEach((t) => {
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
    /* 12.4 first load: #1c1c1e pulsing blocks in the final layout instead of "—". */
    document.body.classList.toggle("is-skeleton", !state.data);
    renderError();
    const gateErr = document.getElementById("gate-error");
    if (!state.err && gateErr) {
      gateErr.textContent = "";
      gateErr.classList.add("hidden");
    }
    const ev = equityView(d);
    document.getElementById("balance").textContent = !state.data ? "" : (ev.equity != null && isFinite(ev.equity) ? ev.equity.toFixed(2) : "—");
    const today = document.getElementById("today");
    today.textContent = ev.pct != null && isFinite(ev.pct) ? ((ev.pct >= 0 ? "+" : "") + ev.pct.toFixed(2) + "%") : "";
    today.className = "pill " + ((ev.pct != null && ev.pct < 0) ? "down" : "green");
    const mult = document.getElementById("mult");
    mult.textContent = ev.mult != null && isFinite(ev.mult) ? ev.mult.toFixed(2) + "x" : "";
    mult.className = "pill " + ((ev.mult != null && ev.mult < 1) ? "down" : "green");
    const eqLine = document.getElementById("equity-line");
    if (eqLine) {
      if (ev.cash != null && isFinite(ev.cash) && ev.equity != null && isFinite(ev.equity)) {
        const pos = (ev.positions != null && isFinite(ev.positions)) ? ev.positions : 0;
        eqLine.textContent = "Cash " + money2(ev.cash) + " · Positions " + money2(pos) + " · Total " + money2(ev.equity);
        eqLine.classList.remove("hidden");
      } else {
        eqLine.textContent = "";
        eqLine.classList.add("hidden");
      }
    }
    const paper = document.getElementById("paper");
    paper.classList.toggle("hidden", modeOf(d) !== "PAPER");
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
    renderHomeActivity();
    renderPool();
    renderRanges();
    renderLive(d);
    renderBell();
    renderAccount(d);
    renderSettings(d);
    refreshFrame(false);
    showTab(state.tab);
    refreshScreen();
  }

  /* Once a second: offline countdown, LIVE frame age and its refresh (15s Plan B, 1s Plan A). */
  function tickSecond() {
    if (state.err) renderError();
    if (!state.data) return;
    paintLiveStatus();
    refreshFrame(false);
    if (Date.now() - coinPricesAt >= COIN_PRICE_MS) refreshCoinPrices();
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
    state.coins = {};
    state.coinsA = {};
    state.chartA = null;
    state.decisionsA = {};
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

  const refreshBtn = document.getElementById("refresh");
  if (refreshBtn) refreshBtn.addEventListener("click", () => load());

  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

  const bellBtn = byId("bell");
  if (bellBtn) bellBtn.addEventListener("click", openBell);

  const avatar = byId("avatar");
  if (avatar) avatar.addEventListener("click", () => { closeAllScreens(); showTab("account"); });

  const seeAll = byId("see-all");
  if (seeAll) seeAll.addEventListener("click", () => showTab("activity"));

  document.querySelectorAll("#ranges button").forEach((b) => b.addEventListener("click", () => {
    state.chartRange = b.dataset.range;
    renderRanges();
    paintChart();
    loadChartA();
  }));

  const liveCard = byId("live-card");
  if (liveCard) {
    liveCard.addEventListener("click", () => { if (state.data) openScreen({ type: "frame" }); });
    liveCard.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      if (state.data) openScreen({ type: "frame" });
    });
  }

  const screenBack = byId("screen-back");
  if (screenBack) screenBack.addEventListener("click", closeScreen);
  const sheetClose = byId("sheet-close");
  if (sheetClose) sheetClose.addEventListener("click", closeSheet);
  const sheetBackdrop = byId("sheet-backdrop");
  if (sheetBackdrop) sheetBackdrop.addEventListener("click", closeSheet);

  const switchLive = byId("switch-live");
  if (switchLive) switchLive.addEventListener("click", openLiveSheet);
  const signupBtn = byId("signup");
  if (signupBtn) signupBtn.addEventListener("click", invite);
  const testPush = byId("test-push");
  if (testPush) {
    testPush.addEventListener("click", () => {
      const note = byId("test-push-note");
      if (!note) return;
      note.textContent = "Send /status in Telegram to test";
      note.classList.remove("hidden");
    });
  }

  const search = document.getElementById("search");
  if (search) {
    search.addEventListener("input", () => {
      state.query = search.value.trim();
      if (state.query) {
        const q = state.query.toLowerCase();
        const act = (state.activity || []).some((row) => activityHit(row, q));
        const bots = botSource(state.data).some((bot) => botHit(bot, q));
        const pool = poolData(state.data).candidates.some((row) => poolHit(row, q)) || poolData(state.data).finals.some((row) => poolHit(row, q));
        if (pool && !act) state.tab = "pool";
        else state.tab = (act || !bots) ? "activity" : "bots";
      }
      if (state.cfg && (state.cfg.token || state.cfg.dataPath)) render();
    });
  }

  if (location.hash && location.hash.includes("d=")) {
    const parsed = parseDeskLink(location.href);
    if (parsed.dataPath) { saveStored(Object.assign(stored() || {}, parsed)); state.cfg = stored(); }
  }
  render();
  if (state.cfg && (state.cfg.token || state.cfg.dataPath)) load();
  state.nextPollAt = Date.now() + POLL_MS;
  setInterval(() => {
    state.nextPollAt = Date.now() + POLL_MS;
    if (state.cfg && (state.cfg.token || state.cfg.dataPath)) load();
  }, POLL_MS);
  setInterval(tickPoolCountdowns, 1000);
  setInterval(tickSecond, 1000);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js?v=7").catch(() => {});
})();
