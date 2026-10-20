# Web schedule requests

`web_edit.py` runs beside the existing `bot.py` and `publish.py`; it is not browser code. The two patches record the integration with those existing scripts. They add signed `edit` requests, editable metadata and encrypted result receipts. The installed listener must be restarted after deploying the module and patches, then the publisher must run before edit controls become available.

Edits keep the original ID and registration history. A revision covers the original item and the name masking table. Stale revisions and invalid patches change no item fields. Request IDs make retries idempotent. Masked names are restored only when their mapping is unambiguous; ambiguous text changes are rejected. No unmasked names are added to web payloads. Results are limited to the latest 30 requests.

The payload also advertises `done_dates: 1`. With that capability, completion requests put the selected occurrence's ISO date in the signed `text` field. The bot validates that the date belongs to the current schedule and is no later than tomorrow. It preserves later completion history when an older request arrives. Completion continues to cover all occurrences through the selected date; the history timestamp records the day the request is processed. Empty-text requests from older clients retain their existing behavior. Restart the installed listener and publish the updated payload before enabling this capability.

Set `SCHEDULE_BOT_DIR` to the installed bot folder when running the full checks:

```powershell
python -m unittest discover -s tests -p '*_test.py'
node --test tests/ui.test.cjs
```

The integration and browser bridge use synthetic items, keys and temporary storage. They stub all notifications and never publish live data.

New clients use `create` only when `add_receipts: 1` is advertised. Its signed `text` is JSON containing `rid` and the original `text`. The handler prepares the new item without saving; the item and receipt are then saved together. Failed parsing also produces a receipt. The local `web_adds` ledger retains request identities, including deleted items, so manual retries cannot create duplicates. Only the latest 30 receipts are published; retrying an older request moves its existing receipt back into that window. Legacy plain-text `add` is still accepted. The browser keeps unconfirmed/failed input until the user explicitly clears its status and never infers success from matching titles.

Items include their full `kind` because `weekly` and `weekdays` share the old `k: 'w'`. Daily and weekday rules support text, time and category edits, and are excluded from overdue counts. Push registration publishes SHA-256 fingerprints of registered endpoints inside the encrypted payload; a browser subscription alone does not confirm that the bot registered the device.

The patches are cumulative against the original pre-edit source (UTF-8 text with LF newlines): `bot.py` SHA-256 `0bae67bc33563822395917806a9280bd6608960b1d1c338a9765c489205dd388`, `publish.py` SHA-256 `21c87560d96bf0f56c1c526795a34fc6a8f20a34b547155979d3358b8ca0ee5b`. They include the already-installed Korean date and daily/weekday support. Apply them to that baseline, not over an already-patched listener. Deploy `web_edit.py` with the updated bot and publisher, restart the listener, then publish. Unit tests load the repository module explicitly; integration checks use `SCHEDULE_BOT_DIR` separately.

Reliability: verified request timestamps are retained and interpreted in Korea time for both create and legacy add. Requests are marked consumed only after handling succeeds; reply failures do not repeat saved actions. Transient storage errors are retried on the next poll within the existing 24-hour request validity. Future one-time items beyond the repeating occurrence window remain available to search and edit. Automated publication commits only data.enc.json and leaves unrelated staged source intact.

Memo weather uses the existing current-weather response, with decorative rain/snow only. It makes no extra weather requests, does not intercept input, can be switched off, and respects reduced motion. Missing or failed weather clears the effect.
