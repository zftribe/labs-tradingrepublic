# Trading Republic Labs — setup

A blog for `labs.tradingrepublic.io`. Public reads; invited authors write.
Next.js 16 (App Router) · Supabase (Auth + Postgres + Storage) · Tiptap.

## 1. Create the Supabase project

1. Create a project at https://supabase.com/dashboard.
2. Project Settings → **API**, copy:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` `public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (server-only, keep secret)
3. Copy `.env.example` to `.env.local` and fill those three, plus
   `NEXT_PUBLIC_SITE_URL=http://localhost:3000` for local dev.

## 2. Apply the database schema

Run [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql):

- **SQL editor:** paste the file's contents into Supabase → SQL Editor → Run.
- **or CLI:** `supabase link --project-ref <ref>` then `supabase db push`.

This creates the tables, RLS policies, triggers, and the `post-media`
storage bucket.

## 3. Configure Auth (invite-only)

In Supabase → Authentication:

- **Sign In / Providers → Email**: turn **OFF** "Allow new users to sign up"
  (authoring is invite-only; the only way in is an admin invite).
- **URL Configuration**:
  - Site URL: `http://localhost:3000` (dev) — later `https://labs.tradingrepublic.io`.
  - Redirect URLs: add `http://localhost:3000/auth/confirm` (and the prod
    equivalent once deployed).

## 4. Bootstrap the first admin (one-time)

There's no admin yet to invite the first admin, so promote yourself once:

1. Invite/create your own user (Authentication → Users → Add user, or send
   yourself an invite), set a password, sign in once so the profile row exists.
2. In the SQL editor:

   ```sql
   update public.profiles set role = 'admin'
   where id = (select id from auth.users where email = 'you@tradingrepublic.io');
   ```

After this you can invite other authors from `/admin/authors`.

## 5. Run it

```bash
npm run dev
```

Open http://localhost:3000. Sign in at `/login`; author tools live at
`/dashboard`, admin at `/admin`.

## 6. Deploy to Vercel (labs.tradingrepublic.io)

1. Push this repo to GitHub and import it as a new Vercel project (separate from
   the existing `tr-landingpage` project).
2. In Vercel → Project → Settings → **Environment Variables**, add (Production):
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `NEXT_PUBLIC_SITE_URL=https://labs.tradingrepublic.io`
3. Deploy.
4. **Domain:** Vercel → Settings → Domains → add `labs.tradingrepublic.io`, then
   create the DNS record it shows (a `CNAME` on the `labs` subdomain at your DNS
   provider for `tradingrepublic.io`).
5. **Point Supabase at production:** Authentication → URL Configuration:
   - Site URL: `https://labs.tradingrepublic.io`
   - Redirect URLs: add `https://labs.tradingrepublic.io/auth/confirm`

After DNS propagates, sign in, invite an author, and publish a test post to
confirm auth, invites, and OG previews work on the live domain.

## 7. Public teaser handoff (optional, off until you enable it)

Published articles are already public on the site. There is no membership or
paywall. A separate author control, default **Not classified**, decides whether
a short public teaser may be handed to the downstream research bot the first
time a draft is published. Existing articles stay unclassified. See
[docs/public-teaser-event.md](docs/public-teaser-event.md).

This repository does not apply the database change, deploy, or send anything.

1. Review [`supabase/migrations/0002_public_teaser.sql`](supabase/migrations/0002_public_teaser.sql)
   and run it yourself in the SQL editor only after that review. It defaults
   every article to `unknown`.
2. Set `FM_LABS_EVENT_SECRET` in this host's server environment and the same
   value on the bot host. Generate it yourself. Do not put the chat bot token
   on this host.
3. Set `LABS_MIRROR_URL` to the https origin of the intake you approve. The
   website posts to `/v1/labs-events` on that origin. No intake address is
   stored in git.
4. On the bot host, set `FM_LABS_RECHECK_URL` to
   `https://<this-site>/api/distribution/eligibility` with an https scheme and
   no user, password, query, fragment, or trailing slash. The bot calls
   `<that base>/<post id>`.
5. Leave `LABS_MIRROR_CATCHUP_ENABLED` unset. After the route is verified live
   separately, set it to `true`, queue the single latest confirmed article from
   `/admin/distribution`, and retry within five minutes. That path queues one
   row and does not send a backlog. A teaser that was already handed off cannot
   be recalled.
