#!/usr/bin/env python3
# Renders the CrewLogic truck-marker STATES graphic: 4 half-size trucks, one per status color,
# noses pointing 4 different directions (tagged), with a number callout pointing at the number.
from PIL import Image, ImageDraw, ImageFont
import math

SS = 3
W, H = 980, 500
BG = (15, 28, 42)
TXT = (232, 240, 247)
MUT = (156, 172, 188)
LINE = (150, 166, 182)
NUMDK = (6, 18, 29)

STATES = [
    ("Moving",  (0, 231, 133),  "#00E785", "actively driving", 0),     # nose up
    ("Parked",  (56, 189, 248), "#38bdf8", "reporting, sitting still", 90),   # nose right
    ("Stale",   (110, 129, 148), "#6e8194", "no report in 1 hr+", 0),  # nose up (keeps label clear)
    ("Offline", (239, 68, 68),  "#ef4444", "unplugged — a risk", 270),  # nose left
]

def F(sz, bold=False):
    paths = (["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Helvetica.ttc"]
             if bold else ["/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc"])
    for p in paths:
        try:
            return ImageFont.truetype(p, int(sz * SS))
        except Exception:
            pass
    return ImageFont.load_default()

def P(pt):
    return (pt[0] * SS, pt[1] * SS)

def centered(d, cx, cy, txt, font, fill):
    tb = d.textbbox((0, 0), txt, font=font)
    d.text((P((cx, cy))[0] - (tb[2] - tb[0]) / 2, P((cx, cy))[1] - (tb[3] - tb[1]) / 2 - tb[1]), txt, font=font, fill=fill)

def ctext(d, cx, y, txt, font, fill):  # horizontally-centered text at cx
    tb = d.textbbox((0, 0), txt, font=font)
    d.text((P((cx, y))[0] - (tb[2] - tb[0]) / 2, P((cx, y))[1]), txt, font=font, fill=fill)

def arrow(d, x1, y1, x2, y2):
    d.line([P((x1, y1)), P((x2, y2))], fill=LINE, width=int(2.5 * SS))
    ang = math.atan2(y2 - y1, x2 - x1)
    hl, hw = 13, 6.5
    b1 = (x2 - hl * math.cos(ang) + hw * math.sin(ang), y2 - hl * math.sin(ang) - hw * math.cos(ang))
    b2 = (x2 - hl * math.cos(ang) - hw * math.sin(ang), y2 - hl * math.sin(ang) + hw * math.cos(ang))
    d.polygon([P((x2, y2)), P(b1), P(b2)], fill=LINE)

def truck(d, cx, cy, r, color, num, nose_deg):
    # nose points relative to disc center, then rotated by nose_deg (0=up, 90=right, 180=down, 270=left)
    u = r / 10.0
    a = math.radians(nose_deg)
    def rot(px, py):
        rx = px * math.cos(a) - py * math.sin(a)
        ry = px * math.sin(a) + py * math.cos(a)
        return (cx + rx * u, cy + ry * u)
    nose = [rot(0, -19.5), rot(8, -6.5), rot(-8, -6.5)]
    d.polygon([P(p) for p in nose], fill=color, outline=(255, 255, 255), width=int(1.3 * SS))
    d.ellipse([P((cx - r, cy - r)), P((cx + r, cy + r))], fill=color, outline=(255, 255, 255), width=int(2.2 * SS))
    centered(d, cx, cy, num, F(r * 0.52, True), NUMDK)
    return rot(0, -19.5)  # nose tip

img = Image.new("RGB", (W * SS, H * SS), BG)
d = ImageDraw.Draw(img)

d.text(P((60, 34)), "CrewLogic — Truck Marker States", font=F(29, True), fill=TXT)
d.text(P((60, 76)), "The disc color is the truck's status. The nose points its direction of travel. The number is its order on the map.",
       font=F(15.5), fill=MUT)

xs = [225, 445, 665, 875]
cy = 265
r = 50
tips = []
for (name, col, hexs, mean, deg), cx in zip(STATES, xs):
    tip = truck(d, cx, cy, r, col, str(xs.index(cx) + 1), deg)
    tips.append(tip)
    ctext(d, cx, cy + r + 30, name, F(17, True), col)
    ctext(d, cx, cy + r + 54, mean, F(12.5), MUT)

# --- Annotations on truck 1 (Moving, nose up) ---
t1x, (ntx, nty) = xs[0], tips[0]
# Nose tag
d.text(P((t1x + 40, nty - 44)), "NOSE = direction", font=F(14.5, True), fill=TXT)
d.text(P((t1x + 40, nty - 22)), "of travel", font=F(14.5, True), fill=TXT)
arrow(d, t1x + 34, nty - 20, ntx + 4, nty + 6)
# Color tag (points AT the disc fill)
d.text(P((40, cy - 78)), "COLOR = truck", font=F(14.5, True), fill=TXT)
d.text(P((40, cy - 56)), "activity state", font=F(14.5, True), fill=TXT)
arrow(d, 150, cy - 54, t1x - r + 18, cy - 20)
# Number tag (points AT the number in the disc)
d.text(P((40, cy - 8)), "NUMBER =", font=F(14.5, True), fill=TXT)
d.text(P((40, cy + 14)), "truck's order", font=F(14.5, True), fill=TXT)
arrow(d, 165, cy + 6, t1x - 10, cy)

d.text(P((60, 452)), "Red = unplugged: the GPS + dash-cam can't see the driver, so it hides risky behavior. Treat it as a red flag.",
       font=F(13.5), fill=(239, 120, 120))

img = img.resize((W, H), Image.LANCZOS)
img.save("/private/tmp/claude-501/-Users-charlesdennis-code-crewlogic/a3816668-135b-4dba-9e2e-5f3a62b08882/scratchpad/truck-states.png", "PNG")
print("saved", img.size)
