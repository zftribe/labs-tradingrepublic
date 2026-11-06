import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACCESS_CHANGED_TYPE,
  ARTICLE_COLUMNS,
  BLOCKING_TERMINAL,
  ELIGIBILITY_COLUMNS,
  ELIGIBILITY_ROUTE,
  PUBLISH_TYPE,
  SIGNATURE_HEADER,
  UNPUBLISH_TYPE,
  buildEligibilityResponse,
  buildPublishEvent,
  buildRevocationEvent,
  canClassifyPost,
  canonicalJson,
  canonicalStamp,
  createMemoryStore,
  deliverEvent,
  deliveryOrder,
  eligibilityHttpFromRow,
  evaluatePublish,
  frozenPublishedAt,
  intakeAllowsPublic,
  interpretBotResponse,
  isMissingDistributionColumn,
  planDatabaseTransition,
  publishBlocks,
  publishFreshness,
  queueCatchUp,
  readMirrorConfig,
  resolveDeliveryUrl,
  signCanonicalBody,
  signatureHeader,
  slugPatchForSave,
  snapshotFrom,
  summarizeHandoff,
  teaserRequestForPublish,
  verifySignature,
  type ArticleSnapshot,
  type MirrorConfig,
  type OutboxEvent,
} from "./event.ts";

const POST = "11111111-1111-4111-8111-111111111111";
const EVENT = "33333333-3333-4333-8333-333333333333";
const ISSUED = "2026-11-06T01:00:01.000000Z";
const PUBLISHED = "2026-11-06T01:00:00.000000Z";
const NOW = Date.parse("2026-11-06T01:00:02.000Z");
const SECRET = "test-secret";
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function article(overrides: Partial<ArticleSnapshot> = {}): ArticleSnapshot {
  return {
    id: POST,
    authorId: "22222222-2222-4222-8222-222222222222",
    status: "published",
    distributionAccess: "public",
    publishedAt: PUBLISHED,
    title: "Hello",
    excerpt: "A note",
    slug: "hello",
    coverImageUrl: null,
    ...overrides,
  };
}

function publishEvent(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  const base = article();
  return {
    id: EVENT,
    postId: POST,
    type: PUBLISH_TYPE,
    issuedAt: ISSUED,
    status: "pending",
    terminalResult: null,
    origin: "transition",
    claimToken: null,
    claimedAt: null,
    attemptCount: 0,
    snapshot: snapshotFrom(base),
    ...overrides,
  };
}

function config(overrides: Partial<MirrorConfig> = {}): MirrorConfig {
  return {
    enabled: true,
    secret: SECRET,
    url: "https://intake.example/v1/labs-events",
    catchupEnabled: false,
    ...overrides,
  };
}

const PUBLISH_WIRE =
  '{"id":"33333333-3333-4333-8333-333333333333","issued_at":"2026-11-06T01:00:01.000000Z","post":{"access":"public","excerpt":"A note","id":"11111111-1111-4111-8111-111111111111","published_at":"2026-11-06T01:00:00.000000Z","slug":"hello","status":"published","title":"Hello"},"source":"tr-labs","type":"post.published","v":1}';

const ELIGIBILITY_WIRE =
  '{"id":"11111111-1111-4111-8111-111111111111","issued_at":"2026-11-06T01:00:02.123456Z","post":{"access":"public","id":"11111111-1111-4111-8111-111111111111","status":"published"},"source":"tr-labs","type":"post.eligibility","v":1}';

function keysOf(value: unknown, found = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    value.forEach((item) => keysOf(item, found));
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    found.add(key);
    keysOf(child, found);
  }
  return found;
}

test("canonical json sorts keys by UTF-16, preserves arrays, and rejects bad values", () => {
  assert.equal(canonicalJson({ b: 1, a: true, c: null }), '{"a":true,"b":1,"c":null}');
  assert.equal(canonicalJson({ a: 1, B: 2 }), '{"B":2,"a":1}');
  assert.equal(canonicalJson(["b", "a"]), '["b","a"]');
  assert.equal(canonicalJson({ text: 'say "hi"\n' }), '{"text":"say \\"hi\\"\\n"}');
  assert.equal(canonicalJson({ nested: { z: 1, a: [2, 1] } }), '{"nested":{"a":[2,1],"z":1}}');
  assert.throws(() => canonicalJson({ nope: undefined }));
  assert.throws(() => canonicalJson(Number.NaN));
  assert.equal(canonicalJson("ok").charCodeAt(0) === 0xfeff, false);
});

test("publish wire body is the canonical teaser and the signature covers those exact bytes", () => {
  const built = buildPublishEvent(article(), EVENT, ISSUED, null, NOW);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.event.canonical, PUBLISH_WIRE);
  const mac = createHmac("sha256", SECRET).update(Buffer.from(PUBLISH_WIRE, "utf8")).digest("hex");
  assert.equal(signCanonicalBody(SECRET, PUBLISH_WIRE), mac);
  assert.equal(signatureHeader(SECRET, PUBLISH_WIRE), `v1=${mac}`);
  assert.match(mac, /^[0-9a-f]{64}$/);
  assert.equal(verifySignature(SECRET, PUBLISH_WIRE, `v1=${mac}`), true);
  assert.equal(verifySignature(SECRET, `${PUBLISH_WIRE} `, `v1=${mac}`), false);
  assert.equal(verifySignature(SECRET, PUBLISH_WIRE, `v1=${mac.toUpperCase()}`), false);
  const parsed = JSON.parse(PUBLISH_WIRE) as { id: string; post: { id: string; access: string } };
  assert.notEqual(parsed.id, parsed.post.id);
  assert.equal(parsed.post.access, "public");
  const keys = keysOf(parsed);
  for (const forbidden of [
    "content_html",
    "content_json",
    "channel_id",
    "guild_id",
    "destination",
    "webhook",
    "discord",
    "mentions",
    "allowed_mentions",
    "token",
  ]) {
    assert.equal(keys.has(forbidden), false);
  }
});

test("eligibility wire uses the post id, omits article text, and signs the exact body", () => {
  const built = buildEligibilityResponse({
    postId: POST,
    status: "published",
    access: "public",
    issuedAt: "2026-11-06T01:00:02.123456Z",
    secret: SECRET,
  });
  assert.ok(built);
  assert.equal(built?.body, ELIGIBILITY_WIRE);
  const mac = createHmac("sha256", SECRET).update(Buffer.from(ELIGIBILITY_WIRE, "utf8")).digest("hex");
  assert.equal(built?.signature, `v1=${mac}`);
  const parsed = JSON.parse(ELIGIBILITY_WIRE) as {
    id: string;
    type: string;
    post: Record<string, string>;
  };
  assert.equal(parsed.id, POST);
  assert.equal(parsed.post.id, POST);
  assert.equal(parsed.type, "post.eligibility");
  assert.deepEqual(Object.keys(parsed.post).sort(), ["access", "id", "status"]);
  assert.equal(intakeAllowsPublic(parsed.post.status, parsed.post.access), true);
  assert.equal(built?.body.includes("Hello"), false);
  assert.equal(buildEligibilityResponse({
    postId: POST,
    status: "published",
    access: "public",
    issuedAt: ISSUED,
    secret: null,
  }), null);
});

test("only a signed published+public row passes; missing and non-public do not get a fake pass", () => {
  for (const access of ["unknown", "withheld", "paid", "private", "members", "member-only", ""]) {
    assert.equal(intakeAllowsPublic("published", access), false);
  }
  assert.equal(intakeAllowsPublic("draft", "public"), false);
  assert.equal(intakeAllowsPublic("published", "public"), true);
  const draft = eligibilityHttpFromRow({
    postId: POST,
    secret: SECRET,
    hasQuery: false,
    failed: false,
    row: { status: "draft", access: "public", issued_at: ISSUED },
  });
  assert.equal(draft.status, 200);
  assert.match(draft.signature ?? "", /^v1=[0-9a-f]{64}$/);
  const body = JSON.parse(draft.body) as { post: { status: string; access: string } };
  assert.equal(body.post.status, "draft");
  assert.equal(body.post.access, "public");
  assert.equal(intakeAllowsPublic(body.post.status, body.post.access), false);
  for (const result of [
    eligibilityHttpFromRow({
      postId: POST,
      secret: SECRET,
      hasQuery: false,
      failed: false,
      row: null,
    }),
    eligibilityHttpFromRow({
      postId: POST,
      secret: null,
      hasQuery: false,
      failed: false,
      row: { status: "published", access: "public", issued_at: ISSUED },
    }),
    eligibilityHttpFromRow({
      postId: POST,
      secret: SECRET,
      hasQuery: true,
      failed: false,
      row: { status: "published", access: "public", issued_at: ISSUED },
    }),
    eligibilityHttpFromRow({
      postId: POST,
      secret: SECRET,
      hasQuery: false,
      failed: true,
      row: { status: "published", access: "public", issued_at: ISSUED },
    }),
  ]) {
    assert.equal(result.status, 503);
    assert.equal(result.body, "");
    assert.equal(result.signature, null);
  }
});

test("eligibility and article reads do not ask for private body columns", () => {
  assert.equal(ELIGIBILITY_COLUMNS.includes("content_html"), false);
  assert.equal(ELIGIBILITY_COLUMNS.includes("title"), false);
  assert.equal(ELIGIBILITY_COLUMNS.includes("excerpt"), false);
  assert.equal(ARTICLE_COLUMNS.includes("content_html"), false);
  assert.equal(ARTICLE_COLUMNS.includes("content_json"), false);
  assert.equal(ELIGIBILITY_ROUTE, "/api/distribution/eligibility");
});

test("author authorization and publish regression helpers", () => {
  const author = { id: "author-1", role: "author" };
  assert.equal(canClassifyPost(author, "author-1"), true);
  assert.equal(canClassifyPost(author, "author-2"), false);
  assert.equal(canClassifyPost({ id: "admin-1", role: "admin" }, "author-2"), true);
  assert.equal(frozenPublishedAt("2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"), "2026-01-01T00:00:00.000Z");
  assert.equal(frozenPublishedAt(null, "2026-02-01T00:00:00.000Z"), "2026-02-01T00:00:00.000Z");
  assert.equal(slugPatchForSave("draft"), "refresh");
  assert.equal(slugPatchForSave("published"), "keep");
  assert.equal(teaserRequestForPublish("draft", "public"), true);
  assert.equal(teaserRequestForPublish("published", "public"), false);
  assert.equal(teaserRequestForPublish("draft", "unknown"), false);
  assert.equal(teaserRequestForPublish("draft", "withheld"), false);
  assert.equal(teaserRequestForPublish("draft", undefined), false);
  assert.equal(isMissingDistributionColumn({ code: "42703", message: "" }), true);
  assert.equal(isMissingDistributionColumn({ code: "23505", message: "duplicate" }), false);
});

test("missing, unknown, withheld, draft, and contradictory rows are ineligible", () => {
  assert.equal(evaluatePublish(null, NOW).ok, false);
  assert.equal(evaluatePublish(article({ distributionAccess: undefined }), NOW).reason, "unknown_access");
  assert.equal(evaluatePublish(article({ distributionAccess: "unknown" }), NOW).reason, "unknown_access");
  assert.equal(evaluatePublish(article({ distributionAccess: "withheld" }), NOW).reason, "not_public");
  assert.equal(evaluatePublish(article({ distributionAccess: "paid" }), NOW).reason, "not_public");
  assert.equal(evaluatePublish(article({ distributionAccess: "private" }), NOW).reason, "not_public");
  assert.equal(evaluatePublish(article({ distributionAccess: "members" }), NOW).reason, "not_public");
  assert.equal(evaluatePublish(article({ distributionAccess: "member-only" }), NOW).reason, "not_public");
  assert.equal(evaluatePublish(article({ status: "draft" }), NOW).reason, "contradictory");
  assert.equal(
    evaluatePublish(article({ publishedAt: "2026-11-06T01:02:30.000Z" }), NOW).reason,
    "future_or_invalid",
  );
  assert.equal(buildPublishEvent(article({ distributionAccess: "withheld" }), EVENT, ISSUED, null, NOW).ok, false);
  const dirty = buildPublishEvent(
    article({
      title: "Hello @everyone",
      coverImageUrl: "https://evil.example/a.png",
      content_html: "<p>secret</p>",
      content_json: { secret: true },
    } as ArticleSnapshot),
    EVENT,
    ISSUED,
    "https://abcd.supabase.co",
    NOW,
  );
  assert.equal(dirty.ok, true);
  if (!dirty.ok) return;
  assert.equal(dirty.event.canonical.includes("secret"), false);
  assert.equal(dirty.event.canonical.includes("evil.example"), false);
  assert.equal(dirty.event.canonical.includes("@everyone"), false);
  assert.equal(dirty.event.canonical.includes("everyone"), true);
});

test("safe cover is kept and private media is omitted", () => {
  const built = buildPublishEvent(
    article({
      coverImageUrl: "https://abcd.supabase.co/storage/v1/object/public/post-media/a.png?token=secret",
    }),
    EVENT,
    ISSUED,
    "https://abcd.supabase.co",
    NOW,
  );
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(
    JSON.parse(built.event.canonical).post.cover_image_url,
    "https://abcd.supabase.co/storage/v1/object/public/post-media/a.png",
  );
  assert.equal(built.event.canonical.includes("token"), false);
});

test("one genuine draft transition enqueues, edits and blocking republish do not", () => {
  const before = { status: "draft", distributionAccess: "unknown", publishedAt: null };
  const after = { status: "published", distributionAccess: "public", publishedAt: PUBLISHED };
  const first = planDatabaseTransition(before, after, [], NOW);
  assert.deepEqual(first, {
    suppressPendingPublish: false,
    enqueueRevocation: null,
    enqueuePublish: true,
  });
  const accepted = publishEvent({ status: "accepted" });
  const again = planDatabaseTransition(before, after, [accepted], NOW);
  assert.equal(again.enqueuePublish, false);
  assert.equal(publishBlocks([accepted]), true);
  const edited = planDatabaseTransition(after, after, [accepted], NOW);
  assert.equal(edited.enqueuePublish, false);
  assert.equal(edited.enqueueRevocation, null);
  const expired = publishEvent({ status: "terminal", terminalResult: "expired" });
  assert.equal(planDatabaseTransition(before, after, [expired], NOW).enqueuePublish, true);
  for (const result of BLOCKING_TERMINAL) {
    assert.equal(
      planDatabaseTransition(
        before,
        after,
        [publishEvent({ status: "terminal", terminalResult: result })],
        NOW,
      ).enqueuePublish,
      false,
    );
  }
});

test("revocation is planned only after a publish may have left, and withheld is not a new publish", () => {
  const open = { status: "published", distributionAccess: "public", publishedAt: PUBLISHED };
  const draft = { status: "draft", distributionAccess: "public", publishedAt: PUBLISHED };
  const pending = planDatabaseTransition(open, draft, [publishEvent()], NOW);
  assert.equal(pending.suppressPendingPublish, true);
  assert.equal(pending.enqueueRevocation, null);
  const accepted = planDatabaseTransition(open, draft, [publishEvent({ status: "accepted" })], NOW);
  assert.equal(accepted.enqueueRevocation, UNPUBLISH_TYPE);
  const withheld = planDatabaseTransition(
    open,
    { status: "published", distributionAccess: "withheld", publishedAt: PUBLISHED },
    [publishEvent({ status: "sending" })],
    NOW,
  );
  assert.equal(withheld.enqueueRevocation, ACCESS_CHANGED_TYPE);
  assert.equal(withheld.enqueuePublish, false);
  const optInLater = planDatabaseTransition(
    { status: "published", distributionAccess: "unknown", publishedAt: PUBLISHED },
    open,
    [],
    NOW,
  );
  assert.equal(optInLater.enqueuePublish, false);
});

test("revocation payload keeps the real access and does not force public", () => {
  const revoked = buildRevocationEvent(
    article({ status: "draft", distributionAccess: "withheld" }),
    UNPUBLISH_TYPE,
    EVENT,
    ISSUED,
    null,
  );
  assert.equal(revoked.ok, true);
  if (!revoked.ok) return;
  const parsed = JSON.parse(revoked.event.canonical) as {
    type: string;
    post: { status: string; access: string };
  };
  assert.equal(parsed.type, "post.unpublished");
  assert.equal(parsed.post.status, "draft");
  assert.equal(parsed.post.access, "withheld");
  assert.equal(
    buildRevocationEvent(article(), ACCESS_CHANGED_TYPE, EVENT, ISSUED, null).ok,
    false,
  );
});

test("a publish send rechecks eligibility and does not call the network when the row changed", async () => {
  const store = createMemoryStore({
    articles: [article({ distributionAccess: "withheld" })],
    events: [publishEvent()],
  });
  let calls = 0;
  const outcome = await deliverEvent({
    store,
    eventId: EVENT,
    config: config(),
    nowMs: NOW,
    supabaseUrl: null,
    newToken: () => "token-1",
    transport: async () => {
      calls += 1;
      return { status: 200, body: '{"ok":true,"sent":true}' };
    },
  });
  assert.equal(calls, 0);
  assert.equal(outcome.outcome, "suppressed");
  assert.equal(store.events.get(EVENT)?.status, "suppressed");
});

test("an eligible publish sends one signed body and a duplicate response is not retried", async () => {
  const store = createMemoryStore({ articles: [article()], events: [publishEvent()] });
  const calls: { body: string; signature: string | undefined }[] = [];
  const transport = async (_url: string, body: string, headers: Record<string, string>) => {
    calls.push({ body, signature: headers[SIGNATURE_HEADER] });
    return calls.length === 1
      ? { status: 200, body: '{"ok":true,"sent":false,"result":"duplicate"}' }
      : { status: 200, body: '{"ok":true,"sent":true}' };
  };
  const first = await deliverEvent({
    store,
    eventId: EVENT,
    config: config(),
    nowMs: NOW,
    supabaseUrl: null,
    newToken: () => "token-1",
    transport,
  });
  const second = await deliverEvent({
    store,
    eventId: EVENT,
    config: config(),
    nowMs: NOW,
    supabaseUrl: null,
    newToken: () => "token-2",
    transport,
  });
  assert.equal(first.outcome, "terminal");
  assert.equal(first.result, "duplicate");
  assert.equal(second.outcome, "terminal");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.body, PUBLISH_WIRE);
  assert.equal(calls[0]?.signature, signatureHeader(SECRET, PUBLISH_WIRE));
  assert.equal(store.events.get(EVENT)?.status, "terminal");
});

test("503 not sent retries the same id and 200 sent true is accepted without a second event", async () => {
  const store = createMemoryStore({ articles: [article()], events: [publishEvent()] });
  const bodies: string[] = [];
  let attempt = 0;
  const transport = async (_url: string, body: string) => {
    bodies.push(body);
    attempt += 1;
    return attempt === 1
      ? { status: 503, body: '{"ok":false,"error":"not sent"}' }
      : { status: 200, body: '{"ok":true,"sent":true}' };
  };
  const queued = await deliverEvent({
    store,
    eventId: EVENT,
    config: config(),
    nowMs: NOW,
    supabaseUrl: null,
    newToken: () => "token-a",
    transport,
  });
  const accepted = await deliverEvent({
    store,
    eventId: EVENT,
    config: config(),
    nowMs: NOW,
    supabaseUrl: null,
    newToken: () => "token-b",
    transport,
  });
  assert.equal(queued.outcome, "queued");
  assert.equal(queued.reason, "not_sent");
  assert.equal(accepted.outcome, "accepted");
  assert.equal(bodies.length, 2);
  assert.equal(JSON.parse(bodies[0] ?? "{}").id, JSON.parse(bodies[1] ?? "{}").id);
  assert.equal(store.events.get(EVENT)?.attemptCount, 2);
  assert.equal(store.events.get(EVENT)?.status, "accepted");
});

test("intake responses use the wire keys and unknown bodies are not retried", async () => {
  for (const result of ["duplicate", "stale", "ignored", "expired", "skipped", "republish", "uncertain", "revoked"]) {
    assert.deepEqual(
      interpretBotResponse(200, `{"ok":true,"sent":false,"result":"${result}"}`, PUBLISH_TYPE, ISSUED, NOW),
      { action: "terminal", result },
    );
  }
  assert.deepEqual(
    interpretBotResponse(200, '{"ok":true,"sent":true,"result":"uncertain"}', PUBLISH_TYPE, ISSUED, NOW),
    { action: "accepted" },
  );
  for (const error of ["not live", "not sent", "recheck failed"]) {
    assert.deepEqual(
      interpretBotResponse(503, `{"ok":false,"error":"${error}"}`, PUBLISH_TYPE, ISSUED, NOW),
      { action: "retry", reason: error.replace(/ /g, "_") },
    );
  }
  assert.deepEqual(
    interpretBotResponse(503, '{"ok":false,"error":"not_live"}', PUBLISH_TYPE, ISSUED, NOW),
    { action: "review", reason: "needs_review" },
  );
  assert.deepEqual(
    interpretBotResponse(503, '{"ok":false,"error":"elsewhere"}', UNPUBLISH_TYPE, ISSUED, NOW),
    { action: "review", reason: "needs_review" },
  );
  assert.deepEqual(
    interpretBotResponse(503, '{"ok":false,"error":"not live"}', PUBLISH_TYPE, ISSUED, NOW + 6 * 60 * 1000),
    { action: "review", reason: "window_closed" },
  );
  assert.deepEqual(summarizeHandoff([{ outcome: "accepted" }]), "accepted");
  assert.deepEqual(summarizeHandoff([{ outcome: "review", reason: "needs_review" }]), "needs_review");
  const store = createMemoryStore({ articles: [article()], events: [publishEvent()] });
  let calls = 0;
  const first = await deliverEvent({
    store,
    eventId: EVENT,
    config: config(),
    nowMs: NOW,
    supabaseUrl: null,
    newToken: () => "token-1",
    transport: async () => {
      calls += 1;
      return { status: 503, body: '{"ok":false,"error":"not_live"}' };
    },
  });
  const second = await deliverEvent({
    store,
    eventId: EVENT,
    config: config(),
    nowMs: NOW,
    supabaseUrl: null,
    newToken: () => "token-2",
    transport: async () => {
      calls += 1;
      return { status: 200, body: '{"ok":true,"sent":true}' };
    },
  });
  assert.equal(first.outcome, "review");
  assert.equal(second.outcome, "review");
  assert.equal(calls, 1);
  assert.equal(store.events.get(EVENT)?.status, "review");
});

test("a lost accept ack is not reported as accepted", async () => {
  const store = createMemoryStore({ articles: [article()], events: [publishEvent()] });
  store.markAccepted = async () => false;
  const outcome = await deliverEvent({
    store,
    eventId: EVENT,
    config: config(),
    nowMs: NOW,
    supabaseUrl: null,
    newToken: () => "token-1",
    transport: async () => ({ status: 200, body: '{"ok":true,"sent":true}' }),
  });
  assert.equal(outcome.outcome, "unconfirmed");
  assert.notEqual(store.events.get(EVENT)?.status, "accepted");
});

test("network failure leaves the event queued and a missing config does not call the network", async () => {
  const failed = createMemoryStore({ articles: [article()], events: [publishEvent()] });
  const failedOutcome = await deliverEvent({
    store: failed,
    eventId: EVENT,
    config: config(),
    nowMs: NOW,
    supabaseUrl: null,
    newToken: () => "token-1",
    transport: async () => {
      throw new Error("down");
    },
  });
  assert.equal(failedOutcome.reason, "network");
  assert.equal(failed.events.get(EVENT)?.status, "pending");

  const quiet = createMemoryStore({ articles: [article()], events: [publishEvent()] });
  let calls = 0;
  const quietOutcome = await deliverEvent({
    store: quiet,
    eventId: EVENT,
    config: config({ enabled: false, secret: null, url: null }),
    nowMs: NOW,
    supabaseUrl: null,
    newToken: () => "token-1",
    transport: async () => {
      calls += 1;
      return { status: 200, body: '{"ok":true,"sent":true}' };
    },
  });
  assert.equal(calls, 0);
  assert.equal(quietOutcome.reason, "unconfigured");
  assert.equal(quiet.events.get(EVENT)?.status, "pending");
});

test("a pending revocation is delivered before a pending publish", async () => {
  const revocationId = "44444444-4444-4444-8444-444444444444";
  const store = createMemoryStore({
    articles: [article({ status: "draft", distributionAccess: "withheld" })],
    events: [
      publishEvent(),
      publishEvent({
        id: revocationId,
        type: UNPUBLISH_TYPE,
        issuedAt: "2026-11-06T01:00:01.100000Z",
        snapshot: snapshotFrom(article({ status: "draft", distributionAccess: "withheld" })),
      }),
    ],
  });
  const sent: string[] = [];
  const deferred = await deliverEvent({
    store,
    eventId: EVENT,
    config: config(),
    nowMs: NOW,
    supabaseUrl: null,
    newToken: () => "token-p",
    transport: async (_url, body) => {
      sent.push(JSON.parse(body).type);
      return { status: 200, body: '{"ok":true,"sent":true}' };
    },
  });
  assert.equal(deferred.outcome, "deferred");
  assert.equal(sent.length, 0);
  const ordered = deliveryOrder(await store.listPendingForPost(POST));
  assert.equal(ordered[0]?.type, UNPUBLISH_TYPE);
  const revocation = await deliverEvent({
    store,
    eventId: revocationId,
    config: config(),
    nowMs: NOW,
    supabaseUrl: null,
    newToken: () => "token-r",
    transport: async (_url, body) => {
      sent.push(JSON.parse(body).type);
      return { status: 200, body: '{"ok":true,"sent":true}' };
    },
  });
  assert.equal(revocation.outcome, "accepted");
  assert.deepEqual(sent, ["post.unpublished"]);
  assert.equal(store.events.get(EVENT)?.status, "pending");
});

test("concurrent claims allow one send", async () => {
  const store = createMemoryStore({ articles: [article()], events: [publishEvent()] });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let second: Awaited<ReturnType<typeof deliverEvent>> | null = null;
  const first = deliverEvent({
    store,
    eventId: EVENT,
    config: config(),
    nowMs: NOW,
    supabaseUrl: null,
    newToken: () => "token-1",
    transport: async () => {
      second = await deliverEvent({
        store,
        eventId: EVENT,
        config: config(),
        nowMs: NOW,
        supabaseUrl: null,
        newToken: () => "token-2",
        transport: async () => ({ status: 200, body: '{"ok":true,"sent":true}' }),
      });
      await gate;
      return { status: 200, body: '{"ok":true,"sent":true}' };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  const winner = await first;
  assert.equal(winner.outcome, "accepted");
  assert.equal(second?.outcome, "queued");
  assert.equal(second?.reason, "contended");
  assert.equal(store.events.get(EVENT)?.attemptCount, 1);
});

test("stale recheck after claim suppresses the publish before the request", async () => {
  const store = createMemoryStore({ articles: [article()], events: [publishEvent()] });
  const original = store.getArticle.bind(store);
  let reads = 0;
  store.getArticle = async (id) => {
    reads += 1;
    if (reads > 1) {
      store.articles.set(id, article({ distributionAccess: "withheld" }));
    }
    return original(id);
  };
  let calls = 0;
  const outcome = await deliverEvent({
    store,
    eventId: EVENT,
    config: config(),
    nowMs: NOW,
    supabaseUrl: null,
    newToken: () => "token-1",
    transport: async () => {
      calls += 1;
      return { status: 200, body: '{"ok":true,"sent":true}' };
    },
  });
  assert.equal(calls, 0);
  assert.equal(outcome.reason, "ineligible");
  assert.equal(store.events.get(EVENT)?.status, "suppressed");
});

test("catch-up is admin-only, off by default, and does not walk past the latest row", async () => {
  const older = article({
    id: "55555555-5555-4555-8555-555555555555",
    slug: "older",
    title: "Older",
    publishedAt: "2026-10-01T00:00:00.000000Z",
  });
  const latest = article({ title: "" });
  const store = createMemoryStore({ articles: [older, latest] });
  let inserts = 0;
  const original = store.insertCatchup.bind(store);
  store.insertCatchup = async (...args) => {
    inserts += 1;
    return original(...args);
  };
  const denied = await queueCatchUp({
    actorRole: "author",
    enabled: true,
    nowMs: NOW,
    supabaseUrl: null,
    allocateId: () => EVENT,
    allocateIssuedAt: () => ISSUED,
    store,
  });
  const disabled = await queueCatchUp({
    actorRole: "admin",
    enabled: false,
    nowMs: NOW,
    supabaseUrl: null,
    allocateId: () => EVENT,
    allocateIssuedAt: () => ISSUED,
    store,
  });
  const none = await queueCatchUp({
    actorRole: "admin",
    enabled: true,
    nowMs: NOW,
    supabaseUrl: null,
    allocateId: () => EVENT,
    allocateIssuedAt: () => ISSUED,
    store,
  });
  assert.equal(denied.ok, false);
  assert.equal(disabled.ok, false);
  assert.equal(none.ok, false);
  if (!none.ok) assert.equal(none.reason, "none");
  assert.equal(inserts, 0);

  const fresh = createMemoryStore({ articles: [older, article()] });
  const queued = await queueCatchUp({
    actorRole: "admin",
    enabled: true,
    nowMs: NOW,
    supabaseUrl: null,
    allocateId: () => EVENT,
    allocateIssuedAt: () => "2026-11-06T01:00:03.000000Z",
    store: fresh,
  });
  assert.equal(queued.ok, true);
  if (queued.ok) assert.equal(queued.publicationId, POST);
  const second = await queueCatchUp({
    actorRole: "admin",
    enabled: true,
    nowMs: NOW,
    supabaseUrl: null,
    allocateId: () => "66666666-6666-4666-8666-666666666666",
    allocateIssuedAt: () => "2026-11-06T01:00:04.000000Z",
    store: fresh,
  });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, "catchup_already_used");
  assert.equal([...fresh.events.values()].filter((event) => event.origin === "catchup").length, 1);
});

test("delivery stays disabled without a secret or https intake url", () => {
  assert.deepEqual(readMirrorConfig({}), {
    enabled: false,
    secret: null,
    url: null,
    catchupEnabled: false,
  });
  assert.equal(readMirrorConfig({ LABS_MIRROR_CATCHUP_ENABLED: "TRUE" }).catchupEnabled, false);
  assert.equal(resolveDeliveryUrl("http://intake.example"), null);
  assert.equal(resolveDeliveryUrl("https://user:pass@intake.example"), null);
  assert.equal(resolveDeliveryUrl("https://intake.example/v1/labs-events?x=1"), null);
  assert.equal(resolveDeliveryUrl("https://intake.example"), "https://intake.example/v1/labs-events");
  assert.equal(publishFreshness(ISSUED, NOW), "fresh");
  assert.equal(publishFreshness(ISSUED, NOW + 6 * 60 * 1000), "expired");
  assert.equal(canonicalStamp("2026-11-06 01:00:00.123456+00"), "2026-11-06T01:00:00.123456Z");
});

test("migration defaults to unknown and the recheck route is uncached", () => {
  const sql = readFileSync(join(root, "supabase/migrations/0002_public_teaser.sql"), "utf8");
  assert.match(sql, /default 'unknown'/);
  assert.doesNotMatch(sql, /update\s+public\.posts\s+set\s+distribution_access/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on table public\.distribution_outbox from anon, authenticated/i);
  assert.match(sql, /revoke all on function public\.distribution_eligibility\(uuid\) from anon, authenticated/i);
  const eligibilityFn = sql.slice(
    sql.indexOf("function public.distribution_eligibility"),
    sql.indexOf("revoke all on function public.distribution_eligibility"),
  );
  assert.doesNotMatch(eligibilityFn, /content_html|excerpt|title|cover_image_url/);
  assert.match(eligibilityFn, /posts\.distribution_access/);
  assert.match(eligibilityFn, /clock_timestamp\(\)/);
  const route = readFileSync(
    join(root, "app/api/distribution/eligibility/[id]/route.ts"),
    "utf8",
  );
  assert.match(route, /force-dynamic/);
  assert.match(route, /no-store/);
  assert.doesNotMatch(route, /content_html/);
  const runtime = readFileSync(join(root, "lib/distribution/runtime.ts"), "utf8");
  assert.doesNotMatch(runtime, /127\.0\.0\.1/);
  assert.doesNotMatch(runtime, /DISCORD_BOT_TOKEN/);
  assert.doesNotMatch(runtime, /content_html/);
  assert.doesNotMatch(runtime, /from "next\/server"/);
  const publish = readFileSync(join(root, "app/dashboard/actions.ts"), "utf8");
  assert.match(publish, /await handoffPublication\(id\)/);
  assert.doesNotMatch(publish, /schedulePublicationHandoff|after\(/);
  const admin = readFileSync(join(root, "app/admin/actions.ts"), "utf8");
  assert.match(admin, /handoffPublication\(result\.publicationId\)/);
});
