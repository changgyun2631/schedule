"""Signed web edits: validate a whole patch before changing an existing item."""
import datetime as dt
import hashlib
import json
import re


def revision(item, names=None):
    data = json.dumps([item, names or {}], ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(data.encode('utf-8')).hexdigest()


def is_memo(item):
    return (item['kind'] == 'note' or bool(item.get('memo')) or
            (item.get('memo') is not False and item['kind'] == 'once' and item['date'] < (item.get('added') or '')))


def edit_spec(item, names=None):
    if item.get('event') or item['kind'] not in ('once', 'note', 'weekly', 'monthly', 'daily', 'weekdays') or (item['kind'] == 'once' and item.get('done_until')):
        return None
    return {'rev': revision(item, names), 'kind': item['kind'], 'memo': is_memo(item),
            **{k: item[k] for k in ('date', 'day', 'wd') if k in item}}


def restore_names(original, text, names):
    visible = original
    for real, alias in names.items():
        visible = visible.replace(real, alias)
    if text == visible:
        return original
    pairs = {alias: real for real, alias in names.items() if real != alias and real in original}
    for alias in pairs:
        if not alias or alias in original or list(names.values()).count(alias) != 1:
            raise ValueError('가려진 이름이 겹쳐 내용을 안전하게 바꿀 수 없어요. 내용은 텔레그램에서 바꿔 주세요.')
    if not pairs:
        return text
    pattern = '|'.join(re.escape(s) for s in sorted(pairs, key=len, reverse=True))
    return re.sub(pattern, lambda m: pairs[m[0]], text)


def apply_edit(db, item_id, body, names, categories):
    if not isinstance(body, str) or len(body) > 10000:
        raise ValueError('잘못된 수정 요청')
    command = json.loads(body)
    if not isinstance(command, dict) or not isinstance(command.get('rid'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{10,64}', command['rid']):
        raise ValueError('수정 요청 번호가 올바르지 않아요')
    rid = command['rid']
    for result in db.get('web_edits', []):
        if result['rid'] == rid:
            if result['id'] != item_id:
                raise ValueError('수정 요청 번호가 겹쳤어요')
            return result
    result = {'rid': rid, 'id': item_id, 'ok': False, 'at': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')}
    try:
        item = next((x for x in db['items'] if x['id'] == item_id), None)
        if item is None:
            raise ValueError('이미 삭제된 일정이에요. 새로고침 후 확인해 주세요.')
        if not edit_spec(item, names):
            raise ValueError('자동 경기 일정이나 완료한 일정은 수정할 수 없어요.')
        if command.get('rev') != revision(item, names):
            result['code'] = 'conflict'
            raise ValueError('다른 곳에서 먼저 바뀐 일정이에요. 새로고침 후 다시 수정해 주세요.')
        changes = command.get('changes')
        if not isinstance(changes, dict) or not changes or set(changes) - {'text', 'date', 'time', 'cat', 'day', 'wd', 'archived', 'pinned', 'checklist', 'to_schedule'}:
            raise ValueError('수정할 항목이 올바르지 않아요.')
        new = item.copy()
        memo = is_memo(item)
        for field, value in changes.items():
            if field == 'pinned':
                if not memo or type(value) is not bool:
                    raise ValueError('메모만 상단에 고정할 수 있어요.')
                if value:
                    new['pinned'] = True
                else:
                    new.pop('pinned', None)
            elif field == 'checklist':
                if (not memo and not item.get('checklist')) or not isinstance(value, str) or len(value) > 4000 or any(ord(c) < 32 and c not in '\n\t' for c in value):
                    raise ValueError('체크리스트는 4000자 이내로 적어 주세요.')
                lines = [line.strip() for line in value.splitlines() if line.strip()]
                if len(lines) > 40 or any(not re.sub(r'^\[[xX ]\]\s*', '', line).strip() for line in lines):
                    raise ValueError('체크리스트는 내용이 있는 항목을 최대 40개까지 적어 주세요.')
                if lines:
                    new['checklist'] = restore_names(item.get('checklist', ''), '\n'.join(lines), names)
                else:
                    new.pop('checklist', None)
            elif field == 'to_schedule':
                if not memo or value is not True:
                    raise ValueError('메모만 일정으로 전환할 수 있어요.')
            elif field == 'archived':
                if not memo or type(value) is not bool:
                    raise ValueError('메모만 보관하거나 보관 해제할 수 있어요.')
                if value:
                    new['archived'] = True
                else:
                    new.pop('archived', None)
            elif field == 'text':
                if not isinstance(value, str) or not value.strip() or len(value) > 2000 or any(ord(c) < 32 and c not in '\n\t' for c in value):
                    raise ValueError('내용은 1~2000자로 적어 주세요.')
                new['text'] = restore_names(item['text'], value.strip(), names)
            elif field == 'cat':
                if value not in categories:
                    raise ValueError('분류가 올바르지 않아요.')
                new['cat'] = value
            elif field == 'time':
                if not isinstance(value, str) or (value and not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', value)):
                    raise ValueError('시간은 00:00~23:59로 적어 주세요.')
                if value:
                    new['time'] = value
                else:
                    new.pop('time', None)
            elif field == 'date':
                if item['kind'] not in ('once', 'note') or not isinstance(value, str):
                    raise ValueError('반복 일정은 반복 요일이나 날짜를 바꿔 주세요.')
                if value:
                    if not re.fullmatch(r'(?:20\d\d|2100)-\d{2}-\d{2}', value):
                        raise ValueError('날짜는 2000~2100년의 실제 날짜로 적어 주세요.')
                    try:
                        dt.date.fromisoformat(value)
                    except ValueError:
                        raise ValueError('실제로 존재하는 날짜로 적어 주세요.') from None
                    new.update(kind='once', date=value, memo=memo)
                elif memo:
                    new.update(kind='note', memo=True)
                    new.pop('date', None)
                else:
                    raise ValueError('일정 날짜를 선택해 주세요.')
            elif field in ('day', 'wd'):
                low, high, kind = (1, 31, 'monthly') if field == 'day' else (0, 6, 'weekly')
                if item['kind'] != kind or type(value) is not int or not low <= value <= high:
                    raise ValueError('반복 날짜나 요일이 올바르지 않아요.')
                new[field] = value
        if changes.get('to_schedule'):
            if not new.get('date'):
                raise ValueError('일정으로 전환할 날짜를 선택해 주세요.')
            new.update(kind='once', memo=False)
            new.pop('archived', None)
            new.pop('pinned', None)
        if new['kind'] == 'note' and new.get('time'):
            raise ValueError('알림 시간을 쓰려면 날짜도 선택해 주세요.')
        item.clear()
        item.update(new)
        result.update(ok=True, message='수정했어요.')
    except ValueError as error:
        result['message'] = str(error)
    db['web_edits'] = (db.get('web_edits', []) + [result])[-30:]
    return result


def apply_create(db, body, create):
    """The caller saves the item and receipt together; retries reuse the receipt."""
    command = json.loads(body)
    if not isinstance(command, dict) or not isinstance(command.get('rid'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{10,64}', command['rid']):
        raise ValueError('추가 요청 번호가 올바르지 않아요.')
    rid = command['rid']
    previous = next((r for r in db.get('web_adds', []) if r['rid'] == rid), None)
    if previous:
        db['web_adds'] = [r for r in db['web_adds'] if r['rid'] != rid] + [previous]
        return previous
    result = {'rid': rid, 'ok': False, 'at': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')}
    try:
        text = command.get('text')
        if not isinstance(text, str) or not text.strip() or len(text) > 10000:
            raise ValueError('추가할 내용은 1~10000자로 적어 주세요.')
        before = db['next_id']
        message = create(text)
        item = next((x for x in db['items'] if x['id'] == before), None)
        result.update(ok=item is not None, message='추가했어요.' if item else message)
        if item:
            result['id'] = item['id']
    except ValueError as error:
        result['message'] = str(error)
    # Keep receipt identities after deletion too; a delayed retry must not recreate an item.
    db['web_adds'] = db.get('web_adds', []) + [result]
    return result
