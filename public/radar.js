'use strict';
// CYBORG LIVE — radar (spider) renderer, shared by the phone and the presenter.
// Zero deps, plain SVG strings. See DECK-SCHEMA.md and components.v2.json.
//
// WHY A RADAR AND NOT A 1-D SCALE
// The thesis is "everyone is already a cyborg; what differs is SHAPE." A single
// 0..100 axis measures HOW MUCH, which silently reinstates an endpoint and a
// ranking (and put Vader at the far end as a destination). A polygon over seven
// axes says two people can enclose identical area and have completely different
// silhouettes. The instrument has to make the argument the speaker is making.
//
// HARD RULES (encoded here, do not "optimize" them away):
//   1. AGGREGATE BY MEAN, never sum. Sum makes more picks = bigger polygon,
//      which rebuilds the exact scoreboard the scale was removed for. Mean makes
//      shape = character. Pick COUNT is surfaced as fill opacity, never radius.
//   2. AXIS ORDER IS FIXED by components.v2.json aggregation.axisOrder. Radar
//      silhouettes change dramatically with spoke order on identical data.
//      Never sort spokes by value.
//   3. NEVER rank by enclosed area. Perceived area scales with r^2, so area is
//      a misleading metric nobody authored.

(function (root) {
  const NS = 'http://www.w3.org/2000/svg';

  // ---------------------------------------------------------------- geometry
  // Spoke i sits at -90deg + i*(360/n) so axis 0 points straight up. Keeps the
  // silhouette stable and readable between the phone and the projector.
  function spokeAngle(i, n) {
    return (-Math.PI / 2) + (i * 2 * Math.PI / n);
  }

  function pointAt(cx, cy, radius, value, i, n) {
    const r = radius * (Math.max(0, Math.min(100, value)) / 100);
    const a = spokeAngle(i, n);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }

  function polygonPoints(vector, axisOrder, cx, cy, radius) {
    const n = axisOrder.length;
    return axisOrder
      .map((ax, i) => pointAt(cx, cy, radius, +vector[ax] || 0, i, n))
      .map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`)
      .join(' ');
  }

  // ---------------------------------------------------------------- aggregate
  // MEAN across the picked components, per axis. Empty selection -> all zeros
  // (a collapsed polygon at the centre), never NaN.
  function meanVector(components, axisOrder) {
    const out = {};
    for (const ax of axisOrder) out[ax] = 0;
    if (!components || !components.length) return out;
    for (const c of components) {
      const v = (c && c.vector) || {};
      for (const ax of axisOrder) out[ax] += (+v[ax] || 0);
    }
    for (const ax of axisOrder) {
      out[ax] = Math.round((out[ax] / components.length) * 10) / 10;
    }
    return out;
  }

  // Mean of a set of already-averaged participant vectors (room aggregate).
  // Same rule: mean, not sum, so a fuller room does not inflate the polygon.
  function meanOfVectors(vectors, axisOrder) {
    const out = {};
    for (const ax of axisOrder) out[ax] = 0;
    const list = (vectors || []).filter((v) => v && typeof v === 'object');
    if (!list.length) return out;
    for (const v of list) {
      for (const ax of axisOrder) out[ax] += (+v[ax] || 0);
    }
    for (const ax of axisOrder) {
      out[ax] = Math.round((out[ax] / list.length) * 10) / 10;
    }
    return out;
  }

  // Largest per-axis gap between two vectors — used to prove two shapes are
  // actually distinguishable rather than rendering as the same blob.
  function maxDivergence(a, b, axisOrder) {
    let m = 0;
    for (const ax of axisOrder) m = Math.max(m, Math.abs((+a[ax] || 0) - (+b[ax] || 0)));
    return Math.round(m * 10) / 10;
  }

  // ---------------------------------------------------------------- rendering
  // Returns an SVG element. Caller owns placement/sizing via CSS.
  //   opts.vector      : {AXIS: 0..100} the participant / room polygon
  //   opts.axes        : [{id,label,short,lo,hi}] from components.v2.json
  //   opts.axisOrder   : fixed spoke order (REQUIRED — never derive from keys)
  //   opts.ghosts      : [{label, vector}] translucent reference polygons
  //   opts.pickCount   : drives fill opacity (density), NEVER radius
  //   opts.size        : viewBox size, default 320
  //   opts.labels      : show axis labels (false on tiny phone renders)
  function render(opts) {
    const o = opts || {};
    const axes = o.axes || [];
    const axisOrder = o.axisOrder || axes.map((a) => a.id);
    const n = axisOrder.length;
    const size = o.size || 320;
    const labels = o.labels !== false;
    // leave room for labels around the plot when they are shown
    const pad = labels ? size * 0.19 : size * 0.06;
    const cx = size / 2;
    const cy = size / 2;
    const radius = (size / 2) - pad;

    const byId = new Map(axes.map((a) => [a.id, a]));
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('class', 'radar');
    svg.setAttribute('role', 'img');

    const vector = o.vector || {};
    const pickCount = o.pickCount || 0;
    svg.setAttribute('aria-label', buildAltText(vector, axisOrder, byId, pickCount));

    const frag = document.createDocumentFragment();
    const mk = (tag, attrs) => {
      const e = document.createElementNS(NS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    };

    // --- web: concentric rings at 25/50/75/100 give the eye a scale reference
    const gWeb = mk('g', { class: 'radar__web' });
    for (const pct of [25, 50, 75, 100]) {
      const ring = axisOrder
        .map((_, i) => pointAt(cx, cy, radius, pct, i, n))
        .map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`)
        .join(' ');
      gWeb.appendChild(mk('polygon', {
        points: ring,
        class: 'radar__ring' + (pct === 100 ? ' radar__ring--outer' : ''),
      }));
    }
    // --- spokes
    for (let i = 0; i < n; i++) {
      const [x, y] = pointAt(cx, cy, radius, 100, i, n);
      gWeb.appendChild(mk('line', {
        x1: cx, y1: cy, x2: x.toFixed(2), y2: y.toFixed(2), class: 'radar__spoke',
      }));
    }
    frag.appendChild(gWeb);

    // --- ghost reference polygons UNDER the live shape.
    // Vader as the end of a line is a destination; Vader as a translucent shape
    // behind yours is a comparison. That is the whole point of these.
    for (const gh of (o.ghosts || [])) {
      if (!gh || !gh.vector) continue;
      frag.appendChild(mk('polygon', {
        points: polygonPoints(gh.vector, axisOrder, cx, cy, radius),
        class: 'radar__ghost',
        'data-ghost': gh.id || gh.label || '',
      }));
    }

    // --- the live polygon. Opacity (not radius) carries pick density.
    const fillOpacity = pickCount
      ? Math.min(0.42, 0.14 + 0.035 * pickCount).toFixed(3)
      : '0.05';
    frag.appendChild(mk('polygon', {
      points: polygonPoints(vector, axisOrder, cx, cy, radius),
      class: 'radar__shape' + (pickCount ? '' : ' is-empty'),
      'fill-opacity': fillOpacity,
    }));

    // --- vertex dots
    const gDots = mk('g', { class: 'radar__dots' });
    axisOrder.forEach((ax, i) => {
      const [x, y] = pointAt(cx, cy, radius, +vector[ax] || 0, i, n);
      gDots.appendChild(mk('circle', {
        cx: x.toFixed(2), cy: y.toFixed(2), r: size > 260 ? 3.2 : 2.4, class: 'radar__dot',
      }));
    });
    frag.appendChild(gDots);

    // --- axis labels
    if (labels) {
      const gLab = mk('g', { class: 'radar__labels' });
      axisOrder.forEach((ax, i) => {
        const a = spokeAngle(i, n);
        const lx = cx + (radius + pad * 0.52) * Math.cos(a);
        const ly = cy + (radius + pad * 0.52) * Math.sin(a);
        const cos = Math.cos(a);
        const anchor = Math.abs(cos) < 0.25 ? 'middle' : (cos > 0 ? 'start' : 'end');
        const t = mk('text', {
          x: lx.toFixed(2), y: ly.toFixed(2),
          'text-anchor': anchor,
          'dominant-baseline': 'middle',
          class: 'radar__label',
        });
        const meta = byId.get(ax) || {};
        t.textContent = meta.short || meta.label || ax;
        gLab.appendChild(t);
        // numeric readout under the label so the shape is also legible as data
        const val = mk('text', {
          x: lx.toFixed(2), y: (ly + size * 0.042).toFixed(2),
          'text-anchor': anchor,
          'dominant-baseline': 'middle',
          class: 'radar__val',
        });
        val.textContent = String(Math.round(+vector[ax] || 0));
        gLab.appendChild(val);
      });
      frag.appendChild(gLab);
    }

    svg.appendChild(frag);
    return svg;
  }

  // Screen-reader text: a polygon is meaningless without the numbers.
  function buildAltText(vector, axisOrder, byId, pickCount) {
    const parts = axisOrder.map((ax) => {
      const meta = byId.get(ax) || {};
      return `${meta.label || ax} ${Math.round(+vector[ax] || 0)}`;
    });
    return `Assemblage radar over ${axisOrder.length} axes from ${pickCount} picks. ${parts.join(', ')}.`;
  }

  // Mount helper: replaces the contents of a host element.
  function mount(host, opts) {
    if (!host) return null;
    const svg = render(opts);
    host.replaceChildren(svg);
    return svg;
  }

  root.Radar = {
    render, mount, meanVector, meanOfVectors, maxDivergence,
    polygonPoints, spokeAngle,
  };
})(typeof window !== 'undefined' ? window : globalThis);
