-- Supabase schema

-- users
create table if not exists users (
  id bigserial primary key,
  telegram_id bigint unique not null,
  username text,
  first_name text,
  free_comments int default 35,
  total_comments_purchased int default 0,
  unread_replies_count int default 0,
  voice_comments_sent int default 0,
  created_at timestamptz default now()
);

-- threads
create table if not exists threads (
  id bigserial primary key,
  social_link text unique not null,
  creator_telegram_id bigint references users(telegram_id),
  created_at timestamptz default now()
);

-- voice_comments
create table if not exists voice_comments (
  id bigserial primary key,
  thread_id bigint references threads(id) on delete cascade,
  telegram_id bigint,
  username text,
  first_name text,
  telegram_file_id text,
  duration int default 0,
  language_code text,
  created_at timestamptz default now()
);

-- voice_replies
create table if not exists voice_replies (
  id bigserial primary key,
  comment_id bigint references voice_comments(id) on delete cascade,
  replier_telegram_id bigint,
  replier_username text,
  replier_first_name text,
  telegram_file_id text,
  reply_text text,
  created_at timestamptz default now()
);

-- voice_reactions
create table if not exists voice_reactions (
  id bigserial primary key,
  comment_id bigint references voice_comments(id) on delete cascade,
  user_id bigint,
  type text check (type in ('like', 'dislike')),
  created_at timestamptz default now()
);

-- notifications
create table if not exists notifications (
  id bigserial primary key,
  telegram_id bigint not null,
  type text,
  message text,
  meta jsonb,
  created_at timestamptz default now(),
  read boolean default false
);

-- OPTIONAL helper RPC to increment unread replies count (create in Supabase SQL editor)
create or replace function increment_unread_replies(p_telegram_id bigint) returns void as $$
begin
  update users set unread_replies_count = coalesce(unread_replies_count,0) + 1 where telegram_id = p_telegram_id;
end;
$$ language plpgsql;
