#!/usr/bin/env python3
"""Plot slip-estimator output against simulator ground truth (dark theme, like plot_run.py).
usage: python3 tools/analysis/plot_slip.py artifacts/slip-harbor.json artifacts/slip-harbor.png
"""
import json, sys
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src))
t = np.array(d["t"])
bt = np.degrees(d["betaTrue"]); be = np.degrees(d["betaEst"]); bs = np.degrees(d["betaSigma"])
vt = np.array(d["speedTrue"]); ve = np.array(d["speedEst"])
valid = np.array(d["valid"]) > 0
xt, yt, xe, ye = (np.array(d[k]) for k in ("xTrue", "yTrue", "xEst", "yEst"))
m = {k: (v if isinstance(v, (int, float)) and v is not None else float("nan")) for k, v in d["metrics"].items()}

BG, PANEL, GRID, TXT = "#0b0d11", "#12161c", "#2a3340", "#c9ccd3"
TRUTH, EST, SIG, GPS, WARN = "#ece9e2", "#ff5a1f", "#ff5a1f", "#29e3ff", "#ffd23f"

fig = plt.figure(figsize=(18, 13))
fig.patch.set_facecolor(BG)
gs = fig.add_gridspec(4, 2, height_ratios=[2.2, 1.2, 1.2, 1.4])
ax_b = fig.add_subplot(gs[0, :])
ax_e = fig.add_subplot(gs[1, :], sharex=ax_b)
ax_v = fig.add_subplot(gs[2, :], sharex=ax_b)
ax_m = fig.add_subplot(gs[3, 0])
ax_p = fig.add_subplot(gs[3, 1], sharex=ax_b)
for a in (ax_b, ax_e, ax_v, ax_m, ax_p):
    a.set_facecolor(PANEL); a.tick_params(colors=TXT); a.title.set_color("#ece9e2")
    for sp in a.spines.values(): sp.set_color(GRID)
    a.xaxis.label.set_color(TXT); a.yaxis.label.set_color(TXT)
    a.grid(color=GRID, lw=0.5, alpha=0.6)

ax_b.fill_between(t, be - 2 * bs, be + 2 * bs, color=SIG, alpha=0.18, lw=0, label="estimate ±2σ")
ax_b.plot(t, bt, color=TRUTH, lw=1.6, label="truth β")
ax_b.plot(t, be, color=EST, lw=1.0, label="estimate β")
inval = np.where(~valid, 1.0, np.nan)
ax_b.plot(t, inval * (np.nanmax(np.abs(bt)) + 5), color=WARN, lw=4, label="invalid (no lock / slow)")
ax_b.axhline(0, color=GRID, lw=0.8)
ax_b.set_ylabel("slip angle (deg)")
ax_b.set_title(f"{d['track']} seed {d['seed']} — slip angle: truth vs estimate   |   drift RMS {m['driftRmsDeg']:.2f}°  peak {m['driftPeakDeg']:.2f}°  straight RMS {m['straightRmsDeg']:.2f}°  lag {m['lagMs']:.0f} ms  sign errors {m['signErrors']}/{m['signSamples']}")
ax_b.legend(loc="upper right", facecolor=PANEL, edgecolor=GRID, labelcolor=TXT)

err = be - bt
ax_e.plot(t, err, color=EST, lw=0.8, label="β error (deg)")
ax_e.plot(t, 2 * bs, color=SIG, lw=0.6, alpha=0.6, ls="--", label="+2σ")
ax_e.plot(t, -2 * bs, color=SIG, lw=0.6, alpha=0.6, ls="--")
ax_e.set_ylim(-12, 12); ax_e.set_ylabel("error (deg)")
ax_e.legend(loc="upper right", facecolor=PANEL, edgecolor=GRID, labelcolor=TXT)

ax_v.plot(t, vt * 3.6, color=TRUTH, lw=1.4, label="truth speed km/h")
ax_v.plot(t, ve * 3.6, color=EST, lw=0.9, label="fused speed km/h")
ax_v.plot(d["gpsT"], np.array(d["gpsSpeed"]) * 3.6, ".", color=GPS, ms=4, label="GPS speed (delivered t)")
ax_v.set_ylabel("speed"); ax_v.set_xlabel("t (s)")
ax_v.set_title(f"speed RMS err {m['speedRms']:.2f} m/s")
ax_v.legend(loc="upper right", facecolor=PANEL, edgecolor=GRID, labelcolor=TXT)

ax_m.plot(xt, yt, color=TRUTH, lw=1.2, label="truth path")
ax_m.plot(xe, ye, color=EST, lw=0.8, label="estimated path")
ax_m.set_aspect("equal"); ax_m.set_title(f"position (m)   RMS err {m['posRms']:.2f} m")
ax_m.legend(loc="upper right", facecolor=PANEL, edgecolor=GRID, labelcolor=TXT)

perr = np.hypot(xe - xt, ye - yt)
ax_p.plot(t, perr, color=GPS, lw=0.8)
ax_p.set_ylim(0, max(6, np.percentile(perr[np.isfinite(perr)], 99.5) * 1.2))
ax_p.set_ylabel("position error (m)"); ax_p.set_xlabel("t (s)"); ax_p.set_title("position error over time")

plt.tight_layout(); plt.savefig(dst, dpi=80, facecolor=fig.get_facecolor())
print("wrote", dst)
