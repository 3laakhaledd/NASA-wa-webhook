# spen-wa-webhook

SPEN WhatsApp insights over Evolution API, now with up to 3 connected numbers ("lines").

- `GET /connect` : scan QR (or get a pairing code) for each line. Missing Evolution instances are created automatically.
- `GET /lines` : connection status of every line.
- Line 1 keeps the legacy routes (`/insights`, `/chats`, `/search`...). Lines 2 and 3: `/line/2/insights`, `/line/3/chats`, etc.
- `/groups` and `/groups/members` accept `?line=2`.
- Daily 05:00 import runs every connected line; tasks from lines 2/3 end with `[Line N]`.

Env: `EVO_INSTANCES` (default `<EVO_INSTANCE>,<EVO_INSTANCE>-2,<EVO_INSTANCE>-3`), optional `CONNECT_KEY` to lock `/connect` and `/lines` behind `?key=`.

## Private daily phone-number list

`GET /insights/numbers?date=YYYY-MM-DD&offset=0&limit=50&unresolvedOffset=0`

Lines 2 and 3 use `/line/2/insights/numbers` and `/line/3/insights/numbers`. Retrieve each requested line separately. The explicit date is a Riyadh calendar day; today's result is a snapshot at `snapshotAt`, not a promise about the rest of the day. It reuses the verified daily-message job (two passes, exhausted pagination, verified account identity).

Set a strong random `WA_REPORT_READ_TOKEN` in the deployment's secret environment. Clients must send it in the `Authorization: Bearer <token>` header over HTTPS. Never put the token or contact identifiers in URLs. Without configuration the route returns 503; without valid authorization it returns 401. An authenticated client/connector is needed: public web fetchers cannot call this private endpoint. Existing public routes are unchanged.

Poll `status=running` until `status=complete` and `coverage.complete=true`. All individual conversations with inbound OR outbound records in the date window are considered, not just unanswered conversations. Group/broadcast/status conversations are excluded from the individual-contact list.

Resolution uses direct phone JIDs, explicit message alternate phone identifiers, inbound sender phone identifiers, and, where needed, matching group-roster LID-to-phone pairs. The connected account is excluded. Conflicting mappings remain unresolved. Numeric LIDs are never treated as phone numbers. The service cannot manufacture numbers that WhatsApp has not exposed.

`contacts` contains phone numbers in international `+` format, names, mapping sources, and merged thread counts. Confirmed aliases are deduplicated within each school line. `uniquePhoneNumbers`, `resolvedThreads`, `unresolvedThreads`, and `individualThreads` distinguish phone totals from raw threads. `unresolved` lists names/reasons without internal IDs. `phoneNumbersComplete=false` means the phone-number list is incomplete even when message coverage is complete. An unresolved thread is not necessarily a distinct person.

Follow BOTH `pagination.nextOffset` (set `offset`) and `unresolvedPagination.nextOffset` (set `unresolvedOffset`) until null. Limits are capped at 200. Do not mistake the existing weekly number report's unanswered-burst subset for all daily contacts.

Tests: `node --test phone-numbers.test.js` (synthetic fixtures, no WhatsApp writes). Deploy the code and configure private authentication before live verification. No message sending, read-state changes, ClickUp command execution, or task creation is performed by this endpoint.
