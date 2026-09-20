#!/usr/bin/env python3
"""Build the live progress page from tools/progress/state.json → artifacts/progress.html"""
import json, html, base64, io, os, sys, datetime
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
state = json.load(open(ROOT / "tools/progress/state.json"))
out = ROOT / "artifacts/progress.html"

def esc(s): return html.escape(str(s))

def img_data_uri(path, width=420):
    try:
        from PIL import Image
        im = Image.open(ROOT / path).convert("RGB")
        w, h = im.size
        im = im.resize((width, int(h * width / w)))
        buf = io.BytesIO(); im.save(buf, format="JPEG", quality=72)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception as e:
        return ""

STATUS = {
    "queued": ("Queued", "queued"),
    "building": ("Building", "building"),
    "critique": ("In critique", "critique"),
    "fixing": ("Fixing", "building"),
    "passed": ("Passed", "passed"),
    "failed": ("Failed", "failed"),
}
pieces = state["pieces"]
counts = {k: sum(1 for p in pieces if p["status"] == k) for k in STATUS}
now = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
state["updated"] = now

rows = []
for p in pieces:
    label, cls = STATUS.get(p["status"], (p["status"], "queued"))
    score = p.get("score")
    rows.append(f"""
    <tr>
      <td class="name"><span class="piece">{esc(p['name'])}</span><span class="note">{esc(p.get('note',''))}</span></td>
      <td><span class="layer">{esc(p['layer'])}</span></td>
      <td><span class="chip {cls}">{esc(label)}</span></td>
      <td class="num">{p.get('rounds',0)}</td>
      <td class="num">{esc(score) if score is not None else '–'}</td>
      <td class="verdict">{esc(p.get('verdict','')) or '<span class="dim">no verdict yet</span>'}</td>
    </tr>""")

verdicts = []
for v in state.get("verdicts", []):
    findings = "".join(f"<li>{esc(f)}</li>" for f in v.get("findings", []))
    cls = "passed" if v.get("pass") else "failed"
    verdicts.append(f"""
    <details class="verdict-card" {'open' if v is state['verdicts'][0] else ''}>
      <summary><span class="chip {cls}">{'PASS' if v.get('pass') else 'FAIL'}</span> <strong>{esc(v['piece'])}</strong> · round {v.get('round','?')} · {esc(v.get('t',''))} <span class="score">{esc(v.get('score',''))}</span></summary>
      <p>{esc(v.get('summary',''))}</p>
      <ol>{findings}</ol>
    </details>""")

shots = []
for s in state.get("shots", []):
    uri = img_data_uri(s["path"], s.get("width", 420))
    if not uri: continue
    shots.append(f"""<figure><img src="{uri}" alt="{esc(s.get('caption',''))}"><figcaption>{esc(s.get('caption',''))}</figcaption></figure>""")

log = "".join(f"<li><time>{esc(e['t'])}</time><span>{esc(e['text'])}</span></li>" for e in reversed(state.get("log", [])))
verif = "".join(f"<li>{esc(x)}</li>" for x in state.get("verification", []))

page = f"""<title>{esc(state['title'])}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,600;0,700;1,700&family=Barlow:wght@400;500;600&display=swap">
<style>
:root {{
  --bg:#0B0D11; --panel:#12161C; --panel2:#181D25; --line:#232B37; --text:#ECE9E2; --muted:#8B93A3;
  --ember:#FF6A2A; --cyan:#2FD6F0; --pass:#45E0A0; --fail:#FF4D4D; --amber:#FFC14D; --dim:#5B6472;
  --display:'Barlow Condensed', 'Arial Narrow', Impact, sans-serif; --body:'Barlow', 'Helvetica Neue', Arial, sans-serif;
}}
html {{ color-scheme: dark; }}
body {{ background:var(--bg); color:var(--text); font-family:var(--body); font-size:15px; line-height:1.45; margin:0; padding-block:0 48px; padding-inline:16px; }}
.wrap {{ max-width:1080px; margin:0 auto; }}
header {{ padding-block:28px 18px; border-bottom:2px solid var(--ember); display:flex; flex-wrap:wrap; align-items:flex-end; justify-content:space-between; gap:12px; }}
h1 {{ font-family:var(--display); font-weight:700; font-style:italic; font-size:clamp(34px,6vw,54px); letter-spacing:.01em; line-height:.95; margin:0; text-transform:uppercase; }}
h1 span {{ color:var(--ember); }}
.phase {{ color:var(--muted); font-weight:500; letter-spacing:.06em; text-transform:uppercase; font-size:12px; margin-top:8px; }}
.updated {{ color:var(--muted); font-size:13px; font-variant-numeric:tabular-nums; }}
.summary {{ color:var(--text); max-width:70ch; margin-block:18px 0; }}
.strip {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-block:22px; }}
.tile {{ background:var(--panel); border:1px solid var(--line); padding:12px 14px; }}
.tile b {{ display:block; font-family:var(--display); font-size:36px; font-weight:700; line-height:1; font-variant-numeric:tabular-nums; }}
.tile span {{ color:var(--muted); font-size:12px; letter-spacing:.08em; text-transform:uppercase; }}
.tile.pass b {{ color:var(--pass); }} .tile.build b {{ color:var(--ember); }} .tile.crit b {{ color:var(--amber); }} .tile.fail b {{ color:var(--fail); }}
h2 {{ font-family:var(--display); font-weight:700; text-transform:uppercase; font-size:22px; letter-spacing:.03em; margin-block:34px 12px; color:var(--text); }}
.tablewrap {{ overflow-x:auto; border:1px solid var(--line); background:var(--panel); }}
table {{ border-collapse:collapse; width:100%; min-width:760px; }}
th {{ text-align:left; font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); font-weight:600; padding:10px 12px; border-bottom:1px solid var(--line); }}
td {{ padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top; }}
tr:last-child td {{ border-bottom:0; }}
td.name .piece {{ display:block; font-family:var(--display); font-size:19px; font-weight:600; letter-spacing:.01em; }}
td.name .note {{ display:block; color:var(--muted); font-size:13px; max-width:34ch; }}
td.num {{ font-variant-numeric:tabular-nums; text-align:right; }}
td.verdict {{ max-width:36ch; font-size:14px; }}
.layer {{ font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--cyan); }}
.chip {{ display:inline-block; font-size:11px; letter-spacing:.1em; text-transform:uppercase; font-weight:600; padding:3px 8px; border:1px solid currentColor; border-radius:2px; white-space:nowrap; }}
.chip.queued {{ color:var(--dim); }} .chip.building {{ color:var(--ember); }} .chip.critique {{ color:var(--amber); }} .chip.passed {{ color:var(--pass); }} .chip.failed {{ color:var(--fail); }}
.dim {{ color:var(--dim); }}
.verdict-card {{ background:var(--panel); border:1px solid var(--line); padding:12px 14px; margin-bottom:10px; }}
.verdict-card summary {{ cursor:pointer; font-size:15px; }}
.verdict-card .score {{ color:var(--muted); font-variant-numeric:tabular-nums; margin-left:6px; }}
.verdict-card p {{ color:var(--text); margin-block:10px 6px; max-width:80ch; }}
.verdict-card ol {{ margin:0; padding-left:20px; color:var(--muted); }}
.verdict-card li {{ margin-bottom:4px; }}
.shots {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:14px; }}
figure {{ margin:0; background:var(--panel); border:1px solid var(--line); padding:8px; }}
figure img {{ width:100%; display:block; }}
figcaption {{ font-size:12px; color:var(--muted); margin-top:6px; }}
ul.verif {{ padding-left:18px; color:var(--muted); max-width:80ch; }}
ol.log {{ list-style:none; padding:0; margin:0; border-left:2px solid var(--line); }}
ol.log li {{ display:grid; grid-template-columns:56px 1fr; gap:10px; padding:6px 0 6px 14px; }}
ol.log time {{ color:var(--ember); font-variant-numeric:tabular-nums; font-weight:600; font-size:13px; }}
@media (max-width:480px) {{ ol.log li {{ grid-template-columns:1fr; gap:2px; }} }}
@media (prefers-reduced-motion:no-preference) {{ header {{ animation:in .5s ease-out both; }} @keyframes in {{ from {{ opacity:.6; transform:translateY(4px); }} to {{ opacity:1; transform:none; }} }} }}
</style>
<div class="wrap">
<header>
  <div><h1>Drift-<span>O</span>-Meter <span>Build Board</span></h1><div class="phase">{esc(state['phase'])}</div></div>
  <div class="updated">Updated {esc(now)}</div>
</header>
<p class="summary">{esc(state['summary'])}</p>
<div class="strip">
  <div class="tile"><b>{len(pieces)}</b><span>pieces</span></div>
  <div class="tile pass"><b>{counts['passed']}</b><span>passed critic</span></div>
  <div class="tile crit"><b>{counts['critique']}</b><span>in critique</span></div>
  <div class="tile build"><b>{counts['building'] + counts['fixing']}</b><span>building / fixing</span></div>
  <div class="tile"><b>{counts['queued']}</b><span>queued</span></div>
</div>
<h2>Pieces</h2>
<div class="tablewrap"><table>
<thead><tr><th>Piece</th><th>Layer</th><th>Status</th><th>Critic rounds</th><th>Critic score</th><th>Latest verdict</th></tr></thead>
<tbody>{''.join(rows)}</tbody></table></div>
<h2>Latest critic verdicts</h2>
{''.join(verdicts) if verdicts else '<p class="dim">No critic rounds yet.</p>'}
<h2>What the critics are looking at</h2>
<div class="shots">{''.join(shots) if shots else '<p class="dim">Screenshots appear here once the harness runs.</p>'}</div>
<h2>How things are verified</h2>
<ul class="verif">{verif}</ul>
<h2>Log</h2>
<ol class="log">{log}</ol>
</div>
"""
out.parent.mkdir(exist_ok=True)
out.write_text(page)
print("wrote", out, len(page), "bytes")
