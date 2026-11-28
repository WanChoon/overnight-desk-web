/* Hand-drawn balance chart and coin candles on <canvas>, devicePixelRatio aware. */
(function (global) {
  const GREEN = "#00d35a";
  const RED = "#ff453a";
  const BLUE = "#0a84ff";
  const ORANGE = "#ff9f0a";
  const CARD = "#1c1c1e";
  const TERTIARY = "rgba(235,235,245,0.3)";
  const SECONDARY = "rgba(235,235,245,0.6)";
  const LABEL_FONT = "600 11px -apple-system, \"SF Pro Text\", sans-serif";

  function prep(canvas, fallbackH) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 360;
    const cssH = canvas.clientHeight || fallbackH;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    return { ctx: ctx, w: cssW, h: cssH };
  }

  function tsMs(value) {
    if (value == null || value === "") return NaN;
    if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
    return Date.parse(String(value).trim().replace(/(\.\d{3})\d+/, "$1"));
  }

  function money(n) {
    const x = Math.abs(n);
    return Number.isInteger(x) ? String(x) : x.toFixed(2);
  }

  /* bought -> "Bought X" blue; sold/stopped -> "+$N" green or "-25% -$N" red (pnl from "$8.72 (-3.28)"). */
  function markLabel(m) {
    const kind = String((m && m.kind) || "").toLowerCase();
    const title = m && m.title ? String(m.title) : "";
    if (kind === "bought") return { text: title || "Bought", color: BLUE };
    const raw = String((m && m.value) == null ? "" : m.value);
    const pnlHit = raw.match(/\(([+\-]?[0-9,.]+)\)/);
    const pnl = pnlHit ? Number(pnlHit[1].replace(/,/g, "")) : NaN;
    if (isFinite(pnl)) {
      if (pnl >= 0) return { text: "+$" + money(pnl), color: GREEN };
      const procHit = raw.match(/\$([0-9,.]+)/);
      const proceeds = procHit ? Number(procHit[1].replace(/,/g, "")) : NaN;
      const cost = proceeds - pnl;
      const pct = isFinite(cost) && cost > 0 ? Math.round(pnl / cost * 100) : null;
      return { text: (pct != null ? pct + "% " : "") + "-$" + money(pnl), color: RED };
    }
    if (!title && !kind) return null;
    return { text: title || kind, color: kind === "stopped" ? RED : SECONDARY };
  }

  /* Fractional point index for a mark time, so marks sit on the drawn line. */
  function markIndex(times, t) {
    if (!isFinite(t) || !times.length || !isFinite(times[0]) || t < times[0]) return null;
    const last = times.length - 1;
    if (!isFinite(times[last]) || t > times[last]) return null;
    for (let i = 0; i < last; i++) {
      if (t >= times[i] && t <= times[i + 1]) {
        const span = times[i + 1] - times[i];
        return span > 0 ? i + (t - times[i]) / span : i;
      }
    }
    return last;
  }

  function drawChart(canvas, points, marks, opts) {
    if (!canvas) return;
    const box = prep(canvas, 180);
    const ctx = box.ctx;
    const cssW = box.w;
    const cssH = box.h;
    const data = (points && points.length) ? points : [{ ts: 0, value: 100 }, { ts: 1, value: 100 }];
    const vals = data.map((p) => Number(p.value) || 0);
    const startRaw = opts && opts.startValue != null ? Number(opts.startValue) : vals[0];
    const start = isFinite(startRaw) ? startRaw : vals[0];
    const markList = Array.isArray(marks) ? marks : [];
    const min = Math.min(start, Math.min.apply(null, vals));
    const max = Math.max(start, Math.max.apply(null, vals));
    const pad = 16;
    const padTop = markList.length ? 44 : pad;
    const span = (max - min) || 1;
    const xAt = (i) => pad + (i / Math.max(data.length - 1, 1)) * (cssW - pad * 2);
    const yAt = (v) => cssH - pad - ((v - min) / span) * (cssH - pad - padTop);
    ctx.beginPath();
    data.forEach((p, i) => {
      const x = xAt(i);
      const y = yAt(vals[i]);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.lineTo(xAt(data.length - 1), cssH);
    ctx.lineTo(pad, cssH);
    ctx.closePath();
    const grd = ctx.createLinearGradient(0, 0, 0, cssH);
    grd.addColorStop(0, "rgba(0,211,90,0.28)");
    grd.addColorStop(1, "rgba(0,211,90,0)");
    ctx.fillStyle = grd;
    ctx.fill();
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = TERTIARY;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, yAt(start));
    ctx.lineTo(cssW - pad, yAt(start));
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    data.forEach((p, i) => {
      const x = xAt(i);
      const y = yAt(vals[i]);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 2;
    ctx.stroke();
    if (!markList.length) return;
    const times = data.map((p) => tsMs(p && p.ts));
    const placed = [];
    const rowH = 16;
    ctx.font = LABEL_FONT;
    ctx.textBaseline = "middle";
    markList.forEach((m) => {
      const label = markLabel(m);
      const f = markIndex(times, tsMs(m && m.ts));
      if (!label || f == null) return;
      const lo = Math.floor(f);
      const hi = Math.min(lo + 1, vals.length - 1);
      const v = vals[lo] + (vals[hi] - vals[lo]) * (f - lo);
      const x = xAt(f);
      const lineY = yAt(v);
      ctx.fillStyle = label.color;
      ctx.beginPath();
      ctx.arc(x, lineY, 3, 0, Math.PI * 2);
      ctx.fill();
      const w = Math.ceil(ctx.measureText(label.text).width) + 8;
      const left = Math.max(2, Math.min(x - w / 2, cssW - w - 2));
      let bottom = lineY - 6;
      let rect = null;
      while (bottom - rowH >= 1) {
        const r = { l: left, r: left + w, t: bottom - rowH, b: bottom };
        const hit = placed.some((p) => r.l < p.r + 4 && r.r + 4 > p.l && r.t < p.b && r.b > p.t);
        if (!hit) { rect = r; break; }
        bottom -= rowH + 2;
      }
      if (!rect) return;
      placed.push(rect);
      ctx.fillStyle = CARD;
      ctx.fillRect(rect.l, rect.t, w, rowH);
      ctx.fillStyle = label.color;
      ctx.fillText(label.text, rect.l + 4, rect.t + rowH / 2);
    });
  }

  /* 1-minute candles: green up, red down, orange dashed exit line at opts.stop. */
  function drawCandles(canvas, candles, opts) {
    if (!canvas) return false;
    const box = prep(canvas, 200);
    const ctx = box.ctx;
    const rows = (Array.isArray(candles) ? candles : []).map((c) => ({
      o: Number(c && c.o), h: Number(c && c.h), l: Number(c && c.l), c: Number(c && c.c)
    })).filter((c) => isFinite(c.o) && isFinite(c.h) && isFinite(c.l) && isFinite(c.c));
    if (!rows.length) return false;
    const stopRaw = opts && opts.stop != null ? Number(opts.stop) : NaN;
    const stop = isFinite(stopRaw) && stopRaw > 0 ? stopRaw : null;
    let min = Math.min.apply(null, rows.map((c) => Math.min(c.l, c.o, c.c)));
    let max = Math.max.apply(null, rows.map((c) => Math.max(c.h, c.o, c.c)));
    if (stop != null) { min = Math.min(min, stop); max = Math.max(max, stop); }
    const pad = 10;
    const span = (max - min) || (Math.abs(max) || 1);
    const yAt = (v) => box.h - pad - ((v - min) / span) * (box.h - pad * 2);
    const slot = (box.w - pad * 2) / rows.length;
    const bodyW = Math.max(1, Math.min(10, slot * 0.6));
    rows.forEach((c, i) => {
      const x = pad + slot * i + slot / 2;
      const color = c.c >= c.o ? GREEN : RED;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yAt(c.h));
      ctx.lineTo(x, yAt(c.l));
      ctx.stroke();
      const top = yAt(Math.max(c.o, c.c));
      const height = Math.max(1, yAt(Math.min(c.o, c.c)) - top);
      ctx.fillRect(x - bodyW / 2, top, bodyW, height);
    });
    if (stop != null) {
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = ORANGE;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(pad, yAt(stop));
      ctx.lineTo(box.w - pad, yAt(stop));
      ctx.stroke();
      ctx.restore();
    }
    return true;
  }

  global.DeskChart = { drawChart, drawCandles, markLabel };
})(window);
