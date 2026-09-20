import sys, numpy as np
from PIL import Image
TOP, BOT = 330, 2070      # 110*3, (844-154)*3
def analyse(path):
    im = np.asarray(Image.open(path).convert('RGB')).astype(np.int16)
    world = im[TOP:BOT]
    H,W,_ = world.shape
    lum = world.max(axis=2)
    # "empty": max channel <= 22 (bg0 #07090D has max 13; the grid #131A23 has max 35)
    empty = (lum <= 22).mean()
    near_empty = (lum <= 40).mean()
    # ink: pixels clearly above the dark plate
    ink = (lum >= 90).mean()
    hot = (lum >= 170).mean()
    # colour census over the world window
    r,g,b = world[...,0],world[...,1],world[...,2]
    ember  = ((r>110)&(r>g+40)&(g>=b)&(b<r*0.7)).mean()
    cyan   = ((b>110)&(g>90)&(r<g-40)).mean()
    magenta= ((r>110)&(b>90)&(g<r-50)&(b>g+30)).mean()
    white  = ((r>150)&(g>150)&(b>150)).mean()
    # thirds
    thirds=[]
    for k in range(3):
        sub = lum[k*H//3:(k+1)*H//3]
        thirds.append(round(float((sub<=22).mean())*100))
    # quadrant emptiness
    quads=[]
    for qy in range(2):
        for qx in range(2):
            sub = lum[qy*H//2:(qy+1)*H//2, qx*W//2:(qx+1)*W//2]
            quads.append(round(float((sub<=22).mean())*100))
    print(f"{path.split('/')[-1]:34s} empty={empty*100:5.1f}%  <40lum={near_empty*100:5.1f}%  ink>=90={ink*100:5.2f}%  hot>=170={hot*100:5.2f}%  ember={ember*100:4.2f}% cyan={cyan*100:4.2f}% magenta={magenta*100:4.2f}% white={white*100:4.2f}%  thirds(empty%)={thirds} quads={quads}")
for p in sys.argv[1:]:
    analyse(p)
