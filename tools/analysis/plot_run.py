#!/usr/bin/env python3
"""Plot a dumped simulated run: track map, truth slip angle, raw phone-frame sensors, GPS.
usage: python3 tools/analysis/plot_run.py artifacts/run.json artifacts/run.png
"""
import json, sys, math
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

src, dst = sys.argv[1], sys.argv[2]
run = json.load(open(src))
tr = run["truth"]; mo = run["motion"]; gp = run["gps"]
t = np.array([s["t"] for s in tr]); beta = np.degrees([s["beta"] for s in tr])
x = np.array([s["x"] for s in tr]); y = np.array([s["y"] for s in tr]); v = np.array([s["speed"] for s in tr])
tm = np.array([m["t"] for m in mo])
rot = np.array([[m["rotationRate"]["x"], m["rotationRate"]["y"], m["rotationRate"]["z"]] for m in mo])
acc = np.array([[m["accel"]["x"], m["accel"]["y"], m["accel"]["z"]] for m in mo])
grav = np.array([[m["gravity"]["x"], m["gravity"]["y"], m["gravity"]["z"]] for m in mo])
fig, ax = plt.subplots(3, 2, figsize=(16, 12))
fig.patch.set_facecolor("#0b0d11")
for a in ax.flat:
    a.set_facecolor("#12161c"); a.tick_params(colors="#c9ccd3"); a.title.set_color("#ece9e2")
    for sp in a.spines.values(): sp.set_color("#2a3340")
    a.xaxis.label.set_color("#c9ccd3"); a.yaxis.label.set_color("#c9ccd3")
sc = ax[0,0].scatter(x, y, c=np.abs(beta), cmap="inferno", s=2, vmin=0, vmax=50)
ax[0,0].set_aspect("equal"); ax[0,0].set_title(f"{run['meta']['track']} — track map coloured by |slip angle| (deg)")
plt.colorbar(sc, ax=ax[0,0])
gx = np.array([(g["lon"]-run["originLon"])*111132.954*math.cos(math.radians(run["originLat"])) for g in gp])
gy = np.array([(g["lat"]-run["originLat"])*111132.954 for g in gp])
ax[0,0].plot(gx, gy, ".", color="#29e3ff", ms=3, label="GPS fixes"); ax[0,0].legend()
ax[0,1].plot(t, beta, color="#ff5a1f", lw=1); ax[0,1].set_title("truth slip angle β (deg)"); ax[0,1].set_xlabel("t (s)")
ax[1,0].plot(tm, np.degrees(rot), lw=0.6); ax[1,0].set_title("phone-frame rotation rate (deg/s) x,y,z"); ax[1,0].legend(["x","y","z"])
ax[1,1].plot(tm, acc, lw=0.5); ax[1,1].set_title("phone-frame user acceleration (m/s²) x,y,z"); ax[1,1].legend(["x","y","z"])
ax[2,0].plot(tm, grav, lw=0.6); ax[2,0].set_title("phone-frame gravity (m/s²) x,y,z"); ax[2,0].legend(["x","y","z"])
tg = np.array([g["t"] for g in gp]); gs = np.array([g["speed"] for g in gp])
ax[2,1].plot(t, v*3.6, color="#ece9e2", lw=1, label="truth speed km/h"); ax[2,1].plot(tg, gs*3.6, ".", color="#29e3ff", ms=4, label="GPS speed (delivered t)")
ax[2,1].legend(); ax[2,1].set_title("speed"); ax[2,1].set_xlabel("t (s)")
plt.tight_layout(); plt.savefig(dst, dpi=90, facecolor=fig.get_facecolor())
print("wrote", dst)
