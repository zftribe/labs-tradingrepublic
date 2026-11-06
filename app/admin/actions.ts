"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/utils/supabase/admin";
import { requireAdmin } from "@/lib/auth";
import { PREVIEW } from "@/lib/preview";
import { readMirrorConfig } from "@/lib/distribution/event";
import {
  distributionColumnReady,
  retryQueued,
  runCatchUp,
  schedulePublicationHandoff,
} from "@/lib/distribution/runtime";

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export type ActionResult = { ok: boolean; message: string };

// Invites are issued as a copy-able link built on Supabase's server-verified
// token_hash flow (/auth/confirm). We don't send the invite via Supabase's
// email because the free-tier default sender can't use a custom (secure)
// template and is rate-limited; email invites can be re-added once custom SMTP
// is configured (see supabase/email-templates/).
export async function createInviteLink(
  email: string,
): Promise<ActionResult & { link?: string }> {
  await requireAdmin();
  const clean = email.trim();
  if (!clean) return { ok: false, message: "Enter an email address." };

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.generateLink({
    type: "invite",
    email: clean,
  });

  if (error) {
    const m = error.message.toLowerCase();
    if (m.includes("already been registered") || m.includes("already registered")) {
      return { ok: false, message: "That email already has an account." };
    }
    return { ok: false, message: error.message };
  }

  // Build our own token_hash link (server-verified via /auth/confirm) rather
  // than handing out the implicit-flow action_link with tokens in the URL.
  const tokenHash = data.properties?.hashed_token;
  if (!tokenHash) {
    return { ok: false, message: "Could not generate invite link." };
  }

  revalidatePath("/admin/authors");
  return {
    ok: true,
    message: "Invite link created.",
    link: `${siteUrl}/auth/confirm?token_hash=${tokenHash}&type=invite&next=/accept-invite`,
  };
}

export async function setUserRole(
  userId: string,
  role: "admin" | "author",
): Promise<ActionResult> {
  const me = await requireAdmin();
  if (role !== "admin" && role !== "author") {
    return { ok: false, message: "Invalid role." };
  }
  // Don't let an admin demote themselves and risk locking the team out.
  if (userId === me.id && role !== "admin") {
    return { ok: false, message: "You can't remove your own admin role." };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("profiles")
    .update({ role })
    .eq("id", userId);
  if (error) return { ok: false, message: error.message };

  revalidatePath("/admin/authors");
  return {
    ok: true,
    message: role === "admin" ? "Promoted to admin." : "Set to author.",
  };
}

export async function deleteUser(userId: string): Promise<ActionResult> {
  const me = await requireAdmin();
  if (userId === me.id) {
    return { ok: false, message: "You can't delete your own account." };
  }

  const admin = createAdminClient();

  // Posts FK is ON DELETE RESTRICT, so a user with posts can't be removed until
  // their posts are dealt with. Check first for a clear message.
  const { count } = await admin
    .from("posts")
    .select("id", { count: "exact", head: true })
    .eq("author_id", userId);
  if (count && count > 0) {
    return {
      ok: false,
      message: `This person has ${count} post${count === 1 ? "" : "s"}. Delete or reassign them first.`,
    };
  }

  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) return { ok: false, message: error.message };

  revalidatePath("/admin/authors");
  return { ok: true, message: "Account deleted." };
}

export async function adminUnpublishPost(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const admin = createAdminClient();
  const { data: post } = await admin
    .from("posts")
    .select("slug")
    .eq("id", id)
    .single();

  const { error } = await admin
    .from("posts")
    .update({ status: "draft" })
    .eq("id", id);
  if (error) throw new Error(error.message);
  if (await distributionColumnReady(admin)) schedulePublicationHandoff(id);

  revalidatePath("/");
  if (post) revalidatePath(`/posts/${post.slug}`);
  revalidatePath("/admin/posts");
}

export async function queueCatchUpTeaser(): Promise<ActionResult> {
  const me = await requireAdmin();
  if (PREVIEW) return { ok: false, message: "Unavailable in preview." };
  if (me.role !== "admin") return { ok: false, message: "Forbidden." };
  if (!readMirrorConfig(process.env).catchupEnabled) {
    return {
      ok: false,
      message: "Catch-up is off. Nothing was selected or sent.",
    };
  }
  try {
    const result = await runCatchUp(me.role);
    if (!result.ok) {
      return { ok: false, message: catchUpMessage(result.reason) };
    }
    return {
      ok: true,
      message:
        "One article was queued. It was not sent. Retry within five minutes of queuing, and only after the route is verified live.",
    };
  } catch {
    return { ok: false, message: "Catch-up could not be queued. Nothing was sent." };
  }
}

export async function retryQueuedTeasers(): Promise<ActionResult> {
  const me = await requireAdmin();
  if (PREVIEW) return { ok: false, message: "Unavailable in preview." };
  if (me.role !== "admin") return { ok: false, message: "Forbidden." };
  try {
    const result = await retryQueued(me.role);
    if (!result.ok) {
      if (result.reason === "unconfigured") {
        return { ok: false, message: "Mirroring is not configured. Nothing was sent." };
      }
      return { ok: false, message: "Queued handoffs could not be read. Nothing was sent." };
    }
    const accepted = result.outcomes.filter((item) => item.outcome === "accepted").length;
    const queued = result.outcomes.filter((item) => item.outcome === "queued").length;
    const terminal = result.outcomes.filter((item) => item.outcome === "terminal").length;
    return {
      ok: true,
      message: `Intake accepted ${accepted}. Still queued ${queued}. Terminal ${terminal}. This does not confirm a chat post, and an accepted teaser cannot be recalled.`,
    };
  } catch {
    return { ok: false, message: "Retry failed before any handoff was confirmed." };
  }
}

function catchUpMessage(reason: string): string {
  if (reason === "unauthorized") return "Forbidden.";
  if (reason === "disabled") return "Catch-up is off. Nothing was selected or sent.";
  if (reason === "catchup_already_used") return "The one catch-up was already used. Nothing was sent.";
  if (reason === "already_mirrored") {
    return "The latest confirmed article was already handed off. No older article was selected.";
  }
  if (reason === "already_recorded") {
    return "The latest confirmed article already has a teaser record. Nothing new was queued.";
  }
  if (reason === "none") return "No confirmed public article is available. Nothing was selected.";
  return "Catch-up did not queue an article. Nothing was sent.";
}
