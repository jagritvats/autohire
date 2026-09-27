-- Source publish date on the shared posting (§3 freshness). `first_seen` is when WE
-- first polled a role, so a months-old req at a newly added company read as brand new;
-- `posted_at` is what the source says (Greenhouse first_published, Lever createdAt,
-- Ashby publishedAt, …). Null when the source gives no trustworthy date.
-- Idempotent: safe to re-run.

alter table posting
  add column if not exists posted_at timestamptz;

create index if not exists posting_posted_at_idx on posting (posted_at desc) where is_active;
