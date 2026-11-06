// Public teaser handoff for a downstream research bot.
//
// Labs has no membership or paywall. A published article is already public on
// the site. `distribution_access` is a separate author choice about whether a
// short public teaser may leave the site. Missing and `unknown` are not
// eligible. This module never reads article HTML or editor JSON, and it never
// chooses a chat destination.
//
// The intake authenticates event bodies with HMAC. That does not prove the
// article is still free when a chat message is later created, and nothing here
// can recall a message that was already posted. Publish sends re-read the
// current row first. The intake also GETs /api/distribution/eligibility/<post id>
// and accepts only a signed current-row document. See docs/public-teaser-event.md.

import { createHmac, timingSafeEqual } from "node:crypto";

export const EVENT_VERSION = 1;
export const EVENT_SOURCE = "tr-labs";
export const PUBLISH_TYPE = "post.published";
export const UNPUBLISH_TYPE = "post.unpublished";
export const ACCESS_CHANGED_TYPE = "post.access_changed";
export const ELIGIBILITY_TYPE = "post.eligibility";
export const SIGNATURE_HEADER = "X-TR-Labs-Signature";
export const DELIVERY_PATH = "/v1/labs-events";
export const MAX_BODY_BYTES = 8192;
export const PUBLISH_MAX_AGE_MS = 5 * 60 * 1000;
export const MAX_FUTURE_MS = 60 * 1000;
export const CLAIM_STALE_MS = 2 * 60 * 1000;
export const TITLE_MAX = 180;
export const EXCERPT_MAX = 500;
export const CANONICAL_HOST = "labs.tradingrepublic.io";

export const DISTRIBUTION_ACCESS_VALUES = ["unknown", "public", "withheld"] as const;
export type DistributionAccess = (typeof DISTRIBUTION_ACCESS_VALUES)[number];

export const TERMINAL_RESULTS = [
  "duplicate",
  "stale",
  "ignored",
  "expired",
  "skipped",
  "republish",
  "uncertain",
] as const;

/** Terminal intake results that mean a later publish must not be issued. */
export const BLOCKING_TERMINAL = new Set<string>([
  "duplicate",
  "stale",
  "ignored",
  "skipped",
  "republish",
  "uncertain",
]);

export const ARTICLE_COLUMNS =
  "id, author_id, status, distribution_access, published_at, title, excerpt, slug, cover_image_url";
export const ELIGIBILITY_COLUMNS = "status, distribution_access";
export const ELIGIBILITY_ROUTE = "/api/distribution/eligibility";

export type EventType =
  | typeof PUBLISH_TYPE
  | typeof UNPUBLISH_TYPE
  | typeof ACCESS_CHANGED_TYPE;

export interface ArticleSnapshot {
  id: string;
  authorId: string;
  status: string;
  distributionAccess: string | null | undefined;
  publishedAt: string | null;
  title: string;
  excerpt: string | null;
  slug: string;
  coverImageUrl: string | null;
}

export interface TeaserSnapshot {
  status: string;
  access: string;
  publishedAt: string | null;
  title: string;
  slug: string;
  excerpt: string | null;
  coverImageUrl: string | null;
}

export interface OutboxEvent {
  id: string;
  postId: string;
  type: EventType;
  issuedAt: string;
  status: "pending" | "sending" | "accepted" | "terminal" | "suppressed";
  terminalResult: string | null;
  origin: "transition" | "catchup";
  claimToken: string | null;
  claimedAt: string | null;
  attemptCount: number;
  snapshot: TeaserSnapshot;
}

export interface MirrorConfig {
  enabled: boolean;
  secret: string | null;
  url: string | null;
  catchupEnabled: boolean;
}

export interface PostGate {
  status: string;
  distributionAccess: string | null | undefined;
  publishedAt: string | null;
}

export function parseDistributionAccess(value: unknown): DistributionAccess | null {
  if (value === "unknown" || value === "public" || value === "withheld") return value;
  return null;
}

export function canClassifyPost(
  actor: { id: string; role: string },
  authorId: string,
): boolean {
  return actor.role === "admin" || actor.id === authorId;
}

export function frozenPublishedAt(existing: string | null, nowIso: string): string {
  return existing ?? nowIso;
}

export function slugPatchForSave(status: string): "refresh" | "keep" {
  return status === "draft" ? "refresh" : "keep";
}

export function teaserRequestForPublish(
  beforeStatus: string,
  access: string | null | undefined,
): boolean {
  return beforeStatus === "draft" && access === "public";
}

export function isMissingDistributionColumn(error: {
  code?: string;
  message?: string;
}): boolean {
  const code = error.code ?? "";
  if (code === "42703" || code === "PGRST204") return true;
  const message = (error.message ?? "").toLowerCase();
  return (
    message.includes("distribution_access") &&
    (message.includes("does not exist") || message.includes("schema cache"))
  );
}

export function isMissingOutbox(error: { code?: string; message?: string }): boolean {
  const code = error.code ?? "";
  if (code === "42P01" || code === "PGRST205") return true;
  const message = (error.message ?? "").toLowerCase();
  return (
    message.includes("distribution_outbox") &&
    (message.includes("does not exist") || message.includes("schema cache"))
  );
}

export function canonicalJson(value: unknown): string {
  return encodeCanonical(value);
}

function encodeCanonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("nonfinite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => encodeCanonical(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      if (typeof record[key] === "undefined") throw new Error("undefined");
      parts.push(`${JSON.stringify(key)}:${encodeCanonical(record[key])}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new Error("unsupported");
}

export function signCanonicalBody(secret: string, canonicalBody: string): string {
  if (!secret) throw new Error("missing_secret");
  return createHmac("sha256", secret)
    .update(Buffer.from(canonicalBody, "utf8"))
    .digest("hex");
}

export function signatureHeader(secret: string, canonicalBody: string): string {
  return `v1=${signCanonicalBody(secret, canonicalBody)}`;
}

export function verifySignature(
  secret: string,
  canonicalBody: string,
  header: string | null,
): boolean {
  if (!secret || !header) return false;
  const match = /^v1=([0-9a-f]{64})$/.exec(header.trim());
  if (!match) return false;
  const expected = Buffer.from(signCanonicalBody(secret, canonicalBody), "hex");
  const got = Buffer.from(match[1], "hex");
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}

const STAMP =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00(?::00)?)?$/;

export function canonicalStamp(input: string | null | undefined): string | null {
  if (!input) return null;
  const match = STAMP.exec(input.trim());
  if (!match) return null;
  const frac = match[3] ? match[3].slice(0, 6) : "";
  return frac
    ? `${match[1]}T${match[2]}.${frac}Z`
    : `${match[1]}T${match[2]}Z`;
}

export function timestampMillis(stamp: string): number | null {
  const canonical = canonicalStamp(stamp);
  if (!canonical) return null;
  const match = STAMP.exec(canonical);
  if (!match) return null;
  const frac = (match[3] ?? "").padEnd(3, "0").slice(0, 3);
  const parsed = Date.parse(`${match[1]}T${match[2]}.${frac}Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

export function publishFreshness(
  issuedAt: string,
  nowMs: number,
): "fresh" | "expired" | "too_future" | "invalid" {
  const ms = timestampMillis(issuedAt);
  if (ms === null) return "invalid";
  if (nowMs - ms > PUBLISH_MAX_AGE_MS) return "expired";
  if (ms - nowMs > MAX_FUTURE_MS) return "too_future";
  return "fresh";
}

export function publishedAtAllowed(
  publishedAt: string | null | undefined,
  nowMs: number,
): boolean {
  if (!publishedAt) return false;
  const ms = timestampMillis(publishedAt);
  if (ms === null) return false;
  return ms <= nowMs + MAX_FUTURE_MS;
}

function clampText(input: string, max: number): string {
  const chars = Array.from(input);
  return chars.length <= max ? input : chars.slice(0, max).join("");
}

function publicText(input: string, max: number): string {
  const cleaned = input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/@everyone/gi, "everyone")
    .replace(/@here/gi, "here");
  return clampText(cleaned, max);
}

export function safeCoverUrl(
  raw: string | null | undefined,
  supabaseUrl: string | null,
): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const path = url.pathname;
  if (url.host === CANONICAL_HOST) {
    return `https://${CANONICAL_HOST}${path}`;
  }
  if (!supabaseUrl) return null;
  let supabase: URL;
  try {
    supabase = new URL(supabaseUrl);
  } catch {
    return null;
  }
  if (url.host !== supabase.host) return null;
  if (!path.startsWith("/storage/v1/object/public/post-media/")) return null;
  return `https://${url.host}${path}`;
}

function uuidOk(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function slugOk(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 160;
}

export interface BuiltEvent {
  canonical: string;
  bytes: number;
}

export function buildPublishEvent(
  article: ArticleSnapshot,
  eventId: string,
  issuedAt: string,
  supabaseUrl: string | null,
  nowMs: number,
): { ok: true; event: BuiltEvent } | { ok: false; reason: string } {
  const decision = evaluatePublish(article, nowMs);
  if (!decision.ok) return decision;
  return buildEvent(PUBLISH_TYPE, article, eventId, issuedAt, supabaseUrl, true);
}

export function evaluatePublish(
  article: ArticleSnapshot | null,
  nowMs: number,
): { ok: true } | { ok: false; reason: string } {
  if (!article) return { ok: false, reason: "missing" };
  const access = article.distributionAccess;
  if (access == null || access === "" || access === "unknown") {
    return { ok: false, reason: "unknown_access" };
  }
  if (access !== "public") return { ok: false, reason: "not_public" };
  if (article.status !== "published") return { ok: false, reason: "contradictory" };
  if (!publishedAtAllowed(article.publishedAt, nowMs)) {
    return article.publishedAt
      ? { ok: false, reason: "future_or_invalid" }
      : { ok: false, reason: "future_or_invalid" };
  }
  if (!uuidOk(article.id)) return { ok: false, reason: "bad_id" };
  if (!slugOk(article.slug)) return { ok: false, reason: "bad_slug" };
  if (!publicText(article.title, TITLE_MAX)) return { ok: false, reason: "empty_title" };
  return { ok: true };
}

function buildEvent(
  type: EventType,
  article: ArticleSnapshot,
  eventId: string,
  issuedAt: string,
  supabaseUrl: string | null,
  requirePublic: boolean,
): { ok: true; event: BuiltEvent } | { ok: false; reason: string } {
  if (!uuidOk(eventId) || !uuidOk(article.id)) return { ok: false, reason: "bad_id" };
  if (!canonicalStamp(issuedAt)) return { ok: false, reason: "bad_issued_at" };
  const access = article.distributionAccess ?? "unknown";
  if (requirePublic) {
    if (access !== "public" || article.status !== "published") {
      return { ok: false, reason: "ineligible" };
    }
    if (!article.publishedAt || !canonicalStamp(article.publishedAt)) {
      return { ok: false, reason: "future_or_invalid" };
    }
  } else if (type === UNPUBLISH_TYPE) {
    if (article.status === "published") return { ok: false, reason: "contradictory" };
  } else if (type === ACCESS_CHANGED_TYPE) {
    if (article.status !== "published" || access === "public") {
      return { ok: false, reason: "contradictory" };
    }
  }
  if (!slugOk(article.slug)) return { ok: false, reason: "bad_slug" };
  const title = publicText(article.title, TITLE_MAX);
  if (!title) return { ok: false, reason: "empty_title" };
  const excerptText = article.excerpt ? publicText(article.excerpt, EXCERPT_MAX) : "";
  const post: Record<string, unknown> = {
    id: article.id,
    status: article.status,
    access,
    published_at: canonicalStamp(article.publishedAt),
    title,
    slug: article.slug,
    excerpt: excerptText ? excerptText : null,
  };
  const cover = safeCoverUrl(article.coverImageUrl, supabaseUrl);
  if (cover) post.cover_image_url = cover;
  const payload = {
    v: EVENT_VERSION,
    source: EVENT_SOURCE,
    type,
    id: eventId,
    issued_at: canonicalStamp(issuedAt),
    post,
  };
  let canonical: string;
  try {
    canonical = canonicalJson(payload);
  } catch {
    return { ok: false, reason: "canonical" };
  }
  const bytes = Buffer.byteLength(canonical, "utf8");
  if (canonical.charCodeAt(0) === 0xfeff) return { ok: false, reason: "bom" };
  if (bytes > MAX_BODY_BYTES) return { ok: false, reason: "oversize" };
  return { ok: true, event: { canonical, bytes } };
}

export function buildRevocationEvent(
  article: ArticleSnapshot,
  type: typeof UNPUBLISH_TYPE | typeof ACCESS_CHANGED_TYPE,
  eventId: string,
  issuedAt: string,
  supabaseUrl: string | null,
): { ok: true; event: BuiltEvent } | { ok: false; reason: string } {
  return buildEvent(type, article, eventId, issuedAt, supabaseUrl, false);
}

export function resolveDeliveryUrl(configured: string | undefined): string | null {
  if (!configured?.trim()) return null;
  let url: URL;
  try {
    url = new URL(configured.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.search || url.hash) return null;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path !== "/" && path !== DELIVERY_PATH) return null;
  return `${url.origin}${DELIVERY_PATH}`;
}

export function readMirrorConfig(env: NodeJS.ProcessEnv): MirrorConfig {
  const secret = env.FM_LABS_EVENT_SECRET?.trim() ?? "";
  const url = resolveDeliveryUrl(env.LABS_MIRROR_URL);
  return {
    enabled: Boolean(secret && url),
    secret: secret || null,
    url,
    catchupEnabled: env.LABS_MIRROR_CATCHUP_ENABLED === "true",
  };
}

export interface TransitionPlan {
  suppressPendingPublish: boolean;
  enqueueRevocation: typeof UNPUBLISH_TYPE | typeof ACCESS_CHANGED_TYPE | null;
  enqueuePublish: boolean;
}

export function isPublishGateOpen(post: PostGate, nowMs: number): boolean {
  return (
    post.status === "published" &&
    post.distributionAccess === "public" &&
    publishedAtAllowed(post.publishedAt, nowMs)
  );
}

export function publishBlocks(existing: OutboxEvent[]): boolean {
  return existing.some(
    (event) =>
      event.type === PUBLISH_TYPE &&
      (event.status === "pending" ||
        event.status === "sending" ||
        event.status === "accepted" ||
        (event.status === "terminal" &&
          event.terminalResult != null &&
          BLOCKING_TERMINAL.has(event.terminalResult))),
  );
}

export function planDatabaseTransition(
  before: PostGate,
  after: PostGate,
  existing: OutboxEvent[],
  nowMs: number,
): TransitionPlan {
  const wasOpen = isPublishGateOpen(before, nowMs);
  const nowOpen = isPublishGateOpen(after, nowMs);
  let enqueueRevocation: TransitionPlan["enqueueRevocation"] = null;
  if (wasOpen && !nowOpen) {
    const visible = existing.some(
      (event) =>
        event.type === PUBLISH_TYPE &&
        (event.status === "accepted" ||
          event.status === "sending" ||
          (event.status === "terminal" && event.terminalResult === "uncertain")),
    );
    const revocationOpen = existing.some(
      (event) =>
        event.type !== PUBLISH_TYPE &&
        (event.status === "pending" || event.status === "sending"),
    );
    if (visible && !revocationOpen) {
      enqueueRevocation =
        after.status !== "published" ? UNPUBLISH_TYPE : ACCESS_CHANGED_TYPE;
    }
  }
  const enqueuePublish =
    before.status === "draft" && nowOpen && !publishBlocks(existing);
  const suppressPendingPublish = wasOpen && !nowOpen;
  return { suppressPendingPublish, enqueueRevocation, enqueuePublish };
}

export type Interpret =
  | { action: "accepted" }
  | { action: "terminal"; result: string }
  | { action: "retry"; reason: string };

function resultCode(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as { result?: unknown };
    if (!parsed || typeof parsed !== "object" || typeof parsed.result !== "string") {
      return null;
    }
    return parsed.result.trim().toLowerCase().replace(/\s+/g, "_");
  } catch {
    return null;
  }
}

export function interpretBotResponse(
  status: number,
  rawBody: string,
  eventType: EventType,
  issuedAt: string,
  nowMs: number,
): Interpret {
  const publishExpired =
    eventType === PUBLISH_TYPE && publishFreshness(issuedAt, nowMs) === "expired";
  if (status === 200) {
    let sent: unknown;
    let result = "";
    try {
      const parsed = JSON.parse(rawBody) as { sent?: unknown; result?: unknown };
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { action: "terminal", result: "uncertain" };
      }
      sent = parsed.sent;
      if (typeof parsed.result === "string") {
        result = parsed.result.trim().toLowerCase().replace(/\s+/g, "_");
      }
    } catch {
      return { action: "terminal", result: "uncertain" };
    }
    if (sent === true && result === "uncertain") {
      return { action: "terminal", result: "uncertain" };
    }
    if (sent === true) return { action: "accepted" };
    if (sent === false && (TERMINAL_RESULTS as readonly string[]).includes(result)) {
      return { action: "terminal", result };
    }
    return { action: "terminal", result: "uncertain" };
  }
  if (status === 409) return { action: "terminal", result: "issued_at_conflict" };
  if (status >= 300 && status < 400) return { action: "terminal", result: "rejected" };
  if (status === 503) {
    const result = resultCode(rawBody) ?? "not_live";
    if (result === "not_sent") {
      if (publishExpired) return { action: "terminal", result: "expired" };
      return { action: "retry", reason: "not_sent" };
    }
    if (publishExpired || (eventType === PUBLISH_TYPE && publishFreshness(issuedAt, nowMs) !== "fresh")) {
      return { action: "terminal", result: "expired" };
    }
    return { action: "retry", reason: "not_live" };
  }
  if (status === 429 || status === 502 || status === 504 || status >= 500) {
    if (publishExpired) return { action: "terminal", result: "expired" };
    return { action: "retry", reason: `http_${status}` };
  }
  if (status >= 400) return { action: "terminal", result: "rejected" };
  return { action: "terminal", result: "rejected" };
}

export interface DeliveryStore {
  getEvent(id: string): Promise<OutboxEvent | null>;
  getArticle(postId: string): Promise<ArticleSnapshot | null>;
  listPendingForPost(postId: string): Promise<OutboxEvent[]>;
  claim(
    id: string,
    token: string,
    nowIso: string,
    staleBeforeIso: string,
  ): Promise<OutboxEvent | null>;
  markAccepted(id: string, token: string): Promise<boolean>;
  markTerminal(id: string, token: string, result: string): Promise<boolean>;
  markPending(id: string, token: string, error: string): Promise<boolean>;
  suppressClaimed(id: string, token: string, result: string): Promise<boolean>;
  expirePending(id: string): Promise<boolean>;
  suppressPendingPublish(postId: string): Promise<void>;
  suppressPending(id: string, result: string): Promise<boolean>;
}

export interface DeliveryOutcome {
  outcome:
    | "missing"
    | "accepted"
    | "terminal"
    | "suppressed"
    | "deferred"
    | "queued"
    | "unconfirmed";
  reason?: string;
  result?: string;
}

function materialize(
  article: ArticleSnapshot | null,
  event: OutboxEvent,
): ArticleSnapshot {
  if (article) return article;
  return {
    id: event.postId,
    authorId: "",
    status: event.snapshot.status,
    distributionAccess: event.snapshot.access,
    publishedAt: event.snapshot.publishedAt,
    title: event.snapshot.title,
    excerpt: event.snapshot.excerpt,
    slug: event.snapshot.slug,
    coverImageUrl: event.snapshot.coverImageUrl,
  };
}

export function deliveryOrder(events: OutboxEvent[]): OutboxEvent[] {
  return [...events].sort((a, b) => {
    const rank = (event: OutboxEvent) => (event.type === PUBLISH_TYPE ? 1 : 0);
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    if (a.issuedAt < b.issuedAt) return -1;
    if (a.issuedAt > b.issuedAt) return 1;
    return 0;
  });
}

export async function deliverEvent(args: {
  store: DeliveryStore;
  eventId: string;
  config: MirrorConfig;
  nowMs: number;
  supabaseUrl: string | null;
  newToken: () => string;
  transport: (
    url: string,
    body: string,
    headers: Record<string, string>,
  ) => Promise<{ status: number; body: string }>;
}): Promise<DeliveryOutcome> {
  const event = await args.store.getEvent(args.eventId);
  if (!event) return { outcome: "missing" };
  if (event.status === "accepted") return { outcome: "accepted" };
  if (event.status === "terminal" || event.status === "suppressed") {
    return { outcome: "terminal", result: event.terminalResult ?? undefined };
  }

  const article = await args.store.getArticle(event.postId);
  const pending = await args.store.listPendingForPost(event.postId);
  if (event.type === PUBLISH_TYPE) {
    const revocationFirst = pending.some(
      (item) =>
        item.id !== event.id &&
        item.type !== PUBLISH_TYPE &&
        (item.status === "pending" || item.status === "sending"),
    );
    if (revocationFirst) return { outcome: "deferred" };
    if (!article || !evaluatePublish(article, args.nowMs).ok) {
      if (event.status === "pending") await args.store.suppressPendingPublish(event.postId);
      return { outcome: "suppressed", reason: "ineligible" };
    }
    const fresh = publishFreshness(event.issuedAt, args.nowMs);
    if (fresh === "expired" || fresh === "invalid") {
      await args.store.expirePending(event.id);
      return { outcome: "terminal", result: "expired" };
    }
    if (fresh === "too_future") return { outcome: "queued", reason: "too_future" };
    if (!args.config.enabled || !args.config.url || !args.config.secret) {
      return { outcome: "queued", reason: "unconfigured" };
    }
  } else if (!args.config.enabled || !args.config.url || !args.config.secret) {
    return { outcome: "queued", reason: "unconfigured" };
  } else if (article && evaluatePublish(article, args.nowMs).ok) {
    if (event.status === "pending") {
      await args.store.suppressPending(event.id, "superseded");
    }
    return { outcome: "suppressed", reason: "superseded" };
  }

  const token = args.newToken();
  const staleBefore = new Date(args.nowMs - CLAIM_STALE_MS).toISOString();
  const claimed = await args.store.claim(
    event.id,
    token,
    new Date(args.nowMs).toISOString(),
    staleBefore,
  );
  if (!claimed) return { outcome: "queued", reason: "contended" };

  const freshArticle = await args.store.getArticle(event.postId);
  const source =
    event.type === PUBLISH_TYPE
      ? freshArticle
      : freshArticle
        ? freshArticle
        : materialize(null, claimed);
  if (!source) {
    await args.store.suppressClaimed(claimed.id, token, "missing");
    return { outcome: "suppressed", reason: "missing" };
  }
  if (event.type === PUBLISH_TYPE) {
    if (!freshArticle || !evaluatePublish(freshArticle, args.nowMs).ok) {
      await args.store.suppressClaimed(claimed.id, token, "revoked_before_send");
      return { outcome: "suppressed", reason: "ineligible" };
    }
  } else if (freshArticle && evaluatePublish(freshArticle, args.nowMs).ok) {
    await args.store.suppressClaimed(claimed.id, token, "superseded");
    return { outcome: "suppressed", reason: "superseded" };
  }

  const revocationType =
    event.type === ACCESS_CHANGED_TYPE ? ACCESS_CHANGED_TYPE : UNPUBLISH_TYPE;
  let payloadSource = source;
  if (event.type === UNPUBLISH_TYPE && !freshArticle) {
    payloadSource = { ...payloadSource, status: "draft" };
  }
  if (event.type === PUBLISH_TYPE && publishFreshness(claimed.issuedAt, args.nowMs) !== "fresh") {
    const marked = await args.store.markTerminal(claimed.id, token, "expired");
    return marked
      ? { outcome: "terminal", result: "expired" }
      : { outcome: "unconfirmed", reason: "expired" };
  }
  const built =
    event.type === PUBLISH_TYPE
      ? buildEvent(PUBLISH_TYPE, payloadSource, claimed.id, claimed.issuedAt, args.supabaseUrl, true)
      : buildEvent(
          revocationType,
          payloadSource,
          claimed.id,
          claimed.issuedAt,
          args.supabaseUrl,
          false,
        );
  if (!built.ok) {
    const marked = await args.store.markTerminal(claimed.id, token, "skipped");
    return marked
      ? { outcome: "terminal", result: "skipped" }
      : { outcome: "unconfirmed", reason: "skipped" };
  }

  let response: { status: number; body: string };
  try {
    response = await args.transport(args.config.url!, built.event.canonical, {
      "content-type": "application/json",
      [SIGNATURE_HEADER]: signatureHeader(args.config.secret!, built.event.canonical),
    });
  } catch {
    const marked = await args.store.markPending(claimed.id, token, "network");
    return marked
      ? { outcome: "queued", reason: "network" }
      : { outcome: "unconfirmed", reason: "network" };
  }

  const decision = interpretBotResponse(
    response.status,
    response.body,
    event.type,
    claimed.issuedAt,
    args.nowMs,
  );
  if (decision.action === "accepted") {
    const marked = await args.store.markAccepted(claimed.id, token);
    return marked
      ? { outcome: "accepted" }
      : { outcome: "unconfirmed", reason: "ack_unconfirmed" };
  }
  if (decision.action === "terminal") {
    const marked = await args.store.markTerminal(claimed.id, token, decision.result);
    return marked
      ? { outcome: "terminal", result: decision.result }
      : { outcome: "unconfirmed", reason: decision.result };
  }
  const marked = await args.store.markPending(claimed.id, token, decision.reason);
  return marked
    ? { outcome: "queued", reason: decision.reason }
    : { outcome: "unconfirmed", reason: decision.reason };
}

export interface CatchUpStore {
  latestEligibleCandidate(nowMs: number): Promise<ArticleSnapshot | null>;
  listEventsForPost(postId: string): Promise<OutboxEvent[]>;
  catchupExists(): Promise<boolean>;
  insertCatchup(
    article: ArticleSnapshot,
    issuedAt: string,
    eventId: string,
  ): Promise<"inserted" | "conflict" | "blocked">;
}

export async function queueCatchUp(args: {
  actorRole: string;
  enabled: boolean;
  nowMs: number;
  supabaseUrl: string | null;
  allocateId: () => string;
  allocateIssuedAt: () => string | Promise<string>;
  store: CatchUpStore;
}): Promise<{ ok: true; publicationId: string } | { ok: false; reason: string }> {
  if (args.actorRole !== "admin") return { ok: false, reason: "unauthorized" };
  if (!args.enabled) return { ok: false, reason: "disabled" };
  if (await args.store.catchupExists()) return { ok: false, reason: "catchup_already_used" };
  const latest = await args.store.latestEligibleCandidate(args.nowMs);
  if (!latest || !evaluatePublish(latest, args.nowMs).ok) {
    return { ok: false, reason: "none" };
  }
  const existing = await args.store.listEventsForPost(latest.id);
  if (existing.some((event) => event.type === PUBLISH_TYPE && event.status === "accepted")) {
    return { ok: false, reason: "already_mirrored" };
  }
  if (publishBlocks(existing)) return { ok: false, reason: "already_recorded" };
  const inserted = await args.store.insertCatchup(
    latest,
    await args.allocateIssuedAt(),
    args.allocateId(),
  );
  if (inserted !== "inserted") {
    return { ok: false, reason: inserted === "blocked" ? "already_recorded" : "conflict" };
  }
  return { ok: true, publicationId: latest.id };
}

const TOKEN = /^[a-z0-9_-]{1,32}$/;

/** Intake rule for the recheck document: only a published row with access exactly public. */
export function intakeAllowsPublic(status: string, access: string): boolean {
  return status === "published" && access === "public";
}

export function isPostId(value: string): boolean {
  return uuidOk(value);
}

/**
 * Sign the fixed current-row document. `id` is the post id, not an event id.
 * Callers must pass the access and status read from the row. This does not
 * accept extra fields, so it is not a signing oracle.
 */
export function buildEligibilityResponse(args: {
  postId: string;
  status: string;
  access: string;
  issuedAt: string;
  secret: string | null;
}): { body: string; signature: string } | null {
  if (!args.secret) return null;
  if (!uuidOk(args.postId)) return null;
  if (!TOKEN.test(args.status) || !TOKEN.test(args.access)) return null;
  const issuedAt = canonicalStamp(args.issuedAt);
  if (!issuedAt) return null;
  const body = canonicalJson({
    v: EVENT_VERSION,
    source: EVENT_SOURCE,
    type: ELIGIBILITY_TYPE,
    id: args.postId,
    issued_at: issuedAt,
    post: {
      id: args.postId,
      status: args.status,
      access: args.access,
    },
  });
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return null;
  const parsed = JSON.parse(body) as {
    id: string;
    post: { id: string; status: string; access: string };
  };
  if (parsed.id !== args.postId || parsed.post.id !== args.postId) return null;
  if (parsed.post.access !== args.access || parsed.post.status !== args.status) return null;
  return { body, signature: signatureHeader(args.secret, body) };
}

export function eligibilityHttpFromRow(args: {
  postId: string;
  secret: string | null;
  hasQuery: boolean;
  failed: boolean;
  row: { status: string; access: string; issued_at: string } | null;
}): { status: number; body: string; signature: string | null } {
  if (args.hasQuery || args.failed || !args.row) {
    return { status: 503, body: "", signature: null };
  }
  const built = buildEligibilityResponse({
    postId: args.postId,
    status: args.row.status,
    access: args.row.access,
    issuedAt: args.row.issued_at,
    secret: args.secret,
  });
  if (!built) return { status: 503, body: "", signature: null };
  return { status: 200, body: built.body, signature: built.signature };
}

export function createMemoryStore(seed?: {
  articles?: ArticleSnapshot[];
  events?: OutboxEvent[];
}): DeliveryStore & CatchUpStore & {
  articles: Map<string, ArticleSnapshot>;
  events: Map<string, OutboxEvent>;
} {
  const articles = new Map((seed?.articles ?? []).map((article) => [article.id, article]));
  const events = new Map((seed?.events ?? []).map((event) => [event.id, structuredClone(event)]));
  const copy = (event: OutboxEvent) => structuredClone(event);
  return {
    articles,
    events,
    async getEvent(id) {
      const event = events.get(id);
      return event ? copy(event) : null;
    },
    async getArticle(postId) {
      const article = articles.get(postId);
      return article ? structuredClone(article) : null;
    },
    async listPendingForPost(postId) {
      return [...events.values()]
        .filter(
          (event) =>
            event.postId === postId &&
            (event.status === "pending" || event.status === "sending"),
        )
        .map(copy);
    },
    async listEventsForPost(postId) {
      return [...events.values()].filter((event) => event.postId === postId).map(copy);
    },
    async claim(id, token, nowIso, staleBeforeIso) {
      const event = events.get(id);
      if (!event) return null;
      const stale =
        event.status === "sending" &&
        event.claimedAt != null &&
        event.claimedAt < staleBeforeIso;
      if (event.status !== "pending" && !stale) return null;
      event.status = "sending";
      event.claimToken = token;
      event.claimedAt = nowIso;
      event.attemptCount += 1;
      return copy(event);
    },
    async markAccepted(id, token) {
      const event = events.get(id);
      if (!event || event.status !== "sending" || event.claimToken !== token) return false;
      event.status = "accepted";
      event.claimToken = null;
      event.terminalResult = null;
      return true;
    },
    async markTerminal(id, token, result) {
      const event = events.get(id);
      if (!event || event.status !== "sending" || event.claimToken !== token) return false;
      event.status = "terminal";
      event.terminalResult = result;
      event.claimToken = null;
      return true;
    },
    async markPending(id, token, error) {
      const event = events.get(id);
      if (!event || event.status !== "sending" || event.claimToken !== token) return false;
      event.status = "pending";
      event.claimToken = null;
      event.terminalResult = error;
      return true;
    },
    async suppressClaimed(id, token, result) {
      const event = events.get(id);
      if (!event || event.status !== "sending" || event.claimToken !== token) return false;
      event.status = "suppressed";
      event.terminalResult = result;
      event.claimToken = null;
      return true;
    },
    async expirePending(id) {
      const event = events.get(id);
      if (!event || event.status !== "pending") return false;
      event.status = "terminal";
      event.terminalResult = "expired";
      return true;
    },
    async suppressPendingPublish(postId) {
      for (const event of events.values()) {
        if (
          event.postId === postId &&
          event.type === PUBLISH_TYPE &&
          event.status === "pending"
        ) {
          event.status = "suppressed";
          event.terminalResult = "revoked_before_send";
        }
      }
    },
    async suppressPending(id, result) {
      const event = events.get(id);
      if (!event || event.status !== "pending") return false;
      event.status = "suppressed";
      event.terminalResult = result;
      return true;
    },
    async catchupExists() {
      return [...events.values()].some((event) => event.origin === "catchup");
    },
    async latestEligibleCandidate(nowMs) {
      const eligible = [...articles.values()].filter(
        (article) =>
          article.status === "published" &&
          article.distributionAccess === "public" &&
          publishedAtAllowed(article.publishedAt, nowMs),
      );
      eligible.sort((a, b) => {
        const left = a.publishedAt ?? "";
        const right = b.publishedAt ?? "";
        return left < right ? 1 : left > right ? -1 : 0;
      });
      const latest = eligible[0];
      return latest ? structuredClone(latest) : null;
    },
    async insertCatchup(article, issuedAt, eventId) {
      if ([...events.values()].some((event) => event.origin === "catchup")) return "blocked";
      if ([...events.values()].some((event) => event.id === eventId || event.issuedAt === issuedAt)) {
        return "conflict";
      }
      if (publishBlocks([...events.values()].filter((event) => event.postId === article.id))) {
        return "blocked";
      }
      events.set(eventId, {
        id: eventId,
        postId: article.id,
        type: PUBLISH_TYPE,
        issuedAt,
        status: "pending",
        terminalResult: null,
        origin: "catchup",
        claimToken: null,
        claimedAt: null,
        attemptCount: 0,
        snapshot: snapshotFrom(article),
      });
      return "inserted";
    },
  };
}

export function snapshotFrom(article: ArticleSnapshot): TeaserSnapshot {
  return {
    status: article.status,
    access: article.distributionAccess ?? "unknown",
    publishedAt: article.publishedAt,
    title: article.title,
    slug: article.slug,
    excerpt: article.excerpt,
    coverImageUrl: article.coverImageUrl,
  };
}
