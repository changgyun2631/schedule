"""Synthetic failure, midnight, long-range and isolated Git publication checks."""
import datetime as dt
import hashlib
import hmac
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

BOT_DIR = os.environ.get('SCHEDULE_BOT_DIR')
if BOT_DIR:
    sys.path.insert(0, BOT_DIR)
    import bot, publish, alarm


@unittest.skipUnless(BOT_DIR, 'Set SCHEDULE_BOT_DIR')
class ReliabilityTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.p = Path(self.tmp.name)
        for mock in [patch.multiple(bot, SELFTEST=True, DATA=str(self.p/'data.json'), PAGE=str(self.p/'page.html'), NTFY_STATE=str(self.p/'state.json')),
                     patch.object(bot, 'ntfy_conf', return_value={'key':'fake-key','topic':'fake-topic'}),
                     patch.object(bot, 'say'), patch.object(bot, 'log'), patch.object(bot, 'write_page'),
                     patch.object(bot, 'classify', return_value='기타'), patch.object(bot, 'ai_rewrite', return_value=None),
                     patch('urllib.request.urlopen', side_effect=AssertionError('Network forbidden'))]:
            mock.start()
            self.addCleanup(mock.stop)
        self.sent = int(dt.datetime(2026,10,21,23,59,tzinfo=publish.KST).timestamp())

    def event(self, action='create', text=None):
        text = text if text is not None else json.dumps({'rid':'reliability-request-001','text':'내일 책 반납'})
        msg={'a':action,'text':text,'ts':self.sent,'sig':hmac.new(b'fake-key',f'{action}||{text}|{self.sent}'.encode(),hashlib.sha256).hexdigest()}
        return lambda _: [{'event':'message','id':'fake-event','message':json.dumps(msg)}]

    def test_save_failure_retries_same_event_after_recovery(self):
        with patch.object(bot,'save',side_effect=PermissionError('synthetic')):
            self.assertEqual(bot.poll_ntfy('fake',self.event(),self.sent),0)
        self.assertEqual(bot.poll_ntfy('fake',self.event(),self.sent+15),1)
        self.assertEqual(len(bot.load()['items']),1)
        self.assertEqual(bot.poll_ntfy('fake',self.event(),self.sent+30),0)

    def test_reply_failure_does_not_repeat_saved_legacy_add(self):
        with patch.object(bot,'say',side_effect=OSError('synthetic reply failure')):
            bot.poll_ntfy('fake',self.event('add','내일 책 반납'),self.sent)
        bot.poll_ntfy('fake',self.event('add','내일 책 반납'),self.sent+15)
        self.assertEqual(len(bot.load()['items']),1)

    def test_temporary_unreadable_database_does_not_consume_request(self):
        with patch.object(bot,'load',side_effect=json.JSONDecodeError('synthetic','',0)):
            self.assertEqual(bot.poll_ntfy('fake',self.event(),self.sent),0)
        self.assertEqual(bot.poll_ntfy('fake',self.event(),self.sent+15),1)

    def test_midnight_uses_signed_request_day_for_create_and_legacy_add(self):
        for action,text in [('create',None),('add','내일 책 반납')]:
            for file in ('data.json','state.json'):
                (self.p/file).unlink(missing_ok=True)
            with patch.object(bot,'today',return_value=dt.date(2026,10,22)):
                self.assertEqual(bot.poll_ntfy('fake',self.event(action,text),self.sent+120),1)
            self.assertEqual(bot.load()['items'][0]['date'],'2026-10-22')

    def test_far_future_once_visible_and_repeat_window_bounded(self):
        base=dt.date(2026,10,21)
        items=[{'id':1,'kind':'once','date':'2027-10-21','text':'appointment','cat':'기타'},
               {'id':2,'kind':'daily','text':'exercise','cat':'기타'}]
        payload=publish.build_payload({'items':items},base,{})
        self.assertEqual([x['date'] for x in payload['items'] if x['id']==1],['2027-10-21'])
        self.assertEqual(len([x for x in payload['items'] if x['id']==2]),162)

    def test_data_commit_leaves_unrelated_staged_source_untouched(self):
        repo=self.p/'repo'; repo.mkdir()
        def git(*args,check=True):
            if args[0]=='push': return ''
            return subprocess.run(['git','-c','user.name=Test','-c','user.email=test@example.invalid',*args],cwd=repo,check=check,capture_output=True,text=True).stdout
        git('init','-q')
        (repo/'index.html').write_text('baseline')
        git('add','index.html');git('commit','-qm','baseline')
        (repo/'index.html').write_text('unfinished design');git('add','index.html')
        with (patch.multiple(publish,SITE=str(repo),STATE=str(self.p/'publish.json')),
              patch.object(publish,'git',side_effect=git),patch.object(publish,'names',return_value={}),
              patch.object(publish,'read_password',return_value='fake-password'),patch.object(publish,'encrypt',side_effect=lambda payload,*_:payload),
              patch.object(bot,'wx_place',return_value=None),patch.object(alarm,'vapid_keys',return_value={'public':'fake'}),patch.object(alarm,'load_subs',return_value=[])):
            publish.publish({'items':[]})
        self.assertEqual(git('diff-tree','--no-commit-id','--name-only','-r','HEAD').splitlines(),['data.enc.json'])
        self.assertEqual(git('diff','--cached','--name-only').strip(),'index.html')
