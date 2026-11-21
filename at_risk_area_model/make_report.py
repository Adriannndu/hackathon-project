#!/usr/bin/env python3
"""Build a self-contained, offline HTML map + ward report from the risk model outputs.

Reads  outputs/risk_v2/ward_risk.csv, delhi_wards.geojson, reference_wards.csv, outputs/risk_v2/summary.json
Writes outputs/report/index.html  (no external libraries; open it in any browser)
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
from shapely.geometry import shape

OUT = Path("outputs/report")
SIZE = 1000.0  # SVG units for the map's longer side

GROUP_COLS = ["Heat hazard", "Exposure", "Sensitivity", "Adaptive capacity"]
# column -> (label, unit/format). 'pct100' multiplies a 0-1 share by 100.
FACTS = [
    ("total_population", "Population (WorldPop 2020)", "int"),
    ("pop_density", "People per km²", "int"),
    ("lst_mean_c", "Surface temperature, Apr–Jun mean (°C)", "1"),
    ("lst_hot45_share", "Clear days above 45 °C surface temp", "pct100"),
    ("built_up_share", "Built-up share of area", "pct100"),
    ("tree_cover_pct", "Tree cover (%)", "1"),
    ("elderly_share", "Population aged 65+", "pct100"),
    ("under5_share", "Children under 5", "pct100"),
    ("hospital_travel_min", "Est. minutes to nearest hospital", "1"),
    ("hospitals_per_100k", "Hospitals per 100k people", "1"),
    ("tap_treated_pct", "Households with treated tap water (%, Census 2011)", "0"),
    ("assets_index", "Household assets index (0 low – 1 high, Census 2011)", "2"),
]


def project(coords, lon0, lat0, k):
    return [((x - lon0) * np.cos(np.radians(lat0)) * k, (lat0 - y) * k) for x, y in coords]


def path_d(geom, lon0, lat0, k):
    polys = [geom] if geom.geom_type == "Polygon" else list(geom.geoms)
    parts = []
    for p in polys:
        for ring in [p.exterior, *p.interiors]:
            pts = project(list(ring.coords), lon0, lat0, k)
            parts.append("M" + "L".join(f"{x:.1f},{y:.1f}" for x, y in pts) + "Z")
    return "".join(parts)


def main():
    risk = pd.read_csv("outputs/risk_v2/ward_risk.csv", dtype={"ward_id": str}).set_index("ward_id")
    ref = pd.read_csv("reference_wards.csv", dtype={"matched_ward_id": str}).dropna(subset=["matched_ward_id"])
    named = ref.groupby("matched_ward_id").list_name.apply(lambda s: sorted(set(s))).to_dict()
    summary = json.load(open("outputs/risk_v2/summary.json"))
    gj = json.load(open("delhi_wards.geojson"))

    geoms = {str(f["properties"]["ward_id"]): shape(f["geometry"]).simplify(0.0004, preserve_topology=True)
             for f in gj["features"]}
    minx = min(g.bounds[0] for g in geoms.values()); maxx = max(g.bounds[2] for g in geoms.values())
    miny = min(g.bounds[1] for g in geoms.values()); maxy = max(g.bounds[3] for g in geoms.values())
    lat0 = (miny + maxy) / 2
    width_u = (maxx - minx) * np.cos(np.radians(lat0)); height_u = maxy - miny
    k = SIZE / max(width_u, height_u)
    W, H = width_u * k, height_u * k

    wards = []
    for f in gj["features"]:
        wid = str(f["properties"]["ward_id"])
        r = risk.loc[wid] if wid in risk.index else None
        d = {"id": wid, "name": f["properties"]["Ward_Name"].strip().title(), "type": f["properties"].get("ward_type"),
             "d": path_d(geoms[wid], minx, maxy, k), "named": named.get(wid, [])}
        if r is not None and pd.notna(r.risk_score):
            d.update(score=float(r.risk_score), cls=r.risk_class, rank=int(r["rank"]),
                     groups={g: float(r[f"{g}_score"]) for g in GROUP_COLS},
                     drivers=r.top_drivers, estimated=bool(r.census_data == "estimated"),
                     facts={c: (None if pd.isna(r[c]) else float(r[c])) for c, _, _ in FACTS})
        wards.append(d)

    payload = {"W": round(W, 1), "H": round(H, 1), "wards": wards, "facts": [[c, l, f] for c, l, f in FACTS],
               "groups": GROUP_COLS, "n_scored": summary["wards_scored"],
               "sens": summary["weight_sensitivity"], "est": summary["census_estimation"],
               "check": summary["check_against_heat_action_plan_and_cse_lists"],
               "indicators": [v["label"] + " (" + v["group"] + ")" for v in summary["indicators"].values()],
               "limits": summary["limitations"]}
    OUT.mkdir(parents=True, exist_ok=True)
    html = TEMPLATE.replace("/*DATA*/", "const DATA = " + json.dumps(payload, separators=(",", ":")) + ";")
    (OUT / "index.html").write_text(html, encoding="utf-8")
    print(f"wrote {OUT / 'index.html'} ({len(html) / 1e6:.2f} MB, {len(wards)} wards)")


TEMPLATE = r"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Delhi ward heat-risk ranking (prototype)</title>
<style>
:root{--bg:#fafaf8;--fg:#1c1c1a;--mute:#5d5d57;--line:#dcdcd4;--card:#fff;--accent:#8b1a0e}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:18px 24px 6px}h1{margin:0 0 4px;font-size:22px}header p{margin:0;color:var(--mute);max-width:980px}
.banner{margin:10px 24px;padding:10px 14px;border:1px solid #e6c46a;background:#fff8e1;border-radius:8px;font-size:13.5px;max-width:1100px}
main{display:grid;grid-template-columns:minmax(320px,1.25fr) minmax(300px,1fr);gap:18px;padding:8px 24px 28px;max-width:1400px}
@media(max-width:900px){main{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}
select,input{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:#fff}
label.t{font-size:13px;color:var(--mute);display:flex;gap:5px;align-items:center}
#mapwrap{position:relative}svg{width:100%;height:auto;background:#f3f1ea;border-radius:8px;display:block}
svg path{stroke:#fff;stroke-width:.6;cursor:pointer}svg path:hover{stroke:#000;stroke-width:1.6}
svg path.sel{stroke:#000;stroke-width:2.4}svg path.est{stroke-dasharray:3 2;stroke:#555}
svg path.named{stroke:#0a4fa8;stroke-width:2}
#tip{position:absolute;pointer-events:none;background:#1c1c1a;color:#fff;padding:5px 8px;border-radius:5px;font-size:12.5px;display:none;white-space:nowrap;z-index:5}
.legend{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px;font-size:12.5px;color:var(--mute)}.legend i{display:inline-block;width:14px;height:14px;border-radius:3px;margin-right:4px;vertical-align:-2px;border:1px solid #0002}
h2{font-size:16px;margin:0 0 8px}h3{font-size:14px;margin:12px 0 6px}
.bar{display:grid;grid-template-columns:130px 1fr 38px;gap:8px;align-items:center;font-size:13px;margin:3px 0}
.bar div.b{height:10px;background:#eee;border-radius:5px;overflow:hidden}.bar div.b span{display:block;height:100%}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid var(--line)}
tr.row{cursor:pointer}tr.row:hover{background:#f3efe4}td.n{text-align:right;font-variant-numeric:tabular-nums}
.pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;font-weight:600}
.facts td:first-child{color:var(--mute)}details{margin-top:10px}summary{cursor:pointer;font-weight:600}
.flag{font-size:12.5px;color:#7a4b00;background:#fff3d6;border-radius:5px;padding:3px 7px;display:inline-block;margin-top:6px}
.sm{font-size:12.5px;color:var(--mute)}ul{margin:6px 0 6px 18px;padding:0}
</style></head><body>
<header><h1>Delhi ward heat-risk ranking <span class="sm">(prototype)</span></h1>
<p>Which wards are most at risk when a heat wave hits? Each ward is scored against the others on heat hazard, exposure, sensitivity and ability to cope.</p></header>
<div class="banner"><b>Read this first.</b> This is a <b>relative</b> ranking of Delhi's wards. It is not a forecast, not a probability of anyone being harmed, and it has not been checked against heat-illness data. Treat it as a way to ask "where should we look first?" and check the details before acting.</div>
<main>
<section class="card"><div class="controls">
<label class="t">Colour by <select id="layer"></select></label>
<input id="search" list="names" placeholder="Search ward…" autocomplete="off"><datalist id="names"></datalist>
<label class="t"><input type="checkbox" id="named"> Outline wards named in the Heat Action Plan / CSE</label>
</div>
<div id="mapwrap"><svg id="map" role="img" aria-label="Map of Delhi wards coloured by heat risk"></svg><div id="tip"></div></div>
<div class="legend" id="legend"></div>
<div class="sm" style="margin-top:6px">Dashed outline = Census-based factors were estimated for this ward (the Census has no row for it). Grey = not scored.</div>
</section>
<section>
<div class="card" id="detail"><h2>Click a ward</h2><div class="sm">Select a ward on the map or in the table to see why it scored the way it did.</div></div>
<div class="card" style="margin-top:14px"><h2>Top 25 wards</h2><table id="top"></table></div>
<div class="card" style="margin-top:14px"><h2>How it works, and its limits</h2><div id="method"></div></div>
</section></main>
<script>
/*DATA*/
const PAL=["#ffffcc","#fed976","#fd8d3c","#e31a1c","#800026"],CLS=["Low","Moderate","High","Very High","Extreme"];
const $=s=>document.querySelector(s),svg=$("#map"),NS="http://www.w3.org/2000/svg";
svg.setAttribute("viewBox",`0 0 ${DATA.W} ${DATA.H}`);
const layers=[["cls","Risk class (overall)"],["score","Overall risk score"],...DATA.groups.map(g=>["g:"+g,g+" score"])];
layers.forEach(([v,t])=>{const o=document.createElement("option");o.value=v;o.textContent=t;$("#layer").appendChild(o)});
const scored=DATA.wards.filter(w=>w.score!==undefined);
const ramp=v=>PAL[Math.min(4,Math.max(0,Math.floor(v/20)))]; // 0-100 -> 5 bands (used for the small bars)
const hex=h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16));
function interp(t){t=Math.min(1,Math.max(0,t));const x=t*4,i=Math.min(3,Math.floor(x)),f=x-i,a=hex(PAL[i]),b=hex(PAL[i+1]);return"rgb("+a.map((v,k)=>Math.round(v+(b[k]-v)*f)).join(",")+")"}
const val=(w,L)=>L==="score"?w.score:w.groups[L.slice(2)];
const RANGE={};layers.slice(1).forEach(([L])=>{const v=scored.map(w=>val(w,L)).sort((a,b)=>a-b);RANGE[L]=[v[Math.floor(v.length*.02)],v[Math.floor(v.length*.98)]]});
function colour(w){const L=$("#layer").value;if(w.score===undefined)return"#cfcfc8";
 if(L==="cls")return PAL[CLS.indexOf(w.cls)];const[lo,hi]=RANGE[L];return interp((val(w,L)-lo)/(hi-lo))}
const paths={};let selected=null;
DATA.wards.forEach(w=>{const p=document.createElementNS(NS,"path");p.setAttribute("d",w.d);
 if(w.estimated)p.classList.add("est");p.addEventListener("click",()=>select(w.id));
 p.addEventListener("mousemove",e=>tip(e,w));p.addEventListener("mouseleave",()=>$("#tip").style.display="none");
 svg.appendChild(p);paths[w.id]=p;
 const o=document.createElement("option");o.value=w.name;$("#names").appendChild(o)});
function tip(e,w){const t=$("#tip"),r=$("#mapwrap").getBoundingClientRect();t.style.display="block";
 t.textContent=w.score===undefined?w.name+" (not scored)":`${w.name}: ${w.cls} (${w.score.toFixed(0)}), rank ${w.rank}`;
 t.style.left=Math.min(e.clientX-r.left+12,r.width-t.offsetWidth-4)+"px";t.style.top=(e.clientY-r.top+14)+"px"}
function paint(){DATA.wards.forEach(w=>{const p=paths[w.id];p.setAttribute("fill",colour(w));
 p.classList.toggle("named",$("#named").checked&&w.named.length>0);p.classList.toggle("sel",w.id===selected)});
 const L=$("#layer").value;$("#legend").innerHTML=(L==="cls"?CLS.map((c,i)=>`<span><i style="background:${PAL[i]}"></i>${c}</span>`)
  :[`<span>${RANGE[L][0].toFixed(0)}</span><span style="display:inline-block;width:170px;height:12px;border-radius:3px;background:linear-gradient(to right,${PAL.join(",")})"></span><span>${RANGE[L][1].toFixed(0)} (low to high risk)</span>`]).join("")+`<span><i style="background:#cfcfc8"></i>not scored</span>`;
 const sel=paths[selected];if(sel)svg.appendChild(sel)}
const fmt=(v,f)=>v==null?"—":f==="int"?Math.round(v).toLocaleString():f==="pct100"?(v*100).toFixed(1)+"%":f==="0"?v.toFixed(0):f==="2"?v.toFixed(2):v.toFixed(1);
function select(id){selected=id;const w=DATA.wards.find(x=>x.id===id);paint();const d=$("#detail");
 if(w.score===undefined){d.innerHTML=`<h2>${w.name}</h2><div class="sm">Not scored (${w.type||"not a ward"}).</div>`;return}
 const bars=DATA.groups.map(g=>`<div class="bar"><span>${g}</span><div class="b"><span style="width:${w.groups[g]}%;background:${ramp(w.groups[g])};border-right:1px solid #0003"></span></div><span>${w.groups[g].toFixed(0)}</span></div>`).join("");
 const facts=DATA.facts.map(([c,l,f])=>`<tr><td>${l}</td><td class="n">${fmt(w.facts[c],f)}</td></tr>`).join("");
 d.innerHTML=`<h2>${w.name}</h2><span class="pill" style="background:${PAL[CLS.indexOf(w.cls)]};color:${CLS.indexOf(w.cls)>=3?"#fff":"#1c1c1a"}">${w.cls}</span>
 <span class="sm"> &nbsp;score ${w.score.toFixed(1)} / 100 &middot; rank ${w.rank} of ${DATA.n_scored}</span>
 ${w.estimated?`<div class="flag">Census-based factors were estimated for this ward, so treat its score with more caution.</div>`:""}
 ${w.named.length?`<div class="sm" style="margin-top:6px">Named in: ${w.named.join(", ").replace(/_/g," ")}</div>`:""}
 <h3>Four groups (higher = more risk)</h3>${bars}
 <h3>What pushes the score up most</h3><div class="sm">${w.drivers.split("; ").join(" · ")}</div>
 <h3>Underlying numbers</h3><table class="facts">${facts}</table>`}
const top=scored.slice().sort((a,b)=>a.rank-b.rank).slice(0,25);
$("#top").innerHTML="<tr><th>#</th><th>Ward</th><th>Class</th><th class='n'>Score</th></tr>"+top.map(w=>`<tr class="row" data-id="${w.id}"><td>${w.rank}</td><td>${w.name}${w.estimated?" *":""}</td><td>${w.cls}</td><td class="n">${w.score.toFixed(1)}</td></tr>`).join("")+`<tr><td colspan="4" class="sm">* Census-based factors estimated</td></tr>`;
document.querySelectorAll("tr.row").forEach(r=>r.addEventListener("click",()=>select(r.dataset.id)));
$("#layer").addEventListener("change",paint);$("#named").addEventListener("change",paint);
$("#search").addEventListener("change",e=>{const w=DATA.wards.find(x=>x.name.toLowerCase()===e.target.value.trim().toLowerCase());if(w)select(w.id)});
const ck=DATA.check,au=ck.auc_named_high_vs_named_low;
$("#method").innerHTML=`<p>Each of ${DATA.n_scored} wards is ranked against the others on ${DATA.indicators.length} indicators, grouped into <b>heat hazard</b>, <b>exposure</b>, <b>sensitivity</b> and <b>adaptive capacity</b>. Each group counts 25%. Risk classes are quintiles (the highest fifth of wards are "Extreme").</p>
<h3>Indicators</h3><ul>${DATA.indicators.map(i=>`<li>${i}</li>`).join("")}</ul>
<h3>Checks</h3><ul><li>Randomly changing the group weights by ±30% hardly changes the ranking (rank correlation ${DATA.sens.mean_rank_correlation}; about ${(DATA.sens.share_of_wards_changing_class*100).toFixed(0)}% of wards move one class).</li>
<li>Wards named as high-risk by the Delhi Heat Action Plan or CSE rank above wards CSE calls low-heat-stress in ${(au*100).toFixed(0)}% of pairs. The heat-hazard part of this check is not independent, because those lists also come from Landsat temperatures.</li></ul>
<details><summary>Known limitations</summary><ul>${DATA.limits.map(l=>`<li>${l}</li>`).join("")}<li>${DATA.est.note} ${DATA.est.wards_estimated} wards affected.</li><li>Ward boundaries are the pre-2022 municipal wards.</li></ul></details>
<details><summary>Data sources</summary><ul><li>Surface temperature &amp; vegetation: Landsat 8/9 (USGS), April–June 2019–2025</li><li>Land cover: ESA WorldCover 2021 (CC BY 4.0)</li><li>Population by age: WorldPop 2020 (CC BY 4.0)</li><li>Hospitals: OpenStreetMap contributors (ODbL)</li><li>Housing, assets, water: Census of India 2011, houselisting table HL-14</li><li>Reference lists: Delhi Heat Action Plan 2025 (DDMA) and CSE, "No time to cool" (2026)</li></ul></details>`;
paint();
</script></body></html>
"""

if __name__ == "__main__":
    main()
