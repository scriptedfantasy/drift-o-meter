import json, sys, math
import numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
G=9.80665
def load(p):
    r=json.load(open(p)); tr=r["truth"]; mo=r["motion"]; gp=r["gps"]
    t=np.array([s["t"] for s in tr]); beta=np.degrees([s["beta"] for s in tr]); v=np.array([s["speed"] for s in tr])
    yaw=np.degrees([s["yawRate"] for s in tr]); ay=np.array([s["ay"] for s in tr]); ax=np.array([s["ax"] for s in tr])
    head=np.array([s["heading"] for s in tr]); crs=np.array([s["course"] for s in tr]); drift=np.array([s["drifting"] for s in tr])
    acc=np.array([[m["accel"]["x"],m["accel"]["y"],m["accel"]["z"]] for m in mo]); rot=np.array([[m["rotationRate"]["x"],m["rotationRate"]["y"],m["rotationRate"]["z"]] for m in mo])
    grav=np.array([[m["gravity"]["x"],m["gravity"]["y"],m["gravity"]["z"]] for m in mo])
    R=np.array(r["mount"]).reshape(3,3)
    return dict(r=r,t=t,beta=beta,v=v,yaw=yaw,ay=ay,ax=ax,head=head,crs=crs,drift=drift,acc=acc,rot=rot,grav=grav,R=R,gp=gp)
def style(fig, axs):
    fig.patch.set_facecolor("#0b0d11")
    for a in np.array(axs).flat:
        a.set_facecolor("#12161c"); a.tick_params(colors="#c9ccd3"); a.title.set_color("#ece9e2"); a.xaxis.label.set_color("#c9ccd3"); a.yaxis.label.set_color("#c9ccd3")
        for sp in a.spines.values(): sp.set_color("#2a3340")
        a.grid(True, color="#1f2630", lw=0.5)
# --- A: touge transition window ---
d=load("artifacts/critic-sim/run-touge-s9-portrait-vent.json")
fig,axs=plt.subplots(5,1,figsize=(16,14),sharex=True); style(fig,axs)
w=(d["t"]>14)&(d["t"]<32)
accV=(d["R"]@d["acc"].T).T; rotV=np.degrees((d["R"]@d["rot"].T).T)
axs[0].plot(d["t"][w],d["beta"][w],color="#ff5a1f",lw=1.5); axs[0].plot(d["t"][w],d["drift"][w]*40,color="#666",lw=0.8,label="drifting flag x40"); axs[0].set_title("touge s9: truth slip angle β (deg), 14–32 s (transition −30° → +28°)"); axs[0].legend()
axs[1].plot(d["t"][w],d["yaw"][w],color="#ece9e2",lw=1.2,label="truth yaw rate"); axs[1].plot(d["t"][w],rotV[w,2],color="#29e3ff",lw=0.6,alpha=0.8,label="gyro→vehicle z"); axs[1].set_title("yaw rate (deg/s)"); axs[1].legend()
axs[2].plot(d["t"][w],d["ay"][w]/G,color="#ece9e2",lw=1.2,label="truth ay"); axs[2].plot(d["t"][w],accV[w,1]/G,color="#29e3ff",lw=0.5,alpha=0.8,label="accel→vehicle y"); axs[2].set_title("lateral accel (g)"); axs[2].legend()
axs[3].plot(d["t"][w],d["ax"][w],color="#ece9e2",lw=1.2,label="truth ax"); axs[3].plot(d["t"][w],accV[w,0],color="#29e3ff",lw=0.5,alpha=0.8,label="accel→vehicle x"); axs[3].set_title("longitudinal accel (m/s²) — note the bang-bang"); axs[3].legend()
axs[4].plot(d["t"][w],d["v"][w]*3.6,color="#ece9e2",lw=1.2); axs[4].set_title("truth speed (km/h)"); axs[4].set_xlabel("t (s)")
plt.tight_layout(); plt.savefig("artifacts/critic-sim/touge-transition.png",dpi=80,facecolor=fig.get_facecolor()); plt.close()
# --- B: accel spectrum at speed, harbor rigid vib1, phone frame z (vertical-ish) ---
d=load("artifacts/critic-sim/run-harbor-s1-portrait-vent.json")
fs=100
w=(d["v"]>15)
accV=(d["R"]@d["acc"].T).T
fig,axs=plt.subplots(2,2,figsize=(16,9)); style(fig,axs)
for k,(lab,col) in enumerate([("vehicle x","#29e3ff"),("vehicle y","#ff5a1f"),("vehicle z","#ece9e2")]):
    sig=accV[w,k]-np.convolve(accV[w,k],np.ones(50)/50,mode="same")  # remove <2 Hz content (truth accel)
    seg=4096; n=len(sig)//seg
    P=np.zeros(seg//2+1)
    for i in range(n):
        x=sig[i*seg:(i+1)*seg]*np.hanning(seg); F=np.fft.rfft(x); P+=np.abs(F)**2
    P/=max(n,1); f=np.fft.rfftfreq(seg,1/fs)
    axs[0,0].semilogy(f,P/P.max()+1e-9,color=col,lw=0.8,label=lab,alpha=0.9)
axs[0,0].set_title("vehicle-frame user-accel PSD at speed>54 km/h (2 Hz high-passed): three pure tones"); axs[0,0].set_xlabel("Hz"); axs[0,0].legend()
# time-domain zoom of vertical accel 0.5 s
w2=(d["t"]>40)&(d["t"]<41.5)
axs[0,1].plot(d["t"][w2],accV[w2,2],color="#ece9e2",lw=0.8); axs[0,1].set_title("vehicle z user accel, 40–41.5 s (m/s²)")
# gravity tilt & gyro z during the long left-hander
w3=(d["t"]>30)&(d["t"]<48)
gV=(d["R"]@d["grav"].T).T
axs[1,0].plot(d["t"][w3],gV[w3,0],label="grav x (veh)"); axs[1,0].plot(d["t"][w3],gV[w3,1],label="grav y (veh)"); axs[1,0].plot(d["t"][w3],d["ay"][w3]/10,color="#ff5a1f",lw=0.7,label="truth ay/10"); axs[1,0].set_title("vehicle-frame gravity components during the 30° left-hander (m/s²)"); axs[1,0].legend()
# speed + vdot over lap 1
w4=(d["t"]>3)&(d["t"]<66)
axs[1,1].plot(d["t"][w4],d["v"][w4]*3.6,color="#ece9e2",lw=1,label="speed km/h"); ax2=axs[1,1].twinx(); ax2.plot(d["t"][w4],d["ax"][w4]*np.cos(np.radians(d["beta"][w4]))+d["ay"][w4]*np.sin(np.radians(d["beta"][w4])),color="#ff5a1f",lw=0.6,label="v̇ (m/s²)"); ax2.tick_params(colors="#ff5a1f")
axs[1,1].set_title("harbor lap 1: speed (white) and v̇ (orange) — bang-bang between −6.5 and +3.5"); axs[1,1].legend(loc="upper left")
plt.tight_layout(); plt.savefig("artifacts/critic-sim/harbor-spectrum-speed.png",dpi=80,facecolor=fig.get_facecolor()); plt.close()
# --- C: end-of-run discontinuity + GPS course vs truth ---
fig,axs=plt.subplots(3,1,figsize=(16,10)); style(fig,axs)
w5=(d["t"]>120)&(d["t"]<130)
axs[0].plot(d["t"][w5],d["beta"][w5],color="#ff5a1f",label="truth β"); axs[0].plot(d["t"][w5],np.degrees(d["head"][w5]),color="#ece9e2",label="truth heading"); axs[0].plot(d["t"][w5],np.degrees(d["crs"][w5]),color="#29e3ff",lw=0.8,label="truth course"); axs[0].set_title("harbor s1: last 10 s — truth heading snaps 33° when the roll-out starts (deg)"); axs[0].legend()
rotV=np.degrees((d["R"]@d["rot"].T).T)
axs[1].plot(d["t"][w5],d["yaw"][w5],color="#ece9e2",label="truth yawRate"); axs[1].plot(d["t"][w5],rotV[w5,2],color="#29e3ff",lw=0.7,label="gyro z → vehicle"); axs[1].plot(d["t"][w5],d["ax"][w5],color="#ff5a1f",lw=0.8,label="truth ax"); axs[1].plot(d["t"][w5],accV[w5,0],color="#ffd23f",lw=0.6,label="accel x → vehicle"); axs[1].set_title("truth vs sensors in the roll-out"); axs[1].legend(); axs[1].set_ylim(-60,60)
# GPS course vs truth course at delivery time and at t-0.5
gp=d["gp"]; tg=np.array([g["t"] for g in gp]); cg=np.array([g["course"] for g in gp]); ok=cg>=0
cm=np.radians(90-cg[ok]); cm=(cm+np.pi)%(2*np.pi)-np.pi
axs[2].plot(d["t"],np.degrees(d["crs"]),color="#ece9e2",lw=0.8,label="truth course (math deg)"); axs[2].plot(tg[ok],np.degrees(cm),".",color="#29e3ff",ms=4,label="GPS course at delivery t"); axs[2].plot(tg[ok]-0.5,np.degrees(cm),"x",color="#ff5a1f",ms=4,label="GPS course shifted −0.5 s"); axs[2].set_xlim(15,50); axs[2].set_title("GPS course vs truth: pure delay, no receiver filtering lag"); axs[2].legend()
plt.tight_layout(); plt.savefig("artifacts/critic-sim/harbor-end-gps.png",dpi=80,facecolor=fig.get_facecolor()); plt.close()
print("ok")
