"""Test-only bridge: fake input -> installed verifier/storage/publisher -> fake output."""
import datetime as dt
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from unittest.mock import patch

sys.path.insert(0, os.environ['SCHEDULE_BOT_DIR'])
import bot
import publish

request = json.load(sys.stdin)
with tempfile.TemporaryDirectory() as temp:
    path = Path(temp) / 'fake-data.json'
    path.write_text(json.dumps(request['db']), encoding='utf-8')
    with (patch.multiple(bot, SELFTEST=True, DATA=str(path), PAGE=str(Path(temp) / 'fake-page.html'),
                        NTFY_STATE=str(Path(temp) / 'fake-ntfy.json')),
          patch.object(bot, 'ntfy_conf', return_value={'key': 'test-only-key', 'topic': 'schedule-ui-test'}),
          patch.object(bot, 'say'), patch.object(bot, 'log'),
          patch.object(publish, 'names', return_value={'테스트상사': 'T사'})):
        if request.get('body'):
            events = [{'event': 'message', 'id': 'browser-edit-event', 'message': json.dumps(request['body'], ensure_ascii=False)}]
            assert bot.poll_ntfy('fake-chat', lambda _: events, int(time.time())) == 1
        db = bot.load()
        payload = publish.build_payload(db, dt.date.fromisoformat(request['today']), publish.names())
        json.dump({'db': db, 'payload': payload}, sys.stdout, ensure_ascii=False)
