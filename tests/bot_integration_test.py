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


if __name__ == '__main__':
    unittest.main()
