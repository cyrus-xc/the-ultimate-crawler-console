"""Private pipe output for a verified login-dialog QR; never invoke as a logger."""
import cv2, sys
from urllib.parse import urlparse,parse_qs
value=cv2.QRCodeDetector().detectAndDecode(cv2.imread(sys.argv[1]))[0]
u=urlparse(value)
if u.scheme!='https' or u.hostname!='v.douyin.com' or u.username or u.password or u.port or u.fragment:
    raise SystemExit(2)
if set(parse_qs(u.query))-{'hide_nav_bar'} or len(u.path.strip('/').split('/'))!=1:
    raise SystemExit(2)
sys.stdout.write(value)
