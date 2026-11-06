import "server-only";

import { createClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/utils/supabase/admin";
import type { Database } from "@/lib/database.types";
import {
  ARTICLE_COLUMNS,
  type ArticleSnapshot,
  type DeliveryOutcome,
  type DeliveryStore,
  type EventType,
  type OutboxEvent,
  deliverEvent,
  deliveryOrder,
  isMissingDistributionColumn,
  isMissingOutbox,
  isPostId,
  queueCatchUp,
  readMirrorConfig,
  type CatchUpStore,
} from "@/lib/distribution/event";

type OutboxRow = Database["public"]["Tables"]["distribution_outbox"]["Row"];
type ArticleRow = {
  id: string;
  author_id: string;
  status: string;
  distribution_access: string | null;
  published_at: string | null;
  title: string;
  excerpt: string | null;
  slug: string;
  cover_image_url: string | null;
};

let columnReady: boolean | null = null;

export async function distributionColumnReady(client: {
  from: (table: "posts") => {
    select: (columns: string) => {
      limit: (
        count: number,
      ) => PromiseLike<{ error: { code?: string; message?: string } | null }>;
    };
  };
}): Promise<boolean> {
  if (columnReady === true) return true;
  const { error } = await client.from("posts").select("distribution_access").limit(1);
  if (!error) {
    columnReady = true;
    return true;
  }
  if (isMissingDistributionColumn(error)) return false;
  throw new Error("Could not read the editor record");
}

function mapArticle(row: ArticleRow): ArticleSnapshot {
  return {
    id: row.id,
    authorId: row.author_id,
    status: row.status,
    distributionAccess: row.distribution_access,
    publishedAt: row.published_at,
    title: row.title,
    excerpt: row.excerpt,
    slug: row.slug,
    coverImageUrl: row.cover_image_url,
  };
}

function mapEvent(row: OutboxRow): OutboxEvent {
  return {
    id: row.id,
    postId: row.post_id,
    type: row.type as EventType,
    issuedAt: row.issued_at,
    status: row.status as OutboxEvent["status"],
    terminalResult: row.terminal_result,
    origin: row.origin === "catchup" ? "catchup" : "transition",
    claimToken: row.claim_token,
    claimedAt: row.claimed_at,
    attemptCount: row.attempt_count,
    snapshot: {
      status: row.snapshot_status,
      access: row.snapshot_access,
      publishedAt: row.snapshot_published_at,
      title: row.snapshot_title,
      slug: row.snapshot_slug,
      excerpt: row.snapshot_excerpt,
      coverImageUrl: row.snapshot_cover,
    },
  };
}

function admin() {
  return createAdminClient();
}

function createStore(): DeliveryStore & CatchUpStore {
  return {
    async getEvent(id) {
      const { data, error } = await admin()
        .from("distribution_outbox")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error || !data) return null;
      return mapEvent(data);
    },
    async getArticle(postId) {
      const { data, error } = await admin()
        .from("posts")
        .select(ARTICLE_COLUMNS)
        .eq("id", postId)
        .maybeSingle();
      if (error || !data) return null;
      return mapArticle(data as ArticleRow);
    },
    async listPendingForPost(postId) {
      const { data, error } = await admin()
        .from("distribution_outbox")
        .select("*")
        .eq("post_id", postId)
        .in("status", ["pending", "sending"]);
      if (error || !data) return [];
      return data.map(mapEvent);
    },
    async listEventsForPost(postId) {
      const { data, error } = await admin()
        .from("distribution_outbox")
        .select("*")
        .eq("post_id", postId);
      if (error || !data) return [];
      return data.map(mapEvent);
    },
    async claim(id, token, nowIso, staleBeforeIso) {
      const { data: row, error } = await admin()
        .from("distribution_outbox")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error || !row) return null;
      const stale =
        row.status === "sending" &&
        row.claimed_at != null &&
        row.claimed_at < staleBeforeIso;
      if (row.status !== "pending" && !stale) return null;
      const update = admin()
        .from("distribution_outbox")
        .update({
          status: "sending",
          claim_token: token,
          claimed_at: nowIso,
          attempt_count: row.attempt_count + 1,
          last_error: null,
        })
        .eq("id", id)
        .eq("status", row.status);
      const filtered = row.claim_token
        ? update.eq("claim_token", row.claim_token)
        : update.is("claim_token", null);
      const { data, error: writeError } = await filtered.select("*").maybeSingle();
      if (writeError || !data) return null;
      return mapEvent(data);
    },
    async markAccepted(id, token) {
      const { data, error } = await admin()
        .from("distribution_outbox")
        .update({ status: "accepted", claim_token: null, terminal_result: null })
        .eq("id", id)
        .eq("status", "sending")
        .eq("claim_token", token)
        .select("id");
      return !error && (data?.length ?? 0) > 0;
    },
    async markTerminal(id, token, result) {
      const { data, error } = await admin()
        .from("distribution_outbox")
        .update({ status: "terminal", terminal_result: result, claim_token: null })
        .eq("id", id)
        .eq("status", "sending")
        .eq("claim_token", token)
        .select("id");
      return !error && (data?.length ?? 0) > 0;
    },
    async markPending(id, token, errorCode) {
      const { data, error } = await admin()
        .from("distribution_outbox")
        .update({
          status: "pending",
          claim_token: null,
          last_error: errorCode.slice(0, 40),
        })
        .eq("id", id)
        .eq("status", "sending")
        .eq("claim_token", token)
        .select("id");
      return !error && (data?.length ?? 0) > 0;
    },
    async suppressClaimed(id, token, result) {
      const { data, error } = await admin()
        .from("distribution_outbox")
        .update({ status: "suppressed", terminal_result: result, claim_token: null })
        .eq("id", id)
        .eq("status", "sending")
        .eq("claim_token", token)
        .select("id");
      return !error && (data?.length ?? 0) > 0;
    },
    async expirePending(id) {
      const { data, error } = await admin()
        .from("distribution_outbox")
        .update({ status: "terminal", terminal_result: "expired", claim_token: null })
        .eq("id", id)
        .eq("status", "pending")
        .select("id");
      return !error && (data?.length ?? 0) > 0;
    },
    async suppressPendingPublish(postId) {
      await admin()
        .from("distribution_outbox")
        .update({
          status: "suppressed",
          terminal_result: "revoked_before_send",
          claim_token: null,
        })
        .eq("post_id", postId)
        .eq("type", "post.published")
        .eq("status", "pending");
    },
    async suppressPending(id, result) {
      const { data, error } = await admin()
        .from("distribution_outbox")
        .update({ status: "suppressed", terminal_result: result, claim_token: null })
        .eq("id", id)
        .eq("status", "pending")
        .select("id");
      return !error && (data?.length ?? 0) > 0;
    },
    async markReview(id, token, result) {
      const { data, error } = await admin()
        .from("distribution_outbox")
        .update({ status: "review", terminal_result: result, claim_token: null, last_error: result })
        .eq("id", id)
        .eq("status", "sending")
        .eq("claim_token", token)
        .select("id");
      return !error && (data?.length ?? 0) > 0;
    },
    async catchupExists() {
      const { data, error } = await admin()
        .from("distribution_outbox")
        .select("id")
        .eq("origin", "catchup")
        .limit(1);
      if (error) return false;
      return (data?.length ?? 0) > 0;
    },
    async latestEligibleCandidate(nowMs) {
      const cutoff = new Date(nowMs + 60_000).toISOString();
      const { data, error } = await admin()
        .from("posts")
        .select(ARTICLE_COLUMNS)
        .eq("status", "published")
        .eq("distribution_access", "public")
        .not("published_at", "is", null)
        .lte("published_at", cutoff)
        .order("published_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error || !data) return null;
      return mapArticle(data as ArticleRow);
    },
    async insertCatchup(article, issuedAt, eventId) {
      if (await this.catchupExists()) return "blocked";
      const { error } = await admin().from("distribution_outbox").insert({
        id: eventId,
        post_id: article.id,
        publication_id: article.id,
        type: "post.published",
        issued_at: issuedAt,
        status: "pending",
        origin: "catchup",
        snapshot_status: article.status,
        snapshot_access: article.distributionAccess ?? "unknown",
        snapshot_published_at: article.publishedAt,
        snapshot_title: article.title,
        snapshot_slug: article.slug,
        snapshot_excerpt: article.excerpt,
        snapshot_cover: article.coverImageUrl,
      });
      if (!error) return "inserted";
      if (error.code === "23505") return "conflict";
      return "blocked";
    },
  };
}

async function postToIntake(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(4000),
  });
  const text = await response.text();
  return { status: response.status, body: text.slice(0, 512) };
}

export async function deliverOutboxEvent(eventId: string): Promise<DeliveryOutcome> {
  return deliverEvent({
    store: createStore(),
    eventId,
    config: readMirrorConfig(process.env),
    nowMs: Date.now(),
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? null,
    newToken: () => crypto.randomUUID(),
    transport: postToIntake,
  });
}

export async function handoffPublication(postId: string): Promise<DeliveryOutcome[]> {
  try {
    const store = createStore();
    const pending = await store.listPendingForPost(postId);
    const outcomes: DeliveryOutcome[] = [];
    for (const event of deliveryOrder(pending)) {
      outcomes.push(await deliverOutboxEvent(event.id));
    }
    return outcomes;
  } catch {
    return [{ outcome: "unconfirmed", reason: "handoff_failed" }];
  }
}

export async function hasPendingPublish(postId: string): Promise<boolean> {
  const { data, error } = await admin()
    .from("distribution_outbox")
    .select("id")
    .eq("post_id", postId)
    .eq("type", "post.published")
    .in("status", ["pending", "sending"])
    .limit(1);
  if (error) {
    if (isMissingOutbox(error)) return false;
    throw new Error("Could not read the teaser queue");
  }
  return (data?.length ?? 0) > 0;
}

export async function runCatchUp(actorRole: string) {
  const config = readMirrorConfig(process.env);
  const store = createStore();
  return queueCatchUp({
    actorRole,
    enabled: config.catchupEnabled,
    nowMs: Date.now(),
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? null,
    allocateId: () => crypto.randomUUID(),
    allocateIssuedAt: async () => {
      const { data, error } = await admin().rpc("next_teaser_issued_at");
      if (error || typeof data !== "string" || !data) {
        throw new Error("Could not allocate a teaser timestamp");
      }
      return data;
    },
    store,
  });
}

export async function retryQueued(actorRole: string, limit = 5) {
  if (actorRole !== "admin") return { ok: false as const, reason: "unauthorized" };
  const config = readMirrorConfig(process.env);
  if (!config.enabled) return { ok: false as const, reason: "unconfigured" };
  const { data, error } = await admin()
    .from("distribution_outbox")
    .select("*")
    .eq("status", "pending")
    .order("issued_at", { ascending: true })
    .limit(50);
  if (error) {
    if (isMissingOutbox(error)) return { ok: false as const, reason: "unavailable" };
    return { ok: false as const, reason: "unavailable" };
  }
  const ordered = deliveryOrder((data ?? []).map(mapEvent)).slice(0, limit);
  const outcomes: DeliveryOutcome[] = [];
  for (const event of ordered) {
    outcomes.push(await deliverOutboxEvent(event.id));
  }
  return { ok: true as const, outcomes };
}

export async function readEligibilityRow(
  postId: string,
): Promise<{ status: string; access: string; issued_at: string } | null | "failed"> {
  if (!isPostId(postId)) return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return "failed";
  try {
    const client = createClient<Database>(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
      },
    });
    const { data, error } = await client.rpc("distribution_eligibility", { p_id: postId });
    if (error) return "failed";
    const row = Array.isArray(data) ? data[0] : null;
    if (!row || typeof row.status !== "string" || typeof row.access !== "string") return null;
    if (typeof row.issued_at !== "string") return "failed";
    return row;
  } catch {
    return "failed";
  }
}
