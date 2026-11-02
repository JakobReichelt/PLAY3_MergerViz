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
    tip: document.getElementById("tooltip"),
    foot: document.getElementById("foot-note"),
    metaTop: document.getElementById("merge-meta-top"),
    metaBottom: document.getElementById("merge-meta-bottom"),
    svgTop: document.getElementById("merge-svg-top"),
    svgBottom: document.getElementById("merge-svg-bottom"),
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
  let raf = null;
  let lastTs = 0;
  let mergedBubble = null;
  let trailLines = [];

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

  function resetStyles() {
    for (const [id, marker] of markers) {
      const c = byId.get(id);
      marker.setLatLng(baseLatLng.get(id));
      marker.setStyle({
        fillColor: "#4f8ea3",
        color: "#0b1f2a",
        weight: 1,
        fillOpacity: 0.72,
        opacity: 0.9,
      });
      marker.setRadius(radiusFor(c.revenue));
      if (!map.hasLayer(marker)) marker.addTo(layer);
    }
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

  function updateProgressBar() {
    if (!merges.length) {
      els.bar.style.width = "0%";
      return;
    }
    const t = (mergeIdx + progress) / merges.length;
    els.bar.style.width = `${Math.min(100, t * 100)}%`;
  }

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

  function diagramRadius(rev, scale) {
    return Math.max(14 * scale, radiusFor(rev) * 1.35 * scale);
  }

  function drawMergeDiagram(svg, merge, p, mode) {
    const NS = "http://www.w3.org/2000/svg";
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const isMini = mode === "mini";
    const W = 960;
    const H = isMini ? 110 : 220;
    const scale = isMini ? 0.55 : 1;
    const cy = H * 0.42;
    const homeX = W * 0.32;
    const startX = W * 0.72;

    if (!merge) {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", String(W / 2));
      t.setAttribute("y", String(H / 2));
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("fill", "#5a7380");
      t.setAttribute("font-size", isMini ? "12" : "16");
      t.setAttribute("font-family", "IBM Plex Sans, sans-serif");
      t.textContent = "No merger selected";
      svg.appendChild(t);
      return;
    }

    const ids = merge.parties.filter((id) => byId.has(id));
    if (ids.length < 2) {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", String(W / 2));
      t.setAttribute("y", String(H / 2));
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("fill", "#5a7380");
      t.setAttribute("font-size", isMini ? "12" : "16");
      t.textContent = "Need two matched parties";
      svg.appendChild(t);
      return;
    }

    const dest = mergeDestination(ids);
    const otherId = ids.find((id) => id !== dest.id) || ids[1];
    const extraCount = Math.max(0, ids.length - 2);

    const travelEnd = 0.58;
    const absorbEnd = 0.72;
    const homeCo = byId.get(dest.id);
    const otherCo = byId.get(otherId);
    const rHome0 = diagramRadius(homeCo.revenue, scale);
    const rOther0 = diagramRadius(otherCo.revenue, scale);
    const rMerged = Math.sqrt(rHome0 * rHome0 + rOther0 * rOther0);

    let otherX = startX;
    let otherR = rOther0;
    let otherOpacity = 1;
    let homeR = rHome0;
    let showMergedOnly = false;
    let mergedR = rMerged;

    if (p < travelEnd) {
      const e = easeInOut(p / travelEnd);
      otherX = startX + (homeX - startX) * e;
    } else if (p < absorbEnd) {
      const e = easeInOut((p - travelEnd) / (absorbEnd - travelEnd));
      otherX = homeX;
      otherR = Math.max(1, rOther0 * (1 - e));
      otherOpacity = 1 - e;
      homeR = rHome0 + (rMerged - rHome0) * e;
    } else {
      showMergedOnly = true;
      const hold = (p - absorbEnd) / (1 - absorbEnd);
      mergedR = rMerged * (reduceMotion ? 1 : 1 + 0.05 * Math.sin(hold * Math.PI));
    }

    // Guide line
    if (!showMergedOnly && otherOpacity > 0.05) {
      const line = document.createElementNS(NS, "line");
      line.setAttribute("x1", String(otherX));
      line.setAttribute("y1", String(cy));
      line.setAttribute("x2", String(homeX));
      line.setAttribute("y2", String(cy));
      line.setAttribute("stroke", "#ffb703");
      line.setAttribute("stroke-width", isMini ? "1.5" : "2.5");
      line.setAttribute("stroke-opacity", String(0.35 * otherOpacity));
      line.setAttribute("stroke-dasharray", "6 6");
      svg.appendChild(line);
    }

    function addBubble(x, r, opacity, label, sub) {
      const g = document.createElementNS(NS, "g");
      g.setAttribute("opacity", String(opacity));

      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", String(x));
      c.setAttribute("cy", String(cy));
      c.setAttribute("r", String(r));
      c.setAttribute("fill", "#e85d04");
      c.setAttribute("stroke", "#ffb703");
      c.setAttribute("stroke-width", isMini ? "2" : "3");
      g.appendChild(c);

      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", String(x));
      t.setAttribute("y", String(cy + r + (isMini ? 14 : 22)));
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("fill", "#0b1f2a");
      t.setAttribute("font-size", isMini ? "11" : "15");
      t.setAttribute("font-weight", "600");
      t.setAttribute("font-family", "Syne, IBM Plex Sans, sans-serif");
      t.textContent = shortName(label, isMini ? 22 : 34);
      g.appendChild(t);

      if (sub && !isMini) {
        const s = document.createElementNS(NS, "text");
        s.setAttribute("x", String(x));
        s.setAttribute("y", String(cy + r + 40));
        s.setAttribute("text-anchor", "middle");
        s.setAttribute("fill", "#5a7380");
        s.setAttribute("font-size", "12");
        s.setAttribute("font-family", "IBM Plex Sans, sans-serif");
        s.textContent = sub;
        g.appendChild(s);
      }

      svg.appendChild(g);
    }

    if (showMergedOnly) {
      const labels = [
        partyLabel(merge, dest.id, 0),
        partyLabel(merge, otherId, 1),
      ];
      addBubble(
        homeX,
        mergedR,
        1,
        shortName(labels.join(" + "), isMini ? 28 : 42),
        `${merge.case_id} · merged`
      );
      if (!isMini) {
        const ring = document.createElementNS(NS, "circle");
        ring.setAttribute("cx", String(homeX));
        ring.setAttribute("cy", String(cy));
        ring.setAttribute("r", String(mergedR * 1.25));
        ring.setAttribute("fill", "none");
        ring.setAttribute("stroke", "#ffb703");
        ring.setAttribute("stroke-width", "2");
        ring.setAttribute("opacity", "0.35");
        svg.appendChild(ring);
      }
    } else {
      addBubble(
        homeX,
        homeR,
        1,
        partyLabel(merge, dest.id, 0),
        `${homeCo.city || homeCo.iso} · destination`
      );
      addBubble(
        otherX,
        otherR,
        otherOpacity,
        partyLabel(merge, otherId, 1),
        `${otherCo.city || otherCo.iso}${extraCount ? ` · +${extraCount} more` : ""}`
      );
    }
  }

  function updateMergeStages() {
    const m =
      phase === "idle"
        ? merges[0] || null
        : merges[mergeIdx] || null;
    const p = phase === "idle" ? 0 : progress;

    if (!m) {
      els.metaTop.innerHTML =
        '<span class="merge-stage__idle">No mergers in this year range</span>';
      els.metaBottom.textContent = "";
      drawMergeDiagram(els.svgTop, null, 0, "hero");
      drawMergeDiagram(els.svgBottom, null, 0, "mini");
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

    els.metaBottom.textContent = `${m.case_id} · ${m.labels?.slice(0, 2).join(" → ") || m.title}`;

    drawMergeDiagram(els.svgTop, m, p, "hero");
    drawMergeDiagram(els.svgBottom, m, p, "mini");
  }

  function renderFrame() {
    const m = merges[mergeIdx];
    if (!m) {
      updateMergeStages();
      updateProgressBar();
      return;
    }

    const ids = m.parties.filter((id) => markers.has(id));
    if (ids.length < 2) {
      updateMergeStages();
      updateProgressBar();
      return;
    }

    const dest = mergeDestination(ids);
    const target = dest.latlng;
    const movers = ids.filter((id) => id !== dest.id);
    const targetR = combinedRadius(ids);
    const p = progress;
    const travelEnd = 0.58;
    const absorbEnd = 0.72;

    clearTrails();
    clearMergedBubble();

    for (const [id, marker] of markers) {
      if (ids.includes(id)) continue;
      marker.setLatLng(baseLatLng.get(id));
      marker.setStyle({
        fillColor: "#4f8ea3",
        color: "#0b1f2a",
        weight: 1,
        fillOpacity: 0.14,
        opacity: 0.28,
      });
      marker.setRadius(radiusFor(byId.get(id).revenue));
      if (!map.hasLayer(marker)) marker.addTo(layer);
    }

    const home = markers.get(dest.id);
    if (home) {
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
      if (home) home.setRadius(radiusFor(byId.get(dest.id).revenue));

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
        marker.setRadius(radiusFor(byId.get(id).revenue));
        if (!map.hasLayer(marker)) marker.addTo(layer);

        trailLines.push(
          L.polyline([base, [lat, lng]], {
            color: "#ffb703",
            weight: 1.4,
            opacity: 0.35 * (1 - e * 0.5),
            interactive: false,
          }).addTo(map)
        );
      }
    } else if (p < absorbEnd) {
      const e = easeInOut((p - travelEnd) / (absorbEnd - travelEnd));
      const homeR0 = radiusFor(byId.get(dest.id).revenue);
      if (home) {
        home.setLatLng(target);
        home.setRadius(homeR0 + (targetR - homeR0) * e);
      }

      for (const id of movers) {
        const marker = markers.get(id);
        const r0 = radiusFor(byId.get(id).revenue);
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
      for (const id of ids) {
        const marker = markers.get(id);
        if (map.hasLayer(marker)) layer.removeLayer(marker);
      }

      const hold = (p - absorbEnd) / (1 - absorbEnd);
      const pulse = reduceMotion ? 1 : 1 + 0.06 * Math.sin(hold * Math.PI);
      mergedBubble = L.circleMarker(target, {
        radius: targetR * pulse,
        color: "#ffb703",
        weight: 3,
        fillColor: "#e85d04",
        fillOpacity: 0.92,
        opacity: 1,
        interactive: false,
      }).addTo(map);

      trailLines.push(
        L.circleMarker(target, {
          radius: targetR * (1.15 + hold * 0.55),
          color: "#ffb703",
          weight: 2,
          fillOpacity: 0,
          opacity: Math.max(0, 0.55 - hold * 0.55),
          interactive: false,
        }).addTo(map)
      );
    }

    updateMergeStages();
    updateProgressBar();
  }

  function tick(ts) {
    if (phase !== "playing") return;
    if (!lastTs) lastTs = ts;
    const dt = ts - lastTs;
    lastTs = ts;
    const duration = (reduceMotion ? 280 : 1400) / Number(els.speed.value || 1);
    progress += dt / duration;

    if (progress >= 1) {
      if (mergeIdx >= merges.length - 1) {
        progress = 1;
        phase = "done";
        setPlayLabel();
        renderFrame();
        setTimeout(() => {
          if (phase === "done") {
            resetStyles();
            updateMergeStages();
          }
        }, 400);
        updateProgressBar();
        return;
      }
      resetStyles();
      mergeIdx += 1;
      progress = 0;
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
  }

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
