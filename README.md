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

Resolution uses direct phone JIDs, explicit message alternate phone identifiers, inbound sender phone identifiers, saved contacts, chat metadata, matching group-roster LID-to-phone pairs, and recent messages from each selected LID thread. Older sampled messages are identity evidence only, never included in the requested transcript. The connected account is excluded. Conflicting mappings remain unresolved. Numeric LIDs are never treated as phone numbers. The service cannot manufacture numbers that WhatsApp has not exposed. Mapping-source failures are explicitly reported in warnings.

`contacts` contains phone numbers in international `+` format, names, mapping sources, and merged thread counts. Confirmed aliases are deduplicated within each school line. `uniquePhoneNumbers`, `resolvedThreads`, `unresolvedThreads`, and `individualThreads` distinguish phone totals from raw threads. `unresolved` lists names/reasons without internal IDs. `phoneNumbersComplete=false` means the phone-number list is incomplete even when message coverage is complete. An unresolved thread is not necessarily a distinct person.

Follow BOTH `pagination.nextOffset` (set `offset`) and `unresolvedPagination.nextOffset` (set `unresolvedOffset`) until null. Limits are capped at 200. Do not mistake the existing weekly number report's unanswered-burst subset for all daily contacts.

## Private ClickUp time-window transcript (no new HTTP read token needed)

Use the existing authorized WA Reports command bridge, only after approval to create the command task and post its private result:

`RUN: daily-chats 2026-11-09 11:00 13:00 line 1 ending 6444`

The existing two-minute command processor runs this server-side using the existing Evolution and ClickUp credentials. It does not depend on `WA_REPORT_READ_TOKEN`. Never trigger the public command-processing route for this workflow. The new command returns results only to the initiating task in the configured private report list, not to a public URL. Creating a command task causes private report comments to be posted; it is not a side-effect-free HTTP read.

Times use 24-hour Asia/Riyadh time, start inclusive and end exclusive. The command verifies the connected school account before and after retrieval and retrieves the exact time window with the existing two-pass exhausted-pagination collector. It includes both sent and received individual-chat records, merges confirmed phone aliases, supplies transcript text, direction, local timestamps, message type and verified phone numbers, and explicitly flags missing numbers. Group, broadcast and status threads are excluded from this individual-contact report. No WhatsApp sends, read receipts, or settings changes are performed.

The existing command processor chunks long results into comments. Reassemble all comment chunks in order before parsing the JSON or creating a PDF. No claim of live success should be made until the deployed command has been executed and its coverage and phone-number completeness checked.

Tests: `node --test phone-numbers.test.js` (synthetic fixtures, no WhatsApp writes). Deploy the code before live verification. Private HTTP access still requires its own configured header token; the ClickUp command bridge is the alternative, not a public-authentication bypass.

## Direct ClickUp MCP and CX tools (v1.1.0)

The existing NASA service exposes stateless Streamable HTTP MCP at `/mcp`, without creating ClickUp tasks. Set a random secret of at least 32 characters as `NASA_WA_MCP_API_KEY` privately in Railway. In ClickUp Custom MCP, use the service's HTTPS `/mcp` URL and send the same secret in `X-API-Key` or `Authorization: Bearer`. No credentials, contact filters or identifiers belong in query strings. Missing/weak configuration fails closed with 503; unauthorized requests receive 401. Existing key/URL can be retained on upgrade. Refresh/reconnect the ClickUp MCP connection to rediscover eight tools after deployment. Discovery is not proof that real reporting succeeded.

The original tools remain: `nasa_wa_connection_status`, `nasa_wa_daily_report`, `nasa_wa_daily_messages`.

Five read-only CX tools are added:

- `nasa_wa_follow_up_queue`: required `line`, `fromDate`, `throughDate` (must be today's Riyadh date); optional `minWaitingMinutes`, `offset`, `limit`. Verifies later stored messages through a visible snapshot, merges confirmed phone aliases, and returns contacts ending inbound as candidates requiring transcript review. This does not establish a real unanswered request, unread status, or semantic resolution. Requests outside the explicit lookback are not assessed.
- `nasa_wa_contact_history`: required distinct `lines`, international `number` (for example a synthetic `+966500000001`), `fromDate`, `throughDate`; optional `offset`, `limit`. Returns only evidence-verified matches and retains school-line associations. Unresolved aliases can make history incomplete even when stored-message coverage is verified. Display names and numeric LIDs are not phone evidence.
- `nasa_wa_response_metrics`: required `line`, dates, `workingDays` (`0=Sunday` through `6=Saturday`), `openTime`, `closeTime`, and `slaMinutes`; optional pagination. No default school schedule/SLA is assumed. Same-day shifts only; closeTime may be `24:00`. Measures within-window inbound text bursts until a later eligible school text event. Separates responded/pending episodes and SLA breaches. Captions may count as text; uncaptioned media, reactions and filenames do not. Same-second opposite directions are excluded. An event is not proof of a meaningful answer, first-ever response, or resolution. Holidays are not inferred.
- `nasa_wa_unread_snapshot`: required `line`, optional pagination. Reuses read-only unread lookups, groups verified aliases, excludes self, reports unresolved threads and separate group counters, and checks counters before/after. Counter sums across aliases may overlap. No mark-as-read/settings changes; other devices can change counters independently. Sender display names are not substituted for group subjects.
- `nasa_wa_group_insights`: required `line`, `date`; optional `view` (`groups` or `messages`), exact `groupName` OR `groupId`, and pagination. Message view requires a group selection from inventory. Group subjects come from actual current metadata, not sender names, and are not guaranteed historical names. Missing subjects remain null. Does not export participant numbers.

Range tools accept at most 14 Riyadh calendar days and reject future/reversed dates. Larger periods must be split into smaller ranges. A window over 50,000 stored records fails rather than silently truncating. Jobs are bounded, line-local, and verified with the existing two-pass collector; poll `running` with the same arguments and never treat failed/running as zero. Today ends at the retrieval snapshot, not future midnight. Confirm account identity, window and coverage; follow every `pagination.nextOffset` until null. Message coverage and phone completeness remain independent. Caches are short-lived and accounts are rechecked before cached reports are returned.

MCP never invokes sending, pairing, reconnecting, task/comment creation, group member export or arbitrary API routes. The server's existing Evolution credentials stay server-side; no additional secret is required for these five tools. HIS is untouched. Tests use synthetic fixtures: `node --test mcp-reporting.test.js`.
