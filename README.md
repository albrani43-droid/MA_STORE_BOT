# M A Store — comments only

Deploy on existing Render web service with `npm install` and `npm start`.

Required Render environment variables:
- `PAGE_ACCESS_TOKEN`
- `VERIFY_TOKEN`
- `META_APP_SECRET`
- `PAGE_ID`
- `TARGET_POST_ID` (actual Facebook Page Post ID, often `PAGEID_POSTID`; NOT the share URL)

Optional: `GRAPH_API_VERSION` (defaults to `v23.0`).

Meta Page Webhooks must be subscribed to `feed`. The Page token/app needs the relevant approved Page messaging and engagement permissions. Meta Private Replies may be limited to one per comment within 7 days; availability and API support depend on the app and Meta version. Verify in a test before using in production.

The bot does not reply to incoming Messenger messages. It attempts a private reply first, then posts the public `تم رد على الخاص ✔️` only after private sending succeeds.

`processed` is in-memory only; process restarts may allow retrying. Meta usually rejects duplicate private replies, but for high volume use persistent deduplication.

Keep credentials in Render, not in GitHub. Suspend/unsuspend the service from Render when ready. `DATABASE_URL`, `PUBLIC_BASE_URL`, and `OPENAI_API_KEY` are not used by this simplified bot.
