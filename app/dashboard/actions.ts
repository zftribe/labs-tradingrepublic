"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireUser } from "@/lib/auth";
import { slugify } from "@/lib/slug";
import { renderPostHtml } from "@/lib/sanitize";
import { PREVIEW } from "@/lib/preview";
import type { DistributionAccess, Json } from "@/lib/database.types";
import {
  canClassifyPost,
  frozenPublishedAt,
  parseDistributionAccess,
  slugPatchForSave,
  summarizeHandoff,
  teaserRequestForPublish,
} from "@/lib/distribution/event";
import {
  distributionColumnReady,
  handoffPublication,
  hasPendingPublish,
} from "@/lib/distribution/runtime";

// Slug uniqueness is global (posts.slug has a UNIQUE constraint), but a normal
// RLS-scoped client can't see other authors' drafts, so two authors would both
// land on "untitled" and the second write would fail the constraint. Check
// existence with the service-role client so we compare against every slug; the
// actual insert/update stays on the caller's RLS-scoped client, so write
// authorization is unchanged.
async function uniqueSlug(base: string, excludeId?: string): Promise<string> {
  const admin = createAdminClient();
  const root = slugify(base);
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const { data } = await admin
      .from("posts")
      .select("id")
      .eq("slug", candidate)
      .maybeSingle();
    if (!data || data.id === excludeId) return candidate;
  }
}

export async function createDraft() {
  if (PREVIEW) {
    redirect("/dashboard/posts/new/edit");
  }
  const profile = await requireUser();
  const supabase = await createClient();
  // A fresh draft only needs a globally-unique placeholder slug; it gets
  // re-derived from the title on first save. A random suffix is collision-proof
  // without the extra round-trips of a uniqueSlug lookup (which matters because
  // the DB is a cross-region round-trip away).
  const slug = `untitled-${crypto.randomUUID().slice(0, 8)}`;

  const { data, error } = await supabase
    .from("posts")
    .insert({ author_id: profile.id, title: "Untitled", slug })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "Could not create draft");
  }
  redirect(`/dashboard/posts/${data.id}/edit`);
}

export async function savePost(
  id: string,
  input: {
    title: string;
    excerpt: string | null;
    cover_image_url: string | null;
    content_json: Json;
    distribution_access?: DistributionAccess;
  },
) {
  const profile = await requireUser();
  const supabase = await createClient();
  const access = parseAccess(input.distribution_access);

  const ready = await distributionColumnReady(supabase);
  const current = ready
    ? (
        await supabase
          .from("posts")
          .select("status, author_id, distribution_access")
          .eq("id", id)
          .single()
      ).data
    : (
        await supabase.from("posts").select("status, author_id").eq("id", id).single()
      ).data;
  if (!current) throw new Error("Post not found");
  if (!canClassifyPost(profile, current.author_id)) throw new Error("Forbidden");

  // Keep the slug in sync with the title while still a draft; freeze it once
  // published so shared links never break.
  const slug =
    slugPatchForSave(current.status) === "refresh"
      ? await uniqueSlug(input.title || "untitled", id)
      : undefined;

  const { error } = await supabase
    .from("posts")
    .update({
      title: input.title,
      excerpt: input.excerpt,
      cover_image_url: input.cover_image_url,
      content_json: input.content_json,
      ...(slug ? { slug } : {}),
      ...(ready && access ? { distribution_access: access } : {}),
    })
    .eq("id", id);

  if (error) throw new Error(error.message);
  if (ready) {
    try {
      await handoffPublication(id);
    } catch {
      // The article save stands. A pending teaser stays in the outbox.
    }
  }
  return { slug };
}

function parseAccess(value: DistributionAccess | undefined): DistributionAccess | undefined {
  if (value === undefined) return undefined;
  const parsed = parseDistributionAccess(value);
  if (!parsed) throw new Error("Invalid redistribution choice");
  return parsed;
}

export async function setPostTags(postId: string, tagNames: string[]) {
  await requireUser();
  const supabase = await createClient();

  const names = Array.from(
    new Set(tagNames.map((t) => t.trim()).filter(Boolean)),
  ).slice(0, 8);

  const tagIds: string[] = [];
  for (const name of names) {
    const slug = slugify(name);
    const { data: existing } = await supabase
      .from("tags")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (existing) {
      tagIds.push(existing.id);
      continue;
    }
    const { data: created } = await supabase
      .from("tags")
      .insert({ name, slug })
      .select("id")
      .single();
    if (created) tagIds.push(created.id);
  }

  await supabase.from("post_tags").delete().eq("post_id", postId);
  if (tagIds.length) {
    await supabase
      .from("post_tags")
      .insert(tagIds.map((tag_id) => ({ post_id: postId, tag_id })));
  }
}

export type PublishTeaserState =
  | "not_requested"
  | "accepted"
  | "retryable"
  | "needs_review"
  | "closed"
  | "not_configured"
  | "not_queued";

export async function publishPost(
  id: string,
  input?: { distribution_access?: DistributionAccess },
): Promise<{ teaser: PublishTeaserState }> {
  const profile = await requireUser();
  const supabase = await createClient();
  const access = parseAccess(input?.distribution_access);
  const ready = await distributionColumnReady(supabase);

  const fetched = ready
    ? await supabase
        .from("posts")
        .select("slug, content_json, published_at, author_id, status, distribution_access")
        .eq("id", id)
        .single()
    : await supabase
        .from("posts")
        .select("slug, content_json, published_at, author_id, status")
        .eq("id", id)
        .single();
  const post = fetched.data;
  if (fetched.error || !post) throw new Error(fetched.error?.message ?? "Post not found");
  if (!canClassifyPost(profile, post.author_id)) throw new Error("Forbidden");

  const html = renderPostHtml(post.content_json);
  const publishedAt = frozenPublishedAt(post.published_at, new Date().toISOString());
  const storedAccess =
    "distribution_access" in post
      ? (post.distribution_access as DistributionAccess | null | undefined)
      : undefined;
  const requested = teaserRequestForPublish(post.status, access ?? storedAccess);

  const { data: updated, error } = await supabase
    .from("posts")
    .update({
      status: "published",
      content_html: html,
      published_at: publishedAt,
      ...(ready && access ? { distribution_access: access } : {}),
    })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!updated) throw new Error("Post not found");

  revalidatePath("/");
  revalidatePath(`/posts/${post.slug}`);
  revalidatePath("/dashboard");

  if (!requested) {
    if (ready) {
      try {
        await handoffPublication(id);
      } catch {
        // Publication stands. Any revocation stays queued.
      }
    }
    return { teaser: "not_requested" };
  }
  if (!ready) return { teaser: "not_queued" };
  try {
    const pending = await hasPendingPublish(id);
    if (!pending) return { teaser: "not_queued" };
    return { teaser: summarizeHandoff(await handoffPublication(id)) };
  } catch {
    return { teaser: "retryable" };
  }
}

export async function unpublishPost(id: string) {
  await requireUser();
  const supabase = await createClient();

  const { data: post } = await supabase
    .from("posts")
    .select("slug")
    .eq("id", id)
    .single();

  const { error } = await supabase
    .from("posts")
    .update({ status: "draft" })
    .eq("id", id);
  if (error) throw new Error(error.message);
  if (await distributionColumnReady(supabase)) {
    try {
      await handoffPublication(id);
    } catch {
      // The draft change stands. A revocation stays queued.
    }
  }

  revalidatePath("/");
  if (post) revalidatePath(`/posts/${post.slug}`);
  revalidatePath("/dashboard");
}

export async function deletePost(id: string) {
  await requireUser();
  const supabase = await createClient();

  const { data: post } = await supabase
    .from("posts")
    .select("slug, status")
    .eq("id", id)
    .single();

  const { error } = await supabase.from("posts").delete().eq("id", id);
  if (error) throw new Error(error.message);
  if (await distributionColumnReady(supabase)) {
    try {
      await handoffPublication(id);
    } catch {
      // The delete stands. A revocation stays queued.
    }
  }

  revalidatePath("/");
  if (post?.status === "published") revalidatePath(`/posts/${post.slug}`);
  revalidatePath("/dashboard");
  redirect("/dashboard");
}
