# Web schedule editing

`web_edit.py` runs beside the existing `bot.py` and `publish.py`; it is not browser code. The two patches record the integration with those existing scripts. They add signed `edit` requests, editable metadata and encrypted result receipts. The installed listener must be restarted after deploying the module and patches, then the publisher must run before edit controls become available.

Edits keep the original ID and registration history. A revision covers the original item and the name masking table. Stale revisions and invalid patches change no item fields. Request IDs make retries idempotent. Masked names are restored only when their mapping is unambiguous; ambiguous text changes are rejected. No unmasked names are added to web payloads. Results are limited to the latest 30 requests.

The payload also advertises `done_dates: 1`. With that capability, completion requests put the selected occurrence's ISO date in the signed `text` field. The bot validates that the date belongs to the current schedule and is no later than tomorrow. It preserves later completion history when an older request arrives. Completion continues to cover all occurrences through the selected date; the history timestamp records the day the request is processed. Empty-text requests from older clients retain their existing behavior. Restart the installed listener and publish the updated payload before enabling this capability.

Set `SCHEDULE_BOT_DIR` to the installed bot folder when running the full checks:

```powershell
python -m unittest discover -s tests -p '*_test.py'
node --test tests/ui.test.cjs
```

The integration and browser bridge use synthetic items, keys and temporary storage. They stub all notifications and never publish live data.
