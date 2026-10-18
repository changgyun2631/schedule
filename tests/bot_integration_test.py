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
