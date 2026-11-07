"""Pixel identity prevents selecting an unrelated gallery item."""
import json, subprocess, sys, tempfile, unittest
from pathlib import Path
import cv2
import numpy as np

class ThumbnailTests(unittest.TestCase):
    def test_only_current_imported_image_matches(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rng = np.random.default_rng(1234)
            qr = rng.integers(0,2,(64,64),dtype=np.uint8)*255
            other = rng.integers(0,2,(64,64),dtype=np.uint8)*255
            screen = np.zeros((128,256),dtype=np.uint8)
            screen[:,:128] = cv2.resize(other,(128,128))
            screen[:,128:] = cv2.resize(qr,(128,128))
            cv2.imwrite(str(root/'screen.png'),screen)
            cv2.imwrite(str(root/'qr.png'),qr)
            helper = Path(__file__).resolve().parents[1]/'tools/login_qr_match.py'
            def match(regions):
                return subprocess.check_output([sys.executable,str(helper),str(root/'screen.png'),str(root/'qr.png')],input=json.dumps(regions).encode()).decode().strip()
            self.assertEqual(match([[0,0,128,128],[128,0,128,128]]),'1')
            self.assertEqual(match([[0,0,128,128]]),'-1')



class DestinationTests(unittest.TestCase):
    def test_private_decoder_rejects_non_login_destinations(self):
        with tempfile.TemporaryDirectory() as tmp:
            image=Path(tmp)/'qr.png'
            helper=Path(__file__).resolve().parents[1]/'tools/login_qr_url.py'
            for value,accepted in [('https://v.douyin.com/example?hide_nav_bar=1',True),('https://example.com/example',False),('https://v.douyin.com/example?redirect=elsewhere',False)]:
                matrix=cv2.QRCodeEncoder_create().encode(value)
                cv2.imwrite(str(image),cv2.resize(matrix,None,fx=5,fy=5,interpolation=cv2.INTER_NEAREST))
                result=subprocess.run([sys.executable,str(helper),str(image)],capture_output=True,text=True)
                self.assertEqual(result.returncode==0,accepted)
                self.assertEqual(result.stdout,value if accepted else '')

if __name__ == '__main__': unittest.main()
