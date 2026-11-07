import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'clients/python'))
from crawler_queue import CrawlerQueueClient, QueueError

class Client(CrawlerQueueClient):
    def __init__(self, states, pages):
        self.states = iter(states)
        self.pages = iter(pages)
        self.actions = []
        self.cursors = []
    def get(self, request_id):
        return copy.deepcopy(next(self.states))
    def results(self, request_id, cursor=0):
        self.cursors.append(cursor)
        return copy.deepcopy(next(self.pages))
    def decide(self, request_id, decision_id, action):
        self.actions.append((decision_id, action))

def state(unit='a', decision='d1', page=1):
    return {'state':'running', 'decisions':[{'id':decision,'unit_id':unit,'action':None}],
            'units':[{'id':unit, 'state':'waiting_decision','checkpoint':{'page':page}}]}
def item(seq, unit):
    return {'seq':seq, 'unit_id':unit,'payload':{'body':str(seq)}}
def page(items, cursor):
    return {'items':items,'next_cursor':cursor}

class QueueClientTests(unittest.TestCase):
    def test_local_callback_receives_only_its_unit_and_cumulative_evidence(self):
        client=Client([state(),state(decision='d2',page=2),{'state':'succeeded'}],
            [page([item(1,'b')],1),page([item(2,'a')],2),page([],2),
             page([item(3,'a')],3),page([],3)])
        seen=[]
        def decide(unit, observations):
            seen.append((unit['checkpoint']['page'],[x['seq'] for x in observations]))
            observations[0]['payload']['body']='local modification'
            return 'continue' if unit['checkpoint']['page']==1 else 'stop'
        result=client.wait_with_decisions('request',decide,interval=0)
        self.assertEqual(result['state'],'succeeded')
        self.assertEqual(seen,[(1,[2]),(2,[2,3])])
        self.assertEqual(client.actions,[('d1','continue'),('d2','stop')])
        self.assertEqual(client.cursors,[0,1,2,2,3])

    def test_callback_failure_does_not_continue_or_cancel_collection(self):
        client=Client([state()],[page([],0)])
        def fail(*args):raise RuntimeError('business failure')
        with self.assertRaisesRegex(RuntimeError,'business failure'):
            client.wait_with_decisions('request',fail,interval=0)
        self.assertEqual(client.actions,[])

    def test_paused_request_does_not_execute_old_pending_decision(self):
        snapshot=state();snapshot['state']='paused';snapshot['units'][0]['state']='queued'
        client=Client([snapshot],[page([],0)])
        client.wait_with_decisions('request',lambda *args:self.fail('must not run'))
        self.assertEqual(client.actions,[])

    def test_nonadvancing_result_cursor_is_rejected(self):
        client=Client([state()],[page([item(1,'a')],0)])
        with self.assertRaisesRegex(QueueError,'SERVICE_RESPONSE_INVALID'):
            client.wait_with_decisions('request',lambda *args:'continue')
        self.assertEqual(client.actions,[])

if __name__=='__main__':unittest.main()
