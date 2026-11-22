// =====================================================================
// HeatWatch Delhi. Data: risk-data.js (scores, forecast rules) and wards.js (outlines).
// The map is drawn by MapLibre GL, which uses the graphics card to redraw every shape at the exact
// zoom level on every frame. Wards stay sharp all the way through a zoom, line widths never change,
// and opening a ward never redraws anything on the main thread (it just changes a filter and fades
// one setting), so zooming and clicking stay smooth.
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
// "now" (the default) is the heat risk right now: the forecast combined with the ward's vulnerability.
// The others show the vulnerability ranking alone, i.e. how the ward would fare if a heat wave hit.
const layers = [["now", "Heat risk now (forecast)"], ["cls", "Vulnerability class (if a heat wave hits)"],
  ["score", "Vulnerability score"], ...DATA.groups.map((g) => ["g:" + g, g + " score"])];
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
layers.slice(2).forEach(([L]) => { // the number layers only
  const v = scored.map((p) => val(p, L)).sort((a, b) => a - b);
  RANGE[L] = [v[Math.floor(v.length * 0.02)], v[Math.floor(v.length * 0.98)]];
});
// Heat risk = worst forecast heat level (next 7 days, or one picked day) x the ward's vulnerability class.
// Defined here, not in section 6, because the map asks for colours as soon as it is created.
const RISK = ["No risk", "Low risk", "Medium risk", "High risk"];
const RISKCOL = ["#d9ead3", "#fed976", "#fd8d3c", "#b10026"];
const LOADING = "#e9e4d8"; // while the forecast is on its way
// ward class -> tier (0: Low/Moderate, 1: High, 2: Very High/Extreme); rows = heat level 0 normal .. 3 severe heat wave
const tier = (c) => (c === "High" ? 1 : c === "Very High" || c === "Extreme" ? 2 : 0);
const MATRIX = [[0, 0, 0], [1, 1, 2], [2, 3, 3], [3, 3, 3]];
let WARDFC = null; // ward id -> its forecast; filled in by loadMapForecast() (section 6)
function nowRisk(p) {
  const fc = WARDFC && WARDFC[p.id];
  if (!fc || p.score === undefined) return null;
  const ahead = fc.days.slice(fc.today, fc.today + 7), day = $("#day").value;
  const lvl = day === "all" ? Math.max(...ahead.map((d) => d.level)) : (ahead[+day] || { level: 0 }).level;
  return MATRIX[lvl][tier(p.cls)];
}
function colour(p) {
  if (p.score === undefined) return NOT_SCORED;
  const L = $("#layer").value;
  if (L === "now") { const r = nowRisk(p); return r === null ? LOADING : RISKCOL[r]; }
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

const NOBODY = ["==", ["id"], -1]; // a filter that matches no ward
const STYLE = {
  version: 8,
  sources: {
    sat: { type: "raster", tiles: [ESRI + "/World_Imagery/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 17, bounds: AREA,
      attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics" },
    labels: { type: "raster", tiles: [ESRI + "/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 15, bounds: AREA,
      attribution: "Labels &copy; Esri, OpenStreetMap contributors" },
    wards: { type: "geojson", data: wardsGeoJSON(), maxzoom: 15 },
    outside: { type: "geojson", data: outsideGeoJSON(), maxzoom: 12 },
    border: { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: closeRing(DELHI_OUTLINE) } }, maxzoom: 14 },
  },
  // bottom to top
  layers: [
    { id: "paper", type: "background", paint: { "background-color": "#e2dccf" } },
    { id: "sat", type: "raster", source: "sat" },
    { id: "labels", type: "raster", source: "labels" },
    { id: "ward-fill", type: "fill", source: "wards", paint: { "fill-color": ["get", "fill"], "fill-opacity": 0.82 } },
    { id: "ward-lines", type: "line", source: "wards", layout: { "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-opacity": 0.85, "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.5, 14, 1.3] } },
    { id: "ward-est", type: "line", source: "wards", filter: ["==", ["get", "est"], true],
      paint: { "line-color": "#5a5146", "line-width": 1, "line-dasharray": [3, 2] } },
    { id: "ward-named", type: "line", source: "wards", filter: ["==", ["get", "named"], true], layout: { visibility: "none" },
      paint: { "line-color": "#0a4fa8", "line-width": 2 } },
    // the grey veil over every ward except the open one; it fades in and out
    { id: "veil", type: "fill", source: "wards",
      paint: { "fill-color": "#dad5cb", "fill-opacity": 0, "fill-opacity-transition": { duration: 650, delay: 0 } } },
    { id: "outside", type: "fill", source: "outside", paint: { "fill-pattern": "hatch" } },
    { id: "delhi-border", type: "line", source: "border", layout: { "line-join": "round" },
      paint: { "line-color": "rgba(43, 36, 28, 0.8)", "line-width": 1.6 } },
    { id: "sel-line", type: "line", source: "wards", filter: NOBODY, layout: { "line-join": "round" },
      paint: { "line-color": "#2b241c", "line-width": 3 } },
    { id: "hover-line", type: "line", source: "wards", layout: { "line-join": "round" },
      paint: { "line-color": "#2b241c", "line-width": 1.6, "line-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 1, 0] } },
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
map.on("styleimagemissing", (e) => {
  if (e.id !== "hatch") return;
  const h = hatchImage();
  map.addImage("hatch", h.image, { pixelRatio: h.pixelRatio });
});

// Things that touch the map's layers have to wait until the map has loaded
let mapReady = false;
const afterLoad = [];
const whenReady = (fn) => (mapReady ? fn() : afterLoad.push(fn));
map.on("load", () => { mapReady = true; afterLoad.splice(0).forEach((fn) => fn()); });

// Colour setting changed: hand the map the new colours (it re-processes them off the main thread and
// swaps them in when ready, so the old colours stay on screen until then)
function paint() {
  whenReady(() => map.getSource("wards").setData(wardsGeoJSON()));
  renderLegend();
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
  const r = $("#layer").value === "now" ? nowRisk(p) : null;
  const text = selected && selected !== p ? p.label
    : p.score === undefined ? `${p.label} (not scored)`
    : r !== null ? `${p.label}: ${RISK[r]} · ${p.cls} vulnerability`
    : `${p.label}: ${p.cls} (${p.score.toFixed(0)}), rank ${p.rank}`;
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

// Grey veil over every ward except the open one, plus the open ward's dark border
function showSelected(p) {
  document.body.classList.toggle("ward-open", !!p);
  whenReady(() => {
    if (p) {
      const id = places.indexOf(p);
      map.setFilter("veil", ["!=", ["id"], id]);
      map.setFilter("sel-line", ["==", ["id"], id]);
      map.setPaintProperty("veil", "fill-opacity", 0.9);
    } else {
      map.setFilter("sel-line", NOBODY);
      map.setPaintProperty("veil", "fill-opacity", 0);
    }
  });
}

const wardBounds = (p) => [[p.bbox[0], p.bbox[1]], [p.bbox[2], p.bbox[3]]];

// opts.point = { lat, lon, kind: "gps" | "address" }: a real spot inside the ward (your location, or an
// address you searched for). It gets a pin, and the forecast is for that exact spot.
function openWard(p, opts = {}) {
  const pt = opts.point || null;
  selected = p;
  setHover(null);
  if (!panelOpen()) setPanel(true, false);
  showSelected(p);
  whenReady(() => map.fitBounds(wardBounds(p), { padding: fitPad(), maxZoom: 14, duration: FLIGHT_MS }));
  if (marker) { marker.remove(); marker = null; }
  if (pt) marker = new maplibregl.Marker({ color: "#a4482c" }).setLngLat([pt.lon, pt.lat]).addTo(map);
  changePage(wardPage, () => {
    renderDetail(p);
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
const LEVEL = ["normal", "hot (40 °C+)", "heat wave", "severe heat wave"];
const LEVCOL = ["#e4e2da", "#fed976", "#e31a1c", "#800026"];
// (RISK, RISKCOL, tier and MATRIX are in section 2)
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
const num = (v, n = 0) => (v == null || Number.isNaN(v) ? "–" : v.toFixed(n)); // safe number formatting

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

// 2 past days (so a heat wave already under way is caught) + today + 6 days
const FC_URL = "https://api.open-meteo.com/v1/forecast?daily=temperature_2m_max,temperature_2m_min,apparent_temperature_max" +
  "&timezone=Asia%2FKolkata&past_days=2&forecast_days=7";
const demoForecast = () => ({ days: classify(DATA.demo.map((d) => ({ ...d }))), today: 2,
  src: "Demo: observed Delhi temperatures, 22–30 May 2024, shown as if 24 May were today." });
function parseDaily(j, src) {
  const days = j.time.map((t, i) => ({
    date: t, tmax: j.temperature_2m_max[i], tmin: j.temperature_2m_min[i], app: j.apparent_temperature_max[i],
  }));
  // find today by date (not by position), in Delhi's time zone
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const idx = j.time.indexOf(todayStr);
  return { days: classify(days), today: idx >= 0 ? idx : 2, src };
}
async function forecast(lat, lon) {
  if ($("#demo").checked) return demoForecast();
  // Open-Meteo's weather grid is about 11 km wide, so wards close together share one request
  const key = lat.toFixed(1) + "," + lon.toFixed(1);
  const hit = fcCache[key];
  if (hit && Date.now() - hit.at < FORECAST_TTL_MS) return hit.value;
  const res = await fetch(FC_URL + "&latitude=" + lat.toFixed(3) + "&longitude=" + lon.toFixed(3));
  if (!res.ok) throw new Error("forecast service answered " + res.status);
  const value = parseDaily((await res.json()).daily, "Forecast: Open-Meteo, fetched " + new Date().toLocaleTimeString() + ".");
  fcCache[key] = { at: Date.now(), value };
  return value;
}

// The map's colours: the forecast for every ward, in one request. Wards share the nearest point of a
// ~5 km grid (about 50 points for all of Delhi).
let mapReq = 0;
function mapStatus(text, warn) {
  const el = $("#map-status");
  el.textContent = text;
  el.classList.toggle("flag", !!warn);
}
async function loadMapForecast() {
  const my = ++mapReq; // only the newest request counts
  WARDFC = null;
  mapStatus("Loading the forecast for every ward…");
  paint();
  const byWard = {};
  let src;
  try {
    if ($("#demo").checked) {
      const fc = demoForecast();
      places.forEach((p) => (byWard[p.id] = fc));
      src = fc.src;
    } else {
      const cellOf = (p) => (Math.round(p.lat * 20) / 20).toFixed(2) + "," + (Math.round(p.lon * 20) / 20).toFixed(2);
      const grid = {};
      places.forEach((p) => (grid[cellOf(p)] = grid[cellOf(p)] || []).push(p));
      const cells = Object.keys(grid);
      const res = await fetch(FC_URL + "&latitude=" + cells.map((c) => c.split(",")[0]).join(",") +
        "&longitude=" + cells.map((c) => c.split(",")[1]).join(","));
      if (!res.ok) throw new Error("forecast service answered " + res.status);
      let j = await res.json();
      if (!Array.isArray(j)) j = [j]; // a single point comes back as one object
      src = "Forecast: Open-Meteo, fetched " + new Date().toLocaleTimeString() + ".";
      j.forEach((loc, i) => { const fc = parseDaily(loc.daily, src); grid[cells[i]].forEach((p) => (byWard[p.id] = fc)); });
    }
  } catch (e) {
    if (my !== mapReq) return;
    mapStatus(`Couldn't load the forecast (${e.message}). Check the internet connection, or tick the demo box.`, true);
    return;
  }
  if (my !== mapReq) return;
  WARDFC = byWard;
  // the day picker: the worst of the next 7 days, or one day
  const first = Object.values(byWard)[0], ahead = first.days.slice(first.today, first.today + 7);
  const sel = $("#day"), keep = sel.value;
  sel.innerHTML = '<option value="all">the next 7 days (worst day)</option>' +
    ahead.map((d, i) => `<option value="${i}">${i === 0 ? "today" : dayName(d.date)}</option>`).join("");
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "all";
  mapStatus(src + " Each ward's colour combines the worst forecast day (or the day picked) with the ward's heat vulnerability, as on its ward page.");
  paint();
}

async function setHere(h) {
  here = h;
  const b = $("#youbody");
  b.innerHTML = '<div class="sm">Getting the forecast…</div>';
  let fc;
  try { fc = !h.kind && WARDFC && WARDFC[h.ward.id] ? WARDFC[h.ward.id] : await forecast(h.lat, h.lon); } // same as the map
  catch (e) {
    if (here !== h) return;
    b.innerHTML = `<div class="flag">Couldn't get the forecast (${e.message}). Check the internet connection and try again, or tick the demo box.</div>`;
    return;
  }
  if (here !== h) return; // a newer request replaced this one
  renderHere(h, fc);
  b.classList.remove("arrive");
  void b.offsetWidth;
  b.classList.add("arrive");
}

function renderHere(h, fc) {
  const w = h.ward, scoredWard = w && w.score !== undefined;
  const ahead = fc.days.slice(fc.today, fc.today + 7), now = ahead[0];
  const lvl = Math.max(...ahead.map((d) => d.level)), peak = Math.max(...ahead.map((d) => (d.tmax == null ? -Infinity : d.tmax)));
  const firstHw = ahead.find((d) => d.hw), risk = scoredWard ? MATRIX[lvl][tier(w.cls)] : null;
  let head;
  if (now.hw) head = `<b>You are in a ${now.severe ? "severe " : ""}heat wave now</b> (day ${now.streak}). Highest forecast: ${num(peak)} °C.`;
  else if (firstHw) head = `<b>${ahead.some((d) => d.severe) ? "Severe heat wave" : "Heat wave"} expected from ${dayName(firstHw.date)}</b>. Highest forecast: ${num(peak)} °C.`;
  else if (lvl === 1) head = `<b>Hot days ahead</b> (up to ${num(peak)} °C), but no heat wave forecast in the next 7 days.`;
  else head = `<b>No heat wave in the next 7 days.</b> Highest forecast: ${num(peak)} °C.`;
  const place = h.kind === "gps" ? `Your location is in <b>${w.label}</b>`
    : h.kind === "address" ? `This address is in <b>${w.label}</b>` : `<b>${w.label}</b>`;
  const wardLine = !scoredWard
    ? `<div class="flag">${w.label} isn't a scored ward (${w.type || "not a ward"}), so only the forecast is shown.</div>`
    : `<div class="sm">${place}: <span class="pill" style="background:${PAL[CLS.indexOf(w.cls)]};color:${CLS.indexOf(w.cls) >= 3 ? "#fff" : "#1c1c1a"}">${w.cls}</span> heat vulnerability, rank ${w.rank} of ${DATA.n_scored} wards.</div>`;
  const strip = ahead.map((d, i) =>
    `<div class="day${i === 0 ? " today" : ""}" title="${LEVEL[d.level]}; ${d.anom >= 0 ? "+" : ""}${num(d.anom, 1)} °C vs normal">` +
    `${i === 0 ? "Today" : wkday(d.date)}<b>${num(d.tmax)}°</b>${num(d.tmin)}° · feels ${num(d.app)}°<i style="background:${LEVCOL[d.level]}"></i></div>`).join("");
  const key = LEVEL.map((l, i) => `<span><i style="background:${LEVCOL[i]}"></i>${l}</span>`).join("");
  $("#youbody").innerHTML =
    (risk === null ? "" : `<div class="risk" style="background:${RISKCOL[risk]};color:${risk === 3 ? "#fff" : "#1c1c1a"}">${RISK[risk]}</div>`) +
    `<div class="headline">${head}</div>${wardLine}<div class="days">${strip}</div><div class="legend" style="margin-top:0">${key}</div>` +
    (risk === null ? "" : `<div class="advice">${ADVICE[risk]}</div>`) +
    `<div class="sm" style="margin-top:6px">${fc.src} Daily max/min and feels-like max. Heat wave = IMD rule: 2+ days at 40 °C or more and 4.5 °C above Delhi's normal, or 45 °C or more.${h.kind ? "" : " Forecast for the ward's area."}</div>`;
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
  const L = $("#layer").value;
  $("#daywrap").classList.toggle("hidden", L !== "now");
  $("#map-status").classList.toggle("hidden", L !== "now");
  $("#legend").innerHTML = (L === "now"
    ? RISK.map((c, i) => `<span><i style="background:${RISKCOL[i]}"></i>${c}</span>`)
    : L === "cls"
    ? CLS.map((c, i) => `<span><i style="background:${PAL[i]}"></i>${c}</span>`)
    : [`<span>${RANGE[L][0].toFixed(0)}</span><span class="grad" style="background:linear-gradient(to right,${PAL.join(",")})"></span><span>${RANGE[L][1].toFixed(0)} (low to high risk)</span>`]
  ).join("") + `<span><i style="background:${NOT_SCORED}"></i>not scored</span>`;
}

const fmt = (v, f) => v == null ? "—" : f === "int" ? Math.round(v).toLocaleString()
  : f === "pct100" ? (v * 100).toFixed(1) + "%" : f === "0" ? v.toFixed(0) : f === "2" ? v.toFixed(2) : v.toFixed(1);

// The ward's detail card: score, four groups, what drives it, and the underlying numbers
function renderDetail(p) {
  const d = $("#detail");
  if (p.score === undefined) {
    d.innerHTML = `<h2>${p.label}</h2><div class="sm">Not scored (${p.type || "not a ward"}).</div>`;
    return;
  }
  const bars = DATA.groups.map((g) =>
    `<div class="bar"><span>${g}</span><div class="b"><span style="width:${p.groups[g]}%;background:${ramp(p.groups[g])}"></span></div><span>${p.groups[g].toFixed(0)}</span></div>`).join("");
  const facts = DATA.facts.map(([c, l, f]) => `<tr><td>${l}</td><td class="n">${fmt(p.facts[c], f)}</td></tr>`).join("");
  d.innerHTML = `<h2>${p.label}</h2><span class="pill" style="background:${PAL[CLS.indexOf(p.cls)]};color:${CLS.indexOf(p.cls) >= 3 ? "#fff" : "#1c1c1a"}">${p.cls}</span>
    <span class="sm"> &nbsp;score ${p.score.toFixed(1)} / 100 &middot; rank ${p.rank} of ${DATA.n_scored}</span>
    ${p.ac ? `<div class="sm" style="margin-top:4px">Assembly constituency: ${p.ac}</div>` : ""}
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
<details><summary>Known limitations</summary><ul>${DATA.limits.filter((l) => !/robustness checks/i.test(l)).map((l) => `<li>${l}</li>`).join("")}<li>${DATA.est.note} ${DATA.est.wards_estimated} wards affected.</li><li>Ward boundaries are the 2022 MCD delimitation (250 wards). NDMC and Delhi Cantonment, which are not MCD wards, use DataMeet's earlier outlines trimmed to fit.</li></ul></details>
<details><summary>Data sources</summary><ul><li>Surface temperature &amp; vegetation: Landsat 8/9 (USGS), April–June 2019–2025</li><li>Land cover: ESA WorldCover 2021 (CC BY 4.0)</li><li>Population by age: WorldPop 2020 (CC BY 4.0)</li><li>Hospitals: OpenStreetMap contributors (ODbL)</li><li>Housing, assets, water: Census of India 2011, houselisting table HL-14</li><li>Reference lists: Delhi Heat Action Plan 2025 (DDMA) and CSE, "No time to cool" (2026)</li><li>Ward boundaries: 2022 MCD wards from OpenCity (source: Geospatial Delhi Ltd / State Election Commission of Delhi); NDMC and Cantonment from DataMeet Municipal Spatial Data (CC BY-SA 2.5 IN)</li><li>Ward populations on the 2022 map: Census 2011 figures used for the delimitation</li></ul></details>`;


// ---------- 8. CONTROLS ----------------------------------------------
$("#layer").addEventListener("change", paint);
$("#day").addEventListener("change", paint);
$("#named").addEventListener("change", showNamed);

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
  const num = (t.match(/^(?:ward |w ?)?([0-9]+)$/) || [])[1]; // "12", "ward 12", "w12"
  const scored = [];
  for (const w of wardIndex) {
    let rank = null;
    if (num && w.num === num) rank = 0;
    else if (w.name === t) rank = 1;
    else if (w.name.startsWith(t)) rank = 2;
    else if ((" " + w.name).includes(" " + t)) rank = 3; // a word in the name starts with it
    else if (w.name.includes(t)) rank = 4;
    else if (w.ac && (w.ac.startsWith(t) || (" " + w.ac).includes(" " + t))) rank = 5;
    if (rank !== null) scored.push({ w, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.w.name.localeCompare(b.w.name, "en", { numeric: true }));
  return scored.slice(0, 8).map((s) => s.w.p);
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
function showWardList(hits) {
  wardHits = hits;
  wardActive = -1;
  if (!hits.length) return closeWardList();
  wardList.innerHTML = hits.map((p, i) => {
    const sub = [p.cls ? p.cls + " vulnerability" : "not scored", p.ac ? "Assembly constituency: " + p.ac : p.type].filter(Boolean).join(" · ");
    return `<div class="opt" role="option" id="ward-opt-${i}" data-i="${i}" aria-selected="false"><b>${esc(p.label)}</b><span>${esc(sub)}</span></div>`;
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
  const q = wardInput.value;
  const hits = findWards(q);
  showWardList(hits);
  if (norm(q).length >= 3 && !hits.length) wardNoteText(`No ward matches "${q.trim()}". For a street, area or landmark, use the address box above.`);
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
    else if (wardInput.value.trim()) wardNoteText(`No ward matches "${wardInput.value.trim()}". For a street, area or landmark, use the address box above.`);
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
function showSuggestions(hits) {
  addrHits = hits;
  addrActive = -1;
  if (!hits.length) return closeSuggestions();
  addrList.innerHTML = hits.map((h, i) =>
    `<div class="opt" role="option" id="addr-opt-${i}" data-i="${i}" aria-selected="false"><b>${esc(h.main)}</b>${h.sub ? `<span>${esc(h.sub)}</span>` : ""}</div>`).join("") +
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
    try { showSuggestions(await lookUp(q, 6)); }
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

// Switching the demo on or off recolours the map and re-runs the outlook for the open ward
$("#demo").addEventListener("change", async () => { await loadMapForecast(); if (here) setHere({ ...here }); });
// a page left open (say, on a screen at a meeting) picks up a fresh forecast every hour
setInterval(() => { if (!$("#demo").checked) loadMapForecast(); }, FORECAST_TTL_MS);

// Test helpers: ?demo turns the demo on, ?lat=..&lon=.. pretends to be a GPS position, ?ward=ID opens a ward
{
  const q = new URLSearchParams(location.search);
  if (q.has("demo")) $("#demo").checked = true;
  renderLegend();
  if (q.has("lat") && q.has("lon")) useLocation(+q.get("lat"), +q.get("lon"));
  else if (q.has("ward") && byId[q.get("ward")]) openWard(byId[q.get("ward")]);
  loadMapForecast();
}
