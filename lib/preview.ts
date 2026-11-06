// DEV-ONLY preview mode. Lets you browse the authenticated app without a
// Supabase backend by faking an admin session and serving sample content.
//
// Safety: only active when running `next dev` AND the flag is set. In a
// production build NODE_ENV is "production", so PREVIEW is always false (dead
// code). The flag lives only in local .env.local, never in .env.example.
import type { Post, Profile } from "@/lib/database.types";

export const PREVIEW =
  process.env.NODE_ENV === "development" &&
  process.env.NEXT_PUBLIC_PREVIEW_MODE === "true";

export const previewProfile: Profile = {
  id: "preview-admin",
  role: "admin",
  display_name: "Preview Admin",
  bio: "Exploring Trading Republic Labs in preview mode.",
  avatar_url: null,
  twitter: null,
  created_at: "2026-01-01T00:00:00.000Z",
};

const welcomeJson = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Welcome to Labs — where the Trading Republic team shares research, market notes, and the occasional deep dive.",
        },
      ],
    },
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "What to expect" }],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Macro and markets commentary" }],
            },
          ],
        },
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Walkthroughs and tutorials" }],
            },
          ],
        },
      ],
    },
    {
      type: "blockquote",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Plan the trade, trade the plan.",
            },
          ],
        },
      ],
    },
  ],
};

const welcomeHtml = `
<p>Welcome to Labs — where the Trading Republic team shares research, market notes, and the occasional deep dive.</p>
<h2>What to expect</h2>
<ul><li><p>Macro and markets commentary</p></li><li><p>Walkthroughs and tutorials</p></li></ul>
<blockquote><p>Plan the trade, trade the plan.</p></blockquote>
`;

const macroJson = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "A simple framework for reading the macro tape heading into the next quarter.",
        },
      ],
    },
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Watch the rates first" }],
    },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Rates set the tone for everything else. Start there, then work outward to FX and equities.",
        },
      ],
    },
    {
      type: "youtube",
      attrs: { src: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    },
  ],
};

const macroHtml = `
<p>A simple framework for reading the macro tape heading into the next quarter.</p>
<h2>Watch the rates first</h2>
<p>Rates set the tone for everything else. Start there, then work outward to FX and equities.</p>
<div data-youtube-video><iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" allowfullscreen frameborder="0"></iframe></div>
`;

export const previewPosts: Post[] = [
  {
    id: "p1",
    author_id: previewProfile.id,
    title: "Welcome to Trading Republic Labs",
    slug: "welcome-to-trading-republic-labs",
    excerpt:
      "What this blog is for and what to expect from the Trading Republic team.",
    cover_image_url: null,
    content_json: welcomeJson,
    content_html: welcomeHtml,
    status: "published",
    distribution_access: "unknown",
    published_at: "2026-06-20T09:00:00.000Z",
    created_at: "2026-06-19T09:00:00.000Z",
    updated_at: "2026-06-20T09:00:00.000Z",
  },
  {
    id: "p2",
    author_id: previewProfile.id,
    title: "Reading the Macro Tape: A Q3 Framework",
    slug: "reading-the-macro-tape",
    excerpt:
      "Rates, FX, and equities — a simple order of operations for the quarter ahead.",
    cover_image_url: null,
    content_json: macroJson,
    content_html: macroHtml,
    status: "published",
    distribution_access: "unknown",
    published_at: "2026-06-22T14:00:00.000Z",
    created_at: "2026-06-22T11:00:00.000Z",
    updated_at: "2026-06-22T14:00:00.000Z",
  },
  {
    id: "p3",
    author_id: previewProfile.id,
    title: "Options flow notes (work in progress)",
    slug: "options-flow-notes",
    excerpt: null,
    cover_image_url: null,
    content_json: { type: "doc", content: [] },
    content_html: null,
    status: "draft",
    distribution_access: "unknown",
    published_at: null,
    created_at: "2026-06-23T08:00:00.000Z",
    updated_at: "2026-06-23T08:00:00.000Z",
  },
];

export function previewPostById(id: string): Post | null {
  const found = previewPosts.find((p) => p.id === id);
  if (found) return found;
  // The "New post" flow redirects here in preview — a fresh blank draft.
  if (id === "new") {
    return {
      id: "new",
      author_id: previewProfile.id,
      title: "Untitled",
      slug: "new",
      excerpt: null,
      cover_image_url: null,
      content_json: { type: "doc", content: [] },
      content_html: null,
      status: "draft",
      distribution_access: "unknown",
      published_at: null,
      created_at: "2026-06-23T00:00:00.000Z",
      updated_at: "2026-06-23T00:00:00.000Z",
    };
  }
  return null;
}

export function previewPostBySlug(slug: string): Post | null {
  return (
    previewPosts.find((p) => p.slug === slug && p.status === "published") ??
    null
  );
}

export const previewAuthors = [
  {
    id: previewProfile.id,
    email: "you@tradingrepublic.io",
    role: "admin" as const,
    displayName: "Preview Admin",
    lastSignIn: "2026-06-23T08:00:00.000Z",
  },
  {
    id: "author-2",
    email: "rochelle@tradingrepublic.io",
    role: "author" as const,
    displayName: "Rochelle",
    lastSignIn: "2026-06-21T10:00:00.000Z",
  },
  {
    id: "author-3",
    email: "newwriter@tradingrepublic.io",
    role: "author" as const,
    displayName: null,
    lastSignIn: null,
  },
];
