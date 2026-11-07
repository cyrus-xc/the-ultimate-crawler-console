"""Match imported QR thumbnail to screenshot regions; no QR decoding/OCR."""
import json, sys
import cv2
screen = cv2.imread(sys.argv[1], cv2.IMREAD_GRAYSCALE)
qr = cv2.imread(sys.argv[2], cv2.IMREAD_GRAYSCALE)
regions = json.load(sys.stdin)
if screen is None or qr is None:
    raise SystemExit(2)
for index, (x, y, width, height) in enumerate(regions):
    if min(width, height) < 80 or abs(width-height) > max(width,height)*.2:
        continue
    crop = screen[y:y+height, x:x+width]
    if crop.shape != (height,width):
        continue
    expected = cv2.resize(qr, (width,height))
    if float(cv2.matchTemplate(crop, expected, cv2.TM_CCOEFF_NORMED)[0,0]) > .85:
        print(index)
        break
else:
    print(-1)
