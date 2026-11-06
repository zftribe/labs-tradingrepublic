# Public teaser event

Labs articles are public on the site once published. There is no membership or
paywall. `posts.distribution_access` is an author choice about a short teaser:

- `unknown` is the default for existing and new articles and is not eligible
- `public` allows a teaser when a draft is first published
- `withheld` refuses redistribution

Missing or any other access value is not eligible. The event never carries
article HTML, editor JSON, a destination, or a mention instruction.

## Delivery

When `FM_LABS_EVENT_SECRET` and `LABS_MIRROR_URL` are both set, the server
`POST`s to `<LABS_MIRROR_URL origin>/v1/labs-events`. The URL must be `https`,
with no username, password, query, or fragment. If either value is missing,
nothing is sent.

- `Content-Type: application/json`
- Body is UTF-8 canonical JSON: object keys sorted by UTF-16 code unit, no
  whitespace, no BOM, arrays left in order, `JSON.stringify` escaping, no
  `undefined` or non-finite numbers, at most 8192 bytes
- `X-TR-Labs-Signature: v1=<64 lowercase hex HMAC-SHA256 of the exact body bytes>`

```json
{
  "v": 1,
  "source": "tr-labs",
  "type": "post.published",
  "id": "<new event uuid>",
  "issued_at": "<database commit timestamp>",
  "post": {
    "id": "<post uuid>",
    "status": "published",
    "access": "public",
    "published_at": "<timestamp>",
    "title": "<bounded title>",
    "slug": "<slug>",
    "excerpt": "<bounded excerpt or null>",
    "cover_image_url": "<optional https url on an allowed host>"
  }
}
```

`access` is copied from the stored choice. A publish event is built only when
that value is exactly `public`, status is `published`, and `published_at` is
valid and not more than 60 seconds in the future. `id` is a new event UUID.
Retries of the same attempt reuse that id and `issued_at`.

`post.unpublished` and `post.access_changed` use the same envelope. They carry
the current status and access. They are created only when a publish attempt may
already have been accepted or is in flight. A pending publish that has not
started is suppressed instead.

The intake's five-minute freshness window applies to `post.published`
(`issued_at` no older than five minutes and no more than 60 seconds in the
future). Revocations are still sent after five minutes. Two different event ids
with the same `issued_at` are not retried after a `409`.

HTTP `200` with `sent: false` and result `duplicate`, `stale`, `ignored`,
`expired`, `skipped`, `republish`, or `uncertain` is terminal. `sent: true`
with result `uncertain` is also terminal and needs a human check. `503` with
`not_live` or `not_sent` leaves a publish retryable only inside the five-minute
window. A revocation `503` is not consumed and stays retryable. This process
does not poll.

## Current-row recheck

`GET /api/distribution/eligibility/<post uuid>` reads the current row with the
service role and returns only:

```json
{
  "v": 1,
  "source": "tr-labs",
  "type": "post.eligibility",
  "id": "<post uuid>",
  "issued_at": "<timestamp of this database read>",
  "post": {
    "id": "<post uuid>",
    "status": "<draft or published>",
    "access": "<unknown, public, or withheld>"
  }
}
```

`id` is the post id, not an event id. The response is canonical JSON, at most
8192 bytes, with the same signature header and `Cache-Control: no-store`. The
route is dynamic and does not cache the read. Only `published` plus access
exactly `public` passes. Any other signed status or access is a definitive
non-public result. A missing row, a failed read, or a missing signing secret
returns `503` with no signature, which leaves the intake event unconsumed.

The route signs only that fixed document for the row it just read. It does not
sign caller-supplied JSON. Anonymous database policies are unchanged: drafts and
article bodies are not granted to anonymous readers. The response has no title,
excerpt, body, or routing id.

The downstream bot calls `GET <FM_LABS_RECHECK_URL>/<post uuid>` before a live
send and before catch-up. The owner sets `FM_LABS_RECHECK_URL` to
`https://<this-site>/api/distribution/eligibility` with https and no user,
password, query, fragment, or trailing slash. This website does not store that
deployment address.

## What this does not guarantee

The website re-reads eligibility before it posts a publish event, suppresses a
not-yet-started publish when consent is withdrawn, and emits a newer revocation
when a publish may already have left. The bot re-reads this endpoint before it
creates a chat message. A change can still land after that read and before the
chat message is created. HMAC proves the body was signed. It does not recall a
message. There is no delete or edit of a message that was already posted.

Publish events are not replayed after the five-minute window. An article
published while delivery is off, or while the intake is down longer than that,
is not handed off later except by the single owner catch-up below. Edits and
republishes do not create a second publish once one was accepted or terminally
recorded as a duplicate, republish, or uncertain result.

## Catch-up

`/admin/distribution` can queue the newest author-confirmed public article when
`LABS_MIRROR_CATCHUP_ENABLED` is exactly `true`. It does not select an older
article if that one is already recorded, and it does not send. An admin retry
within five minutes is what attempts delivery. The flag ships unset.
