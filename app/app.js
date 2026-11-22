// =====================================================================
// HeatLens Delhi. Data: risk-data.js (scores, forecast rules) and wards.js (outlines).
// The map is drawn by MapLibre GL, which uses the graphics card to redraw every shape at the exact
// zoom level on every frame. Wards stay sharp all the way through a zoom and line widths never change.
// Anything that changes while you use the map (the open ward, hover, each day's colours, 3D heights) is a
// small per-ward value the graphics card reads, never a filter or style change that would make the map
// rebuild every ward shape, so zooming, clicking and the story stay smooth.
// Sections: 1 join the data, 2 colours, 3 the map, 4 hover and click, 5 opening a ward,
//           6 heat outlook (forecast x ward), 7 side panel, 8 controls.
// =====================================================================
const $ = (s) => document.querySelector(s);
const mapEl = $("#map");


// ---------- 1. JOIN THE DATA ----------------------------------------
// wards.js has the outlines, risk-data.js has the scores. They share the ward number.
const info = Object.fromEntries(DATA.wards.map((w) => [w.id, w]));
const places = WARDS.map((geo) => {
  const d = info[geo.no];
  const numbered = /^[0-9]+$/.test(d.id);
  const outer = geo.polys.flatMap((poly) => poly[0]); // a ward can have several parts (and holes)
  const lngs = outer.map((q) => q[0]), lats = outer.map((q) => q[1]);
  return {
    ...d,
    polys: geo.polys,
    nb: geo.nb || [], // the wards it shares a border with
    bbox: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)], // [west, south, east, north]
    label: (numbered ? `${d.name} (Ward ${d.id})` : d.name).replace("Ndmc", "NDMC"),
  };
});
const byId = Object.fromEntries(places.map((p) => [p.id, p]));
const scored = places.filter((p) => p.score !== undefined);


// ---------- 2. COLOURS ----------------------------------------------
const PAL = ["#ffffcc", "#fed976", "#fd8d3c", "#e31a1c", "#800026"];
const CLS = ["Low", "Moderate", "High", "Very High", "Extreme"];
const NOT_SCORED = "#c9c3b3";
const RISKCOL = ["#d9ead3", "#fed976", "#fd8d3c", "#b10026"]; // no / low / medium / high heat risk (this week's view)
const layers = [["cls", "Risk class (overall)"], ["score", "Overall risk score"],
  ...DATA.groups.map((g) => ["g:" + g, g + " score"])];
layers.forEach(([v, t]) => {
  const o = document.createElement("option");
  o.value = v; o.textContent = t;
  $("#layer").appendChild(o);
});

const ramp = (v) => PAL[Math.min(4, Math.max(0, Math.floor(v / 20)))]; // 0-100 -> 5 bands (small bars)
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function interp(t) { // smooth blend along the palette, t from 0 to 1
  t = Math.min(1, Math.max(0, t));
  const x = t * 4, i = Math.min(3, Math.floor(x)), f = x - i, a = hex(PAL[i]), b = hex(PAL[i + 1]);
  return "rgb(" + a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(",") + ")";
}
const val = (p, L) => (L === "score" ? p.score : p.groups[L.slice(2)]);
// colour scale runs from the 2nd to the 98th percentile so a few outliers don't wash it out
const RANGE = {};
layers.slice(1).forEach(([L]) => {
  const v = scored.map((p) => val(p, L)).sort((a, b) => a - b);
  RANGE[L] = [v[Math.floor(v.length * 0.02)], v[Math.floor(v.length * 0.98)]];
});
// What the map shows: "week" = each day's heat danger (the default), "vuln" = who is vulnerable (the colour setting below)
let mapMode = "week", weekDay = 0, week = null;
const LOADING = "#e9e4d8"; // the wards' colour in the heat view until the forecast has arrived
function colour(p) {
  if (p.score === undefined) return NOT_SCORED;
  if (mapMode === "week" && !week) return LOADING; // no forecast yet: don't show vulnerability colours as if they were heat
  const L = $("#layer").value;
  if (L === "cls") return PAL[CLS.indexOf(p.cls)];
  const [lo, hi] = RANGE[L];
  return interp(hi > lo ? (val(p, L) - lo) / (hi - lo) : 0.5);
}


// ---------- 3. THE MAP ----------------------------------------------
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const DELHI_VIEW = [[76.84, 28.40], [77.35, 28.89]]; // [west, south], [east, north]
const AREA = [75.9, 27.9, 78.3, 29.4];               // the map can't be dragged outside this box

const panelOpen = () => !document.body.classList.contains("panel-closed");
const wide = () => window.innerWidth > 800;
// The panel floats over the map, so whenever the map fits something into view it leaves room for it
const fitPad = () => wide()
  ? { top: 40, bottom: 40, left: panelOpen() ? 450 : 40, right: 70 }                         // panel on the left
  : { top: 24, left: 24, right: 24, bottom: Math.round(window.innerHeight * 0.46) + 24 };    // panel along the bottom

const closeRing = (r) => (r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r : [...r, r[0]]);

// One shape per ward, numbered in the same order as `places`, each carrying its current colour
function wardsGeoJSON() {
  return {
    type: "FeatureCollection",
    features: places.map((p, i) => ({
      type: "Feature", id: i,
      properties: { fill: colour(p), est: !!p.estimated, named: p.named.length > 0 },
      geometry: { type: "MultiPolygon", coordinates: p.polys.map((poly) => poly.map(closeRing)) },
    })),
  };
}
// Everything outside Delhi: a world-sized shape with Delhi cut out as a hole
// (the hole has to wind the opposite way round to the outer edge)
function outsideGeoJSON() {
  const turn = (r) => r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + (q[0] - p[0]) * (q[1] + p[1]); }, 0);
  const outer = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]; // anticlockwise
  let hole = closeRing(DELHI_OUTLINE);
  if (turn(hole) < 0) hole = [...hole].reverse(); // make it clockwise
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [outer, hole] } };
}
// A small repeating square of warm paper with one diagonal hatch line (it tiles seamlessly)
function hatchImage() {
  const r = Math.max(1, Math.round(window.devicePixelRatio || 1)), n = 8 * r;
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#e2dccf";
  ctx.fillRect(0, 0, n, n);
  ctx.strokeStyle = "rgba(92, 78, 52, 0.16)";
  ctx.lineWidth = r;
  ctx.beginPath();
  for (const off of [-n, 0, n]) { ctx.moveTo(off, n); ctx.lineTo(off + n, 0); }
  ctx.stroke();
  return { image: ctx.getImageData(0, 0, n, n), pixelRatio: r };
}

const STYLE = {
  version: 8,
  // a soft light for the 3D view, so raised wards keep their map colours instead of glowing
  light: { anchor: "viewport", color: "#ffffff", intensity: 0.25 },
  sources: {
    sat: { type: "raster", tiles: [ESRI + "/World_Imagery/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 17, bounds: AREA,
      attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics" },
    labels: { type: "raster", tiles: [ESRI + "/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 15, bounds: AREA,
      attribution: "Labels &copy; Esri, OpenStreetMap contributors" },
    // the wards, the grey mask and the Delhi border share one level of detail, so their edges always line
    // up (a mask cut at a coarser level would leave slivers along the border when zoomed in)
    wards: { type: "geojson", data: wardsGeoJSON(), maxzoom: 15 },
    // the 3D view's own, slightly simpler copy of the wards: it is only used zoomed out, and keeping the
    // towers apart means opening a ward or hovering never has to touch them
    wards3d: { type: "geojson", data: wardsGeoJSON(), maxzoom: 12, tolerance: 1 },
    outside: { type: "geojson", data: outsideGeoJSON(), maxzoom: 15 },
    border: { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: closeRing(DELHI_OUTLINE) } }, maxzoom: 15 },
    flows: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
  },
  // bottom to top
  layers: [
    { id: "paper", type: "background", paint: { "background-color": "#e2dccf" } },
    { id: "sat", type: "raster", source: "sat" },
    { id: "labels", type: "raster", source: "labels" },
    // in the week view each ward gets a small per-ward value "r" (its risk that day) and the graphics card
    // picks the colour, so changing the day is instant and nothing has to be re-processed
    { id: "ward-fill", type: "fill", source: "wards", paint: {
      "fill-color": ["match", ["to-number", ["coalesce", ["feature-state", "r"], -1]],
        0, RISKCOL[0], 1, RISKCOL[1], 2, RISKCOL[2], 3, RISKCOL[3], ["to-color", ["get", "fill"]]],
      "fill-opacity": 0.82, "fill-opacity-transition": { duration: 600, delay: 0 } } },
    { id: "ward-lines", type: "line", source: "wards", layout: { "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-opacity": 0.85, "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.5, 14, 1.3] } },
    { id: "ward-est", type: "line", source: "wards", filter: ["==", ["get", "est"], true],
      paint: { "line-color": "#5a5146", "line-width": 1, "line-dasharray": [3, 2] } },
    { id: "ward-named", type: "line", source: "wards", filter: ["==", ["get", "named"], true], layout: { visibility: "none" },
      paint: { "line-color": "#0a4fa8", "line-width": 2 } },
    // the grey veil over every ward except the open one; it fades in and out. The open ward is marked with
    // a per-ward value ("sel"), never a filter: changing a filter makes the map rebuild every ward shape,
    // which is what used to stall the zoom and let the grey layers slip out of line for a moment
    // No edge smoothing on the veil: with it, two neighbouring grey shapes each leave a half-see-through
    // fringe along their shared border, so thin lines of colour would show through. Without it they meet
    // pixel for pixel, and the borders drawn on top hide any stair-steps.
    { id: "veil", type: "fill", source: "wards",
      paint: { "fill-color": ["case", ["boolean", ["feature-state", "sel"], false], "rgba(218, 213, 203, 0)", "#dad5cb"],
        "fill-antialias": false, "fill-opacity": 0, "fill-opacity-transition": { duration: 650, delay: 0 } } },
    // the hatched mask over everything outside Delhi (faded out in 3D, where the far edge of a tilted
    // view would show where it stops)
    { id: "outside", type: "fill", source: "outside",
      paint: { "fill-pattern": "hatch", "fill-opacity": 1, "fill-opacity-transition": { duration: 600, delay: 0 } } },
    { id: "delhi-border", type: "line", source: "border", layout: { "line-join": "round" },
      paint: { "line-color": "rgba(43, 36, 28, 0.8)", "line-width": 1.6 } },
    // red dashed outline: wards still short after neighbours have helped (needs city help)
    { id: "unmet-line", type: "line", source: "wards", layout: { "line-join": "round" },
      paint: { "line-color": "#b10026", "line-width": 2.5, "line-dasharray": [1.4, 1.1], "line-opacity": ["case", ["boolean", ["feature-state", "unmet"], false], 1, 0] } },
    { id: "sel-line", type: "line", source: "wards", layout: { "line-join": "round" },
      paint: { "line-color": "#2b241c", "line-width": 3, "line-opacity": ["case", ["boolean", ["feature-state", "outline"], false], 1, 0] } },
    { id: "hover-line", type: "line", source: "wards", layout: { "line-join": "round" },
      paint: { "line-color": "#2b241c", "line-width": 1.6, "line-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 1, 0] } },
    // neighbours sharing: a moving dashed arc from the ward that lends to the ward that needs it, with an arrowhead
    // 3D view: each ward raised by a per-ward height "h" (metres). The layer is always built but drawn only
    // when it fades in, so switching 3D on costs nothing up front; tilting the camera is what raises it.
    // It stops at zoom 12.5 (the 3D view is a city overview), which keeps it out of the way when a ward opens.
    { id: "ward-3d", type: "fill-extrusion", source: "wards3d", maxzoom: 12.5, paint: {
      "fill-extrusion-color": ["match", ["to-number", ["coalesce", ["feature-state", "r"], -1]],
        0, RISKCOL[0], 1, RISKCOL[1], 2, RISKCOL[2], 3, RISKCOL[3], ["to-color", ["get", "fill"]]],
      "fill-extrusion-height": ["coalesce", ["feature-state", "h"], 0],
      "fill-extrusion-base": 0, "fill-extrusion-opacity": 0, "fill-extrusion-opacity-transition": { duration: 650, delay: 0 },
      "fill-extrusion-vertical-gradient": true } },
    { id: "flow-line", type: "line", source: "flows", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#7a2a12", "line-width": ["interpolate", ["linear"], ["get", "n"], 1, 1.6, 12, 5],
        "line-opacity": ["case", ["==", ["get", "hops"], 2], 0.55, 0.92], "line-dasharray": [0, 4, 3] } },
    { id: "flow-arrow", type: "symbol", source: "flows",
      layout: { "symbol-placement": "line-center", "icon-image": "arrow", "icon-size": ["interpolate", ["linear"], ["get", "n"], 1, 0.75, 12, 1.15],
        "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true } },
  ],
};

// A "home" button that sits under the + / − buttons and brings back the whole of Delhi
class HomeControl {
  onAdd() {
    const box = document.createElement("div");
    box.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "home-btn";
    b.title = "Show all of Delhi";
    b.setAttribute("aria-label", "Show all of Delhi");
    b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path d="M4 11.5 12 5l8 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M6.5 10v8.5h4v-5h3v5h4V10" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
    b.addEventListener("click", () => goHome());
    box.appendChild(b);
    return box;
  }
  onRemove() {}
}

// A "3D" button under the home button: tilts the map and raises every ward by how crowded it is and how much danger it faces
class ThreeDControl {
  onAdd() {
    const box = document.createElement("div");
    box.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "td-btn";
    b.textContent = "3D";
    b.title = "3D view: raise each ward by how crowded it is and how much danger it faces";
    b.setAttribute("aria-label", "3D view");
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => set3D(!is3D));
    box.appendChild(b);
    return box;
  }
  onRemove() {}
}

let map;
try {
  map = new maplibregl.Map({
    container: mapEl,
    style: STYLE,
    bounds: DELHI_VIEW,
    fitBoundsOptions: { padding: fitPad() },
    maxBounds: [[AREA[0], AREA[1]], [AREA[2], AREA[3]]],
    minZoom: 8, maxZoom: 16.5,
    dragRotate: false, pitchWithRotate: false, touchPitch: false, // a flat map, no tilting or turning
    renderWorldCopies: false,
    attributionControl: false,
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.scrollZoom.setWheelZoomRate(1 / 600); // the scroll wheel zooms a little more gently than the default
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new HomeControl(), "top-right"); // appears just below the + / − buttons
  map.addControl(new ThreeDControl(), "top-right");
  map.addControl(new maplibregl.AttributionControl({
    compact: true,
    customAttribution: '2022 ward boundaries: <a href="https://data.opencity.in/dataset/delhi-wards-information">OpenCity</a> (Geospatial Delhi Ltd) · NDMC &amp; Cantonment: <a href="https://github.com/datameet/Municipal_Spatial_Data">DataMeet</a> (CC BY-SA 2.5 IN)',
  }), "bottom-right");
} catch (err) {
  // No map possible (graphics turned off, or the map library couldn't download): keep the panel working
  mapEl.innerHTML = '<p class="no-map">This map needs WebGL, which this browser has turned off. The ward list and forecasts on the left still work.</p>';
  const stub = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  map = stub;
}
// A small arrowhead for the sharing arcs (drawn here, so there's no image file to load)
function arrowImage() {
  const r = Math.max(1, Math.round(window.devicePixelRatio || 1)), n = 16 * r;
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const ctx = c.getContext("2d");
  ctx.beginPath();
  ctx.moveTo(3 * r, 3 * r); ctx.lineTo(13.5 * r, 8 * r); ctx.lineTo(3 * r, 13 * r); ctx.closePath();
  ctx.lineJoin = "round";
  ctx.lineWidth = 1.6 * r;
  ctx.strokeStyle = "#fffaf3";
  ctx.stroke();
  ctx.fillStyle = "#7a2a12";
  ctx.fill();
  return { image: ctx.getImageData(0, 0, n, n), pixelRatio: r };
}
map.on("styleimagemissing", (e) => {
  const make = { hatch: hatchImage, arrow: arrowImage }[e.id];
  if (!make) return;
  const h = make();
  map.addImage(e.id, h.image, { pixelRatio: h.pixelRatio });
});

// Things that touch the map's layers have to wait until the map has loaded
let mapReady = false;
const afterLoad = [];
const whenReady = (fn) => (mapReady ? fn() : afterLoad.push(fn));
map.on("load", () => { mapReady = true; afterLoad.splice(0).forEach((fn) => fn()); });

// Colour setting changed: hand the map the new colours (it re-processes them off the main thread and
// swaps them in when ready, so the old colours stay on screen until then)
// The heat view shows plain wards until the forecast arrives; repaint when that changes
let fillLoading = mapMode === "week" && !week;
function refreshFill() {
  const l = mapMode === "week" && !week;
  if (l !== fillLoading) { fillLoading = l; paint(); }
}
function paint() {
  whenReady(() => { const g = wardsGeoJSON(); map.getSource("wards").setData(g); map.getSource("wards3d").setData(g); });
  renderLegend();
}
// Set one per-ward value on every ward of a map source
function setAllStates(source, fn) {
  whenReady(() => places.forEach((p, i) => map.setFeatureState({ source, id: i }, fn(p, i))));
}
function showNamed() {
  whenReady(() => map.setLayoutProperty("ward-named", "visibility", $("#named").checked ? "visible" : "none"));
}


// ---------- 4. HOVER AND CLICK ---------------------------------------
// Which ward is at a position? (used for GPS and the address box; quick box test, then the exact outline)
function wardAtLatLng(lat, lng) {
  for (const p of places) {
    const b = p.bbox;
    if (lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3] && inWard(lat, lng, p.polys)) return p;
  }
  return null;
}

// Hover: outline the ward and show its name once. The label is a single element whose text only
// changes when the pointer moves onto a different ward; moving within a ward just slides it.
const tip = document.createElement("div");
tip.className = "ward-tip";
mapEl.appendChild(tip);
let hoverId = null, tipText = "", moving = false, lastMove = null, hoverQueued = false;

function setHover(id) {
  if (id === hoverId) return;
  if (hoverId !== null) map.setFeatureState({ source: "wards", id: hoverId }, { hover: false });
  hoverId = id;
  map.getCanvas().style.cursor = id === null ? "" : "pointer";
  if (id === null) { tip.style.display = "none"; tipText = ""; return; }
  const p = places[id];
  if (p !== selected) map.setFeatureState({ source: "wards", id }, { hover: true });
  const text = selected && selected !== p ? p.label
    : mapMode === "week" && week && p.score !== undefined ? `${p.label}: ${RISK[dayRisk(p, weekDay)]} ${dayWord(weekDay)} (${p.cls} vulnerability)`
    : p.score === undefined ? `${p.label} (not scored)` : `${p.label}: ${p.cls} (${p.score.toFixed(0)}), rank ${p.rank}`;
  if (text !== tipText) { tip.textContent = text; tipText = text; }
  tip.style.display = "block";
}
map.on("mousemove", "ward-fill", (e) => {
  // copy what we need now: MapLibre clears e.features as soon as this handler returns
  if (!e.features || !e.features.length) return;
  lastMove = { id: e.features[0].id, x: e.point.x, y: e.point.y };
  if (hoverQueued) return;
  hoverQueued = true;
  requestAnimationFrame(() => { // at most once per frame, so moving the mouse never queues up work
    hoverQueued = false;
    if (moving) return;
    setHover(lastMove.id);
    tip.style.transform = `translate(${Math.round(lastMove.x + 14)}px, ${Math.round(lastMove.y + 16)}px)`;
  });
});
map.on("mouseleave", "ward-fill", () => setHover(null));
map.on("movestart", () => { moving = true; setHover(null); });
map.on("moveend", () => { moving = false; });
map.on("click", "ward-fill", (e) => { if (e.features.length) openWard(places[e.features[0].id]); });


// ---------- 5. OPENING A WARD ----------------------------------------
// Click a ward (map, table, search or address): fly in, grey out the rest, open its page on the left.
const overviewView = $("#overview-view");
const wardPage = $("#ward-page");
let marker = null;   // "you are here" pin (only for GPS)
let selected = null; // the ward that is open, or null
const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const FLIGHT_MS = 1500; // long enough to follow, short enough not to wait for

// Panel pages: the current page eases out, then the new one (with its new content) glides in
// from the left, one block after another.
let pageTimer = null;
function changePage(show, fill) {
  clearTimeout(pageTimer);
  const current = [overviewView, wardPage].find((el) => !el.classList.contains("hidden"));
  if (current) { current.classList.remove("in"); current.classList.add("out"); }
  pageTimer = setTimeout(() => {
    [overviewView, wardPage].forEach((el) => { el.classList.add("hidden"); el.classList.remove("out"); });
    if (fill) fill();
    show.classList.remove("hidden", "in", "out");
    void show.offsetWidth; // restart the animation
    show.classList.add("in");
    $("#panel").scrollTop = 0;
  }, current && !calm ? 240 : 0);
}

// Grey veil over every ward except the open one, plus the open ward's dark border. Both read per-ward
// values ("sel" cuts the open ward out of the veil, "outline" draws its border), so nothing is rebuilt.
let selId = null, fadeId = null, fadeTimer = null;
function showSelected(p) {
  document.body.classList.toggle("ward-open", !!p);
  whenReady(() => {
    const id = p ? places.indexOf(p) : null;
    const st = (i, s) => map.setFeatureState({ source: "wards", id: i }, s);
    clearTimeout(fadeTimer);
    if (fadeId !== null && fadeId !== id) st(fadeId, { sel: false }); // a ward still fading out loses its gap now
    fadeId = null;
    if (selId !== null && selId !== id) {
      st(selId, { outline: false });
      if (id === null) { // closing: keep the gap until the veil has faded away, so the ward doesn't flash grey
        const f = selId;
        fadeId = f;
        fadeTimer = setTimeout(() => { st(f, { sel: false }); if (fadeId === f) fadeId = null; }, 700);
      } else st(selId, { sel: false });
    }
    if (id !== null) st(id, { sel: true, outline: true });
    map.setPaintProperty("veil", "fill-opacity", id !== null ? 0.9 : 0);
    selId = id;
  });
}

const wardBounds = (p) => [[p.bbox[0], p.bbox[1]], [p.bbox[2], p.bbox[3]]];

// opts.point = { lat, lon, kind: "gps" | "address" }: a real spot inside the ward (your location, or an
// address you searched for). It gets a pin, and the forecast is for that exact spot.
function openWard(p, opts = {}) {
  const pt = opts.point || null;
  if (is3D) set3D(false); // the ward view is flat
  selected = p;
  setHover(null);
  if (!panelOpen()) setPanel(true, false);
  showSelected(p);
  whenReady(() => map.fitBounds(wardBounds(p), { padding: fitPad(), maxZoom: 14, duration: FLIGHT_MS }));
  if (marker) { marker.remove(); marker = null; }
  if (pt) marker = new maplibregl.Marker({ color: "#a4482c" }).setLngLat([pt.lon, pt.lat]).addTo(map);
  changePage(wardPage, () => {
    // top to bottom: who it is, the heat now, the heat if May 2024 came back, what to send, then the details
    wardOutlook.live = null;
    wardOutlook.demo = null;
    wardBasis = null;
    renderWardHead(p);
    renderScenarioWard(p);
    renderSend(p);
    renderWhy(p);
    renderDetail(p);
    wardPage.querySelectorAll("details").forEach((el) => { el.open = false; });
    setHere({ lat: pt ? pt.lat : p.lat, lon: pt ? pt.lon : p.lon, kind: pt ? pt.kind : null, ward: p });
  });
}

function closeWard() {
  selected = null;
  here = null;
  if (marker) { marker.remove(); marker = null; }
  showSelected(null);
  $("#my-status").classList.add("hidden");
  changePage(overviewView);
  whenReady(() => map.fitBounds(DELHI_VIEW, { padding: fitPad(), duration: FLIGHT_MS }));
}
$("#ward-back").addEventListener("click", closeWard);

// The home button: back to the whole of Delhi. If a ward is open, this also closes it
// (the same as "← All wards"), so the map and the panel always agree.
function goHome() {
  if (selected) return closeWard();
  whenReady(() => map.fitBounds(DELHI_VIEW, { padding: fitPad(), duration: FLIGHT_MS }));
}

// ---- Show / hide the panel. It slides out to the left and the map glides so the same spot stays centred.
function setPanel(open, pan = true) {
  if (open === panelOpen()) return;
  document.body.classList.toggle("panel-closed", !open);
  $("#panel-toggle").setAttribute("aria-expanded", String(open));
  $("#panel-toggle").title = open ? "Hide the panel" : "Show the panel";
  if (pan && wide()) whenReady(() => map.panBy([open ? -205 : 205, 0], { duration: 550 }));
}
$("#panel-toggle").addEventListener("click", () => setPanel(!panelOpen()));


// ---------- 6. HEAT OUTLOOK: FORECAST x WARD RISK ---------------------
const R = DATA.rule;
const RISK = ["No risk", "Low risk", "Medium risk", "High risk"];
const LEVEL = ["normal", "hot (40 °C+)", "heat wave", "severe heat wave"];
const LEVCOL = ["#e4e2da", "#fed976", "#e31a1c", "#800026"];
// ward risk class -> tier (0: Low/Moderate, 1: High, 2: Very High/Extreme); rows = worst heat level in the next 7 days
const tier = (c) => (c === "High" ? 1 : c === "Very High" || c === "Extreme" ? 2 : 0);
const MATRIX = [[0, 0, 0], [1, 1, 2], [2, 3, 3], [3, 3, 3]];
const ADVICE = [
  "No heat-related precautions needed beyond the usual.",
  "Drink water regularly and avoid strenuous activity outdoors in the early afternoon.",
  "Stay indoors from noon to 4 pm where you can, drink water often, and check on elderly neighbours and young children.",
  "Avoid going out from noon to 4 pm, drink water often even if not thirsty, check on elderly people, children and anyone working outdoors, and know where your nearest hospital is. Heat stroke is an emergency: call 112.",
];
let here = null;
const fcCache = {};
const FORECAST_TTL_MS = 60 * 60 * 1000; // forecasts older than an hour are fetched again

const doy = (s) => {
  const d = new Date(s + "T00:00:00Z");
  return Math.round((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1;
};
const dayName = (s) => new Date(s + "T00:00:00Z").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const wkday = (s) => new Date(s + "T00:00:00Z").toLocaleDateString("en-IN", { weekday: "short", timeZone: "UTC" });
const num = (v, n = 0) => (v == null || !Number.isFinite(v) ? "–" : v.toFixed(n)); // safe number formatting

// IMD rule: hot day = (>=40 C and >=4.5 C above normal) or >=45 C; heat wave = 2+ hot days in a row;
// severe = 6.5 C above normal (and >=40 C) or >=47 C
function classify(days) {
  days.forEach((d) => {
    if (d.tmax == null) { d.anom = NaN; d.hot = false; return; } // a missing day can't be hot
    d.anom = d.tmax - DATA.normals[doy(d.date) - 1];
    d.hot = (d.tmax >= R.thr && d.anom >= R.anom) || d.tmax >= R.abs;
  });
  for (let i = 0; i < days.length;) {
    if (!days[i].hot) { days[i].hw = false; i++; continue; }
    let j = i;
    while (j < days.length && days[j].hot) j++;
    for (let k = i; k < j; k++) { days[k].hw = j - i >= R.run; days[k].streak = k - i + 1; }
    i = j;
  }
  days.forEach((d) => {
    d.severe = d.hw && ((d.anom >= R.anomSev && d.tmax >= R.thr) || d.tmax >= R.absSev);
    d.level = d.severe ? 3 : d.hw ? 2 : d.tmax >= R.thr ? 1 : 0;
  });
  return days;
}

// The May 2024 replay: observed Delhi temperatures, 22–30 May 2024, shown as if 24 May were today
let demoFc = null;
function demoForecast() {
  if (!demoFc) demoFc = { days: classify(DATA.demo.map((d) => ({ ...d }))), today: 2,
    src: "Replay: observed Delhi temperatures, 22–30 May 2024, shown as if 24 May were today." };
  return demoFc;
}
// What a forecast means for one ward: the next 7 days, the worst heat level, the first heat-wave day,
// the hottest day, and the ward's risk (worst heat level x its vulnerability)
function outlookOf(fc, w) {
  const ahead = fc.days.slice(fc.today, fc.today + 7), now = ahead[0];
  const lvl = Math.max(...ahead.map((d) => d.level));
  const peak = Math.max(...ahead.map((d) => (d.tmax == null ? -Infinity : d.tmax)));
  const firstHw = ahead.find((d) => d.hw);
  const risk = w && w.score !== undefined ? MATRIX[lvl][tier(w.cls)] : null;
  return { w, fc, ahead, now, lvl, peak, firstHw, risk };
}
// 2 past days (so a heat wave already under way is caught) + today + 6 days
async function forecast(lat, lon, replay = $("#demo").checked) {
  if (replay) return demoForecast();
  // Open-Meteo's weather grid is about 11 km wide, so every place snaps to the nearest 0.1° point
  const key = gridKey(lat, lon);
  const hit = fcCache[key];
  if (hit && Date.now() - hit.at < FORECAST_TTL_MS) return hit.value;
  const [glat, glon] = key.split(",");
  const url = "https://api.open-meteo.com/v1/forecast?latitude=" + glat + "&longitude=" + glon +
    "&daily=temperature_2m_max,temperature_2m_min,apparent_temperature_max&timezone=Asia%2FKolkata&past_days=2&forecast_days=7";
  const res = await fetch(url);
  if (!res.ok) throw new Error("forecast service answered " + res.status);
  const j = (await res.json()).daily;
  const days = j.time.map((t, i) => ({
    date: t, tmax: j.temperature_2m_max[i], tmin: j.temperature_2m_min[i], app: j.apparent_temperature_max[i],
  }));
  // find today by date (not by position), in Delhi's time zone
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const idx = j.time.indexOf(todayStr);
  const value = { days: classify(days), today: idx >= 0 ? idx : 2,
    src: "Forecast: Open-Meteo, fetched " + new Date().toLocaleTimeString() + "." };
  fcCache[key] = { at: Date.now(), value };
  return value;
}

// The ward page's "Now" section: always the live forecast for the ward (or the exact spot searched for)
async function setHere(h) {
  here = h;
  const b = $("#youbody");
  b.innerHTML = '<div class="sm">Getting the forecast…</div>';
  let fc;
  try { fc = await forecast(h.lat, h.lon, false); }
  catch (e) {
    if (here !== h) return;
    b.innerHTML = `<div class="flag">Couldn't get the live forecast (${esc(e.message)}). The May 2024 plan below still works.</div>`;
    return;
  }
  if (here !== h) return; // a newer request replaced this one
  renderHere(h, fc);
  b.classList.remove("arrive");
  void b.offsetWidth;
  b.classList.add("arrive");
}

// The risk badge, coloured like the map
const riskBadge = (risk) => `<span class="risk" style="background:${RISKCOL[risk]};color:${risk === 3 ? "#fff" : "#1c1c1a"}">${RISK[risk]}</span>`;
// One line saying what the heat is doing
function heatLine(o) {
  if (o.now.hw) return `<b>${o.now.severe ? "Severe heat wave" : "Heat wave"} now</b> (day ${o.now.streak}), up to ${num(o.peak)} °C`;
  if (o.firstHw) return `<b>${o.ahead.some((d) => d.severe) ? "Severe heat wave" : "Heat wave"} from ${dayName(o.firstHw.date)}</b>, up to ${num(o.peak)} °C`;
  if (o.lvl === 1) return `<b>Hot days ahead</b>, up to ${num(o.peak)} °C, but no heat wave`;
  return `<b>No heat wave in the next 7 days</b>, up to ${num(o.peak)} °C`;
}
// A compact 7-day strip: day, maximum, heat-level colour (details on hover)
const dayStrip = (o) => `<div class="days">${o.ahead.map((d, i) =>
  `<div class="day${i === 0 ? " today" : ""}" title="${LEVEL[d.level]}; low ${num(d.tmin)} °C, feels like ${num(d.app)} °C; ${d.anom >= 0 ? "+" : ""}${num(d.anom, 1)} °C vs normal">` +
  `${i === 0 ? "Today" : wkday(d.date)}<b>${num(d.tmax)}°</b><i style="background:${LEVCOL[d.level]}"></i></div>`).join("")}</div>`;

function renderHere(h, fc) {
  const w = h.ward, o = outlookOf(fc, w);
  const where = h.kind === "gps" ? "Your location is in this ward. " : h.kind === "address" ? "The address you searched is in this ward. " : "";
  $("#youbody").innerHTML = `<div class="verdict">${o.risk === null ? "" : riskBadge(o.risk)}<span>${heatLine(o)}.</span></div>` +
    dayStrip(o) +
    (o.risk ? `<div class="advice">${ADVICE[o.risk]}</div>` : "") +
    `<p class="sm note">${where}${fc.src} Heat wave = IMD rule: 2+ days at 40 °C and 4.5 °C above Delhi's normal, or 45 °C.</p>`;
  wardOutlook.live = o;
  if (selected === w) renderSend(w); // the live forecast decides whether the plan below is for this week
}

// Is a point inside a ward? Inside one of its parts, and not inside a hole in that part
function inWard(lat, lng, polys) {
  return polys.some((poly) => inRing(lat, lng, poly[0]) && !poly.slice(1).some((hole) => inRing(lat, lng, hole)));
}
// Which ring is a point in? (ray casting: count how many outline edges a line to the right crosses)
function inRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function wardAt(lat, lon) {
  const hit = wardAtLatLng(lat, lon);
  if (hit) return hit;
  // simplified borders can leave slivers: fall back to the nearest ward centre within 1.5 km
  let best = null, bd = 1.5;
  places.forEach((p) => {
    const km = Math.hypot((p.lon - lon) * 97.5, (p.lat - lat) * 111.3);
    if (km < bd) { bd = km; best = p; }
  });
  return best;
}


// ---------- 7. SIDE PANEL ---------------------------------------------
function renderLegend() {
  if (mapMode === "week") {
    const sharing = $("#share-on").checked, need = NEEDS.find((n) => n.key === $("#share-res").value);
    $("#legend").innerHTML = RISK.map((r, i) => `<span><i style="background:${RISKCOL[i]}"></i>${r}</span>`).join("") +
      (sharing ? `<span><i class="key-arrow"></i>${need.short} lent by a neighbouring ward</span><span><i class="key-unmet"></i>still short: the city sends the rest</span>` : "");
    return;
  }
  const L = $("#layer").value;
  $("#legend").innerHTML = (L === "cls"
    ? CLS.map((c, i) => `<span><i style="background:${PAL[i]}"></i>${c}</span>`)
    : [`<span>${RANGE[L][0].toFixed(0)}</span><span class="grad" style="background:linear-gradient(to right,${PAL.join(",")})"></span><span>${RANGE[L][1].toFixed(0)} (low to high risk)</span>`]
  ).join("") + `<span><i style="background:${NOT_SCORED}"></i>not scored</span>`;
}

const fmt = (v, f) => v == null ? "—" : f === "int" ? Math.round(v).toLocaleString()
  : f === "pct100" ? (v * 100).toFixed(1) + "%" : f === "0" ? v.toFixed(0) : f === "2" ? v.toFixed(2) : v.toFixed(1);

const clsPill = (c) => `<span class="pill" style="background:${PAL[CLS.indexOf(c)]};color:${CLS.indexOf(c) >= 3 ? "#fff" : "#1c1c1a"}">${c}</span>`;

// The ward page's heading: name, vulnerability, rank, ward number
function renderWardHead(p) {
  const no = /^\d+$/.test(p.id) ? `Ward ${p.id}` : (p.type || "");
  $("#ward-head").innerHTML = `<h2 class="ward-name">${esc(shortName(p))}</h2>
    <div class="ward-meta">${p.score === undefined ? "Not scored" : `${clsPill(p.cls)} vulnerability · rank ${p.rank} of ${DATA.n_scored}`}${no ? ` · ${esc(no)}` : ""}${p.ac ? ` · ${esc(p.ac)}` : ""}</div>
    ${p.score !== undefined ? `<div class="sm">About ${count(p.facts.total_population || 0)} people live here.${p.transferred || p.estimated ? ' <span class="est">Score partly estimated (see the details below).</span>' : ""}</div>` : ""}`;
}

// The ward page's "If May 2024 happened again": the same ward in the replayed heat wave
function renderScenarioWard(p) {
  const box = $("#scenario-body");
  const o = outlookOf(demoForecast(), p);
  wardOutlook.demo = o;
  if (o.risk === null) { box.innerHTML = `<p class="sm">${esc(p.label)} isn't a scored ward, so there's no risk level to replay.</p>`; return; }
  const w = demoWeek(), d = peakDay(p, w);
  const hiDays = [0, 1, 2, 3, 4, 5, 6].filter((x) => dayRisk(p, x, w) === 3).length;
  const hiWards = scored.filter((q) => dayRisk(q, d, w) === 3).length;
  const nbs = p.nb.map((id) => byId[id]).filter((q) => q && q.score !== undefined);
  const nbHi = nbs.filter((q) => dayRisk(q, d, w) === 3);
  box.innerHTML = `<div class="verdict">${riskBadge(o.risk)}<span>${heatLine(o)}${hiDays ? `; ${hiDays} day${hiDays === 1 ? "" : "s"} at high risk here` : ""}.</span></div>
    <p class="sm">${o.risk === 3 ? `One of the ${hiWards} wards at high risk in that heat wave.` : `${RISK[o.risk]} here, while ${hiWards} other wards reach high risk.`}
    ${nbs.length ? `${nbHi.length} of its ${nbs.length} neighbouring wards ${nbHi.length === 1 ? "is" : "are"} at high risk too${nbHi.length ? `: ${nbHi.slice(0, 4).map((q) => esc(shortName(q))).join(", ")}${nbHi.length > 4 ? "…" : ""}` : ""}.` : ""}</p>`;
}

// The ward's score in detail (inside a fold-out): four groups, what drives it, the underlying numbers
function renderDetail(p) {
  const d = $("#detail");
  if (p.score === undefined) {
    d.innerHTML = `<div class="sm">Not scored (${p.type || "not a ward"}).</div>`;
    return;
  }
  const bars = DATA.groups.map((g) =>
    `<div class="bar"><span>${g}</span><div class="b"><span style="width:${p.groups[g]}%;background:${ramp(p.groups[g])}"></span></div><span>${p.groups[g].toFixed(0)}</span></div>`).join("");
  const facts = DATA.facts.map(([c, l, f]) => `<tr><td>${l}</td><td class="n">${fmt(p.facts[c], f)}</td></tr>`).join("");
  d.innerHTML = `<div class="sm">Score ${p.score.toFixed(1)} / 100 · rank ${p.rank} of ${DATA.n_scored}</div>
    ${p.transferred ? `<div class="flag">Estimated for the 2022 ward map from the older wards it overlaps${p.from && p.from.length ? ": " + p.from.map((f) => `${f.name} ${f.pct}%`).join(", ") : ""}. Exact scores need the model re-run on the 2022 wards.</div>` : ""}
    ${p.estimated ? `<div class="flag">Census-based factors were estimated for this ward, so treat its score with more caution.</div>` : ""}
    ${p.named.length ? `<div class="sm" style="margin-top:6px">Named in: ${p.named.join(", ").replace(/_/g, " ")}</div>` : ""}
    <h3>Four groups (higher = more risk)</h3>${bars}
    <h3>What pushes the score up most</h3><div class="sm">${p.drivers.split("; ").join(" · ")}</div>
    <h3>Underlying numbers</h3><table class="facts">${facts}</table>`;
}

const topWards = scored.slice().sort((a, b) => a.rank - b.rank).slice(0, 25);
$("#top").innerHTML = "<tr><th>#</th><th>Ward</th><th>Class</th><th class='n'>Score</th></tr>" +
  topWards.map((p) => `<tr class="row" data-id="${p.id}"><td>${p.rank}</td><td>${p.label}${p.estimated ? " *" : ""}</td><td>${p.cls}</td><td class="n">${p.score.toFixed(1)}</td></tr>`).join("") +
  `<tr><td colspan="4" class="sm">* Census-based factors estimated</td></tr>`;
document.querySelectorAll("tr.row").forEach((r) => r.addEventListener("click", () => openWard(byId[r.dataset.id])));

$("#method").innerHTML = `<p>Each of ${DATA.n_scored} wards is ranked against the others on ${DATA.indicators.length} indicators, grouped into <b>heat hazard</b>, <b>exposure</b>, <b>sensitivity</b> and <b>adaptive capacity</b>. Each group counts 25%. Risk classes are quintiles (the highest fifth of wards are "Extreme").</p>
<h3>Indicators</h3><ul>${DATA.indicators.map((i) => `<li>${i}</li>`).join("")}</ul>
<details><summary>Known limitations</summary><ul>${DATA.limits.filter((l) => !/robustness checks/i.test(l)).map((l) => `<li>${l}</li>`).join("")}<li>${DATA.est.note} ${DATA.est.wards_estimated} wards affected.</li><li>Neighbour sharing is a planning model, not an inventory: it assumes every ward holds a population share of the city's stock of each resource (enough in total for a full heat wave), and that spare stock can move to bordering wards, or one ward further, on the day.</li><li>Ward boundaries are the 2022 MCD delimitation (250 wards). NDMC and Delhi Cantonment, which are not MCD wards, use DataMeet's earlier outlines trimmed to fit.</li></ul></details>
<details><summary>Data sources</summary><ul><li>Surface temperature &amp; vegetation: Landsat 8/9 (USGS), April–June 2019–2025</li><li>Land cover: ESA WorldCover 2021 (CC BY 4.0)</li><li>Population by age: WorldPop 2020 (CC BY 4.0)</li><li>Hospitals: OpenStreetMap contributors (ODbL)</li><li>Housing, assets, water: Census of India 2011, houselisting table HL-14</li><li>Reference lists: Delhi Heat Action Plan 2025 (DDMA) and CSE, "No time to cool" (2026)</li><li>Ward boundaries: 2022 MCD wards from OpenCity (source: Geospatial Delhi Ltd / State Election Commission of Delhi); NDMC and Cantonment from DataMeet Municipal Spatial Data (CC BY-SA 2.5 IN)</li><li>Ward populations on the 2022 map: Census 2011 figures used for the delimitation</li></ul></details>`;


// ---------- 7b. WHAT TO SEND ------------------------------------------
// Turns each ward's own numbers into practical help to send before and during a heat wave.
// The rules are deliberately simple and shown on the page: a need appears when the ward is among
// the worst 30% of Delhi's areas on that factor, and quantities are rules of thumb per resident
// for a heat-wave week (planning numbers, not official norms).
const NEED_CODES = ["tree_cover_pct", "lst_mean_c", "built_up_share", "tap_treated_pct", "elderly_share", "under5_share",
  "hospital_travel_min", "hospitals_per_100k", "assets_index", "pop_density"];
const sortedFacts = Object.fromEntries(NEED_CODES.map((c) => [c,
  scored.map((p) => p.facts && p.facts[c]).filter((v) => v != null && !Number.isNaN(v)).sort((a, b) => a - b)]));
// Where a ward sits among all areas for one factor: 0 = lowest value, 1 = highest
function pr(p, code) {
  const v = p.facts && p.facts[code], a = sortedFacts[code];
  if (v == null || !a.length) return null;
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= v) lo = m + 1; else hi = m; }
  return lo / a.length;
}
const worstOf = (...xs) => { const v = xs.filter((x) => x != null); return v.length ? Math.max(...v) : null; };
const flip = (x) => (x == null ? null : 1 - x);
const share = (v) => (v == null ? "–" : Math.round(v * 100) + "%");
const count = (n) => Math.round(n).toLocaleString("en-IN");
const svg = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const NEEDS = [
  {
    key: "cool", title: "Cooling shelters and shade", short: "Cooling shelters",
    icon: svg('<path d="M12 3a9 9 0 0 1 9 9H3a9 9 0 0 1 9-9Z"/><path d="M12 12v6.5a2 2 0 0 0 4 0"/>'),
    what: "Open cool shelters (schools, community halls) from noon to 5 pm, and put up shade at bus stops, markets and worksites.",
    sev: (p) => worstOf(flip(pr(p, "tree_cover_pct")), pr(p, "lst_mean_c"), pr(p, "built_up_share")),
    why: (f) => `Tree cover ${num(f.tree_cover_pct)}%, built-up ${share(f.built_up_share)} of the land, surface ${num(f.lst_mean_c, 1)} °C in summer`,
    qty: (pop) => ({ n: Math.max(1, Math.round(pop / 20000)), one: "shelter", many: "shelters", rule: "1 per 20,000 residents" }),
  },
  {
    key: "water", title: "Drinking-water points", short: "Water points",
    icon: svg('<path d="M12 3s6 6.4 6 10.8a6 6 0 0 1-12 0C6 9.4 12 3 12 3Z"/>'),
    what: "Set up free drinking-water points (piaos) and send tankers to streets without treated tap water.",
    sev: (p) => flip(pr(p, "tap_treated_pct")),
    why: (f) => `${num(f.tap_treated_pct)}% of households have treated tap water (Census 2011)`,
    qty: (pop) => ({ n: Math.max(1, Math.round(pop / 10000)), one: "water point", many: "water points", rule: "1 per 10,000 residents" }),
  },
  {
    key: "outreach", title: "Door-to-door checks on older people and infants", short: "Outreach teams",
    icon: svg('<circle cx="9" cy="8" r="3"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="9.5" r="2.3"/><path d="M15.6 20a4.6 4.6 0 0 1 5.4-4.5"/>'),
    what: "ASHA and Anganwadi workers or volunteers check daily on people over 65 and children under 5 during hot spells.",
    sev: (p) => worstOf(pr(p, "elderly_share"), pr(p, "under5_share")),
    why: (f) => `${share(f.elderly_share)} aged 65+, ${share(f.under5_share)} under 5`,
    qty: (pop, f) => {
      const atRisk = pop * ((f.elderly_share || 0) + (f.under5_share || 0));
      return { n: Math.max(1, Math.ceil(atRisk / 1500)), one: "team", many: "teams", rule: `1 per 1,500 people aged 65+ or under 5 (about ${count(atRisk)} here)` };
    },
  },
  {
    key: "medical", title: "Mobile medical unit and ambulance on standby", short: "Medical units",
    icon: svg('<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M12 8.5v7M8.5 12h7"/>'),
    what: "Station a mobile medical unit with ORS, IV fluids and ice packs in the ward, and keep an ambulance nearby in the afternoons.",
    sev: (p) => worstOf(pr(p, "hospital_travel_min"), flip(pr(p, "hospitals_per_100k"))),
    why: (f) => `About ${num(f.hospital_travel_min)} min to the nearest hospital, ${num(f.hospitals_per_100k, 1)} hospitals per 100,000 people`,
    qty: (pop) => ({ n: Math.max(1, Math.round(pop / 50000)), one: "unit", many: "units", rule: "1 per 50,000 residents" }),
  },
  {
    key: "ors", title: "ORS and heat-safety drive", short: "ORS points",
    icon: svg('<path d="M7.5 3h9l-1.2 18H8.7L7.5 3Z"/><path d="M9.5 8.5h5"/>'),
    what: "Hand out ORS packets and heat advice in crowded lanes and to outdoor workers (construction, vendors, rickshaw drivers), and push for midday breaks.",
    sev: (p) => worstOf(flip(pr(p, "assets_index")), pr(p, "pop_density")),
    why: (f) => `${count(f.pop_density || 0)} people per km²${f.assets_index == null ? "" : `, household assets ${num(f.assets_index, 2)} on a 0–1 scale`}`,
    qty: (pop) => ({ n: Math.max(1, Math.round(pop / 25000)), one: "point", many: "points", rule: "1 distribution point per 25,000 residents" }),
  },
];

// The needs that stand out for one ward, worst first
function wardNeeds(p) {
  if (p.score === undefined || !p.facts) return [];
  const pop = p.facts.total_population || p.facts.pop_census2011 || 0;
  return NEEDS.map((need) => ({ need, sev: need.sev(p) }))
    .filter((x) => x.sev != null && x.sev >= 0.7)
    .sort((a, b) => b.sev - a.sev)
    .map((x) => ({ ...x, q: x.need.qty(pop, p.facts) }));
}

// What the week's forecast means for sending help
function urgency(risk, now, firstHw, who = "the ward") {
  if (risk === null) return ["standby", "No ward data", "This area has no ward data, so there is nothing to plan from."];
  if (risk >= 3) return ["deploy", "Send now", now && now.hw ? "A heat wave is under way. Get these out today." : `A heat wave is expected from ${dayName(firstHw.date)}. Get these in place before then.`];
  if (risk === 2) return ["ready", "Get ready", firstHw ? `Heat-wave conditions from ${dayName(firstHw.date)}. Line these up so they can go out quickly.` : "A hot spell is coming. Line these up so they can go out quickly."];
  if (risk === 1) return ["standby", "Keep on standby", "Hot days ahead, but no heat wave forecast. Keep these ready."];
  return ["standby", "Standby plan", `No heat wave in the next 7 days. This is what ${who} would need when one comes.`];
}
const urgencyHtml = ([kind, label, text], id) => `<div ${id ? `id="${id}" ` : ""}class="urgency ${kind}"><b>${label}</b><span>${text}</span></div>`;

const unitName = (need, k) => { const q = need.qty(1, {}); return k === 1 ? q.one : q.many; };
// Ward lists (overview) open the ward on click or Enter
function bindWardList(box) {
  box.querySelectorAll("li[data-id]").forEach((li) => {
    const go = () => openWard(byId[li.dataset.id]);
    li.addEventListener("click", go);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}
const rankPill = (p) => `<span class="pill" style="background:${PAL[CLS.indexOf(p.cls)]};color:${CLS.indexOf(p.cls) >= 3 ? "#fff" : "#1c1c1a"}">${p.rank}</span>`;

// ---- The ward page's "What to send": one row per resource the ward stands out on, for one day: how many
//      it needs, how many it already holds, how many its neighbours lend and how many the city must send.
//      The day is this week's riskiest if the live forecast brings heat-wave risk to the ward, otherwise
//      the ward's riskiest day of a May-2024-type heat wave (a switch flips between the two).
const wardOutlook = { live: null, demo: null };
let wardBasis = null; // "live" | "demo" when chosen with the switch; null = pick automatically
function sendBasis() {
  if (wardBasis === "demo" || (wardBasis === "live" && wardOutlook.live)) return wardBasis;
  return wardOutlook.live && wardOutlook.live.risk !== null && wardOutlook.live.risk >= 2 ? "live" : "demo";
}
// The ward's plan as numbers: one entry per resource it stands out on, plus anything it lends
function wardPlan(p, w, d) {
  const rows = wardNeeds(p).map(({ need }) => {
    const s = shareFor(d, need.key, w);
    const want = s.demand[p.id] || 0, holds = s.stock[p.id] || 0;
    const ins = s.moves.filter((m) => m.to === p);
    const city = (s.unmet.find((u) => u.p === p) || {}).n || 0;
    return { need, want, own: Math.min(holds, want), from: ins, nb: ins.reduce((t, m) => t + m.n, 0), city };
  });
  const lends = NEEDS.map((need) => ({ need, to: shareFor(d, need.key, w).moves.filter((m) => m.from === p) })).filter((x) => x.to.length);
  return { rows, lends };
}
async function renderSend(p) {
  const box = $("#needs-body");
  if (p.score === undefined) { box.innerHTML = `<p class="sm">Not a scored ward, so there's no plan for it.</p>`; lastOutlook = null; return; }
  let basis = sendBasis(), w = demoWeek();
  if (basis === "live") { try { w = await loadLiveWeek(); } catch (e) { basis = "demo"; } }
  if (selected !== p) return;
  const o = basis === "live" ? wardOutlook.live : wardOutlook.demo;
  lastOutlook = o;
  const d = peakDay(p, w), when = dayName(w.dates[d]), risk = dayRisk(p, d, w);
  const plan = wardPlan(p, w, d);
  const name = esc(shortName(p));
  const liveRisk = wardOutlook.live ? wardOutlook.live.risk : null;
  const status = basis === "live" ? urgency(o.risk, o.now, o.firstHw)
    : liveRisk >= 2 ? ["standby", "May 2024 view", `Showing a heat wave like May 2024 instead of this week's forecast: what ${name} would need on its riskiest day (${when} in that heat wave).`]
    : ["standby", "Be ready", `${liveRisk === null ? "" : "No heat-wave risk here this week. "}If a heat wave like May 2024 comes, this is what ${name} needs on its riskiest day (${when} in that heat wave).`];
  const nameList = (ms) => ms.map((m) => `${esc(shortName(m.from))}${ms.length > 1 ? ` (${m.n})` : ""}`).join(", ");
  const cityItems = plan.rows.filter((r) => r.city).map((r) => `${r.city} ${unitName(r.need, r.city)}`);
  box.innerHTML = `<div class="basis segmented small" role="group" aria-label="Plan for">
      <button type="button" data-basis="live" class="${basis === "live" ? "active" : ""}" ${wardOutlook.live ? "" : "disabled"}>This week</button>
      <button type="button" data-basis="demo" class="${basis === "demo" ? "active" : ""}">A May-2024 heat wave</button></div>` +
    urgencyHtml(status) +
    (plan.rows.length
      ? `<table class="send"><tr><th>${esc(when)}</th><th class="n">Need</th><th class="n">In the ward</th><th class="n">From neighbours</th><th class="n">From the city</th></tr>
        ${plan.rows.map((r) => `<tr><td><span class="ic">${r.need.icon}</span>${r.need.short}</td><td class="n">${r.want}</td><td class="n">${r.own}</td><td class="n">${r.nb || "–"}</td><td class="n${r.city ? " city" : ""}">${r.city || "–"}</td></tr>`).join("")}</table>
        ${risk < 2 ? `<p class="sm">${RISK[risk]} that day, so nothing needs to go out yet.</p>` : ""}
        ${plan.rows.some((r) => r.nb) ? `<p class="sm who"><b>From neighbours:</b> ${plan.rows.filter((r) => r.nb).map((r) => `${r.need.short.toLowerCase()} from ${nameList(r.from)}`).join("; ")}.</p>` : ""}
        ${cityItems.length ? `<p class="sm who city"><b>The city must send:</b> ${cityItems.join(", ")}.</p>` : ""}`
      : `<p class="sm">No standout gaps compared with the rest of Delhi, so city-wide heat measures should cover it.</p>`) +
    (plan.lends.length ? `<p class="sm who"><b>${name} lends:</b> ${plan.lends.map((x) => `${x.to.reduce((t, m) => t + m.n, 0)} ${x.need.short.toLowerCase()} to ${x.to.map((m) => esc(shortName(m.to))).join(", ")}`).join("; ")}.</p>` : "") +
    `<div class="send-actions"><button type="button" class="secondary alert-open">Draft a heat alert</button><button type="button" class="secondary plan-copy">Copy this plan</button></div>`;
}
// The plan as plain text, to paste into a message or an email
function wardPlanText(p) {
  const basis = sendBasis(), w = basis === "live" && liveWeekObj ? liveWeekObj : demoWeek();
  const d = peakDay(p, w), plan = wardPlan(p, w, d);
  const lines = [`${p.label}: heat plan for ${dayName(w.dates[d])}${w.key === "demo" ? " (if a heat wave like May 2024 hit)" : ""}`];
  plan.rows.forEach((r) => {
    const parts = [r.own ? `${r.own} in the ward` : "", ...r.from.map((m) => `${m.n} from ${shortName(m.from)}`), r.city ? `${r.city} from the city` : ""].filter(Boolean);
    lines.push(`- ${r.need.short}: need ${r.want}${parts.length ? ` (${parts.join(", ")})` : ""}`);
  });
  plan.lends.forEach((x) => lines.push(`- Lends ${x.to.reduce((t, m) => t + m.n, 0)} ${x.need.short.toLowerCase()} to ${x.to.map((m) => shortName(m.to)).join(", ")}`));
  lines.push("From HeatLens Delhi. Quantities are planning rules of thumb, not official norms.");
  return lines.join("\n");
}
// "Why these resources" (a fold-out): what each one is for and which of the ward's numbers called for it
function renderWhy(p) {
  const list = wardNeeds(p);
  $("#why-body").innerHTML = list.length
    ? list.map(({ need, sev, q }) => `<div class="need">
        <span class="ic">${need.icon}</span><span class="t">${need.title}</span><span class="q">${q.n} ${q.n === 1 ? q.one : q.many}</span>
        <span class="w">${need.what}</span>
        <span class="y">Why: ${esc(need.why(p.facts))} · worst ${Math.max(1, Math.round((1 - sev) * 100))}% of Delhi's wards · ${q.rule}</span>
      </div>`).join("") +
      `<p class="sm note">The number on the right is the plan for a full heat-wave week: a ward at high risk needs all of it on the day, one at medium risk half. Quantities are rules of thumb, not official norms; check them against the Delhi Heat Action Plan and local teams.</p>`
    : `<p class="sm">No standout gaps compared with the rest of Delhi.</p>`;
}

// ---- The overview, part 1: heat danger now (the live forecast for the whole city)
async function renderNowCity() {
  const box = $("#now-city");
  let w;
  try { w = await loadLiveWeek(); }
  catch (e) {
    box.innerHTML = `<div class="flag">Couldn't get this week's forecast (${esc(e.message)}). The May 2024 replay below still works.</div>`;
    cityStatus = "";
    renderHeadline();
    return;
  }
  const days = w.dates.map((date, d) => {
    let lvl = 0, tmax = -Infinity, hi = 0, med = 0, pop = 0;
    Object.values(w.byGrid).forEach((fc) => { const x = fc.days[fc.today + d]; if (x) { lvl = Math.max(lvl, x.level); if (x.tmax != null) tmax = Math.max(tmax, x.tmax); } });
    scored.forEach((p) => { const r = dayRisk(p, d, w); if (r === 3) { hi++; pop += p.facts.total_population || 0; } else if (r === 2) med++; });
    return { date, lvl, tmax, hi, med, pop };
  });
  const lvl = Math.max(...days.map((x) => x.lvl)), peak = Math.max(...days.map((x) => x.tmax));
  const firstHw = days.find((x) => x.lvl >= 2);
  const worst = days.reduce((a, b) => (b.hi > a.hi || (b.hi === a.hi && b.med > a.med) ? b : a));
  const status = firstHw
    ? ["deploy", days[0].lvl >= 2 ? "Heat wave now" : `Heat wave from ${dayName(firstHw.date)}`,
      `${worst.hi} wards at high risk on ${dayName(worst.date)}, home to about ${fmtPeople(worst.pop).replace("M", " million")} people. The plan below is for this week.`]
    : lvl === 1 ? ["ready", "Hot days ahead", `Up to ${num(peak)} °C, but no heat wave is forecast in the next 7 days.`]
    : ["standby", "No heat wave this week", `Highest forecast ${num(peak)} °C anywhere in Delhi. Nothing needs to go out yet.`];
  box.innerHTML = urgencyHtml(status) +
    `<div class="days">${days.map((x, i) => `<div class="day${i === 0 ? " today" : ""}" title="${LEVEL[x.lvl]}${x.hi ? `; ${x.hi} wards at high risk` : ""}">${i === 0 ? "Today" : wkday(x.date)}<b>${num(x.tmax)}°</b><i style="background:${LEVCOL[x.lvl]}"></i></div>`).join("")}</div>
    <p class="sm note">The hottest forecast anywhere in Delhi each day (Open-Meteo), judged by the IMD heat-wave rule.</p>
    <button type="button" class="secondary" data-go="live">Show this week on the map</button>`;
  cityStatus = firstHw ? (days[0].lvl >= 2 ? "heat wave now" : "heat wave from " + dayName(firstHw.date)) : lvl === 1 ? "hot days this week" : "no heat wave this week";
  renderHeadline();
}

// ---- The overview, part 2: if the May 2024 heat wave happened again, and which wards it hits hardest
function renderScenarioCity() {
  const w = demoWeek(), d = worstDay(w), fc = demoForecast();
  const hi = scored.filter((p) => dayRisk(p, d, w) === 3);
  const med = scored.filter((p) => dayRisk(p, d, w) === 2).length;
  const pop = hi.reduce((t, p) => t + (p.facts.total_population || 0), 0);
  const peak = Math.max(...fc.days.map((x) => (x.tmax == null ? -Infinity : x.tmax)));
  const top = hi.slice().sort((a, b) => a.rank - b.rank).slice(0, 6);
  const box = $("#scenario-city");
  box.innerHTML = `<p class="sm">Delhi's temperatures from 22–30 May 2024 (up to ${num(peak, 1)} °C), run through today's ward scores. On the worst day, ${dayName(w.dates[d])}:</p>
    <div class="stat-row"><div><b>${hi.length}</b><span>wards at high risk</span></div><div><b>${fmtPeople(pop)}</b><span>people in them</span></div><div><b>${med}</b><span>more at medium risk</span></div></div>
    <h3>Most under threat</h3>
    <ul class="plan-list">${top.map((p) => `<li tabindex="0" data-id="${esc(p.id)}">${rankPill(p)}<b>${esc(shortName(p))}</b><small>${fmtPeople(p.facts.total_population || 0)} people</small>
      <span class="chips">${wardNeeds(p).slice(0, 3).map((x) => `<i>${x.need.short}</i>`).join("")}</span></li>`).join("")}</ul>
    <button type="button" class="secondary" data-go="demo">Replay it on the map</button>`;
  bindWardList(box);
}

// ---- The overview, part 3: what to send where. For this week if the live forecast brings heat-wave risk,
//      otherwise for a May-2024-type heat wave (switchable), on that week's worst day.
let planBasis = null; // "live" | "demo" when chosen with the switch; null = pick automatically
async function renderPlan() {
  const box = $("#plan");
  let live = null;
  try { live = await loadLiveWeek(); } catch (e) { live = null; }
  const basis = planBasis === "demo" || (planBasis === "live" && live) ? planBasis : live && anyHeat(live) ? "live" : "demo";
  const w = basis === "live" ? live : demoWeek(), d = worstDay(w), when = dayName(w.dates[d]);
  const rows = NEEDS.map((n) => {
    const s = shareFor(d, n.key, w);
    const want = scored.reduce((t, p) => t + (s.demand[p.id] || 0), 0);
    const city = s.unmet.reduce((t, u) => t + u.n, 0);
    return { n, want, nb: s.covered, city, own: want - s.covered - city };
  });
  // the wards the city has to send to: whatever is still short after the neighbours have helped
  const byWard = new Map();
  NEEDS.forEach((n) => shareFor(d, n.key, w).unmet.forEach((u) => {
    if (!byWard.has(u.p)) byWard.set(u.p, []);
    byWard.get(u.p).push([n, u.n]);
  }));
  const cityList = [...byWard.entries()].map(([p, items]) => ({ p, items, total: items.reduce((t, x) => t + x[1], 0) }))
    .sort((a, b) => b.total - a.total || a.p.rank - b.p.rank);
  const any = rows.some((r) => r.want);
  box.dataset.shows = basis; // which week the plan on screen is for, and its day (the downloads follow it)
  box.dataset.day = d;
  box.innerHTML = `<div class="basis segmented small" role="group" aria-label="Plan for">
      <button type="button" data-basis="live" class="${basis === "live" ? "active" : ""}" ${live ? "" : "disabled"}>This week</button>
      <button type="button" data-basis="demo" class="${basis === "demo" ? "active" : ""}">A May-2024 heat wave</button></div>
    <p class="sm">${basis === "live" ? (any ? `This week's forecast, on its worst day (${when}).` : "This week's forecast brings no heat-wave risk, so nothing needs to go out.")
      : `If a heat wave like May 2024 hit: its worst day (${when}).`}</p>
    ${any ? `<table class="send"><tr><th>Resource</th><th class="n">Need</th><th class="n">In the wards</th><th class="n">From neighbours</th><th class="n">From the city</th></tr>
      ${rows.map((r) => `<tr><td><span class="ic">${r.n.icon}</span>${r.n.short}</td><td class="n">${count(r.want)}</td><td class="n">${count(r.own)}</td><td class="n">${count(r.nb)}</td><td class="n${r.city ? " city" : ""}">${count(r.city)}</td></tr>`).join("")}</table>
    ${cityList.length ? `<h3>Send city help here first</h3>
    <ul class="plan-list">${cityList.slice(0, 8).map(({ p, items }) => `<li tabindex="0" data-id="${esc(p.id)}">${rankPill(p)}<b>${esc(shortName(p))}</b>
      <span class="chips">${items.map(([n, k]) => `<i>${k} ${unitName(n, k)}</i>`).join("")}</span></li>`).join("")}</ul>
    ${cityList.length > 8 ? `<p class="sm">…and ${cityList.length - 8} more wards: every one is in the download.</p>` : ""}` : `<p class="sm">Neighbours can cover every shortfall, so the city doesn't need to send anything.</p>`}` : ""}
    <div class="downloads">
      <button type="button" class="secondary" data-dl="plan">Download the plan (spreadsheet)</button>
      <button type="button" class="secondary" data-dl="moves">Download every move</button>
    </div>
    <p class="sm note">Assumes each ward holds a population share of the city's stock of each resource: a placeholder until real stock levels are added.</p>`;
  bindWardList(box);
}


// ---------- 7c. THIS WEEK, AND NEIGHBOURS SHARING ------------------------
// "This week" colours each ward by its risk on the chosen day: that day's forecast heat level combined
// with the ward's vulnerability, by the same rule as the ward page.
// "Neighbours sharing" is a simple self-help model. Every ward holds a share of the city's stock of each
// resource in proportion to its population (the city's stock = what all wards would need in a full heat
// wave). On a given day, high-risk wards need their full planning quantity and medium-risk wards half.
// Wards with stock to spare lend to the wards next door that are short, most urgent first; if that isn't
// enough, the ward beyond helps; whatever is left is flagged for the city to send.
function gridKey(lat, lon) {
  return (Math.round(lat * 10) / 10).toFixed(1) + "," + (Math.round(lon * 10) / 10).toFixed(1);
}
places.forEach((p) => { p.grid = gridKey(p.lat, p.lon); });
const shortName = (p) => p.label.replace(/ \(Ward \d+\)$/, "");
const dayWord = (d) => (d === 0 ? "today" : week ? "on " + dayName(week.dates[d]) : "");

// Two weeks of heat are kept side by side: the live 7-day forecast for every ward, and the May 2024
// heat wave replayed as if 24 May were today. The map shows one of them (the switch under "Heat by day");
// the overview and each ward page show both.
// The replay: one Delhi series of observed temperatures, used for every ward (built once, never changes)
let demoWeekObj = null;
function demoWeek() {
  if (!demoWeekObj) {
    const ref = demoForecast();
    const byGrid = {};
    places.forEach((p) => { byGrid[p.grid] = ref; });
    demoWeekObj = { key: "demo", at: 0, byGrid, dates: ref.days.slice(ref.today, ref.today + 7).map((d) => d.date) };
  }
  return demoWeekObj;
}
// The live forecast for every ward: one request covers all the grid points Delhi's wards sit on
let liveWeekObj = null, liveLoading = null;
async function loadLiveWeek() {
  if (liveWeekObj && Date.now() - liveWeekObj.at < FORECAST_TTL_MS) return liveWeekObj;
  if (liveLoading) return liveLoading;
  liveLoading = (async () => {
    const byGrid = {};
    const keys = [...new Set(places.map((p) => p.grid))];
    const url = "https://api.open-meteo.com/v1/forecast?latitude=" + keys.map((k) => k.split(",")[0]).join(",") +
      "&longitude=" + keys.map((k) => k.split(",")[1]).join(",") +
      "&daily=temperature_2m_max,temperature_2m_min,apparent_temperature_max&timezone=Asia%2FKolkata&past_days=2&forecast_days=7";
    const res = await fetch(url);
    if (!res.ok) throw new Error("forecast service answered " + res.status);
    let data = await res.json();
    if (!Array.isArray(data)) data = [data];
    const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    keys.forEach((k, i) => {
      const j = data[i].daily;
      const days = j.time.map((t, n) => ({ date: t, tmax: j.temperature_2m_max[n], tmin: j.temperature_2m_min[n], app: j.apparent_temperature_max[n] }));
      const idx = j.time.indexOf(todayStr);
      const value = { days: classify(days), today: idx >= 0 ? idx : 2, src: "Forecast: Open-Meteo, fetched " + new Date().toLocaleTimeString() + "." };
      byGrid[k] = value;
      fcCache[k] = { at: Date.now(), value }; // the ward pages reuse these
    });
    const ref = byGrid[keys[0]];
    liveWeekObj = { key: "live", at: Date.now(), byGrid, dates: ref.days.slice(ref.today, ref.today + 7).map((d) => d.date) };
    return liveWeekObj;
  })();
  try { return await liveLoading; } finally { liveLoading = null; }
}
// The week the map shows
async function loadWeek() {
  week = $("#demo").checked ? demoWeek() : await loadLiveWeek();
  return week;
}
function dayLevel(p, d, w = week) {
  const fc = w && w.byGrid[p.grid];
  const day = fc && fc.days[fc.today + d];
  return day ? day.level : 0;
}
function dayRisk(p, d, w = week) { return MATRIX[dayLevel(p, d, w)][tier(p.cls)]; }
// The day of a week with the most wards at high risk (the first, if several tie)
function worstDay(w) {
  let best = 0, most = -1;
  for (let d = 0; d < 7; d++) {
    const k = scored.filter((p) => dayRisk(p, d, w) === 3).length;
    if (k > most) { most = k; best = d; }
  }
  return best;
}
// A ward's own riskiest day of a week (the first, if several tie)
function peakDay(p, w) {
  let peak = 0;
  for (let d = 1; d < 7; d++) if (dayRisk(p, d, w) > dayRisk(p, peak, w)) peak = d;
  return peak;
}
const anyHeat = (w) => scored.some((p) => [0, 1, 2, 3, 4, 5, 6].some((d) => dayRisk(p, d, w) >= 2));

// ---- the sharing model
const QTY = Object.fromEntries(scored.map((p) => [p.id, Object.fromEntries(wardNeeds(p).map((x) => [x.need.key, x.q.n]))]));
const POP_TOTAL = scored.reduce((t, p) => t + (p.facts.total_population || 0), 0);
const STOCK = {}; // resource -> ward id -> units it holds (its population share of the city's stock)
NEEDS.forEach((n) => {
  const total = scored.reduce((t, p) => t + (QTY[p.id][n.key] || 0), 0);
  const parts = scored.map((p) => { const v = total * (p.facts.total_population || 0) / POP_TOTAL; return { id: p.id, n: Math.floor(v), rest: v - Math.floor(v) }; });
  let left = total - parts.reduce((t, x) => t + x.n, 0);
  parts.slice().sort((a, b) => b.rest - a.rest).forEach((x) => { if (left > 0) { x.n++; left--; } }); // whole units, same total
  STOCK[n.key] = Object.fromEntries(parts.map((x) => [x.id, x.n]));
});
const gap2 = (a, b) => ((a.lon - b.lon) * 0.878) ** 2 + (a.lat - b.lat) ** 2;
const shareCache = new Map();
function shareFor(d, res, w = week) {
  const key = w.key + "|" + w.at + "|" + d + "|" + res;
  if (shareCache.has(key)) return shareCache.get(key);
  const stock = STOCK[res], demand = {}, spare = {}, short = {};
  scored.forEach((p) => {
    const r = dayRisk(p, d, w), q = QTY[p.id][res] || 0;
    demand[p.id] = r >= 3 ? q : r === 2 ? Math.ceil(q / 2) : 0;
    spare[p.id] = Math.max(0, (stock[p.id] || 0) - demand[p.id]);
    short[p.id] = Math.max(0, demand[p.id] - (stock[p.id] || 0));
  });
  const order = scored.filter((p) => short[p.id] > 0).sort((a, b) => (dayRisk(b, d, w) - dayRisk(a, d, w)) || (short[b.id] - short[a.id]));
  const totalShort = order.reduce((t, p) => t + short[p.id], 0);
  const moves = [];
  const take = (to, donors, hops) => {
    for (const from of donors) {
      if (!short[to.id]) break;
      const n = Math.min(spare[from.id], short[to.id]);
      if (n > 0) { spare[from.id] -= n; short[to.id] -= n; moves.push({ from, to, n, hops }); }
    }
  };
  // first the wards next door (the one with most to spare first), then the wards one further out (nearest first)
  order.forEach((to) => take(to, to.nb.map((id) => byId[id]).filter((q) => q && spare[q.id] > 0).sort((a, b) => spare[b.id] - spare[a.id]), 1));
  order.forEach((to) => {
    if (!short[to.id]) return;
    const near = new Set(to.nb);
    const ring2 = [...new Set(to.nb.flatMap((id) => (byId[id] ? byId[id].nb : [])))].filter((id) => id !== to.id && !near.has(id))
      .map((id) => byId[id]).filter((q) => q && spare[q.id] > 0).sort((a, b) => gap2(to, a) - gap2(to, b));
    take(to, ring2, 2);
  });
  const unmet = order.filter((p) => short[p.id] > 0).map((p) => ({ p, n: short[p.id] }));
  const result = { moves, totalShort, covered: totalShort - unmet.reduce((t, u) => t + u.n, 0), unmet, shortWards: order.length, demand, stock };
  shareCache.set(key, result);
  return result;
}

// ---- drawing the sharing on the map
function arc(a, b) { // a gentle curve, bent to one side, so two-way moves don't sit on top of each other
  const kx = 0.878, ax = a.lon * kx, ay = a.lat, bx = b.lon * kx, by = b.lat;
  const cx = (ax + bx) / 2 - (by - ay) * 0.18, cy = (ay + by) / 2 + (bx - ax) * 0.18;
  const pts = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16, u = 1 - t;
    pts.push([(u * u * ax + 2 * u * t * cx + t * t * bx) / kx, u * u * ay + 2 * u * t * cy + t * t * by]);
  }
  return pts;
}
const DASH = [[0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
  [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5]];
let dashTimer = null, dashStep = 0, unmetShown = new Set();
function drawFlows() {
  whenReady(() => {
    const on = mapMode === "week" && week && $("#share-on").checked;
    const s = on ? shareFor(weekDay, $("#share-res").value) : null;
    map.getSource("flows").setData({ type: "FeatureCollection", features: s ? s.moves.map((m) => ({
      type: "Feature", properties: { n: m.n, hops: m.hops }, geometry: { type: "LineString", coordinates: arc(m.from, m.to) },
    })) : [] });
    const now = new Set(s ? s.unmet.map((u) => places.indexOf(u.p)) : []);
    unmetShown.forEach((id) => { if (!now.has(id)) map.setFeatureState({ source: "wards", id }, { unmet: false }); });
    now.forEach((id) => map.setFeatureState({ source: "wards", id }, { unmet: true }));
    unmetShown = now;
    // the key on the map says which supplies the arrows carry
    const key = $("#flow-key"), need = NEEDS.find((n) => n.key === $("#share-res").value);
    key.classList.toggle("hidden", !(s && (s.moves.length || s.unmet.length)));
    if (s) key.innerHTML = (s.moves.length ? `<span><i class="key-arrow"></i>${need.short} lent by a neighbouring ward</span>` : "") +
      (s.unmet.length ? `<span><i class="key-unmet"></i>Still short of ${inSentence(need)}: the city sends the rest</span>` : "");
    clearInterval(dashTimer);
    dashTimer = null;
    if (s && s.moves.length && !calm) { // the dashes march from the lender to the ward that needs it
      dashTimer = setInterval(() => { dashStep = (dashStep + 1) % DASH.length; map.setPaintProperty("flow-line", "line-dasharray", DASH[dashStep]); }, 65);
    }
  });
}

// ---- the side panel for the week view
const maxLevel = (d) => Math.max(...places.map((p) => dayLevel(p, d)));
function renderTicks() {
  $("#day-ticks").innerHTML = week.dates.map((dt, i) =>
    `<button type="button" data-d="${i}" class="${i === weekDay ? "on" : ""}">${i === 0 ? "Today" : wkday(dt)}<i style="background:${LEVCOL[maxLevel(i)]}"></i></button>`).join("");
}
function renderWeekSummary() {
  const counts = [0, 0, 0, 0];
  let popHigh = 0;
  scored.forEach((p) => { const r = dayRisk(p, weekDay); counts[r]++; if (r === 3) popHigh += p.facts.total_population || 0; });
  const people = popHigh >= 1e6 ? (popHigh / 1e6).toFixed(1) + " million" : count(popHigh);
  const lv = maxLevel(weekDay);
  $("#week-summary").innerHTML = `<b>${weekDay === 0 ? "Today" : dayName(week.dates[weekDay])}</b>: ` + (counts[3] + counts[2]
    ? `${counts[3]} wards at high risk${counts[3] ? ` (about ${people} people)` : ""}, ${counts[2]} at medium risk. Worst conditions: ${LEVEL[lv]}.`
    : `no ward reaches medium or high risk. Worst conditions: ${LEVEL[lv]}.`);
}
function renderShare() {
  const box = $("#share-summary");
  if (mapMode !== "week" || !week || !$("#share-on").checked) { box.innerHTML = ""; return; }
  const need = NEEDS.find((n) => n.key === $("#share-res").value);
  const s = shareFor(weekDay, need.key);
  const when = weekDay === 0 ? "Today" : dayName(week.dates[weekDay]);
  if (!s.shortWards) { box.innerHTML = `<p class="sm">${when}: no ward is short of ${need.short.toLowerCase()}, so nothing needs to move.</p>`; return; }
  const top = s.moves.slice().sort((a, b) => b.n - a.n).slice(0, 6);
  const left = s.totalShort - s.covered;
  box.innerHTML = `<div class="share-stats">
      <div><b>${s.shortWards}</b><span>wards short</span></div>
      <div><b>${Math.round(100 * s.covered / s.totalShort)}%</b><span>covered by neighbours</span></div>
      <div><b>${s.unmet.length}</b><span>still need city help</span></div></div>
    <p class="sm">${when}: wards are short by ${count(s.totalShort)} ${need.short.toLowerCase()}. Neighbours lend ${count(s.covered)}${left ? `; ${count(left)} more are needed from the city in ${s.unmet.length} ward${s.unmet.length === 1 ? "" : "s"}` : ", so the city can cover itself"}.</p>
    ${top.length ? `<h3>Biggest moves</h3><ul class="moves">${top.map((m) => `<li tabindex="0" data-id="${esc(m.to.id)}"><span>${esc(shortName(m.from))} → <b>${esc(shortName(m.to))}</b>${m.hops === 2 ? ' <small>(one ward over)</small>' : ""}</span><b>${m.n}</b></li>`).join("")}</ul>` : ""}`;
  box.querySelectorAll(".moves li").forEach((li) => {
    const go = () => openWard(byId[li.dataset.id]);
    li.addEventListener("click", go);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}
// Week colours: set or clear each ward's day risk on the map (flat wards and 3D towers)
function applyWeekColours() {
  const r = (p) => ({ r: p.score === undefined ? null : dayRisk(p, weekDay) });
  setAllStates("wards", r);
  setAllStates("wards3d", r);
}
function clearWeekColours() {
  setAllStates("wards", () => ({ r: null }));
  setAllStates("wards3d", () => ({ r: null }));
}
function setDay(d) {
  weekDay = d;
  $("#day").value = d;
  $("#day-ticks").querySelectorAll("button").forEach((b, i) => b.classList.toggle("on", i === d));
  applyWeekColours();
  renderLegend();
  renderWeekSummary();
  drawFlows();
  renderShare();
  if (is3D) apply3DHeights();
  renderHeadline();
}
let playTimer = null;
function stopPlay() {
  clearInterval(playTimer);
  playTimer = null;
  $("#day-play").textContent = "▶";
  $("#day-play").setAttribute("aria-label", "Play through the week");
}
async function setMode(mode) {
  mapMode = mode;
  document.querySelectorAll("#mode button").forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  $("#vuln-controls").classList.toggle("hidden", mode !== "vuln");
  $("#week-controls").classList.toggle("hidden", mode !== "week");
  $("#map-note").classList.toggle("hidden", mode !== "vuln");
  if (mode !== "week") { stopPlay(); clearWeekColours(); refreshFill(); renderLegend(); drawFlows(); if (is3D) apply3DHeights(); renderHeadline(); return; }
  $("#week-summary").textContent = "Getting the forecast for every ward…";
  try { await loadWeek(); }
  catch (e) { $("#week-summary").textContent = `Couldn't get the forecast (${e.message}). Switch to "May 2024 replay" to see how this works.`; return; }
  refreshFill();
  if (mapMode !== "week") return;
  renderTicks();
  setDay(Math.min(weekDay, 6));
}



// ---------- 7d. HEADLINE NUMBERS, 3D VIEW, THE STORY, ALERTS, DOWNLOADS ---------------
// ---- Headline numbers over the map. They count up to their new value whenever it changes.
const fmtPeople = (v) => (v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? Math.round(v / 1e3) + "k" : String(Math.round(v)));
const fmtInt = (v) => String(Math.round(v));
const fmtPct = (v) => Math.round(v) + "%";
let cityStatus = "";
// The band starts folded into a small pill showing just its first number; the button (or a click on the
// pill) opens it, and the button folds it away again. The story opens it while it plays.
let headMin = true;
const CHEVRON = (up) => `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${up ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"}"/></svg>`;
function setHeadMin(m) {
  headMin = m;
  const box = $("#headline");
  box.classList.toggle("min", m);
  box.title = m ? "Show the key numbers" : "";
  const t = box.querySelector(".h-toggle");
  if (t) {
    t.innerHTML = CHEVRON(!m);
    t.setAttribute("aria-expanded", String(!m));
    t.setAttribute("aria-label", m ? "Show the key numbers" : "Fold the key numbers away");
  }
}
$("#headline").addEventListener("click", (e) => { if (headMin || e.target.closest(".h-toggle")) setHeadMin(!headMin); });
function tween(el, to, fmt) {
  const from = el.dataset.v === undefined ? 0 : +el.dataset.v;
  el.dataset.v = to;
  if (calm || from === to) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 750;
  const step = (t) => {
    if (+el.dataset.v !== to) return; // a newer value has taken over
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function renderHeadline() {
  const box = $("#headline");
  const inWeek = mapMode === "week" && week;
  let title, note, stats;
  if (inWeek) {
    const counts = [0, 0, 0, 0];
    let popHigh = 0;
    scored.forEach((p) => { const r = dayRisk(p, weekDay); counts[r]++; if (r === 3) popHigh += p.facts.total_population || 0; });
    const need = NEEDS.find((n) => n.key === $("#share-res").value);
    const sh = shareFor(weekDay, need.key);
    title = weekDay === 0 ? "Today" : dayName(week.dates[weekDay]);
    note = is3D ? "height = crowding × heat risk" : $("#demo").checked ? "May 2024 replay" : "this week";
    stats = [
      ["pop", popHigh, fmtPeople, "people at high risk"],
      ["wards", counts[3], fmtInt, "wards at high risk"],
      ["cover", sh.totalShort ? (100 * sh.covered) / sh.totalShort : 100, fmtPct,
        sh.totalShort ? `of the shortfall in ${inSentence(need)} covered by neighbours` : `no shortfall in ${inSentence(need)}`],
      ["city", sh.unmet.length, fmtInt, "wards need city help"],
    ];
  } else {
    const top = scored.filter((p) => p.cls === "Extreme" || p.cls === "Very High");
    title = "Delhi";
    note = is3D ? "height = crowding × vulnerability" : cityStatus || "who is vulnerable";
    stats = [
      ["vh", top.length, fmtInt, "wards rated Very High or Extreme"],
      ["vhpop", top.reduce((t, p) => t + (p.facts.total_population || 0), 0), fmtPeople, "people live in them"],
      ["areas", scored.length, fmtInt, "wards and areas scored"],
    ];
  }
  const sig = (inWeek ? "w:" : "v:") + stats.map((x) => x[0]).join();
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    box.innerHTML = `<div class="h-title"><small></small><span></span></div>` +
      stats.map(([k]) => `<div class="hstat" data-k="${k}"><b>0</b><span></span></div>`).join("") +
      `<button type="button" class="h-toggle"></button>`;
    setHeadMin(headMin);
  }
  box.querySelector(".h-title span").textContent = title;
  box.querySelector(".h-title small").textContent = note;
  stats.forEach(([k, v, fmt, label]) => {
    const el = box.querySelector(`.hstat[data-k="${k}"]`);
    tween(el.querySelector("b"), v, fmt);
    el.querySelector("span").textContent = label;
  });
}

// ---- 3D view: tilt the map and raise each ward. Height = how crowded the ward is (people per km²) times
//      its heat risk that day (this week's view) or its vulnerability score. Crowded, high-risk wards rise
//      as towers while the spread-out outer wards stay low, so the tallest pack the most people into the danger.
let is3D = false;
const RISK_RISE = [0.03, 0.12, 0.45, 1]; // no / low / medium / high heat risk
function heightFor(p) {
  const crowd = 0.12 * ((p.facts && p.facts.pop_density) || 0); // metres (exaggerated): about 9 km for the most crowded ward (77,000 per km²)
  if (mapMode === "week" && week) return crowd * RISK_RISE[dayRisk(p, weekDay)];
  return crowd * (p.score / 100);
}
// In a tilted view the far-off imagery tiles slip out past the grey mask, and the raised wards cover the
// imagery inside Delhi anyway, so the 3D view hides it
const showImagery = (on) => ["sat", "labels"].forEach((id) => map.setLayoutProperty(id, "visibility", on ? "visible" : "none"));
function apply3DHeights() {
  setAllStates("wards3d", (p) => ({ h: p.score === undefined ? 0 : heightFor(p) }));
}
// Switching 3D on sets every height once, fades the towers in and tilts the camera: tilting up is what
// makes the wards rise, and the camera moving is all the work each frame does (nothing is rebuilt).
// Switching off fades them out as the camera flattens. The hatched mask fades out while tilted.
let fade3DTimer = null;
function set3D(on) {
  if (on === is3D) return;
  is3D = on;
  const b = document.querySelector(".td-btn");
  if (b) b.setAttribute("aria-pressed", String(on));
  whenReady(() => {
    clearTimeout(fade3DTimer);
    if (on) {
      apply3DHeights();
      showImagery(false);
      map.setPaintProperty("outside", "fill-opacity", 0);
      map.setPaintProperty("ward-fill", "fill-opacity", 0.22);
      map.setPaintProperty("ward-3d", "fill-extrusion-opacity", 1);
      map.easeTo({ pitch: 55, bearing: -20, zoom: Math.min(map.getZoom(), 12.2), duration: calm ? 0 : 1600 });
    } else {
      map.setPaintProperty("ward-3d", "fill-extrusion-opacity", 0);
      map.setPaintProperty("ward-fill", "fill-opacity", 0.82);
      map.easeTo({ pitch: 0, bearing: 0, duration: calm ? 0 : 1000 });
      fade3DTimer = setTimeout(() => {
        if (is3D) return;
        showImagery(true);
        map.setPaintProperty("outside", "fill-opacity", 1);
      }, calm ? 0 : 950);
    }
  });
  renderHeadline();
}
// The 3D view is a city overview: zooming right in drops back to the flat map
map.on("zoomend", () => { if (is3D && map.getZoom() > 12.4) set3D(false); });

// ---- The story: about a minute that plays the May 2024 heat wave and shows off each part of HeatLens.
let storyRun = 0, storyHeadWas = null;
const inSentence = (need) => (need.key === "ors" ? need.short : need.short.toLowerCase());
const listJoin = (a) => (a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]);
// put the key numbers back the way they were before the story opened them
function restoreHead() {
  if (storyHeadWas !== null) setHeadMin(storyHeadWas);
  storyHeadWas = null;
}
function stopStory() {
  storyRun++;
  stopPlay();
  $("#story").classList.add("hidden");
  document.body.classList.remove("story-on");
  closeAlert();
  restoreHead();
}
async function playStory() {
  const run = ++storyRun;
  const alive = () => run === storyRun;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const box = $("#story"), text = box.querySelector(".story-text"), bar = box.querySelector(".story-bar i");
  const STEPS = 13; // one per caption
  let n = 0;
  const say = async (t, ms) => {
    if (!alive()) throw "stopped";
    text.classList.remove("in");
    void text.offsetWidth; // restart the fade
    text.textContent = t;
    text.classList.add("in");
    bar.style.width = (100 * ++n) / STEPS + "%";
    await wait(ms);
    if (!alive()) throw "stopped";
  };
  bar.style.width = "0%";
  box.classList.remove("hidden");
  document.body.classList.add("story-on");
  if (storyHeadWas === null) storyHeadWas = headMin;
  setHeadMin(false); // the numbers count up as the story plays
  try {
    stopPlay();
    closeAlert();
    if (selected) closeWard();
    set3D(false);
    if ($("#share-on").checked) { $("#share-on").checked = false; $("#share-on").dispatchEvent(new Event("change")); }
    if (!$("#demo").checked) { $("#demo").checked = true; $("#demo").dispatchEvent(new Event("change")); }
    if (!panelOpen()) setPanel(true, false);
    await setMode("vuln");
    whenReady(() => map.fitBounds(DELHI_VIEW, { padding: fitPad(), duration: calm ? 0 : 1200 }));
    const popAll = scored.reduce((t, p) => t + (p.facts.total_population || 0), 0); // same population source as every other number
    await say(`Delhi, May 2024. About ${fmtPeople(popAll).replace("M", " million")} people live in its 250 wards, plus NDMC and the Cantonment.`, 4500);
    await say("Heat doesn't hit everyone equally. The darker the ward, the more exposed it is: crowded, hot, few trees, little clean water, far from a hospital.", 6500);
    await setMode("week");
    setDay(0);
    await say(`${dayName(week.dates[0])}: the forecast is hot, but it isn't a heat wave yet.`, 4000);
    setDay(1);
    await say(`${dayName(week.dates[1])}: the heat keeps building.`, 2800);
    setDay(2);
    const high2 = scored.filter((p) => dayRisk(p, 2) === 3).length;
    await say(`${dayName(week.dates[2])}: a heat wave arrives. ${high2} wards turn high risk.`, 4200);
    setDay(3);
    const pop3 = scored.filter((p) => dayRisk(p, 3) === 3).reduce((t, p) => t + (p.facts.total_population || 0), 0);
    await say(`About ${fmtPeople(pop3).replace("M", " million")} people are now at high risk.`, 3800);
    set3D(true);
    await say("In 3D, each ward rises by how crowded it is and how much danger it faces.", 3000);
    whenReady(() => map.easeTo({ bearing: -70, duration: calm ? 0 : 5200, easing: (t) => t }));
    await say("The tallest wards pack the most people into the heat. Help sent there reaches the most people.", 4800);
    set3D(false);
    await wait(900);
    const worst = scored.slice().sort((a, b) => a.rank - b.rank)[0];
    openWard(worst);
    const needs = wardNeeds(worst).map((x) => inSentence(x.need));
    await say(`${shortName(worst)} is Delhi's most vulnerable ward. HeatLens lists exactly what to send there: ${listJoin(needs)}.`, 7000);
    closeWard();
    await wait(700);
    $("#share-on").checked = true;
    $("#share-on").dispatchEvent(new Event("change"));
    const sh = shareFor(weekDay, $("#share-res").value);
    await say(`Neighbours help first: wards with cooling shelters to spare lend them to the wards next door, covering ${Math.round((100 * sh.covered) / sh.totalShort)}% of the shortfall.`, 6200);
    await say(`The ${sh.unmet.length} wards outlined in red still need ${sh.totalShort - sh.covered} more shelters, so that's where the city should send them first.`, 6000);
    openWard(worst);
    await wait(1700);
    if (alive() && lastOutlook && lastOutlook.w === worst) openAlert();
    await say("Every ward also gets a ready-to-send alert in English and Hindi, and the whole plan downloads as a spreadsheet.", 5500);
    closeAlert();
    closeWard();
    await say("HeatLens: see the heat coming, and send help where it's needed.", 5200);
  } catch (e) {
    if (e !== "stopped") throw e;
  } finally {
    if (run === storyRun) {
      box.classList.add("hidden");
      document.body.classList.remove("story-on");
      restoreHead();
    }
  }
}

// ---- Ready-to-send alert, in English or Hindi, built from the ward's own forecast
let lastOutlook = null, alertLang = "en";
const hiDay = (s) => new Date(s + "T00:00:00Z").toLocaleDateString("hi-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
function alertText(lang, o) {
  const w = o.w, hi = lang === "hi";
  const no = /^\d+$/.test(w.id) ? w.id : "";
  const name = shortName(w);
  const t = num(o.peak);
  const where = hi ? `${name}${no ? ` (वार्ड ${no})` : ""}, दिल्ली` : `${name}${no ? ` (Ward ${no})` : ""}, Delhi`;
  // English says "degrees C" rather than "°C": the degree sign isn't in the plain SMS alphabet and would
  // turn the whole message into Unicode, which nearly halves the characters per SMS
  const status = o.now && o.now.hw
    ? (hi ? `लू चल रही है (तापमान ${t}°C तक)।` : `A heat wave is under way (up to ${t} degrees C).`)
    : o.firstHw
      ? (hi ? `${hiDay(o.firstHw.date)} से लू चलने की आशंका है (तापमान ${t}°C तक)।` : `Heat wave expected from ${dayName(o.firstHw.date)} (up to ${t} degrees C).`)
      : o.lvl === 1
        ? (hi ? `आने वाले दिनों में तेज़ गर्मी रहेगी (तापमान ${t}°C तक)।` : `Very hot days ahead (up to ${t} degrees C).`)
        : (hi ? `इस सप्ताह लू की आशंका नहीं है (तापमान ${t}°C तक)।` : `No heat wave expected this week (up to ${t} degrees C).`);
  const advice = {
    en: ["Drink water regularly.",
      "Drink water regularly and avoid hard work outdoors in the afternoon.",
      "Stay indoors 12-4 pm where you can, drink water often, and check on elderly neighbours and young children.",
      "Avoid going out 12-4 pm, drink water often even if not thirsty, and check on elderly people, children and outdoor workers."],
    hi: ["नियमित रूप से पानी पिएं।",
      "नियमित रूप से पानी पिएं और दोपहर में बाहर भारी काम से बचें।",
      "हो सके तो दोपहर 12 से 4 बजे तक घर के अंदर रहें, बार-बार पानी पिएं, और बुज़ुर्ग पड़ोसियों व छोटे बच्चों का ध्यान रखें।",
      "दोपहर 12 से 4 बजे तक बाहर न निकलें, प्यास न लगे तब भी बार-बार पानी पिएं, और बुज़ुर्गों, बच्चों व बाहर काम करने वालों का ध्यान रखें।"],
  }[lang][o.risk];
  const urgent = o.risk >= 2;
  const lines = [
    (hi ? "लू अलर्ट - " : "HEAT ALERT - ") + where,
    status,
    advice,
    urgent ? (hi ? "नज़दीकी ठंडी जगह और मुफ़्त पीने का पानी: [स्थान लिखें]" : "Nearest cool shelter and free drinking water: [add location]") : "",
    urgent ? (hi ? "लू लगना आपात स्थिति है: 112 पर कॉल करें।" : "Heat stroke is an emergency: call 112.") : "",
    hi ? "- HeatLens दिल्ली" : "- HeatLens Delhi",
  ];
  return lines.filter(Boolean).join("\n");
}
function smsInfo(t) {
  // plain SMS (GSM-7) alphabet; [ ] { } \ ~ ^ | € are in its extension table and take two places each
  const gsm = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅå_ÆæßÉ!"#%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà[\]{}\\~^|€]*$/.test(t);
  const chars = [...t];
  const len = gsm ? chars.reduce((n, c) => n + ("[]{}\\~^|€".includes(c) ? 2 : 1), 0) : chars.length;
  const single = gsm ? 160 : 70, part = gsm ? 153 : 67;
  const parts = len <= single ? 1 : Math.ceil(len / part);
  return `${chars.length} characters · ${parts} SMS${gsm ? "" : " (Unicode)"} · no limit on WhatsApp`;
}
function updateAlertLinks() {
  const t = $("#alert-text").value;
  $("#alert-count").textContent = smsInfo(t);
  $("#alert-wa").href = "https://wa.me/?text=" + encodeURIComponent(t);
  $("#alert-sms").href = "sms:?&body=" + encodeURIComponent(t);
}
function fillAlert() {
  if (!lastOutlook) return;
  document.querySelectorAll("#alert-lang button").forEach((b) => b.classList.toggle("active", b.dataset.lang === alertLang));
  const ta = $("#alert-text");
  ta.lang = alertLang;
  ta.value = alertText(alertLang, lastOutlook);
  updateAlertLinks();
}
function openAlert() {
  if (!lastOutlook) return;
  $("#alert-title").textContent = `Heat alert for ${lastOutlook.w.label}`;
  $("#alert-basis").textContent = lastOutlook === wardOutlook.demo
    ? (wardOutlook.live && wardOutlook.live.lvl >= 2
      ? "An example using the May 2024 heat wave. Switch the plan to \"This week\" for an alert from the live forecast."
      : "An example using the May 2024 heat wave, since none is forecast this week. When one is, the dates and temperatures come from the live forecast.")
    : "Written from this week's live forecast for the ward.";
  fillAlert();
  const dlg = $("#alert-dialog");
  if (!dlg.open) dlg.showModal();
}
function closeAlert() {
  const dlg = $("#alert-dialog");
  if (dlg.open) dlg.close();
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; }
  catch (e) {
    const ta = $("#alert-text");
    ta.focus(); ta.select();
    try { return document.execCommand("copy"); } catch (e2) { return false; }
  }
}

// ---- Download the plan: spreadsheets (CSV, opens in Excel or Google Sheets) for the chosen day
const csvCell = (v) => { const t = v == null ? "" : String(v); return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
function saveCsv(name, rows) {
  const text = "\ufeff" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n"); // the mark at the start makes Excel read it as UTF-8
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
async function planDay() {
  await loadWeek();
  if (mapMode === "week") return weekDay;
  let best = 0, most = -1;
  for (let d = 0; d < 7; d++) {
    const k = scored.filter((p) => dayRisk(p, d) === 3).length;
    if (k > most) { most = k; best = d; }
  }
  return best;
}
// Which week and day a download is for: the one the overview's plan shows, or else the map's
async function planTarget(w, d) {
  if (w) return [w, d];
  const day = await planDay();
  return [week, day];
}
async function downloadPlan(w0, d0) {
  const [w, d] = await planTarget(w0, d0), date = w.dates[d];
  const shares = Object.fromEntries(NEEDS.map((n) => [n.key, shareFor(d, n.key, w)]));
  const head = ["Rank", "Ward", "Ward no.", "Area", "Assembly constituency", "Vulnerability", "Score", `Heat risk on ${date}${w.key === "demo" ? " (May 2024 replay)" : ""}`, "People (WorldPop 2020)"];
  NEEDS.forEach((n) => head.push(`${n.short}: plan for a heat-wave week`, `${n.short}: held`, `${n.short}: needed on ${date}`,
    `${n.short}: from neighbours`, `${n.short}: lent to neighbours`, `${n.short}: needed from the city`));
  head.push("What pushes the score up", "Score estimated from pre-2022 wards");
  const rows = [head];
  scored.slice().sort((a, b) => a.rank - b.rank).forEach((p) => {
    const r = [p.rank, shortName(p), /^\d+$/.test(p.id) ? p.id : "", p.type, p.ac || "", p.cls, p.score.toFixed(1), RISK[dayRisk(p, d, w)], Math.round(p.facts.total_population || 0)];
    NEEDS.forEach((n) => {
      const sh = shares[n.key];
      const gets = sh.moves.filter((m) => m.to === p).reduce((t, m) => t + m.n, 0);
      const lends = sh.moves.filter((m) => m.from === p).reduce((t, m) => t + m.n, 0);
      const still = (sh.unmet.find((u) => u.p === p) || {}).n || 0;
      r.push(QTY[p.id][n.key] || 0, sh.stock[p.id] || 0, sh.demand[p.id] || 0, gets, lends, still);
    });
    r.push(p.drivers, p.transferred ? "yes" : "no");
    rows.push(r);
  });
  saveCsv(`heatlens-plan-${date}${w.key === "demo" ? "-replay" : ""}.csv`, rows);
}
async function downloadMoves(w0, d0) {
  const [w, d] = await planTarget(w0, d0), date = w.dates[d];
  const rows = [["Date", "Resource", "From", "To", "Units", "How far"]];
  NEEDS.forEach((n) => shareFor(d, n.key, w).moves.forEach((m) => rows.push([date, n.short, shortName(m.from), shortName(m.to), m.n, m.hops === 1 ? "next door" : "one ward over"])));
  NEEDS.forEach((n) => shareFor(d, n.key, w).unmet.forEach((u) => rows.push([date, n.short, "City", shortName(u.p), u.n, "needs city help"])));
  saveCsv(`heatlens-moves-${date}${w.key === "demo" ? "-replay" : ""}.csv`, rows);
}


// ---------- 8. CONTROLS ----------------------------------------------
$("#layer").addEventListener("change", paint);
$("#named").addEventListener("change", showNamed);
// The map view switch, the day slider and the sharing controls
document.querySelectorAll("#mode button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
$("#day").addEventListener("input", (e) => { stopPlay(); setDay(+e.target.value); });
$("#day-ticks").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { stopPlay(); setDay(+b.dataset.d); } });
$("#day-play").addEventListener("click", () => {
  if (playTimer) return stopPlay();
  if (!week) return;
  if (weekDay >= 6) setDay(0);
  $("#day-play").textContent = "❚❚";
  $("#day-play").setAttribute("aria-label", "Pause");
  playTimer = setInterval(() => { if (weekDay >= 6) return stopPlay(); setDay(weekDay + 1); }, 1300);
});
NEEDS.forEach((n) => { const o = document.createElement("option"); o.value = n.key; o.textContent = n.short; $("#share-res").appendChild(o); });
$("#share-on").addEventListener("change", () => {
  $("#share-box").classList.toggle("hidden", !$("#share-on").checked);
  renderLegend();
  drawFlows();
  renderShare();
});
$("#share-res").addEventListener("change", () => { renderLegend(); drawFlows(); renderShare(); renderHeadline(); });

// The story, the alert window and the downloads
$("#story-btn").addEventListener("click", () => playStory());
$("#story-stop").addEventListener("click", stopStory);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#story").classList.contains("hidden")) stopStory(); });
// The ward page's buttons: draft an alert, copy the plan, and the This week / May 2024 switch
wardPage.addEventListener("click", async (e) => {
  if (e.target.closest(".alert-open")) return openAlert();
  const cp = e.target.closest(".plan-copy");
  if (cp && selected) {
    const ok = await copyText(wardPlanText(selected));
    cp.textContent = ok ? "Copied" : "Couldn't copy";
    setTimeout(() => { cp.textContent = "Copy this plan"; }, 1600);
    return;
  }
  const b = e.target.closest("#needs-body button[data-basis]");
  if (b && selected && !b.disabled) { wardBasis = b.dataset.basis; renderSend(selected); }
});
$("#alert-lang").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { alertLang = b.dataset.lang; fillAlert(); } });
$("#alert-text").addEventListener("input", updateAlertLinks);
$("#alert-copy").addEventListener("click", async () => {
  const ok = await copyText($("#alert-text").value);
  $("#alert-copy").textContent = ok ? "Copied" : "Select and copy";
  setTimeout(() => { $("#alert-copy").textContent = "Copy"; }, 1600);
});
$("#plan").addEventListener("click", (e) => {
  const box = $("#plan");
  const sw = e.target.closest("button[data-basis]");
  if (sw) { if (!sw.disabled) { planBasis = sw.dataset.basis; renderPlan(); } return; }
  const b = e.target.closest("button[data-dl]");
  if (!b) return;
  // the download is for the plan on screen: its week and its day
  const w = box.dataset.shows === "live" && liveWeekObj ? liveWeekObj : demoWeek(), d = +box.dataset.day || 0;
  (b.dataset.dl === "plan" ? downloadPlan(w, d) : downloadMoves(w, d)).catch((err) => alert("Couldn't make the download: " + err.message));
});

// The map's "Heat by day" view shows either this week's forecast or the May 2024 replay
function setWeekSource(demo) {
  $("#demo").checked = demo;
  document.querySelectorAll("#week-src button").forEach((b) => {
    const on = (b.dataset.src === "demo") === demo;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  if (mapMode === "week") return setMode("week");
  renderHeadline();
}
$("#week-src").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setWeekSource(b.dataset.src === "demo"); });
// "Show this week on the map" / "Replay it on the map": switch the map over and frame the whole city
$("#overview-view").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-go]");
  if (!b) return;
  const demo = b.dataset.go === "demo";
  $("#demo").checked = demo;
  await setWeekSource(demo);
  if (mapMode !== "week") await setMode("week");
  if (week) setDay(worstDay(week));
  whenReady(() => map.fitBounds(DELHI_VIEW, { padding: fitPad(), duration: FLIGHT_MS }));
});


// ---- Ward search: instant suggestions from the 267 wards already in the page (no network).
//      Matches the ward name anywhere ("rohini" finds Rohini-A to F), the ward number ("12", "ward 12"),
//      and the assembly constituency.
const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const wardIndex = places.map((p) => ({ p, name: norm(p.name), ac: norm(p.ac), num: /^[0-9]+$/.test(p.id) ? p.id : null }));
const wardInput = $("#search"), wardList = $("#ward-list"), wardNote = $("#ward-note");
let wardHits = [], wardActive = -1;

function findWards(q) {
  const t = norm(q);
  if (!t) return [];
  const no = (t.match(/^(?:ward |w ?)?([0-9]+)$/) || [])[1]; // "12", "ward 12", "w12"
  const found = [];
  for (const w of wardIndex) {
    let rank = null;
    if (no && w.num === no) rank = 0;
    else if (w.name === t) rank = 1;
    else if (w.name.startsWith(t)) rank = 2;
    else if ((" " + w.name).includes(" " + t)) rank = 3; // a word in the name starts with it
    else if (w.name.includes(t)) rank = 4;
    else if (w.ac && (w.ac.startsWith(t) || (" " + w.ac).includes(" " + t))) rank = 5;
    if (rank !== null) found.push({ w, rank });
  }
  found.sort((a, b) => a.rank - b.rank || a.w.name.localeCompare(b.w.name, "en", { numeric: true }));
  return found.slice(0, 8).map((x) => x.w.p);
}
function closeWardList() {
  wardList.classList.add("hidden");
  wardInput.setAttribute("aria-expanded", "false");
  wardInput.removeAttribute("aria-activedescendant");
  wardActive = -1;
}
function wardNoteText(text) {
  wardNote.textContent = text;
  wardNote.classList.toggle("hidden", !text);
}
const noWardText = (q) => `No ward matches "${q.trim()}". For a street, area or landmark, use the address box above.`;
function showWardList(hits) {
  wardHits = hits;
  wardActive = -1;
  if (!hits.length) return closeWardList();
  wardList.innerHTML = hits.map((p, i) => {
    const sub = [p.cls ? p.cls + " vulnerability" : "not scored", p.ac ? "Assembly constituency: " + p.ac : p.type].filter(Boolean).join(" · ");
    return `<div class="opt plain" role="option" id="ward-opt-${i}" data-i="${i}" aria-selected="false"><b>${esc(p.label)}</b><span>${esc(sub)}</span></div>`;
  }).join("");
  wardList.classList.remove("hidden");
  wardInput.setAttribute("aria-expanded", "true");
}
function highlightWard(i) {
  wardActive = i;
  wardList.querySelectorAll(".opt").forEach((el, k) => {
    el.classList.toggle("active", k === i);
    el.setAttribute("aria-selected", String(k === i));
  });
  if (i >= 0) {
    wardInput.setAttribute("aria-activedescendant", "ward-opt-" + i);
    wardList.querySelector("#ward-opt-" + i).scrollIntoView({ block: "nearest" });
  }
}
function pickWard(p) {
  closeWardList();
  wardNoteText("");
  wardInput.value = "";
  wardInput.blur();
  openWard(p);
}
wardInput.addEventListener("input", () => {
  wardNoteText("");
  const q = wardInput.value, hits = findWards(q);
  showWardList(hits);
  if (norm(q).length >= 3 && !hits.length) wardNoteText(noWardText(q));
});
wardInput.addEventListener("focus", () => { if (wardInput.value.trim()) showWardList(findWards(wardInput.value)); });
wardInput.addEventListener("keydown", (e) => {
  const open = !wardList.classList.contains("hidden") && wardHits.length;
  if (e.key === "ArrowDown" && open) { e.preventDefault(); highlightWard((wardActive + 1) % wardHits.length); }
  else if (e.key === "ArrowUp" && open) { e.preventDefault(); highlightWard((wardActive - 1 + wardHits.length) % wardHits.length); }
  else if (e.key === "Escape") closeWardList();
  else if (e.key === "Enter") {
    e.preventDefault();
    const hits = open ? wardHits : findWards(wardInput.value);
    if (hits.length) pickWard(hits[wardActive >= 0 ? wardActive : 0]); // Enter without choosing takes the best match
    else if (wardInput.value.trim()) wardNoteText(noWardText(wardInput.value));
  }
});
wardList.addEventListener("mousedown", (e) => {
  const opt = e.target.closest(".opt");
  e.preventDefault(); // keep focus in the box until the choice is made
  if (opt) pickWard(wardHits[+opt.dataset.i]);
});
wardInput.addEventListener("blur", () => setTimeout(closeWardList, 120));

function showStatus(message) {
  const box = $("#my-status");
  box.textContent = message;
  box.classList.remove("hidden");
}

// ---- Address search. Uses Photon, a free search service built on OpenStreetMap (no key needed).
//      Only the text typed into the box is sent. Suggestions appear once at least 3 letters are typed
//      and typing pauses, and only places in and around Delhi are looked up.
const PHOTON = "https://photon.komoot.io/api/";
const SEARCH_AREA = "76.80,28.38,77.40,28.92"; // west, south, east, north
const addrForm = $("#address-box"), addrInput = $("#address-input"), addrList = $("#address-list");
const addrNote = $("#address-note"), addrBtn = $("#address-btn");
let addrTimer = null, addrAbort = null, addrHits = [], addrActive = -1;

// Place names come from the internet, so they are escaped before going into the page
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function addressNote(text) {
  addrNote.textContent = text;
  addrNote.classList.toggle("hidden", !text);
}

// A short readable name for a search result: the place itself, then where it is
function describePlace(pr) {
  const street = [pr.housenumber, pr.street].filter(Boolean).join(" ");
  const main = pr.name || street || pr.locality || pr.district || pr.city || "Unnamed place";
  const parts = [pr.name ? street : null, pr.locality, pr.district, pr.city, pr.postcode];
  const sub = parts.filter((x, i) => x && x !== main && parts.indexOf(x) === i).slice(0, 3).join(", ");
  return { main, sub };
}

async function lookUp(q, limit) {
  if (addrAbort) addrAbort.abort(); // only the newest search matters
  addrAbort = new AbortController();
  const url = `${PHOTON}?q=${encodeURIComponent(q)}&limit=${limit}&lang=en&bbox=${SEARCH_AREA}&lat=28.62&lon=77.21`;
  const res = await fetch(url, { signal: addrAbort.signal });
  if (!res.ok) throw new Error("the address service answered " + res.status);
  const data = await res.json();
  const seen = new Set();
  return (data.features || [])
    .filter((f) => f.geometry && f.geometry.type === "Point")
    .map((f) => ({ ...describePlace(f.properties || {}), lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }))
    .filter((h) => { const k = h.main + "|" + h.sub; if (seen.has(k)) return false; seen.add(k); return true; });
}

function closeSuggestions() {
  addrList.classList.add("hidden");
  addrInput.setAttribute("aria-expanded", "false");
  addrInput.removeAttribute("aria-activedescendant");
  addrActive = -1;
}
// Show the typed text in bold inside a suggestion (everything else is escaped as plain text)
function markMatch(text, q) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length));
}
const PIN = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/></svg>';
function showSuggestions(hits, q = "") {
  addrHits = hits;
  addrActive = -1;
  if (!hits.length) return closeSuggestions();
  addrList.innerHTML = hits.map((h, i) =>
    `<div class="opt" role="option" id="addr-opt-${i}" data-i="${i}" aria-selected="false">${PIN}<b>${markMatch(h.main, q)}</b>${h.sub ? `<span>${esc(h.sub)}</span>` : ""}</div>`).join("") +
    `<div class="credit">Search by Photon · © OpenStreetMap contributors</div>`;
  addrList.classList.remove("hidden");
  addrInput.setAttribute("aria-expanded", "true");
}
function highlight(i) {
  addrActive = i;
  addrList.querySelectorAll(".opt").forEach((el, k) => {
    el.classList.toggle("active", k === i);
    el.setAttribute("aria-selected", String(k === i));
  });
  if (i >= 0) {
    addrInput.setAttribute("aria-activedescendant", "addr-opt-" + i);
    addrList.querySelector("#addr-opt-" + i).scrollIntoView({ block: "nearest" });
  }
}

// A place was chosen: find its ward and open it, with a pin on the exact spot
function goToPlace(h) {
  closeSuggestions();
  addrInput.value = h.sub ? `${h.main}, ${h.sub}` : h.main;
  const p = wardAt(h.lat, h.lon);
  if (!p) return addressNote("That place is outside the Delhi wards on this map. Try an address inside Delhi.");
  addressNote("");
  openWard(p, { point: { lat: h.lat, lon: h.lon, kind: "address" } });
}

// Suggestions while typing (waits for a pause, so it doesn't send a request for every letter)
addrInput.addEventListener("input", () => {
  clearTimeout(addrTimer);
  addressNote("");
  const q = addrInput.value.trim();
  if (q.length < 3) { if (addrAbort) addrAbort.abort(); return closeSuggestions(); }
  addrTimer = setTimeout(async () => {
    try { showSuggestions(await lookUp(q, 5), q); }
    catch (e) { if (e.name !== "AbortError") closeSuggestions(); }
  }, 300);
});

// Keyboard: up / down to move through suggestions, Enter to pick, Esc to close
addrInput.addEventListener("keydown", (e) => {
  const open = !addrList.classList.contains("hidden") && addrHits.length;
  if (e.key === "ArrowDown" && open) { e.preventDefault(); highlight((addrActive + 1) % addrHits.length); }
  else if (e.key === "ArrowUp" && open) { e.preventDefault(); highlight((addrActive - 1 + addrHits.length) % addrHits.length); }
  else if (e.key === "Escape") closeSuggestions();
  else if (e.key === "Enter" && open && addrActive >= 0) { e.preventDefault(); goToPlace(addrHits[addrActive]); }
});

// Mouse: pick a suggestion (mousedown, so the box keeps focus until the choice is made)
addrList.addEventListener("mousedown", (e) => {
  const opt = e.target.closest(".opt");
  e.preventDefault();
  if (opt) goToPlace(addrHits[+opt.dataset.i]);
});
addrInput.addEventListener("blur", () => setTimeout(closeSuggestions, 120));

// The button (or Enter without picking a suggestion): search and go to the best match
addrForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearTimeout(addrTimer);
  const q = addrInput.value.trim();
  if (q.length < 2) return addressNote("Type an address, area or landmark first.");
  addrBtn.disabled = true;
  addrBtn.textContent = "Searching…";
  try {
    const hits = await lookUp(q, 5);
    if (hits.length) goToPlace(hits[0]);
    else addressNote("Couldn't find that address. Try adding the area or PIN code, or search for your ward by name below.");
  } catch (err) {
    if (err.name !== "AbortError") addressNote(`Couldn't reach the address search (${err.message}). You can still search for your ward by name below, or click it on the map.`);
  } finally {
    addrBtn.disabled = false;
    addrBtn.textContent = "Find my ward";
  }
});

function useLocation(lat, lon) {
  const p = wardAt(lat, lon);
  if (!p) return showStatus("This location is outside Delhi. The heat outlook and ward risk cover Delhi only, so click a ward on the map or search for one instead.");
  openWard(p, { point: { lat, lon, kind: "gps" } });
}
$("#locate-btn").addEventListener("click", () => {
  const b = $("#locate-btn");
  if (!navigator.geolocation) return showStatus("This browser cannot share its location. Click your ward on the map instead.");
  b.disabled = true; b.textContent = "Locating…";
  navigator.geolocation.getCurrentPosition(
    (pos) => { b.disabled = false; b.textContent = "Use my current location"; useLocation(pos.coords.latitude, pos.coords.longitude); },
    (err) => {
      b.disabled = false; b.textContent = "Use my current location";
      showStatus(`Couldn't get your location (${err.code === 1 ? "permission denied" : "location unavailable"}). Click your ward on the map instead.`);
    },
    { timeout: 15000, maximumAge: 600000 }
  );
});

// The (hidden) replay switch can also be flipped from code, as the story does: the map follows it.
// The overview and the ward pages always show both the live forecast and the replay, so they don't change.
$("#demo").addEventListener("change", () => setWeekSource($("#demo").checked));

// Test helpers: ?demo shows the replay on the map, ?lat=..&lon=.. pretends to be a GPS position, ?ward=ID opens a ward
{
  const q = new URLSearchParams(location.search);
  setWeekSource(q.has("demo")); // the map opens on "Heat by day": this week's forecast (or the replay with ?demo)
  renderLegend();
  renderScenarioCity();
  renderNowCity();
  renderPlan();
  renderHeadline();
  if (q.has("lat") && q.has("lon")) useLocation(+q.get("lat"), +q.get("lon"));
  else if (q.has("ward") && byId[q.get("ward")]) openWard(byId[q.get("ward")]);
}
