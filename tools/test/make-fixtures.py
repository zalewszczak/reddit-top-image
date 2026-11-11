# Generates synthetic "space" test images (no network needed).
import random, math, sys
from PIL import Image, ImageDraw, ImageFilter
out = sys.argv[1]
random.seed(4)
def space(w, h):
    im = Image.new('RGB', (w, h), (4, 6, 16))
    px = im.load()
    for y in range(h):
        for x in range(w):
            dx, dy = (x - w*0.62)/w, (y - h*0.45)/h
            r = math.hypot(dx*1.3, dy)
            glow = max(0.0, 1 - r*3.2)
            px[x, y] = (int(4 + 230*glow**1.6), int(6 + 90*glow**1.2 + 40*(1-r)), int(16 + 200*glow))
    d = ImageDraw.Draw(im)
    for _ in range(w*h//4000):
        x, y = random.randrange(w), random.randrange(h); s = random.choice([1,1,1,2,3]); c = random.randint(160,255)
        d.ellipse([x-s, y-s, x+s, y+s], fill=(c, c, 255 - random.randint(0, 60)))
    return im.filter(ImageFilter.GaussianBlur(0.6))
space(4000, 2600).save(out + '/big.jpg', quality=88, progressive=True)
space(1024, 668).save(out + '/small.jpg', quality=88)
space(900, 900).save(out + '/square.png')
p = space(500, 300).convert('RGBA'); p.putpixel((0, 0), (255, 0, 0, 0)); p.save(out + '/alpha.png')

tiny = Image.new('RGB', (120, 90), (240, 240, 255))
ImageDraw.Draw(tiny).rectangle([10, 10, 109, 79], fill=(255, 200, 80))
tiny.save(out + '/tiny.jpg', quality=92)
