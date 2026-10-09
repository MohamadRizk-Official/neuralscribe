# Builds the mascot's animation layers from the canonical art (art/mascot/mascot-canonical.webp).
#   py -3.12 scripts/mascot-layers.py        (needs Pillow + NumPy)
# Output: public/mascot/{body,gem,arm-l,arm-r,foot-l,foot-r,full}.webp - aligned on one canvas, transparent.
# The runtime (src/mascot/) only moves these exact pixels, so the character stays identical in every state.
from PIL import Image, ImageFilter
import numpy as np
import json, os
from collections import deque

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'art', 'mascot', 'mascot-canonical.webp')
OUT = os.path.join(ROOT, 'public', 'mascot')
os.makedirs(OUT, exist_ok=True)

im = Image.open(SRC).convert('RGB')
a = np.asarray(im).astype(np.int32)
H, W, _ = a.shape
# 1) background: white / pale floor shadow connected to the image border
mx = a.max(2); mn = a.min(2)
lum = a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114
bgish = (mx - mn < 46) & (lum > 168)   # white / pale grey-lavender background and floor shadow

seen = np.zeros((H, W), bool)
q = deque()
def push(y, x):
    if bgish[y, x] and not seen[y, x]:
        seen[y, x] = True
        q.append((y, x))
for x in range(W):
    push(0, x); push(H - 1, x)
for y in range(H):
    push(y, 0); push(y, W - 1)
while q:
    y, x = q.popleft()
    if y > 0: push(y - 1, x)
    if y < H - 1: push(y + 1, x)
    if x > 0: push(y, x - 1)
    if x < W - 1: push(y, x + 1)
fg = ~seen
fg = ~seen
a = a.astype(np.float32)
# 2) cleanup, soft edges and parts
mx = a.max(2); mn = a.min(2)
lum = a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114
yy, xx = np.mgrid[0:H, 0:W]

# floor shadow: pale, low-saturation pixels under the body (the feet are saturated blue)
shadow = (yy > 900) & (lum > 140) & ((mx - mn) < 80)
fg = fg & ~shadow
# keep only what is attached to the character (drops specks)
fg_img = Image.fromarray((fg * 255).astype(np.uint8)).filter(ImageFilter.MedianFilter(3))
fg = np.asarray(fg_img) > 127

# soft edges: within 2 px of the background, estimate alpha from distance to white and un-mix the white
hard = fg.astype(np.uint8) * 255
near = np.asarray(Image.fromarray(hard).filter(ImageFilter.MinFilter(5))) < 128   # edge band (inside)
alpha = fg.astype(np.float32)
band = fg & near
est = np.clip((255.0 - mn) / 140.0, 0.0, 1.0)
alpha[band] = np.maximum(est[band], 0.15)
rgb = a.copy()
al = alpha[..., None]
rgb = np.where(al > 0.01, (a - (1 - al) * 255.0) / np.maximum(al, 0.01), 0)
rgb = np.clip(rgb, 0, 255)

# ---- parts ----
GEM_CUT = 330                     # gem above the collar
gem = fg & (yy < GEM_CUT)
arm_l = fg & (xx < 284) & (yy > 480) & (yy < 820)
arm_r = fg & (xx > 966) & (yy > 480) & (yy < 820)
feet = fg & (yy >= 948) & ~((xx > 512) & (xx < 740) & (yy < 990))   # the body's bottom rim between the feet stays with the body
foot_l = feet & (xx < 625)
foot_r = feet & (xx >= 625)
body = fg & ~gem & ~arm_l & ~arm_r & ~feet

ys, xs = np.nonzero(fg)
x0, x1, y0, y1 = xs.min() - 12, xs.max() + 12, ys.min() - 12, ys.max() + 12
cw, ch = x1 - x0, y1 - y0
TARGET_H = 260                    # 2x of ~130 px display height
scale = TARGET_H / ch
size = (round(cw * scale), TARGET_H)

def save(name, mask):
    rgba = np.zeros((H, W, 4), np.float32)
    rgba[..., :3] = rgb
    rgba[..., 3] = alpha * mask * 255.0
    img = Image.fromarray(rgba.astype(np.uint8), 'RGBA').crop((x0, y0, x1, y1)).resize(size, Image.LANCZOS)
    img.save(os.path.join(OUT, f'{name}.webp'), 'WEBP', quality=88, method=6)
    return os.path.getsize(os.path.join(OUT, f'{name}.webp'))

sizes = {n: save(n, m) for n, m in [('body', body), ('gem', gem), ('arm-l', arm_l), ('arm-r', arm_r), ('foot-l', foot_l), ('foot-r', foot_r)]}
# a single flattened image too (no-JS / reduced-data fallback)
sizes['full'] = save('full', fg)

def pct(x, y):
    return [round((x - x0) / cw * 100, 2), round((y - y0) / ch * 100, 2)]

geo = {
    'canvas': {'w': size[0], 'h': size[1], 'aspect': round(cw / ch, 4)},
    # pivots / anchors, in % of the layer canvas
    'armL_pivot': pct(278, 640), 'armR_pivot': pct(972, 640),
    'gem_pivot': pct(632, 325),
    'footL_pivot': pct(450, 960), 'footR_pivot': pct(830, 960),
    'feet_line': pct(625, 1040)[1],
}
print(json.dumps({'sizes': sizes, 'geo': geo}, indent=1))
