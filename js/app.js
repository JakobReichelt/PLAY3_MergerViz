(() => {
  const data = window.MAP_DATA;
  if (!data) {
    document.body.innerHTML =
      "<p style='padding:2rem;font-family:sans-serif'>Missing MAP_DATA. Load js/data.js before app.js.</p>";
    return;
  }

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const companies = data.companies;
  const byId = new Map(companies.map((c) => [c.id, c]));
  const baseLatLng = new Map(
    companies.map((c) => [c.id, L.latLng(c.lat, c.lon)])
  );

  const els = {
    stats: document.getElementById("stats"),
    play: document.getElementById("btn-play"),
    reset: document.getElementById("btn-reset"),
    speed: document.getElementById("speed"),
    yearFrom: document.getElementById("year-from"),
    yearTo: document.getElementById("year-to"),
    bar: document.getElementById("progress-bar"),
    thumb: document.getElementById("timeline-thumb"),
    timeline: document.getElementById("timeline"),
    timelineTrack: document.getElementById("timeline-track"),
    timelinePos: document.getElementById("timeline-pos"),
    timelineDate: document.getElementById("timeline-date"),
    tip: document.getElementById("tooltip"),
    foot: document.getElementById("foot-note"),
    metaTop: document.getElementById("merge-meta-top"),
    svgTop: document.getElementById("merge-svg-top"),
    search: document.getElementById("merge-search"),
    searchResults: document.getElementById("search-results"),
  };

  els.stats.innerHTML = [
    ["Matched companies", data.meta.matched_companies],
    ["Mergers (≥2 Orbis)", data.meta.merges_with_2plus],
    ["Parties matched", data.meta.unique_parties_matched],
    ["Orbis export size", data.meta.orbis_companies],
  ]
    .map(
      ([label, value]) =>
        `<div class="stat"><strong>${formatInt(value)}</strong><span>${label}</span></div>`
    )
    .join("");

  els.foot.textContent = `Source: ${data.meta.source_orbis} ∩ case parties · ${data.meta.geo_note}`;

  const map = L.map("map", {
    worldCopyJump: true,
    minZoom: 2,
    maxZoom: 8,
    zoomControl: true,
  }).setView([20, 10], 2);

  map.createPane("companiesPane");
  map.getPane("companiesPane").style.zIndex = 450;
  map.createPane("mergePane");
  map.getPane("mergePane").style.zIndex = 650;

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 8,
  }).addTo(map);

  function radiusFor(rev) {
    if (rev == null || rev <= 0) return 5;
    const log = Math.log10(rev);
    const t = Math.max(0, Math.min(1, (log - 8) / (11.7 - 8)));
    return 5 + t * 22;
  }

  function formatInt(n) {
    return Number(n).toLocaleString("en-GB");
  }

  function formatRev(rev) {
    if (rev == null) return "n/a";
    if (rev >= 1e9) return `$${(rev / 1e9).toFixed(1)}B`;
    if (rev >= 1e6) return `$${(rev / 1e6).toFixed(0)}M`;
    return `$${formatInt(rev)}`;
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function shortName(name, max = 28) {
    const s = String(name || "");
    return s.length <= max ? s : s.slice(0, max - 1) + "…";
  }

  const markers = new Map();
  const layer = L.layerGroup().addTo(map);

  for (const c of companies) {
    const marker = L.circleMarker(baseLatLng.get(c.id), {
      radius: radiusFor(c.revenue),
      color: "#0b1f2a",
      weight: 1,
      fillColor: "#4f8ea3",
      fillOpacity: 0.72,
      opacity: 0.9,
      className: "company-bubble",
      pane: "companiesPane",
    });
    marker.companyId = c.id;
    marker.on("mouseover", (e) => showTip(c, e.originalEvent));
    marker.on("mousemove", (e) => moveTip(e.originalEvent));
    marker.on("mouseout", hideTip);
    marker.addTo(layer);
    markers.set(c.id, marker);
  }

  function showTip(c, evt) {
    els.tip.hidden = false;
    els.tip.innerHTML = `<strong>${escapeHtml(c.name)}</strong>
      <div class="meta">${escapeHtml(c.city || "—")} · ${escapeHtml(c.iso)}</div>
      <div class="meta">Revenue ${formatRev(c.revenue)}</div>`;
    moveTip(evt);
  }

  function moveTip(evt) {
    if (els.tip.hidden || !evt) return;
    const shell = document.querySelector(".map-shell").getBoundingClientRect();
    const x = evt.clientX - shell.left + 14;
    const y = evt.clientY - shell.top + 14;
    els.tip.style.left = `${Math.min(x, shell.width - 290)}px`;
    els.tip.style.top = `${Math.min(y, shell.height - 100)}px`;
  }

  function hideTip() {
    els.tip.hidden = true;
  }

  let merges = filterMerges();
  let phase = "idle";
  let mergeIdx = 0;
  let progress = 0;
  let pauseLeft = 0; // ms hold after a merger finishes
  let raf = null;
  let lastTs = 0;
  let mergedBubble = null;
  let trailLines = [];
  let isScrubbing = false;
  /** Company IDs removed from the map after being absorbed in a completed merger. */
  let gone = new Set();
  /** Extra circle area (r²) added onto surviving companies from absorptions. */
  let sizeBoost = new Map();

  function yearOf(m) {
    if (!m.date) return null;
    const y = Number(String(m.date).slice(0, 4));
    return Number.isFinite(y) ? y : null;
  }

  function filterMerges() {
    const from = Number(els.yearFrom.value) || 1990;
    const to = Number(els.yearTo.value) || 2026;
    return data.merges.filter((m) => {
      const y = yearOf(m);
      if (y == null) return true;
      return y >= from && y <= to;
    });
  }

  function setPlayLabel() {
    if (phase === "playing") els.play.textContent = "Pause";
    else if (phase === "paused") els.play.textContent = "Resume";
    else els.play.textContent = "Play merges";
  }

  function baseRadius(id) {
    const r0 = radiusFor(byId.get(id).revenue);
    const boost = sizeBoost.get(id) || 0;
    return Math.sqrt(r0 * r0 + boost);
  }

  function mergePartiesVisible(merge) {
    return merge.parties.filter((id) => markers.has(id) && !gone.has(id));
  }

  function commitMergeAbsorption(merge) {
    const ids = merge.parties.filter((id) => markers.has(id) && !gone.has(id));
    if (ids.length < 2) return;
    const dest = mergeDestination(ids);
    let gained = 0;
    for (const id of ids) {
      if (id === dest.id) continue;
      const r = baseRadius(id);
      gained += r * r;
      gone.add(id);
    }
    sizeBoost.set(dest.id, (sizeBoost.get(dest.id) || 0) + gained);
  }

  /** Rebuild gone/sizeBoost for all mergers fully completed before `uptoIdx`, and optionally the current one if absorbed. */
  function rebuildAbsorptionState(uptoIdx, includeCurrentIfAbsorbed) {
    gone = new Set();
    sizeBoost = new Map();
    for (let i = 0; i < uptoIdx; i++) {
      commitMergeAbsorption(merges[i]);
    }
    if (includeCurrentIfAbsorbed && merges[uptoIdx]) {
      commitMergeAbsorption(merges[uptoIdx]);
    }
  }

  function showRestingMarker(id, dimmed) {
    const marker = markers.get(id);
    if (!marker) return;
    if (gone.has(id)) {
      if (map.hasLayer(marker)) layer.removeLayer(marker);
      return;
    }
    const c = byId.get(id);
    marker.setLatLng(baseLatLng.get(id));
    marker.setStyle({
      fillColor: dimmed ? "#4f8ea3" : "#4f8ea3",
      color: "#0b1f2a",
      weight: 1,
      fillOpacity: dimmed ? 0.2 : 0.72,
      opacity: dimmed ? 0.35 : 0.9,
    });
    marker.setRadius(baseRadius(id));
    if (!map.hasLayer(marker)) marker.addTo(layer);
  }

  function resetStyles() {
    // Full restore — used only for hard Reset / idle
    gone = new Set();
    sizeBoost = new Map();
    for (const id of markers.keys()) showRestingMarker(id, false);
    clearTrails();
    clearMergedBubble();
  }

  function applyRestingWorld(dimmed) {
    for (const id of markers.keys()) showRestingMarker(id, dimmed);
    clearTrails();
    clearMergedBubble();
  }

  function clearTrails() {
    for (const line of trailLines) map.removeLayer(line);
    trailLines = [];
  }

  function clearMergedBubble() {
    if (mergedBubble) {
      map.removeLayer(mergedBubble);
      mergedBubble = null;
    }
  }

  function timelineT() {
    if (!merges.length) return 0;
    if (phase === "idle") return 0;
    return Math.min(1, (mergeIdx + Math.min(progress, 1)) / merges.length);
  }

  function updateProgressBar() {
    const t = timelineT();
    const pct = `${(t * 100).toFixed(3)}%`;
    els.bar.style.width = pct;
    els.thumb.style.left = pct;

    const n = merges.length;
    const idx = n ? Math.min(mergeIdx + 1, n) : 0;
    els.timelinePos.textContent = `${idx} / ${n}`;
    const m = n ? merges[Math.min(mergeIdx, n - 1)] : null;
    els.timelineDate.textContent = m
      ? `${m.date || "—"} · ${m.case_id}`
      : "";

    els.timeline.setAttribute("aria-valuemax", String(Math.max(n, 1)));
    els.timeline.setAttribute("aria-valuenow", String(idx));
  }

  function seekToFraction(frac) {
    if (!merges.length) return;
    const f = Math.max(0, Math.min(1, frac));
    const exact = f * merges.length;
    let idx = Math.floor(exact);
    let prog = exact - idx;
    if (idx >= merges.length) {
      idx = merges.length - 1;
      prog = 1;
    }
    mergeIdx = idx;
    progress = prog;
    pauseLeft = 0;
    const absorbedCurrent = prog >= 0.72;
    rebuildAbsorptionState(idx, absorbedCurrent);
    applyRestingWorld(true);
    if (phase === "idle" || phase === "done") phase = "paused";
    setPlayLabel();
    renderFrame();
    updateProgressBar();
  }

  function fractionFromPointer(clientX) {
    const rect = els.timelineTrack.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return (clientX - rect.left) / rect.width;
  }

  function beginScrub(clientX) {
    if (phase === "playing") {
      phase = "paused";
      setPlayLabel();
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      lastTs = 0;
    }
    isScrubbing = true;
    els.timeline.classList.add("is-scrubbing");
    seekToFraction(fractionFromPointer(clientX));
  }

  function moveScrub(clientX) {
    if (!isScrubbing) return;
    seekToFraction(fractionFromPointer(clientX));
  }

  function endScrub() {
    if (!isScrubbing) return;
    isScrubbing = false;
    els.timeline.classList.remove("is-scrubbing");
    // Stay paused after scrub so the user can inspect; they can hit Play to continue
  }

  els.timelineTrack.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    els.timelineTrack.setPointerCapture(e.pointerId);
    beginScrub(e.clientX);
  });
  els.timelineTrack.addEventListener("pointermove", (e) => {
    if (!isScrubbing) return;
    moveScrub(e.clientX);
  });
  els.timelineTrack.addEventListener("pointerup", endScrub);
  els.timelineTrack.addEventListener("pointercancel", endScrub);

  els.timeline.addEventListener(
    "wheel",
    (e) => {
      if (!merges.length) return;
      e.preventDefault();
      const step = (e.deltaY > 0 ? 1 : -1) * (e.shiftKey ? 0.25 : 1);
      // step in merger units
      const cur = mergeIdx + progress;
      const next = Math.max(0, Math.min(merges.length, cur + step));
      if (phase === "playing") {
        phase = "paused";
        setPlayLabel();
        if (raf) cancelAnimationFrame(raf);
        raf = null;
        lastTs = 0;
      }
      seekToFraction(next / merges.length);
    },
    { passive: false }
  );

  els.timeline.addEventListener("keydown", (e) => {
    if (!merges.length) return;
    let delta = 0;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") delta = e.shiftKey ? 0.25 : 1;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") delta = e.shiftKey ? -0.25 : -1;
    if (e.key === "Home") {
      e.preventDefault();
      seekToFraction(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      seekToFraction(1);
      return;
    }
    if (!delta) return;
    e.preventDefault();
    if (phase === "playing") {
      phase = "paused";
      setPlayLabel();
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      lastTs = 0;
    }
    seekToFraction((mergeIdx + progress + delta) / merges.length);
  });

  function easeInOut(t) {
    return t * t * (3 - 2 * t);
  }

  function combinedRadius(ids) {
    let area = 0;
    for (const id of ids) {
      const r = radiusFor(byId.get(id).revenue);
      area += r * r;
    }
    return Math.sqrt(area);
  }

  function mergeDestination(ids) {
    const primary = ids[0];
    if (primary && baseLatLng.has(primary)) {
      return { id: primary, latlng: baseLatLng.get(primary) };
    }
    let bestId = ids[0];
    let bestRev = -1;
    for (const id of ids) {
      const rev = byId.get(id)?.revenue ?? 0;
      if (rev > bestRev) {
        bestRev = rev;
        bestId = id;
      }
    }
    return { id: bestId, latlng: baseLatLng.get(bestId) };
  }

  function partyLabel(merge, companyId, fallbackIdx) {
    const idx = merge.parties.indexOf(companyId);
    if (idx >= 0 && merge.labels && merge.labels[idx]) return merge.labels[idx];
    return byId.get(companyId)?.name || `Party ${fallbackIdx + 1}`;
  }

  /** Preview radii with area ∝ revenue (plus any absorption boost), fitted to the stage. */
  function previewRadiiForPair(idA, idB) {
    const maxR = 78;
    const minR = 10;

    function effectiveRevenue(id) {
      const co = byId.get(id);
      const rev = co?.revenue != null && co.revenue > 0 ? co.revenue : 0;
      // sizeBoost is map-area units; map r≈5..27 → treat boost as share of a mid-size firm
      const boost = sizeBoost.get(id) || 0;
      const boostRev = boost > 0 ? Math.pow(10, 8 + (Math.sqrt(boost) / 27) * 3.7) : 0;
      return Math.max(rev + boostRev, rev > 0 ? rev : 5e7);
    }

    const revA = effectiveRevenue(idA);
    const revB = effectiveRevenue(idB);
    const sA = Math.sqrt(revA);
    const sB = Math.sqrt(revB);
    const peak = Math.max(sA, sB) || 1;
    let rA = (sA / peak) * maxR;
    let rB = (sB / peak) * maxR;

    // Keep tiny firms visible without collapsing the revenue ratio too much
    const smallest = Math.min(rA, rB);
    if (smallest < minR) {
      const lift = minR / smallest;
      const capped = Math.min(lift, (maxR * 1.05) / Math.max(rA, rB));
      rA *= capped;
      rB *= capped;
      rA = Math.max(rA, minR);
      rB = Math.max(rB, minR);
    }

    return {
      rA,
      rB,
      revA: byId.get(idA)?.revenue ?? null,
      revB: byId.get(idB)?.revenue ?? null,
    };
  }

  function drawMergeDiagram(svg, merge, p) {
    const NS = "http://www.w3.org/2000/svg";
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const W = 960;
    const H = 280;
    const cy = 120;
    const midX = W / 2;
    const left0 = W * 0.2;
    const right0 = W * 0.8;

    if (!merge) {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", String(midX));
      t.setAttribute("y", String(H / 2));
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("fill", "#5a7380");
      t.setAttribute("font-size", "16");
      t.setAttribute("font-family", "IBM Plex Sans, sans-serif");
      t.textContent = "No merger selected";
      svg.appendChild(t);
      return;
    }

    const ids = merge.parties.filter((id) => byId.has(id));
    if (ids.length < 2) {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", String(midX));
      t.setAttribute("y", String(H / 2));
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("fill", "#5a7380");
      t.setAttribute("font-size", "16");
      t.textContent = "Need two matched parties";
      svg.appendChild(t);
      return;
    }

    const dest = mergeDestination(ids);
    const aId = dest.id;
    const bId = ids.find((id) => id !== aId) || ids[1];
    const aCo = byId.get(aId);
    const bCo = byId.get(bId);
    const { rA: rA0, rB: rB0, revA, revB } = previewRadiiForPair(aId, bId);
    const rMerged = Math.sqrt(rA0 * rA0 + rB0 * rB0);

    // Smooth liquid timeline
    const approachEnd = 0.62;
    const fuseEnd = 0.82;

    let xA = left0;
    let xB = right0;
    let rA = rA0;
    let rB = rB0;
    let showDual = true;
    let mergedR = rMerged;
    let labelBlend = 0;

    if (p < approachEnd) {
      const e = easeInOut(p / approachEnd);
      // Meet in the middle — leave a small overlap so goo connects
      const gap = (rA0 + rB0) * 0.35;
      xA = left0 + (midX - gap / 2 - left0) * e;
      xB = right0 + (midX + gap / 2 - right0) * e;
      // Soft squash as they near each other
      const near = Math.max(0, (e - 0.55) / 0.45);
      rA = rA0 * (1 + near * 0.08);
      rB = rB0 * (1 + near * 0.08);
    } else if (p < fuseEnd) {
      const e = easeInOut((p - approachEnd) / (fuseEnd - approachEnd));
      xA = midX - (rA0 * 0.12) * (1 - e);
      xB = midX + (rB0 * 0.12) * (1 - e);
      rA = rA0 * (1 - e) + rMerged * e * 0.55;
      rB = rB0 * (1 - e) + rMerged * e * 0.55;
      labelBlend = e;
    } else {
      showDual = false;
      const hold = (p - fuseEnd) / (1 - fuseEnd);
      mergedR =
        rMerged * (reduceMotion ? 1 : 1 + 0.04 * Math.sin(hold * Math.PI));
      labelBlend = 1;
    }

    // Goo / liquid filter
    const defs = document.createElementNS(NS, "defs");
    const filter = document.createElementNS(NS, "filter");
    filter.setAttribute("id", "liquid-goo");
    filter.setAttribute("x", "-40%");
    filter.setAttribute("y", "-40%");
    filter.setAttribute("width", "180%");
    filter.setAttribute("height", "180%");

    const blur = document.createElementNS(NS, "feGaussianBlur");
    blur.setAttribute("in", "SourceGraphic");
    blur.setAttribute("stdDeviation", reduceMotion ? "4" : "14");
    blur.setAttribute("result", "blur");
    filter.appendChild(blur);

    const matrix = document.createElementNS(NS, "feColorMatrix");
    matrix.setAttribute("in", "blur");
    matrix.setAttribute("mode", "matrix");
    matrix.setAttribute(
      "values",
      "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -8"
    );
    matrix.setAttribute("result", "goo");
    filter.appendChild(matrix);

    const composite = document.createElementNS(NS, "feComposite");
    composite.setAttribute("in", "SourceGraphic");
    composite.setAttribute("in2", "goo");
    composite.setAttribute("operator", "atop");
    filter.appendChild(composite);

    defs.appendChild(filter);
    svg.appendChild(defs);

    const goo = document.createElementNS(NS, "g");
    goo.setAttribute("filter", "url(#liquid-goo)");

    function circle(x, r, fill) {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", String(x));
      c.setAttribute("cy", String(cy));
      c.setAttribute("r", String(r));
      c.setAttribute("fill", fill);
      return c;
    }

    if (showDual) {
      goo.appendChild(circle(xA, rA, "#e85d04"));
      goo.appendChild(circle(xB, rB, "#f48c06"));
    } else {
      goo.appendChild(circle(midX, mergedR, "#e85d04"));
    }
    svg.appendChild(goo);

    // Crisp highlight ring on top of goo
    const rim = document.createElementNS(NS, "circle");
    rim.setAttribute("cx", String(showDual ? (xA + xB) / 2 : midX));
    rim.setAttribute("cy", String(cy));
    rim.setAttribute(
      "r",
      String(
        showDual
          ? Math.max(Math.abs(xB - xA) / 2 + Math.min(rA, rB) * 0.35, Math.max(rA, rB))
          : mergedR
      )
    );
    rim.setAttribute("fill", "none");
    rim.setAttribute("stroke", "#ffb703");
    rim.setAttribute("stroke-width", showDual ? "0" : "2.5");
    rim.setAttribute("opacity", showDual ? "0" : "0.7");
    svg.appendChild(rim);

    function label(x, text, yOff, weight) {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", String(x));
      t.setAttribute("y", String(cy + yOff));
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("fill", "#0b1f2a");
      t.setAttribute("font-size", "15");
      t.setAttribute("font-weight", weight || "600");
      t.setAttribute("font-family", "Syne, IBM Plex Sans, sans-serif");
      t.textContent = text;
      svg.appendChild(t);
    }

    function sub(x, text, yOff) {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", String(x));
      t.setAttribute("y", String(cy + yOff));
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("fill", "#5a7380");
      t.setAttribute("font-size", "12");
      t.setAttribute("font-family", "IBM Plex Sans, sans-serif");
      t.textContent = text;
      svg.appendChild(t);
    }

    const nameA = partyLabel(merge, aId, 0);
    const nameB = partyLabel(merge, bId, 1);

    if (labelBlend < 0.55) {
      const fade = 1 - labelBlend / 0.55;
      const g = document.createElementNS(NS, "g");
      g.setAttribute("opacity", String(fade));
      svg.appendChild(g);
      // recreate labels with opacity via group — simpler: draw directly with fade via attribute
    }

    if (labelBlend < 0.7) {
      const fade = Math.max(0, 1 - labelBlend / 0.7);
      const gL = document.createElementNS(NS, "g");
      gL.setAttribute("opacity", String(fade));
      const t1 = document.createElementNS(NS, "text");
      t1.setAttribute("x", String(xA));
      t1.setAttribute("y", String(cy + rA + 24));
      t1.setAttribute("text-anchor", "middle");
      t1.setAttribute("fill", "#0b1f2a");
      t1.setAttribute("font-size", "15");
      t1.setAttribute("font-weight", "600");
      t1.setAttribute("font-family", "Syne, IBM Plex Sans, sans-serif");
      t1.textContent = shortName(nameA, 28);
      gL.appendChild(t1);
      const s1 = document.createElementNS(NS, "text");
      s1.setAttribute("x", String(xA));
      s1.setAttribute("y", String(cy + rA + 42));
      s1.setAttribute("text-anchor", "middle");
      s1.setAttribute("fill", "#5a7380");
      s1.setAttribute("font-size", "12");
      s1.textContent = `${aCo.city || aCo.iso} · ${formatRev(revA)}`;
      gL.appendChild(s1);

      const t2 = document.createElementNS(NS, "text");
      t2.setAttribute("x", String(xB));
      t2.setAttribute("y", String(cy + rB + 24));
      t2.setAttribute("text-anchor", "middle");
      t2.setAttribute("fill", "#0b1f2a");
      t2.setAttribute("font-size", "15");
      t2.setAttribute("font-weight", "600");
      t2.setAttribute("font-family", "Syne, IBM Plex Sans, sans-serif");
      t2.textContent = shortName(nameB, 28);
      gL.appendChild(t2);
      const s2 = document.createElementNS(NS, "text");
      s2.setAttribute("x", String(xB));
      s2.setAttribute("y", String(cy + rB + 42));
      s2.setAttribute("text-anchor", "middle");
      s2.setAttribute("fill", "#5a7380");
      s2.setAttribute("font-size", "12");
      s2.textContent = `${bCo.city || bCo.iso} · ${formatRev(revB)}`;
      gL.appendChild(s2);
      svg.appendChild(gL);
    }

    if (labelBlend > 0.35) {
      const fade = Math.min(1, (labelBlend - 0.35) / 0.45);
      const gM = document.createElementNS(NS, "g");
      gM.setAttribute("opacity", String(fade));
      const tm = document.createElementNS(NS, "text");
      tm.setAttribute("x", String(midX));
      tm.setAttribute("y", String(cy + (showDual ? Math.max(rA, rB) : mergedR) + 26));
      tm.setAttribute("text-anchor", "middle");
      tm.setAttribute("fill", "#0b1f2a");
      tm.setAttribute("font-size", "16");
      tm.setAttribute("font-weight", "700");
      tm.setAttribute("font-family", "Syne, IBM Plex Sans, sans-serif");
      tm.textContent = shortName(`${nameA} + ${nameB}`, 40);
      gM.appendChild(tm);
      const sm = document.createElementNS(NS, "text");
      sm.setAttribute("x", String(midX));
      sm.setAttribute("y", String(cy + (showDual ? Math.max(rA, rB) : mergedR) + 46));
      sm.setAttribute("text-anchor", "middle");
      sm.setAttribute("fill", "#5a7380");
      sm.setAttribute("font-size", "12");
      const mergedRev =
        (revA || 0) + (revB || 0) > 0 ? formatRev((revA || 0) + (revB || 0)) : "n/a";
      sm.textContent = `${merge.case_id} · merged · ${mergedRev}`;
      gM.appendChild(sm);
      svg.appendChild(gM);
    }
  }

  function updateMergeStages() {
    const m =
      phase === "idle" ? merges[0] || null : merges[mergeIdx] || null;
    const p = phase === "idle" ? 0 : progress;

    if (!m) {
      els.metaTop.innerHTML =
        '<span class="merge-stage__idle">No mergers in this year range</span>';
      drawMergeDiagram(els.svgTop, null, 0);
      return;
    }

    const idleHint =
      phase === "idle"
        ? '<span class="merge-stage__idle">Next up · </span>'
        : "";

    els.metaTop.innerHTML = `${idleHint}<span class="merge-stage__date">${escapeHtml(
      m.date || "—"
    )}</span><span class="merge-stage__case">${escapeHtml(
      m.case_id
    )}</span><span class="merge-stage__title">${escapeHtml(m.title)}</span>`;

    drawMergeDiagram(els.svgTop, m, p);
  }

  function renderFrame() {
    const m = merges[mergeIdx];
    if (!m) {
      applyRestingWorld(false);
      updateMergeStages();
      updateProgressBar();
      return;
    }

    // Keep prior absorptions applied; current merge not committed until absorb finishes
    rebuildAbsorptionState(mergeIdx, progress >= 0.72);
    const ids = mergePartiesVisible(m);
    // If already absorbed this merge, ids may be just the survivor — still animate hold
    const idsForAnim =
      ids.length >= 2
        ? ids
        : m.parties.filter((id) => markers.has(id));

    clearTrails();
    clearMergedBubble();

    const dimOthers = phase === "playing" || phase === "paused" || phase === "done";
    for (const id of markers.keys()) {
      if (idsForAnim.includes(id) && progress < 0.72) continue;
      showRestingMarker(id, dimOthers && !gone.has(id));
    }

    if (idsForAnim.length < 2 && progress < 0.72) {
      updateMergeStages();
      updateProgressBar();
      return;
    }

    const liveIds = idsForAnim.filter((id) => !gone.has(id));
    const dest = mergeDestination(liveIds.length ? liveIds : idsForAnim);
    const target = dest.latlng;
    const movers = liveIds.filter((id) => id !== dest.id);
    const activeIds = [dest.id, ...movers].filter((id) => markers.has(id));
    const targetR =
      progress >= 0.72
        ? baseRadius(dest.id)
        : Math.sqrt(
            activeIds.reduce((s, id) => {
              const r = baseRadius(id);
              return s + r * r;
            }, 0)
          );

    const p = progress;
    const travelEnd = 0.58;
    const absorbEnd = 0.72;

    const home = markers.get(dest.id);
    if (home && !gone.has(dest.id)) {
      home.setLatLng(target);
      home.setStyle({
        fillColor: "#e85d04",
        color: "#ffb703",
        weight: 2.5,
        fillOpacity: 0.95,
        opacity: 1,
      });
      if (!map.hasLayer(home)) home.addTo(layer);
    }

    if (p < travelEnd) {
      const e = easeInOut(p / travelEnd);
      if (home) home.setRadius(baseRadius(dest.id));

      for (const id of movers) {
        const marker = markers.get(id);
        const base = baseLatLng.get(id);
        const lat = base.lat + (target.lat - base.lat) * e;
        const lng = base.lng + (target.lng - base.lng) * e;
        marker.setLatLng([lat, lng]);
        marker.setStyle({
          fillColor: "#e85d04",
          color: "#ffb703",
          weight: 2,
          fillOpacity: 0.95,
          opacity: 1,
        });
        marker.setRadius(baseRadius(id));
        if (!map.hasLayer(marker)) marker.addTo(layer);

        trailLines.push(
          L.polyline([base, [lat, lng]], {
            color: "#ffb703",
            weight: 1.4,
            opacity: 0.35 * (1 - e * 0.5),
            interactive: false,
            pane: "mergePane",
          }).addTo(map)
        );
      }
    } else if (p < absorbEnd) {
      const e = easeInOut((p - travelEnd) / (absorbEnd - travelEnd));
      const homeR0 = baseRadius(dest.id);
      if (home) {
        home.setLatLng(target);
        home.setRadius(homeR0 + (targetR - homeR0) * e);
      }

      for (const id of movers) {
        const marker = markers.get(id);
        const r0 = baseRadius(id);
        marker.setLatLng(target);
        marker.setRadius(Math.max(0.5, r0 * (1 - e)));
        marker.setStyle({
          fillColor: "#e85d04",
          color: "#ffb703",
          weight: 1,
          fillOpacity: 0.95 * (1 - e),
          opacity: 1 - e,
        });
        if (!map.hasLayer(marker)) marker.addTo(layer);
      }
    } else {
      // Absorbed: movers stay gone; survivor remains (grown)
      for (const id of movers) {
        const marker = markers.get(id);
        if (marker && map.hasLayer(marker)) layer.removeLayer(marker);
      }
      if (home) {
        home.setLatLng(target);
        home.setStyle({
          fillColor: "#e85d04",
          color: "#ffb703",
          weight: 3,
          fillOpacity: 0.92,
          opacity: 1,
        });
        const hold = (p - absorbEnd) / (1 - absorbEnd);
        const pulse = reduceMotion ? 1 : 1 + 0.06 * Math.sin(hold * Math.PI);
        home.setRadius(baseRadius(dest.id) * pulse);
        if (!map.hasLayer(home)) home.addTo(layer);
        home.bringToFront();

        trailLines.push(
          L.circleMarker(target, {
            radius: baseRadius(dest.id) * (1.15 + hold * 0.45),
            color: "#ffb703",
            weight: 2,
            fillOpacity: 0,
            opacity: Math.max(0, 0.55 - hold * 0.55),
            interactive: false,
            pane: "mergePane",
          }).addTo(map)
        );
      }
    }

    for (const id of activeIds) {
      const marker = markers.get(id);
      if (!marker || !map.hasLayer(marker)) continue;
      const el = marker.getElement && marker.getElement();
      if (el && el.parentElement) el.parentElement.appendChild(el);
      else if (marker.bringToFront) marker.bringToFront();
    }

    updateMergeStages();
    updateProgressBar();
  }

  function pauseAfterMs() {
    // Short beat between mergers; still shortens a bit at higher speed
    const speed = Number(els.speed.value || 1);
    return (reduceMotion ? 220 : 700) / Math.sqrt(speed);
  }

  function advanceOrFinish() {
    if (mergeIdx >= merges.length - 1) {
      progress = 1;
      pauseLeft = 0;
      phase = "done";
      setPlayLabel();
      rebuildAbsorptionState(merges.length, false);
      applyRestingWorld(false);
      updateMergeStages();
      updateProgressBar();
      return false;
    }
    // Commit current merger, then start the next — absorbed bubbles stay gone
    rebuildAbsorptionState(mergeIdx + 1, false);
    applyRestingWorld(true);
    mergeIdx += 1;
    progress = 0;
    pauseLeft = 0;
    return true;
  }

  function tick(ts) {
    if (phase !== "playing") return;
    if (!lastTs) lastTs = ts;
    const dt = ts - lastTs;
    lastTs = ts;

    if (pauseLeft > 0) {
      pauseLeft -= dt;
      progress = 1;
      renderFrame();
      if (pauseLeft <= 0) {
        if (!advanceOrFinish()) return;
      }
      raf = requestAnimationFrame(tick);
      return;
    }

    const duration = (reduceMotion ? 280 : 1400) / Number(els.speed.value || 1);
    progress += dt / duration;

    if (progress >= 1) {
      progress = 1;
      pauseLeft = pauseAfterMs();
      renderFrame();
      raf = requestAnimationFrame(tick);
      return;
    }

    renderFrame();
    raf = requestAnimationFrame(tick);
  }

  function start() {
    if (!merges.length) {
      updateMergeStages();
      return;
    }
    if (phase === "done" || mergeIdx >= merges.length - 1) {
      mergeIdx = 0;
      progress = 0;
      pauseLeft = 0;
      resetStyles();
    }
    phase = "playing";
    setPlayLabel();
    lastTs = 0;
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  function pause() {
    phase = "paused";
    setPlayLabel();
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    lastTs = 0;
  }

  function reset() {
    phase = "idle";
    mergeIdx = 0;
    progress = 0;
    pauseLeft = 0;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    lastTs = 0;
    setPlayLabel();
    resetStyles();
    updateMergeStages();
    updateProgressBar();
  }

  function refilter() {
    if (phase === "playing") pause();
    merges = filterMerges();
    reset();
    hideSearchResults();
  }

  let searchHits = [];
  let searchActive = -1;
  let searchTimer = null;

  function hideSearchResults() {
    els.searchResults.hidden = true;
    els.searchResults.innerHTML = "";
    searchHits = [];
    searchActive = -1;
  }

  function mergeSearchBlob(m) {
    const parts = [m.case_id, m.title, m.date, ...(m.labels || [])];
    for (const id of m.parties || []) {
      const c = byId.get(id);
      if (c) parts.push(c.name, c.city, c.iso);
    }
    return parts.join(" ").toLowerCase();
  }

  function searchMerges(query) {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const tokens = q.split(/\s+/).filter(Boolean);
    const scored = [];
    for (let i = 0; i < merges.length; i++) {
      const m = merges[i];
      const blob = mergeSearchBlob(m);
      if (!tokens.every((t) => blob.includes(t))) continue;
      let score = 0;
      const idLower = String(m.case_id).toLowerCase();
      if (idLower === q || idLower === `m.${q.replace(/^m\./, "")}`) score += 50;
      if (idLower.includes(q)) score += 20;
      for (const label of m.labels || []) {
        const ll = label.toLowerCase();
        if (ll === q) score += 40;
        else if (ll.startsWith(q)) score += 25;
        else if (ll.includes(q)) score += 10;
      }
      if (String(m.title).toLowerCase().includes(q)) score += 8;
      scored.push({ i, m, score });
    }
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    return scored.slice(0, 40);
  }

  function renderSearchResults(hits) {
    searchHits = hits;
    searchActive = hits.length ? 0 : -1;
    if (!hits.length) {
      els.searchResults.hidden = false;
      els.searchResults.innerHTML =
        '<div class="search__empty">No mergers match this search</div>';
      return;
    }
    els.searchResults.hidden = false;
    els.searchResults.innerHTML = hits
      .map((hit, idx) => {
        const parties = (hit.m.labels || []).slice(0, 3).join(" / ");
        return `<button type="button" class="search__hit${
          idx === 0 ? " is-active" : ""
        }" role="option" data-idx="${hit.i}">
          <span class="search__hit-id">${escapeHtml(hit.m.case_id)} · ${escapeHtml(
            hit.m.date || "—"
          )}</span>
          <span class="search__hit-meta">${escapeHtml(
            parties || hit.m.title
          )}</span>
        </button>`;
      })
      .join("");
  }

  function jumpToMergeIndex(i) {
    if (!merges.length || i < 0 || i >= merges.length) return;
    if (phase === "playing") {
      phase = "paused";
      setPlayLabel();
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      lastTs = 0;
    }
    // Show parties before they fuse
    seekToFraction((i + 0.15) / merges.length);
    hideSearchResults();
    els.search.blur();
  }

  function updateSearchActive(next) {
    if (!searchHits.length) return;
    searchActive = (next + searchHits.length) % searchHits.length;
    const buttons = els.searchResults.querySelectorAll(".search__hit");
    buttons.forEach((btn, idx) => {
      btn.classList.toggle("is-active", idx === searchActive);
      if (idx === searchActive) btn.scrollIntoView({ block: "nearest" });
    });
  }

  els.search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const q = els.search.value;
      if (q.trim().length < 2) {
        hideSearchResults();
        return;
      }
      renderSearchResults(searchMerges(q));
    }, 120);
  });

  els.search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideSearchResults();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      updateSearchActive(searchActive + 1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      updateSearchActive(searchActive - 1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (searchActive >= 0 && searchHits[searchActive]) {
        jumpToMergeIndex(searchHits[searchActive].i);
      } else {
        const hits = searchMerges(els.search.value);
        if (hits.length) jumpToMergeIndex(hits[0].i);
      }
    }
  });

  els.searchResults.addEventListener("click", (e) => {
    const btn = e.target.closest(".search__hit");
    if (!btn) return;
    jumpToMergeIndex(Number(btn.dataset.idx));
  });

  document.addEventListener("click", (e) => {
    if (!els.searchResults.hidden && !e.target.closest(".search")) {
      hideSearchResults();
    }
  });

  els.play.addEventListener("click", () => {
    if (phase === "playing") pause();
    else start();
  });
  els.reset.addEventListener("click", reset);
  els.yearFrom.addEventListener("change", refilter);
  els.yearTo.addEventListener("change", refilter);

  setPlayLabel();
  updateProgressBar();
  updateMergeStages();
})();
