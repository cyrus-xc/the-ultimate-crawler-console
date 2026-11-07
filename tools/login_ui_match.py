"""Locate a calibrated scanner album icon, never text or platform content."""
import cv2,json,sys
image=cv2.imread(sys.argv[1],0)
template=cv2.imread(sys.argv[2],0)
if image is None or template is None:raise SystemExit(2)
score=cv2.matchTemplate(image,template,cv2.TM_CCOEFF_NORMED)
_,value,_,point=cv2.minMaxLoc(score)
if value<.95:print('null')
else:print(json.dumps({'center':[point[0]+template.shape[1]//2,point[1]+template.shape[0]//2],'width':template.shape[1],'height':template.shape[0],'text':'相册','content-desc':'calibrated-douyin-scanner'}))
