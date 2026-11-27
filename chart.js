/* Hand-drawn balance chart on <canvas>, devicePixelRatio aware. */
(function (global) {
  const GREEN = "#00d35a";
  function drawChart(canvas, points, marks) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 360;
    const cssH = canvas.clientHeight || 180;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const data = (points && points.length) ? points : [{ ts: 0, value: 100 }, { ts: 1, value: 100 }];
    const vals = data.map((p) => Number(p.value) || 0);
    const min = Math.min.apply(null, vals);
    const max = Math.max.apply(null, vals);
    const pad = 16;
    const span = (max - min) || 1;
    const xy = (i, v) => {
      const x = pad + (i / Math.max(data.length - 1, 1)) * (cssW - pad * 2);
      const y = cssH - pad - ((v - min) / span) * (cssH - pad * 2);
      return [x, y];
    };
    ctx.beginPath();
    data.forEach((p, i) => {
      const [x, y] = xy(i, vals[i]);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    const last = xy(data.length - 1, vals[vals.length - 1]);
    ctx.lineTo(last[0], cssH);
    ctx.lineTo(pad, cssH);
    ctx.closePath();
    const grd = ctx.createLinearGradient(0, 0, 0, cssH);
    grd.addColorStop(0, "rgba(0,211,90,0.28)");
    grd.addColorStop(1, "rgba(0,211,90,0)");
    ctx.fillStyle = grd;
    ctx.fill();
    ctx.beginPath();
    data.forEach((p, i) => {
      const [x, y] = xy(i, vals[i]);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 2;
    ctx.stroke();
    (marks || []).forEach((m) => {
      /* marks sit above the line; skip if we have no index */
    });
  }
  global.DeskChart = { drawChart };
})(window);
