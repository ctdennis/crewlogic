#!/usr/bin/env python3
# Renders an annotated explainer PNG of the CrewLogic map "job home" icon.
from PIL import Image, ImageDraw, ImageFont
import math

SS = 3                      # supersample for smooth edges
W, H = 920, 600
img = Image.new("RGB", (W * SS, H * SS), (15, 28, 42))
d = ImageDraw.Draw(img)

RING = (234, 88, 12)        # #ea580c  route color (example)
FILL = (110, 191, 231)      # #6EBFE7  Vonigo label / status color (New Appointment, example)
TXT = (232, 240, 247)
MUT = (156, 172, 188)
LINE = (120, 138, 156)

def F(sz, bold=False):
    paths = (["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Helvetica.ttc"]
             if bold else ["/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc"])
    for p in paths:
        try:
            return ImageFont.truetype(p, sz * SS)
        except Exception:
            pass
    return ImageFont.load_default()

def S(v):  # scale a scalar to supersampled space
    return v * SS

def P(pt):  # scale a point
    return (pt[0] * SS, pt[1] * SS)

# ---- House geometry (path M12 3 L21 11 L21 21 L3 21 L3 11 Z), scaled up ----
s, ox, oy = 15, 105, 150
pts24 = [(12, 3), (21, 11), (21, 21), (3, 21), (3, 11)]
house = [(x * s + ox, y * s + oy) for (x, y) in pts24]      # base px
num_c = (12 * s + ox, 14 * s + oy)                           # number centered in the house body

# ---- Title ----
d.text(P((60, 40)), "CrewLogic — Map Job Icon", font=F(30, True), fill=TXT)
d.text(P((60, 82)), "Every job on the Where-Are-My-Trucks map is a little house. Three things read at a glance:",
       font=F(16), fill=MUT)

# ---- House: fill + thick route ring, then the stop number ----
d.polygon([P(p) for p in house], fill=FILL, outline=RING, width=int(S(26)))
num_font = F(78, True)
tb = d.textbbox((0, 0), "3", font=num_font)
d.text((P(num_c)[0] - (tb[2] - tb[0]) / 2, P(num_c)[1] - (tb[3] - tb[1]) / 2 - tb[1]),
       "3", font=num_font, fill=(255, 255, 255))

# ---- Annotation helper: swatch + heading + desc, with an arrow to the target ----
def arrow(x1, y1, x2, y2):
    d.line([P((x1, y1)), P((x2, y2))], fill=LINE, width=int(S(2.5)))
    ang = math.atan2(y2 - y1, x2 - x1)
    hl, hw = 14, 7
    tip = (x2, y2)
    b1 = (x2 - hl * math.cos(ang) + hw * math.sin(ang), y2 - hl * math.sin(ang) - hw * math.cos(ang))
    b2 = (x2 - hl * math.cos(ang) - hw * math.sin(ang), y2 - hl * math.sin(ang) + hw * math.cos(ang))
    d.polygon([P(tip), P(b1), P(b2)], fill=LINE)

def callout(lx, ly, swatch, heading, desc, tx, ty):
    sq = 20
    d.rounded_rectangle([P((lx, ly)), P((lx + sq, ly + sq))], radius=int(S(4)),
                        fill=swatch, outline=(255, 255, 255), width=int(S(1)))
    d.text(P((lx + sq + 12, ly - 2)), heading, font=F(19, True), fill=TXT)
    d.text(P((lx + sq + 12, ly + 24)), desc, font=F(14.5), fill=MUT)
    arrow(lx - 10, ly + sq / 2, tx, ty)

# Outer ring -> a point on the roof ring
callout(470, 175, RING, "OUTER RING  =  ROUTE",
        "Which crew route this job is on. Same\ncolor as the route bar on the schedule board.",
        375 + 6, 250)
# Inner color -> the body fill
callout(470, 300, FILL, "INNER COLOR  =  STATUS",
        "The Vonigo appointment label (New Appt,\nEstimate Converted, Lost…). Matches Vonigo.",
        360, 300)
# Number -> the stop number
callout(470, 425, (255, 255, 255), "NUMBER  =  STOP ORDER",
        "The job's stop number along that route\n(1st, 2nd, 3rd… stop).",
        num_c[0] + 26, num_c[1])

# ---- Footer ----
d.text(P((60, 548)), "Gray fill = job is fully paid + completed. Hover a house on the map to see its route code.",
       font=F(13.5), fill=MUT)

img = img.resize((W, H), Image.LANCZOS)
out = "/private/tmp/claude-501/-Users-charlesdennis-code-crewlogic/a3816668-135b-4dba-9e2e-5f3a62b08882/scratchpad/job-icon-explainer.png"
img.save(out, "PNG")
print("saved", out, img.size)
