"""No live data, notifications or network: exercise the web edit transaction."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('repository_web_edit', Path(__file__).resolve().parents[1] / 'server' / 'web_edit.py')
web_edit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(web_edit)

CATS = ['업무', '미팅', '차량', '개인', '경기', '기타']
NAMES = {'테스트상사': 'T사'}


class WebEditTest(unittest.TestCase):
    def test_unit_tests_load_the_repository_module(self):
        self.assertEqual(Path(web_edit.__file__).resolve(), Path(__file__).resolve().parents[1] / 'server' / 'web_edit.py')

    def setUp(self):
        self.assertIsNotNone(web_edit, 'The web edit transaction is not implemented')
        self.item = {'id': 7, 'kind': 'once', 'date': '2026-10-20', 'text': '테스트상사 미팅',
                     'time': '14:00', 'cat': '업무', 'added': '2026-10-18', 'added_at': '2026-10-18T08:00'}
        self.db = {'next_id': 9, 'items': [self.item, {'id': 8, 'kind': 'note', 'text': '다른 메모'}], 'done_log': []}

    def command(self, changes, rid='11111111-1111-4111-8111-111111111111', rev=None):
        return json.dumps({'rid': rid, 'rev': rev or web_edit.revision(self.item, NAMES), 'changes': changes}, ensure_ascii=False)

    def test_edit_keeps_identity_history_other_items_and_real_names(self):
        old_rev = web_edit.revision(self.item, NAMES)
        result = web_edit.apply_edit(self.db, 7, self.command({'text': 'T사 계약 검토', 'date': '2026-10-17', 'time': '09:30', 'cat': '미팅'}), NAMES, CATS)
        self.assertTrue(result['ok'])
        self.assertEqual(self.item['text'], '테스트상사 계약 검토')
        self.assertEqual((self.item['id'], self.item['added'], self.item['added_at']), (7, '2026-10-18', '2026-10-18T08:00'))
        self.assertEqual((self.item['date'], self.item['time'], self.item['cat']), ('2026-10-17', '09:30', '미팅'))
        self.assertFalse(web_edit.is_memo(self.item), 'moving a task into the past must not silently turn it into a memo')
        self.assertEqual((self.db['next_id'], self.db['items'][1]['text'], self.db['done_log']), (9, '다른 메모', []))
        self.assertNotEqual(old_rev, web_edit.revision(self.item, NAMES))

    def test_stale_revision_does_not_overwrite_a_newer_change(self):
        command = self.command({'text': '덮어쓰려는 내용'})
        self.item['time'] = '16:00'
        before = copy.deepcopy(self.db['items'])
        result = web_edit.apply_edit(self.db, 7, command, NAMES, CATS)
        self.assertFalse(result['ok'])
        self.assertEqual(result['code'], 'conflict')
        self.assertEqual(self.db['items'], before)

    def test_a_changed_name_mapping_also_invalidates_the_old_view(self):
        command = self.command({'text': 'T사 계약 검토'})
        before = copy.deepcopy(self.item)
        result = web_edit.apply_edit(self.db, 7, command, {'테스트상사': '새 표시명'}, CATS)
        self.assertFalse(result['ok'])
        self.assertEqual(result['code'], 'conflict')
        self.assertEqual(self.item, before)

    def test_invalid_fields_never_partially_change_the_item(self):
        for change in [{'date': '2026-02-30'}, {'time': '25:00'}, {'cat': '임의분류'}, {'text': '   '},
                       {'date': ''}, {'day': 3}, {'done_until': '2026-10-20'}, {'text': '<x>' * 1000}]:
            with self.subTest(change=change):
                db = copy.deepcopy(self.db)
                before = copy.deepcopy(db['items'])
                result = web_edit.apply_edit(db, 7, self.command({'text': '새 내용', **change}), NAMES, CATS)
                self.assertFalse(result['ok'])
                self.assertEqual(db['items'], before)

    def test_replaying_an_accepted_request_cannot_apply_it_twice(self):
        command = self.command({'time': ''})
        first = web_edit.apply_edit(self.db, 7, command, NAMES, CATS)
        self.assertTrue(first['ok'])
        self.item['cat'] = '개인'
        again = web_edit.apply_edit(self.db, 7, command, NAMES, CATS)
        self.assertEqual(again, first)
        self.assertEqual(len(self.db['web_edits']), 1)
        self.assertEqual(self.item['cat'], '개인')
        self.assertNotIn('time', self.item)

    def test_recurring_edits_preserve_completion_and_validate_repeat_day(self):
        self.item.update(kind='monthly', day=31, done_until='2026-10-16')
        result = web_edit.apply_edit(self.db, 7, self.command({'day': 25, 'time': '08:00'}), NAMES, CATS)
        self.assertTrue(result['ok'])
        self.assertEqual((self.item['day'], self.item['done_until']), (25, '2026-10-16'))
        self.item.update(kind='weekly', wd=4)
        result = web_edit.apply_edit(self.db, 7, self.command({'wd': 0}, rid='22222222-2222-4222-8222-222222222222'), NAMES, CATS)
        self.assertTrue(result['ok'])
        self.assertEqual(self.item['wd'], 0)
        result = web_edit.apply_edit(self.db, 7, self.command({'wd': True}, rid='33333333-3333-4333-8333-333333333333'), NAMES, CATS)
        self.assertFalse(result['ok'])

    def test_memos_can_gain_or_remove_their_date_without_becoming_tasks(self):
        self.item.clear()
        self.item.update(id=7, kind='note', text='책 기록', added='2026-10-18')
        result = web_edit.apply_edit(self.db, 7, self.command({'date': '2026-10-24', 'time': '09:00'}), NAMES, CATS)
        self.assertTrue(result['ok'])
        self.assertTrue(web_edit.is_memo(self.item))
        self.assertEqual(self.item['kind'], 'once')
        result = web_edit.apply_edit(self.db, 7, self.command({'date': '', 'time': ''}, rid='22222222-2222-4222-8222-222222222222'), NAMES, CATS)
        self.assertTrue(result['ok'])
        self.assertEqual(self.item['kind'], 'note')
        self.assertNotIn('date', self.item)

    def test_automatic_events_completed_and_deleted_items_cannot_be_edited(self):
        for fields in [{'event': True}, {'done_until': '2026-10-20'}]:
            db = copy.deepcopy(self.db)
            db['items'][0].update(fields)
            command = json.dumps({'rid': 'test-request-0001', 'rev': web_edit.revision(db['items'][0], NAMES), 'changes': {'text': '새 내용'}})
            before = copy.deepcopy(db['items'])
            self.assertFalse(web_edit.apply_edit(db, 7, command, NAMES, CATS)['ok'])
            self.assertEqual(db['items'], before)
        self.db['items'].clear()
        self.assertFalse(web_edit.apply_edit(self.db, 7, self.command({'text': '새 내용'}), NAMES, CATS)['ok'])

    def test_ambiguous_masked_names_are_rejected_instead_of_corrupting_text(self):
        self.item['text'] = '테스트상사와 T사 미팅'
        before = copy.deepcopy(self.item)
        result = web_edit.apply_edit(self.db, 7, self.command({'text': 'T사와 T사 계약'}), NAMES, CATS)
        self.assertFalse(result['ok'])
        self.assertEqual(self.item, before)

    def test_edit_spec_contains_no_unmasked_text_or_names(self):
        spec = web_edit.edit_spec(self.item)
        self.assertEqual((spec['kind'], spec['date']), ('once', '2026-10-20'))
        self.assertNotIn('테스트상사', json.dumps(spec, ensure_ascii=False))
        self.item['event'] = True
        self.assertIsNone(web_edit.edit_spec(self.item))

    def test_legacy_memo_inference_is_preserved_unless_explicitly_false(self):
        self.item.update(date='2026-10-10', memo=None)
        self.assertTrue(web_edit.is_memo(self.item))
        self.item['memo'] = False
        self.assertFalse(web_edit.is_memo(self.item))

    def test_daily_and_weekday_rules_keep_their_kind_when_editing(self):
        for kind in ('daily', 'weekdays'):
            item = {'id': 1, 'kind': kind, 'text': '반복 업무', 'time': '09:00', 'cat': '업무', 'done_until': '2026-10-20'}
            self.assertIsNotNone(web_edit.edit_spec(item))
            body = json.dumps({'rid': 'repeat-edit-' + kind, 'rev': web_edit.revision(item), 'changes': {'text': '변경한 업무', 'time': '10:00'}})
            self.assertTrue(web_edit.apply_edit({'items': [item]}, 1, body, {}, CATS)['ok'])
            self.assertEqual((item['kind'], item['text'], item['time'], item['done_until']), (kind, '변경한 업무', '10:00', '2026-10-20'))

    def test_old_add_retry_cannot_recreate_a_deleted_item_after_many_receipts(self):
        db = {'next_id': 1, 'items': []}
        def create(text):
            db['items'].append({'id': db['next_id'], 'text': text})
            db['next_id'] += 1
            return '저장'
        body = json.dumps({'rid': 'original-create-001', 'text': '처음 일정'})
        original = web_edit.apply_create(db, body, create)
        db['items'].clear()
        for i in range(35):
            web_edit.apply_create(db, json.dumps({'rid': f'other-create-{i:03}', 'text': []}), create)
        self.assertEqual(web_edit.apply_create(db, body, create), original)
        self.assertEqual(db['items'], [])
        self.assertEqual(db['web_adds'][-1]['rid'], 'original-create-001')


if __name__ == '__main__':
    unittest.main()
