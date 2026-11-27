import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'adapters/xhs-phone'))
from observer_host import PersistentScript, PersistentSession, SCRIPT_PATH
from ui_capture import UiResponseCapture

N='b'*24
CONTRACT={'http_method':'GET','path':'/api/sns/v1/note/imagefeed','allowed_hosts':['example.test'],
          'parameters':[{'name':'note_id','type':'java.lang.String'}]}
def wire(at):
    return {'event':'response_json','at':at,'request':{'method':'GET','host':'example.test','path':CONTRACT['path'],'query':[{'name':'note_id','value':N}]},
            'status':200,'body':{'code':0,'success':True,'data':[{'note_list':[{'id':N}]}]},'at_peek_limit':False,'transport':{},'observation_id':'1'}

class LoadedScript:
    """The one real script: loaded once, never unloaded by a capture."""
    def __init__(self):
        self.exports_sync=self;self.resets=0;self.loads=0;self.unloads=0;self.callback=None
    def on(self,signal,callback):self.callback=callback
    def load(self):self.loads+=1
    def unload(self):self.unloads+=1
    def reset(self):
        self.resets+=1;return {'at':1,'cronet':True,'paths':[]}
    def allowpath(self,path):return [path]
    def allowshare(self,note,path):pass
    def takeshare(self,observation):return None
    def emit(self,payload):self.callback({'type':'send','payload':payload},None)

class PersistentObserverTests(unittest.TestCase):
    def setUp(self):
        self.real=LoadedScript();self.source=SCRIPT_PATH.read_text('utf-8')
        self.script=PersistentScript(self.real,self.source)
        self.real.on('message',self.script.dispatch)
        self.session=PersistentSession(self.script)

    def test_sequential_captures_reset_one_loaded_script(self):
        for at in (5,9):
            clock=iter([at-1,at+1]);capture=UiResponseCapture(self.session,clock_ms=lambda:next(clock))
            result=capture.read('image_detail',CONTRACT,{'note_id':N},lambda:self.real.emit(wire(at)))
            self.assertEqual(result['captured_at_ms'],at)
        self.assertEqual((self.real.loads,self.real.unloads,self.real.resets),(0,0,2))

    def test_idle_traffic_is_dropped_between_captures(self):
        self.real.emit(wire(1))
        self.assertIsNone(self.script.handler)

    def test_reuse_reports_both_observer_ready_events(self):
        events=[]
        self.script.on('message',lambda m,d:events.append(m['payload']['event']))
        self.script.load()
        self.assertEqual(events,['observer_ready','cronet_observer_ready'])

    def test_a_different_observer_source_is_refused(self):
        with self.assertRaises(RuntimeError):
            self.session.create_script('Java.perform(function(){})')

if __name__=='__main__':
    unittest.main()
