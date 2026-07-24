#!/usr/bin/env python3
# Renders annotated explainer PNGs of the CrewLogic truck marker + truck-on-a-job badge.
from PIL import Image, ImageDraw, ImageFont
import math

SS = 3
W, H = 920, 600
BG = (15, 28, 42)
TXT = (232, 240, 247)
MUT = (156, 172, 188)
LINE = (120, 138, 156)
GREEN = (34, 197, 94)     # #22c55e  active truck
GRAY = (91, 107, 122)     # parked / stale
RING = (234, 88, 12)      # #ea580c  route (example)
FILL = (110, 191, 231)    # #6EBFE7  Vonigo status (example)
NUMDK = (6, 18, 29)       # #06121d  number on disc

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

def newimg():
    im = Image.new("RGB", (W * SS, H * SS), BG)
    return im, ImageDraw.Draw(im)

def arrow(d, x1, y1, x2, y2):
    d.line([P((x1, y1)), P((x2, y2))], fill=LINE, width=int(2.5 * SS))
    ang = math.atan2(y2 - y1, x2 - x1)
    hl, hw = 14, 7
    b1 = (x2 - hl * math.cos(ang) + hw * math.sin(ang), y2 - hl * math.sin(ang) - hw * math.cos(ang))
    b2 = (x2 - hl * math.cos(ang) - hw * math.sin(ang), y2 - hl * math.sin(ang) + hw * math.cos(ang))
    d.polygon([P((x2, y2)), P(b1), P(b2)], fill=LINE)

def callout(d, lx, ly, swatch, heading, desc, tx, ty, swatch_shape="sq"):
    sq = 20
    if swatch_shape == "circle":
        d.ellipse([P((lx, ly)), P((lx + sq, ly + sq))], fill=swatch, outline=(255, 255, 255), width=int(1 * SS))
    else:
        d.rounded_rectangle([P((lx, ly)), P((lx + sq, ly + sq))], radius=int(4 * SS),
                            fill=swatch, outline=(255, 255, 255), width=int(1 * SS))
    d.text(P((lx + sq + 12, ly - 2)), heading, font=F(19, True), fill=TXT)
    d.text(P((lx + sq + 12, ly + 24)), desc, font=F(14.5), fill=MUT)
    arrow(d, lx - 10, ly + sq / 2, tx, ty)

def centered(d, cx, cy, txt, font, fill):
    tb = d.textbbox((0, 0), txt, font=font)
    d.text((P((cx, cy))[0] - (tb[2] - tb[0]) / 2, P((cx, cy))[1] - (tb[3] - tb[1]) / 2 - tb[1]), txt, font=font, fill=fill)

# ---- Truck geometry (viewBox 40) -> base px ----
ts, tox, toy = 9, 60, 110
def T(x, y):
    return (x * ts + tox, y * ts + toy)
disc_c = T(20, 20)
disc_r = 10 * ts
nose = [T(20, 0.5), T(28, 13.5), T(12, 13.5)]           # points up (heading north)
badge = [T(30, 22.5), T(36.5, 28), T(36.5, 34.5), T(23.5, 34.5), T(23.5, 28)]  # job-under-truck house (touches disc)

def draw_truck(d, with_number="2", show_nose=True):
    if show_nose:
        d.polygon([P(p) for p in nose], fill=GREEN, outline=(255, 255, 255), width=int(1.4 * SS))
    d.ellipse([P((disc_c[0] - disc_r, disc_c[1] - disc_r)), P((disc_c[0] + disc_r, disc_c[1] + disc_r))],
              fill=GREEN, outline=(255, 255, 255), width=int(2.4 * SS))
    centered(d, disc_c[0], disc_c[1], with_number, F(46, True), NUMDK)

# ============ 1) Truck marker ============
im, d = newimg()
d.text(P((60, 40)), "CrewLogic — Truck Marker", font=F(30, True), fill=TXT)
d.text(P((60, 82)), "Each live truck on the map is a colored disc that points the way it's driving.", font=F(16), fill=MUT)
draw_truck(d, "2")
callout(d, 470, 150, GREEN, "DISC COLOR  =  STATUS",
        "Green = active / moving. Gray = parked\nor its GPS fix is stale.", disc_c[0] + disc_r - 8, disc_c[1] - 30, "circle")
callout(d, 470, 290, (255, 255, 255), "NUMBER  =  TRUCK ORDER",
        "The truck's number on the map (1, 2, 3…),\nmatching the truck list.", disc_c[0], disc_c[1], "circle")
callout(d, 470, 430, GREEN, "NOSE  =  DIRECTION",
        "Sticks out the way the truck is heading\n(only shows while it's moving).", T(20, 4)[0], T(20, 4)[1])
d.text(P((60, 548)), "Hover a truck to see its name. Small badges appear when it's at the yard, a facility, or on a job.",
       font=F(13.5), fill=MUT)
im.resize((W, H), Image.LANCZOS).save(
    "/private/tmp/claude-501/-Users-charlesdennis-code-crewlogic/a3816668-135b-4dba-9e2e-5f3a62b08882/scratchpad/truck-marker-explainer.png", "PNG")

# ============ 2) Truck on a job ============
im, d = newimg()
d.text(P((60, 40)), "CrewLogic — Truck On a Job", font=F(30, True), fill=TXT)
d.text(P((60, 82)), "When a truck sits on top of a job, a little house badge appears so the job isn't hidden.", font=F(16), fill=MUT)
draw_truck(d, "2", show_nose=False)   # at rest over a job → no direction nose
# job-under-truck house badge: status fill + route ring, touching the disc + thicker ring (matches the app)
d.polygon([P(p) for p in badge], fill=FILL, outline=RING, width=int(4.5 * SS))
callout(d, 470, 175, GREEN, "THE TRUCK",
        "Disc + number — a truck parked over a job.\nNo nose when at rest.", disc_c[0] + disc_r - 18, disc_c[1] - 40, "circle")
callout(d, 470, 315, FILL, "JOB HERE  (badge)",
        "A job is at this spot, under the truck.\nRing = route, fill = status — like a job house.", badge[1][0] - 4, badge[1][1] + 20)
d.text(P((60, 548)), "Tap the truck to see the likely crew on it + any tip-split warning for jobs it visited.",
       font=F(13.5), fill=MUT)
im.resize((W, H), Image.LANCZOS).save(
    "/private/tmp/claude-501/-Users-charlesdennis-code-crewlogic/a3816668-135b-4dba-9e2e-5f3a62b08882/scratchpad/truck-on-job-explainer.png", "PNG")

print("done")
