"""Set SCHEDULE_BOT_DIR to verify the installed bot with an isolated fake database."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

BOT_DIR = os.environ.get('SCHEDULE_BOT_DIR')
if BOT_DIR:
    sys.path.insert(0, BOT_DIR)
    sys.path.append(str(Path(__file__).resolve().parents[1] / 'server'))
    import bot
    import publish
    import web_edit


@unittest.skipUnless(BOT_DIR, 'Set SCHEDULE_BOT_DIR to test the installed bot')
class BotEditIntegrationTest(unittest.TestCase):
    def test_signed_edit_is_saved_and_published_with_its_receipt(self):
        item = {'id': 1, 'kind': 'once', 'date': '2026-10-20', 'text': '테스트상사 미팅', 'cat': '미팅', 'added': '2026-10-18'}
        names = {'테스트상사': 'T사'}
        now = int(time.time())
        key = 'fake-test-signing-key'
        text = json.dumps({'rid': 'integration-request-001', 'rev': web_edit.revision(item, names), 'changes': {'text': 'T사 계약 검토', 'time': '10:30'}})
        message = {'a': 'edit', 'id': 1, 'text': text, 'ts': now,
                   'sig': hmac.new(key.encode(), f'edit|1|{text}|{now}'.encode(), hashlib.sha256).hexdigest()}
        with tempfile.TemporaryDirectory() as temp:
            data = str(Path(temp) / 'data.json')
            Path(data).write_text(json.dumps({'next_id': 2, 'items': [item]}), encoding='utf-8')
            with (patch.multiple(bot, SELFTEST=True, DATA=data, PAGE=str(Path(temp) / 'page.html'),
                                NTFY_STATE=str(Path(temp) / 'ntfy-state.json')),
                 patch.object(bot, 'ntfy_conf', return_value={'key': key, 'topic': 'fake-test-topic'}),
                 patch.object(bot, 'say') as say,
                 patch.object(bot, 'log'),
                 patch.object(publish, 'names', return_value=names)):
                self.assertIsNotNone(bot.ntfy_verify(json.dumps(message), key, now), 'the signed edit is accepted by the real verifier')
                bad = {**message, 'id': 2}
                self.assertIsNone(bot.ntfy_verify(json.dumps(bad), key, now), 'a changed ID invalidates the signature')
                fetch = lambda _: [{'event': 'message', 'id': 'fake-event-1', 'message': json.dumps(message)}]
                self.assertEqual(bot.poll_ntfy('fake-chat', fetch, now), 1)
                saved = bot.load()
                self.assertEqual(saved['items'][0]['text'], '테스트상사 계약 검토')
                self.assertEqual(saved['items'][0]['time'], '10:30')
                self.assertTrue(saved['web_edits'][0]['ok'])
                self.assertEqual(say.call_count, 1)
                self.assertEqual(bot.poll_ntfy('fake-chat', fetch, now + 5), 0)
                payload = publish.build_payload(saved, bot.dt.date(2026, 10, 18), names)
                self.assertEqual(payload['edit'], 1)
                self.assertEqual(payload['edit_results'], saved['web_edits'])
                self.assertIn('edit', payload['items'][0])
                self.assertNotIn('테스트상사', json.dumps(payload, ensure_ascii=False))

    def test_editing_a_task_into_the_past_keeps_the_real_bot_task_behavior(self):
        item = {'id': 1, 'kind': 'once', 'date': '2026-10-20', 'text': '업무', 'cat': '업무', 'added': '2026-10-18'}
        db = {'next_id': 2, 'items': [item]}
        command = json.dumps({'rid': 'integration-request-002', 'rev': web_edit.revision(item), 'changes': {'date': '2026-10-17'}})
        self.assertTrue(web_edit.apply_edit(db, 1, command, {}, bot.CATS)['ok'])
        self.assertFalse(bot.is_memo(item))
        self.assertTrue(bot.overdue(item, bot.dt.date(2026, 10, 18)))


@unittest.skipUnless(BOT_DIR, 'Set SCHEDULE_BOT_DIR to test the installed bot')
class BotCompletionIntegrationTest(unittest.TestCase):
    def deliver(self, item, selected, base):
        now = int(time.time())
        key = 'fake-completion-signing-key'
        message = {'a': 'done', 'id': 1, 'text': selected, 'ts': now,
                   'sig': hmac.new(key.encode(), f'done|1|{selected}|{now}'.encode(), hashlib.sha256).hexdigest()}
        day = bot.dt.date.fromisoformat(base)
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'data.json'
            path.write_text(json.dumps({'next_id': 2, 'items': [item]}), encoding='utf-8')
            with (patch.multiple(bot, SELFTEST=True, DATA=str(path), PAGE=str(Path(temp) / 'page.html'),
                                 NTFY_STATE=str(Path(temp) / 'ntfy-state.json')),
                  patch.object(bot, 'ntfy_conf', return_value={'key': key, 'topic': 'fake-test-topic'}),
                  patch.object(bot, 'today', return_value=day), patch.object(bot, 'say'), patch.object(bot, 'log')):
                self.assertIsNotNone(bot.ntfy_verify(json.dumps(message), key, now))
                self.assertIsNone(bot.ntfy_verify(json.dumps({**message, 'text': selected + 'x'}), key, now), 'the selected date is covered by the signature')
                fetch = lambda _: [{'event': 'message', 'id': 'fake-done-event', 'message': json.dumps(message)}]
                self.assertEqual(bot.poll_ntfy('fake-chat', fetch, now), 1)
                self.assertEqual(bot.poll_ntfy('fake-chat', fetch, now + 5), 0)
                saved = bot.load()
                return saved, publish.build_payload(saved, day, {})

    def test_signed_completion_keeps_the_selected_occurrence_across_backlog_and_midnight(self):
        weekly = {'id': 1, 'kind': 'weekly', 'wd': 0, 'text': '반복 업무', 'cat': '업무', 'added': '2026-10-01'}
        monthly = {'id': 1, 'kind': 'monthly', 'day': 18, 'text': '주말 전 처리', 'cat': '업무', 'added': '2026-09-01'}
        once = {'id': 1, 'kind': 'once', 'date': '2026-10-18', 'text': '자정 전 업무', 'cat': '업무', 'added': '2026-10-01'}
        for item, selected, base in [(weekly, '2026-10-19', '2026-10-18'),
                                     (weekly, '2026-10-12', '2026-10-19'),
                                     (monthly, '2026-10-16', '2026-10-19'),
                                     (once, '2026-10-18', '2026-10-19')]:
            with self.subTest(kind=item['kind'], selected=selected, base=base):
                saved, payload = self.deliver(item, selected, base)
                self.assertEqual(saved['items'][0]['done_until'], selected)
                self.assertEqual(len(saved['done_log']), 1)
                self.assertEqual(saved['done_log'][0]['day'], base, 'history records when the action ran, not the scheduled date')
                self.assertEqual(payload.get('done_dates'), 1)

    def test_invalid_or_outdated_occurrence_never_changes_the_schedule(self):
        weekly = {'id': 1, 'kind': 'weekly', 'wd': 0, 'text': '반복 업무', 'cat': '업무', 'added': '2026-10-01'}
        moved = {'id': 1, 'kind': 'once', 'date': '2026-10-20', 'text': '날짜가 바뀐 일정', 'cat': '업무', 'added': '2026-10-01'}
        for item, selected in [(weekly, '2026-02-30'), (weekly, '20261019'), (weekly, '2026-10-20'),
                               (weekly, '2026-10-26'), ({**weekly, 'added': '2026-10-20'}, '2026-10-19'),
                               (moved, '2026-10-19'), ({**weekly, 'event': True}, '2026-10-19')]:
            with self.subTest(item=item, selected=selected):
                saved, _ = self.deliver(item, selected, '2026-10-18')
                self.assertEqual(saved, {'next_id': 2, 'items': [item]})

    def test_a_late_completion_cannot_move_existing_done_history_backwards(self):
        item = {'id': 1, 'kind': 'weekly', 'wd': 0, 'text': '반복 업무', 'cat': '업무',
                'added': '2026-10-01', 'done_until': '2026-10-19'}
        saved, _ = self.deliver(item, '2026-10-12', '2026-10-19')
        self.assertEqual(saved, {'next_id': 2, 'items': [item]}, 'an older or repeated request cannot reopen a later completed occurrence or duplicate history')

    def test_legacy_completion_without_an_occurrence_keeps_existing_behavior(self):
        item = {'id': 1, 'kind': 'weekly', 'wd': 0, 'text': '반복 업무', 'cat': '업무', 'added': '2026-10-01'}
        saved, _ = self.deliver(item, '', '2026-10-18')
        self.assertEqual(saved['items'][0]['done_until'], '2026-10-12')
        self.assertEqual(saved['done_log'][0]['day'], '2026-10-18')


if __name__ == '__main__':
    unittest.main()

@unittest.skipUnless(BOT_DIR, 'Set SCHEDULE_BOT_DIR to test the installed bot')
class BotCreateIntegrationTest(unittest.TestCase):
    def test_create_receipt_is_atomic_idempotent_and_reports_rejected_input(self):
        key, now = 'fake-create-key', int(time.time())
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'data.json'
            path.write_text(json.dumps({'next_id': 1, 'items': []}), encoding='utf-8')
            with (patch.multiple(bot, SELFTEST=True, DATA=str(path), PAGE=str(Path(temp) / 'page.html'), NTFY_STATE=str(Path(temp) / 'state.json')),
                  patch.object(bot, 'ntfy_conf', return_value={'key': key, 'topic': 'fake-topic'}),
                  patch.object(bot, 'say'), patch.object(bot, 'log'), patch.object(bot, 'ai_rewrite', return_value=None)):
                def deliver(text, rid, event, offset=0):
                    body = json.dumps({'rid': rid, 'text': text})
                    msg = {'a': 'create', 'text': body, 'ts': now + offset, 'sig': hmac.new(key.encode(), f'create||{body}|{now + offset}'.encode(), hashlib.sha256).hexdigest()}
                    self.assertIsNotNone(bot.ntfy_verify(json.dumps(msg), key, now + offset))
                    self.assertEqual(bot.poll_ntfy('fake', lambda _: [{'event': 'message', 'id': event, 'message': json.dumps(msg)}], now + offset), 1)
                saved_snapshots=[]
                real_save=bot.save
                def recording_save(db):
                    saved_snapshots.append(json.loads(json.dumps(db)))
                    real_save(db)
                with patch.object(bot, 'save', side_effect=recording_save):
                    deliver('내일 책 반납하기', 'create-request-001', 'first')
                self.assertEqual(len(saved_snapshots),1)
                self.assertTrue(saved_snapshots[0]['web_adds'][0]['ok'])
                deliver('내일 책 반납하기', 'create-request-001', 'retry',121)
                saved=bot.load()
                self.assertEqual(len(saved['items']),1)
                self.assertEqual(len(saved['web_adds']),1)
                deliver('날짜 없음', 'create-request-002', 'bad',122)
                deliver('삭제 1', 'create-request-003', 'command',123)
                saved=bot.load()
                self.assertEqual(len(saved['items']),1)
                self.assertEqual([r['ok'] for r in saved['web_adds']],[True,False,False])
                payload=publish.build_payload(saved,bot.today(),{})
                self.assertEqual(payload['add_receipts'],1)
                self.assertEqual(payload['add_results'],saved['web_adds'])

    def test_publisher_distinguishes_daily_and_weekday_rules(self):
        db={'items':[{'id':1,'kind':'daily','text':'운동'},{'id':2,'kind':'weekdays','text':'업무'}]}
        payload=publish.build_payload(db,bot.dt.date(2026,10,21),{})
        self.assertEqual({x.get('kind') for x in payload['items']},{'daily','weekdays'})
        self.assertEqual({x['edit']['kind'] for x in payload['rules']},{'daily','weekdays'})

@unittest.skipUnless(BOT_DIR, 'Set SCHEDULE_BOT_DIR to test the installed bot')
class BotPushRegistrationTest(unittest.TestCase):
    def test_subscription_save_triggers_publication_and_publishes_only_endpoint_hashes(self):
        import alarm
        key, now = 'fake-sub-key', int(time.time())
        subscription={'endpoint':'https://push.invalid/test','keys':{'auth':'fake','p256dh':'fake'}}
        text=json.dumps(subscription)
        message={'a':'sub','text':text,'ts':now,'sig':hmac.new(key.encode(),f'sub||{text}|{now}'.encode(),hashlib.sha256).hexdigest()}
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'data.json'
            path.write_text(json.dumps({'items':[],'next_id':1}),encoding='utf-8')
            with (patch.multiple(bot,SELFTEST=True,DATA=str(path),PAGE=str(Path(temp)/'page.html'),NTFY_STATE=str(Path(temp)/'ntfy.json')),
                  patch.object(bot,'ntfy_conf',return_value={'key':key,'topic':'fake-topic'}),patch.object(bot,'say'),patch.object(bot,'log'),
                  patch.object(alarm,'add_subscription',return_value='등록'),patch.object(bot,'save',wraps=bot.save) as saved):
                self.assertEqual(bot.poll_ntfy('fake',lambda _:[{'event':'message','id':'fake-sub','message':json.dumps(message)}],now),1)
                self.assertEqual(saved.call_count,1,'registration must trigger the normal publish-on-save path')
            with (patch.multiple(publish,SITE=temp,STATE=str(Path(temp)/'publish-state.json')),
                  patch.object(publish,'read_password',return_value='fake-test-password'),patch.object(publish,'names',return_value={}),
                  patch.object(bot,'wx_place',return_value=None),patch.object(bot,'ntfy_conf',return_value={'key':key,'topic':'fake-topic'}),
                  patch.object(alarm,'vapid_keys',return_value={'public':'fake-public-key'}),patch.object(alarm,'load_subs',return_value=[subscription]),
                  patch.object(publish,'git',return_value=''),patch.object(publish,'encrypt',side_effect=lambda payload,*_:payload)):
                publish.publish({'items':[],'next_id':1})
                payload=json.loads((Path(temp)/'data.enc.json').read_text(encoding='utf-8'))
                self.assertEqual(payload['push']['registered'],[hashlib.sha256(subscription['endpoint'].encode()).hexdigest()])
                self.assertNotIn(subscription['endpoint'],json.dumps(payload))
