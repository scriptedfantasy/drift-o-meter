#!/usr/bin/env python3
"""Convert a replay-frame SVG (from render-replay.ts) to a 1170x2532 PNG, or render the
standard critic shot set.

usage: python3 tools/analysis/render_replay.py in.svg out.png
       python3 tools/analysis/render_replay.py --shots [track] [seed]     # → artifacts/replay-*.png

Needs `pip3 install cairosvg`. cairosvg draws text through fontconfig, so the app's Barlow
Condensed / Orbitron TTFs (from node_modules/@expo-google-fonts) are installed into
~/.local/share/fonts on first use; without them the HUD falls back to DejaVu Sans.
"""
import glob
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
W, H = 1170, 2532

# the standard critic shots: (name, track, seed, time spec, camera mode, extra flags)
SHOTS = [
    ("overview-mid", "mid", "overview", []),
    ("chase-drift", "peak", "chase", []),
    ("cinematic-transition", "transition", "cinematic", []),
    ("ghost-lap2", "ghost", "chase", []),
    ("cinematic-peak", "lap2-peak", "cinematic", []),
]


def ensure_fonts():
    try:
        out = subprocess.run(["fc-match", "Barlow Condensed:bold"], capture_output=True, text=True).stdout
    except FileNotFoundError:
        return
    if "BarlowCondensed" in out:
        return
    dst = os.path.expanduser("~/.local/share/fonts")
    os.makedirs(dst, exist_ok=True)
    n = 0
    for fam in ("barlow-condensed", "barlow", "orbitron"):
        for ttf in glob.glob(os.path.join(ROOT, "node_modules", "@expo-google-fonts", fam, "*", "*.ttf")):
            shutil.copy(ttf, dst)
            n += 1
    if n:
        subprocess.run(["fc-cache", "-f"], capture_output=True)
        print(f"installed {n} font files into {dst}")


def svg_to_png(src, dst):
    import cairosvg

    cairosvg.svg2png(url=src, write_to=dst, output_width=W, output_height=H)
    print("wrote", dst)


def shots(track="harbor", seed="1"):
    art = os.path.join(ROOT, "artifacts")
    os.makedirs(art, exist_ok=True)
    for name, tspec, mode, flags in SHOTS:
        svg = os.path.join(art, f"replay-{name}.svg")
        png = os.path.join(art, f"replay-{name}.png")
        cmd = ["npx", "tsx", os.path.join(ROOT, "tools", "analysis", "render-replay.ts"), track, seed, tspec, mode, svg, *flags]
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
        if r.returncode != 0:
            print(r.stdout, r.stderr, file=sys.stderr)
            raise SystemExit(f"render failed for {name}")
        print(r.stderr.strip())
        svg_to_png(svg, png)


def main(argv):
    ensure_fonts()
    if len(argv) >= 1 and argv[0] == "--shots":
        shots(*argv[1:3])
        return
    if len(argv) != 2:
        print(__doc__)
        raise SystemExit(2)
    svg_to_png(argv[0], argv[1])


if __name__ == "__main__":
    main(sys.argv[1:])
