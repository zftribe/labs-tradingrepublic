import Link from "next/link";
import { Users, FileText, Radio } from "lucide-react";
import { createAdminClient } from "@/utils/supabase/admin";
import { Card } from "@/components/ui/card";
import { PREVIEW, previewPosts, previewAuthors } from "@/lib/preview";

export const metadata = { title: "Admin" };

export default async function AdminHome() {
  let postCount: number | null;
  let userCount: number;

  if (PREVIEW) {
    postCount = previewPosts.length;
    userCount = previewAuthors.length;
  } else {
    const admin = createAdminClient();
    const { count } = await admin
      .from("posts")
      .select("id", { count: "exact", head: true });
    postCount = count;
    const {
      data: { users },
    } = await admin.auth.admin.listUsers({ perPage: 1000 });
    userCount = users.length;
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8">
      <h1 className="mb-6 font-display text-2xl font-bold">Admin</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link href="/admin/authors">
          <Card className="p-6 transition-colors hover:border-primary/50">
            <Users className="mb-3 h-6 w-6 text-primary" />
            <p className="text-2xl font-bold">{userCount}</p>
            <p className="text-sm text-muted-foreground">
              Authors &amp; admins — invite and manage roles
            </p>
          </Card>
        </Link>
        <Link href="/admin/posts">
          <Card className="p-6 transition-colors hover:border-primary/50">
            <FileText className="mb-3 h-6 w-6 text-primary" />
            <p className="text-2xl font-bold">{postCount ?? 0}</p>
            <p className="text-sm text-muted-foreground">
              Posts across all authors — moderate and edit
            </p>
          </Card>
        </Link>
        <Link href="/admin/distribution">
          <Card className="p-6 transition-colors hover:border-primary/50">
            <Radio className="mb-3 h-6 w-6 text-primary" />
            <p className="text-lg font-bold">Public teasers</p>
            <p className="text-sm text-muted-foreground">
              Queue one catch-up or retry a handoff. Nothing here posts by itself.
            </p>
          </Card>
        </Link>
      </div>
    </main>
  );
}
