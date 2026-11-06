-- Public teaser handoff. Do not apply this automatically.
--
-- Labs has no membership or paywall. distribution_access records whether an
-- author allows a short public teaser to leave the site. Existing and new
-- rows default to unknown, which is not eligible. This file does not grant
-- anonymous reads of drafts or article bodies, and it does not backfill
-- any row to public.

alter table public.posts
  add column distribution_access text not null default 'unknown'
    constraint posts_distribution_access_check
    check (distribution_access in ('unknown', 'public', 'withheld'));

comment on column public.posts.distribution_access is
  'Author consent for a public teaser. unknown and withheld are not eligible. Not a paywall flag.';

create index posts_public_teaser_latest_idx
  on public.posts (published_at desc)
  where status = 'published' and distribution_access = 'public';

create table public.distribution_outbox (
  id uuid primary key,
  post_id uuid not null,
  publication_id uuid references public.posts (id) on delete set null,
  type text not null check (type in ('post.published', 'post.unpublished', 'post.access_changed')),
  issued_at text not null unique,
  status text not null check (status in ('pending', 'sending', 'accepted', 'terminal', 'suppressed', 'review')),
  terminal_result text,
  origin text not null default 'transition' check (origin in ('transition', 'catchup')),
  claim_token uuid,
  claimed_at timestamptz,
  attempt_count integer not null default 0,
  last_error text,
  snapshot_status text not null,
  snapshot_access text not null,
  snapshot_published_at text,
  snapshot_title text not null,
  snapshot_slug text not null,
  snapshot_excerpt text,
  snapshot_cover text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index distribution_outbox_one_catchup
  on public.distribution_outbox ((true))
  where origin = 'catchup';

create index distribution_outbox_post_status_idx
  on public.distribution_outbox (post_id, status);

alter table public.distribution_outbox enable row level security;
revoke all on table public.distribution_outbox from anon, authenticated;

create trigger distribution_outbox_touch
  before update on public.distribution_outbox
  for each row execute function public.touch_updated_at();

-- blocking terminal results: duplicate stale ignored skipped republish uncertain
-- non-blocking terminal results: expired

create or replace function public.next_teaser_issued_at()
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  candidate text;
  tries int := 0;
begin
  loop
    candidate := to_char(
      (clock_timestamp() + make_interval(secs => tries::numeric / 1000000)) at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    );
    exit when not exists (
      select 1 from public.distribution_outbox where issued_at = candidate
    );
    tries := tries + 1;
    if tries > 50 then
      raise exception 'issued_at_exhausted';
    end if;
  end loop;
  return candidate;
end;
$$;

revoke all on function public.next_teaser_issued_at() from public;
revoke all on function public.next_teaser_issued_at() from anon, authenticated;
grant execute on function public.next_teaser_issued_at() to service_role;

-- Current-row read for the signed eligibility response. Status and access only.
create or replace function public.distribution_eligibility(p_id uuid)
returns table (status text, access text, issued_at text)
language sql
volatile
security definer
set search_path = public
as $$
  select
    posts.status::text,
    posts.distribution_access,
    to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  from public.posts
  where posts.id = p_id;
$$;

revoke all on function public.distribution_eligibility(uuid) from public;
revoke all on function public.distribution_eligibility(uuid) from anon, authenticated;
grant execute on function public.distribution_eligibility(uuid) to service_role;

create or replace function public.sync_public_teaser()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  was_open boolean;
  now_open boolean;
  issued text;
  event_id uuid;
  rev_type text;
  visible boolean;
  tries int;
begin
  if tg_op = 'DELETE' then
    update public.distribution_outbox
      set status = 'suppressed',
          terminal_result = 'revoked_before_send',
          claim_token = null
      where post_id = old.id
        and type = 'post.published'
        and status = 'pending';

    visible := exists (
      select 1 from public.distribution_outbox o
      where o.post_id = old.id
        and o.type = 'post.published'
        and (
          o.status in ('accepted', 'sending')
          or (o.status = 'terminal' and o.terminal_result = 'uncertain')
        )
    );
    if visible and not exists (
      select 1 from public.distribution_outbox o
      where o.post_id = old.id
        and o.type in ('post.unpublished', 'post.access_changed')
        and o.status in ('pending', 'sending')
    ) then
      tries := 0;
      loop
        begin
          insert into public.distribution_outbox (
            id, post_id, publication_id, type, issued_at, status, origin,
            snapshot_status, snapshot_access, snapshot_published_at,
            snapshot_title, snapshot_slug, snapshot_excerpt, snapshot_cover
          ) values (
            gen_random_uuid(),
            old.id,
            old.id,
            'post.unpublished',
            public.next_teaser_issued_at(),
            'pending',
            'transition',
            'draft',
            old.distribution_access,
            case
              when old.published_at is null then null
              else to_char(old.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            end,
            left(old.title, 180),
            old.slug,
            old.excerpt,
            old.cover_image_url
          );
          exit;
        exception when unique_violation then
          tries := tries + 1;
          if tries > 5 then
            raise;
          end if;
        end;
      end loop;
    end if;
    return old;
  end if;

  was_open := old.status = 'published'
    and old.distribution_access = 'public'
    and old.published_at is not null
    and old.published_at <= clock_timestamp() + interval '60 seconds';
  now_open := new.status = 'published'
    and new.distribution_access = 'public'
    and new.published_at is not null
    and new.published_at <= clock_timestamp() + interval '60 seconds';

  if was_open and not now_open then
    update public.distribution_outbox
      set status = 'suppressed',
          terminal_result = 'revoked_before_send',
          claim_token = null
      where post_id = new.id
        and type = 'post.published'
        and status = 'pending';

    visible := exists (
      select 1 from public.distribution_outbox o
      where o.post_id = new.id
        and o.type = 'post.published'
        and (
          o.status in ('accepted', 'sending')
          or (o.status = 'terminal' and o.terminal_result = 'uncertain')
        )
    );
    if visible and not exists (
      select 1 from public.distribution_outbox o
      where o.post_id = new.id
        and o.type in ('post.unpublished', 'post.access_changed')
        and o.status in ('pending', 'sending')
    ) then
      if new.status is distinct from 'published' then
        rev_type := 'post.unpublished';
      else
        rev_type := 'post.access_changed';
      end if;
      tries := 0;
      loop
        event_id := gen_random_uuid();
        issued := public.next_teaser_issued_at();
        begin
          insert into public.distribution_outbox (
            id, post_id, publication_id, type, issued_at, status, origin,
            snapshot_status, snapshot_access, snapshot_published_at,
            snapshot_title, snapshot_slug, snapshot_excerpt, snapshot_cover
          ) values (
            event_id,
            new.id,
            new.id,
            rev_type,
            issued,
            'pending',
            'transition',
            case when rev_type = 'post.unpublished' then 'draft' else new.status::text end,
            new.distribution_access,
            case
              when new.published_at is null then null
              else to_char(new.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            end,
            left(new.title, 180),
            new.slug,
            new.excerpt,
            new.cover_image_url
          );
          exit;
        exception when unique_violation then
          tries := tries + 1;
          if tries > 5 then
            raise;
          end if;
        end;
      end loop;
    end if;
  end if;

  if old.status = 'draft' and now_open and not exists (
    select 1 from public.distribution_outbox o
    where o.post_id = new.id
      and o.type = 'post.published'
      and (
        o.status in ('pending', 'sending', 'accepted')
        or (
          o.status = 'terminal'
          and o.terminal_result in (
            'duplicate', 'stale', 'ignored', 'skipped', 'republish', 'uncertain'
          )
        )
      )
  ) then
    tries := 0;
    loop
      event_id := gen_random_uuid();
      issued := public.next_teaser_issued_at();
      begin
        insert into public.distribution_outbox (
          id, post_id, publication_id, type, issued_at, status, origin,
          snapshot_status, snapshot_access, snapshot_published_at,
          snapshot_title, snapshot_slug, snapshot_excerpt, snapshot_cover
        ) values (
          event_id,
          new.id,
          new.id,
          'post.published',
          issued,
          'pending',
          'transition',
          new.status::text,
          new.distribution_access,
          to_char(new.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          left(new.title, 180),
          new.slug,
          new.excerpt,
          new.cover_image_url
        );
        exit;
      exception when unique_violation then
        tries := tries + 1;
        if tries > 5 then
          raise;
        end if;
      end;
    end loop;
  end if;

  return new;
end;
$$;

revoke all on function public.sync_public_teaser() from public;
revoke all on function public.sync_public_teaser() from anon, authenticated;

create trigger posts_sync_public_teaser
  after update on public.posts
  for each row execute function public.sync_public_teaser();

create trigger posts_sync_public_teaser_delete
  before delete on public.posts
  for each row execute function public.sync_public_teaser();
