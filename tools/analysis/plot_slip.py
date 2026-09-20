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
scale = 100 * np.array(d["ayScale"]); axb = np.array(d["axBias"])
gyb = np.degrees(d["gyroBias"])
m = {k: (v if isinstance(v, (int, float)) and v is not None else float("nan")) for k, v in d["metrics"].items()}
t0, t1 = m["fromT"], (m["toT"] if np.isfinite(m["toT"]) else t[-1])
win = (t >= t0) & (t <= t1)

BG, PANEL, GRID, TXT = "#0b0d11", "#12161c", "#2a3340", "#c9ccd3"
TRUTH, EST, SIG, GPS, WARN, ALT = "#ece9e2", "#ff5a1f", "#ff5a1f", "#29e3ff", "#ffd23f", "#7ee787"

fig = plt.figure(figsize=(19, 16))
fig.patch.set_facecolor(BG)
gs = fig.add_gridspec(6, 2, height_ratios=[2.2, 1.1, 2.0, 1.1, 1.1, 2.2], hspace=0.42, wspace=0.16)
ax_b = fig.add_subplot(gs[0, :])
ax_e = fig.add_subplot(gs[1, :], sharex=ax_b)
ax_z = fig.add_subplot(gs[2, :])
ax_v = fig.add_subplot(gs[3, :], sharex=ax_b)
ax_s = fig.add_subplot(gs[4, :], sharex=ax_b)
ax_m = fig.add_subplot(gs[5, 0])
ax_p = fig.add_subplot(gs[5, 1], sharex=ax_b)
for a in (ax_b, ax_e, ax_z, ax_v, ax_s, ax_m, ax_p):
    a.set_facecolor(PANEL); a.tick_params(colors=TXT); a.title.set_color("#ece9e2")
    for sp in a.spines.values(): sp.set_color(GRID)
    a.xaxis.label.set_color(TXT); a.yaxis.label.set_color(TXT)
    a.grid(color=GRID, lw=0.5, alpha=0.6)
LEG = dict(facecolor=PANEL, edgecolor=GRID, labelcolor=TXT, fontsize=9)

ax_b.fill_between(t, be - 2 * bs, be + 2 * bs, color=SIG, alpha=0.18, lw=0, label="estimate ±2σ")
ax_b.plot(t, bt, color=TRUTH, lw=1.6, label="truth β (CG)")
ax_b.plot(t, be, color=EST, lw=1.0, label="estimate β")
inval = np.where(~valid, 1.0, np.nan)
ax_b.plot(t, inval * (np.nanmax(np.abs(bt)) + 5), color=WARN, lw=4, label="invalid (no lock / slow)")
ax_b.axhline(0, color=GRID, lw=0.8)
ax_b.set_ylabel("slip angle (deg)")
ax_b.set_title(
    f"{d['track']} seed {d['seed']} — slip angle: truth vs estimate   |   drift RMS {m['driftRmsDeg']:.2f}°  drift peak {m['driftPeakDeg']:.2f}°  "
    f"straight RMS {m['straightRmsDeg']:.2f}°  straight peak {m['straightPeakDeg']:.2f}°  lag {m['lagMs']:.0f} ms  sign errors {m['signErrors']}/{m['signSamples']}"
)
ax_b.set_ylim(min(-15, np.nanmin(bt) - 12), max(15, np.nanmax(bt) + 12))
ax_b.legend(loc="upper right", ncol=4, **LEG)

err = be - bt
ax_e.plot(t, err, color=EST, lw=0.8, label="β error (deg)")
ax_e.plot(t, 2 * bs, color=SIG, lw=0.6, alpha=0.6, ls="--", label="±2σ")
ax_e.plot(t, -2 * bs, color=SIG, lw=0.6, alpha=0.6, ls="--")
ax_e.set_ylim(-8, 8); ax_e.set_ylabel("error (deg)")
ax_e.set_title(f"error inside the evaluation window {t0:.1f}–{t1:.1f} s   |   σ coverage {m['sigmaCoverage']:.2f} at mean σ {m['meanSigmaDeg']:.2f}°")
ax_e.legend(loc="upper right", ncol=2, **LEG)

# zoom: 18 s starting just before the entry of the busiest stretch of drifting, so the panel
# always shows a full initiation → hold → transition → exit rather than a slice of a hold
step = max(1, int(round(1.0 / max(t[1] - t[0], 1e-3))))
score = np.convolve((np.abs(bt) > 10).astype(float) * np.where(win, 1.0, 0.0), np.ones(8 * step), "same")
c = int(np.argmax(score))
entry = c
while entry > 0 and (abs(bt[entry]) > 3 or t[entry] > t[c]):
    entry -= 1
lo = max(t[0], t[entry] - 3.5)
hi = lo + 18
zi = (t >= lo) & (t <= hi)
ax_z.fill_between(t[zi], (be - 2 * bs)[zi], (be + 2 * bs)[zi], color=SIG, alpha=0.18, lw=0, label="estimate ±2σ")
ax_z.plot(t[zi], bt[zi], color=TRUTH, lw=2.4, label="truth β (CG)")
ax_z.plot(t[zi], be[zi], color=EST, lw=1.4, label="estimate β")
ax_z.plot(t[zi], (be - bt)[zi], color=GPS, lw=1.0, alpha=0.85, label="error")
for g in d["gpsT"]:
    if lo <= g <= hi:
        ax_z.axvline(g, color=ALT, lw=0.6, alpha=0.35)
ax_z.axhline(0, color=GRID, lw=0.8)
ax_z.set_xlim(lo, hi); ax_z.set_ylabel("slip angle (deg)")
ax_z.set_title("zoom on the busiest drift sequence — initiation, hold, transition, exit (green = GPS fix delivered)")
ax_z.legend(loc="upper right", ncol=4, **LEG)
ax_b.axvspan(lo, hi, color=ALT, alpha=0.10, lw=0)

ax_v.plot(t, vt * 3.6, color=TRUTH, lw=1.4, label="truth speed km/h")
ax_v.plot(t, ve * 3.6, color=EST, lw=0.9, label="fused speed km/h")
ax_v.plot(d["gpsT"], np.array(d["gpsSpeed"]) * 3.6, ".", color=GPS, ms=4, label="GPS speed (at delivery time)")
ax_v.set_ylabel("speed")
ax_v.set_title(f"speed RMS err {m['speedRms']:.2f} m/s   |   GPS latency: simulated {d['gpsLatencyTrue']:.2f} s, estimator settled at {d['gpsLatencyEst']:.2f} s")
ax_v.legend(loc="upper right", ncol=3, **LEG)

ax_s.plot(t, scale, color=EST, lw=1.2, label="lateral scale state s (%)")
ax_s.plot(t, 10 * axb, color=GPS, lw=1.2, label="longitudinal bias b$_x$ (m/s² ×10)")
ax_s.plot(t, 10 * gyb, color=ALT, lw=1.2, label="gyro bias (deg/s ×10)")
ax_s.axhline(0, color=GRID, lw=0.8)
ax_s.set_ylabel("parameter states"); ax_s.set_xlabel("t (s)")
ax_s.set_title("what the filter learned about the car and the road (scale = body roll + camber, bias = accel bias + grade)")
ax_s.legend(loc="upper right", ncol=3, **LEG)

ax_m.plot(xt, yt, color=TRUTH, lw=1.2, label="truth path")
ax_m.plot(xe, ye, color=EST, lw=0.8, label="estimated path")
ax_m.set_aspect("equal"); ax_m.set_title(f"position (m)   RMS err {m['posRms']:.2f} m")
ax_m.legend(loc="upper right", **LEG)

perr = np.hypot(xe - xt, ye - yt)
ax_p.plot(t, perr, color=GPS, lw=0.8)
ax_p.set_ylim(0, max(6, np.percentile(perr[np.isfinite(perr)], 99.5) * 1.2))
ax_p.set_ylabel("position error (m)"); ax_p.set_xlabel("t (s)"); ax_p.set_title("position error over time")

plt.savefig(dst, dpi=80, facecolor=fig.get_facecolor(), bbox_inches="tight")
print("wrote", dst)
