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

A normal publish of an author-confirmed public article attempts delivery inside
that same server action. The outbox is the record of that attempt. The admin
retry control is recovery for a not-consumed response, not the way every
article is sent. There is no scheduler. On a serverless host the attempt lives
only as long as that invocation: if the platform freezes or kills the function
before the intake responds, the row stays pending and can be retried only while
`issued_at` is still inside five minutes. Nothing in this app polls or retries
later by itself.

The intake's five-minute freshness window applies to a new `post.published`
event (`issued_at` no older than five minutes and no more than 60 seconds in
the future). A revocation may be sent after five minutes. A retry of an
unconsumed `503` uses the same event id and only while that timestamp is still
inside five minutes.

HTTP `200` with `ok: true` and `sent: true` is accepted and is not retried.
HTTP `200` with `ok: true`, `sent: false`, and `result` of `duplicate`, `stale`,
`ignored`, `expired`, `skipped`, `republish`, `uncertain`, or `revoked` is
terminal and is not retried. HTTP `503` with `ok: false` and `error` of
`not live`, `not sent`, or `recheck failed` (spaces, not underscores) was not
consumed. The same event id may be retried only inside five minutes. Any other
status or body is held for review and is not sent again. Stored notes use
`not_live`, `not_sent`, and `recheck_failed` only as names for those three
wire values.

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
is not handed off later except by the single catch-up below. Edits and
republishes do not create a second publish once one was accepted or terminally
recorded as a duplicate, republish, revoked, or uncertain result. `revoked`
closes that event; it does not by itself block a later draft-to-published
transition. `distribution_access` classifies redistribution consent. It does
not enforce payment or membership.

## Catch-up

There is one catch-up. When `LABS_MIRROR_CATCHUP_ENABLED` is exactly `true`,
`/admin/distribution` selects the newest author-confirmed public article and
attempts that one handoff immediately. It does not select an older article, and
it does not ask anyone to run a second catch-up elsewhere. The intake dedupes
by post id and its own destination, so the same post is not posted twice. The
flag ships unset. If that single attempt is an unconsumed `503`, the same event
id can be retried from this page only while it is still inside five minutes.
