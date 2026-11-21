-- マネージャーくん（2026-11-21 開発部・shia2n-mcp v1.125.0・統括の依頼 1便目）
-- チャット 1 本＝mk_chats の 1 行。回答のピン＝mk_pins の 1 行（チャットの中で #1 から番号）。
-- 新しいテーブル 2 本と関数 2 本を作るだけ。既にあるテーブルには触らない（ai_log は外の鍵で指すだけ）。何度流しても同じ結果になる。
-- ブラウザ側（anon・authenticated）からは読めも書けもしない。読み書きは shia2n-mcp の管理者キーだけ。

create table if not exists public.mk_chats (
  no         bigint generated always as identity primary key,
  name       text not null check (char_length(name) between 1 and 120),
  ai         text not null check (ai in ('claude', 'gpt')),
  url        text check (url is null or char_length(url) <= 500),
  state      text not null default '進行中' check (state in ('進行中', '判断待ち', '寝かせ中', '閉じた')),
  doing      text not null default '' check (char_length(doing) <= 200),
  role       text check (role is null or char_length(role) <= 30),
  surface    text check (surface is null or char_length(surface) <= 30),
  ai_log_id  uuid references public.ai_log(id) on delete set null,
  pin_count  integer not null default 0,
  created_at timestamptz not null default now(),
  touched_at timestamptz not null default now()
);
create index if not exists mk_chats_touched_idx on public.mk_chats (touched_at desc);
create index if not exists mk_chats_state_idx on public.mk_chats (state, touched_at desc);

create table if not exists public.mk_pins (
  id         uuid primary key default gen_random_uuid(),
  chat_no    bigint not null references public.mk_chats(no) on delete cascade,
  n          integer not null check (n >= 1),
  title      text not null check (char_length(title) between 1 and 120),
  body       text not null check (char_length(body) between 1 and 200000),
  created_at timestamptz not null default now(),
  unique (chat_no, n)
);
create index if not exists mk_pins_created_idx on public.mk_pins (created_at desc);

alter table public.mk_chats enable row level security;
alter table public.mk_pins enable row level security;
revoke all on public.mk_chats from anon, authenticated;
revoke all on public.mk_pins from anon, authenticated;

comment on table public.mk_chats is 'マネージャーくんの台帳。1 行＝Claude か GPT のチャット 1 本。ai_log__add が会話の最初に作り、manager__update が状態と「何をしているか」を書き直す';
comment on table public.mk_pins is 'マネージャーくんのピン。1 行＝回答 1 つの全文。n はチャットの中の番号（#1 から）。manager__pin が書き、manager__get_pin が読む';

-- ピンを 1 つ足す。チャットの行を先に書き換えて鍵をかけるので、同時に 2 つ来ても番号がぶつからない
create or replace function public.mk_add_pin(p_chat bigint, p_title text, p_body text)
returns table (id uuid, chat_no bigint, n integer, created_at timestamptz)
language plpgsql
set search_path = public
as $$
declare v_n integer;
begin
  update public.mk_chats c set pin_count = c.pin_count + 1, touched_at = now()
   where c.no = p_chat
   returning c.pin_count into v_n;
  if v_n is null then raise exception 'chat_not_found'; end if;
  return query
    insert into public.mk_pins as p (chat_no, n, title, body)
    values (p_chat, v_n, p_title, p_body)
    returning p.id, p.chat_no, p.n, p.created_at;
end $$;

-- 探す。言葉を空白で区切り、全部を含むものだけ（大文字小文字は区別しない）。チャットは名前・何をしているか・役割、ピンは題と全文
create or replace function public.mk_search(p_q text, p_limit integer default 30)
returns table (kind text, chat_no bigint, pin_n integer, pin_id uuid, title text, chat_name text, state text, snippet text, at timestamptz)
language sql stable
set search_path = public
as $$
  with w as (
    select array_agg(lower(x)) as words
      from unnest(regexp_split_to_array(btrim(coalesce(p_q, '')), '[\s　]+')) x
     where x <> ''
  ),
  hits as (
    select 'chat'::text as kind, c.no as chat_no, null::integer as pin_n, null::uuid as pin_id,
           c.name as title, c.name as chat_name, c.state, c.doing as snippet, c.touched_at as at, 0 as rank
      from public.mk_chats c, w
     where w.words is not null
       and not exists (select 1 from unnest(w.words) k
                        where strpos(lower(c.name || ' ' || c.doing || ' ' || coalesce(c.role, '')), k) = 0)
    union all
    select 'pin', p.chat_no, p.n, p.id, p.title, c.name, c.state,
           substr(p.body, greatest(1, strpos(lower(p.body), w.words[1]) - 40), 160),
           p.created_at,
           case when strpos(lower(p.title), w.words[1]) > 0 then 0 else 1 end
      from public.mk_pins p join public.mk_chats c on c.no = p.chat_no, w
     where w.words is not null
       and not exists (select 1 from unnest(w.words) k
                        where strpos(lower(p.title || ' ' || p.body), k) = 0)
  )
  select kind, chat_no, pin_n, pin_id, title, chat_name, state, snippet, at
    from hits
   order by rank, at desc
   limit least(greatest(coalesce(p_limit, 30), 1), 100);
$$;

revoke all on function public.mk_add_pin(bigint, text, text) from public, anon, authenticated;
revoke all on function public.mk_search(text, integer) from public, anon, authenticated;
grant execute on function public.mk_add_pin(bigint, text, text) to service_role;
grant execute on function public.mk_search(text, integer) to service_role;

-- 確かめ：表 2 本と関数 2 本があり、RLS が両方 true
select to_regclass('public.mk_chats') is not null as chats,
       to_regclass('public.mk_pins') is not null as pins,
       (select relrowsecurity from pg_class where oid = 'public.mk_chats'::regclass) as rls_chats,
       (select relrowsecurity from pg_class where oid = 'public.mk_pins'::regclass) as rls_pins,
       (select count(*) from pg_proc where proname in ('mk_add_pin', 'mk_search')) as funcs;

-- ─── v1.126.0（2026-11-21 マネージャーくん 2便目）：シアニンパネルが自動で読んだ全文と、拡張用の鍵 ───
-- Supabase に入れ済み（migration manager_kun_transcripts_ext_keys）。列と表を足し、mk_search に全文を含めただけ。
alter table public.mk_chats add column if not exists transcript text check (transcript is null or char_length(transcript) <= 2000000);
alter table public.mk_chats add column if not exists transcript_at timestamptz;
alter table public.mk_chats add column if not exists turns integer;
alter table public.mk_chats add column if not exists service text check (service is null or service in ('claude', 'chatgpt'));
create index if not exists mk_chats_url_idx on public.mk_chats (url);

create table if not exists public.mk_ext_keys (
  id           uuid primary key default gen_random_uuid(),
  key_hash     text not null unique,
  label        text not null default 'シアニンパネル',
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
alter table public.mk_ext_keys enable row level security;
revoke all on public.mk_ext_keys from anon, authenticated;
-- mk_search は上の定義に、チャットの全文（transcript）も探す形を重ねた（定義の全文は Supabase の migration を正とする）
-- v1.126.1：表は変えていない（結び方の直しは src/manager-store.ts の applyCapture）
-- v1.126.2（Supabase に入れ済み・migration manager_kun_turns_json）：往復を番号で足し合わせるための列
alter table public.mk_chats add column if not exists turns_json jsonb;

-- ─── v1.127.0（2026-11-22 マネージャーくん 3便目）：ほかのアプリとのつなぎ（Supabase に入れ済み・migration manager_kun_links） ───
alter table public.mk_chats add column if not exists tm_task_id text;
alter table public.mk_chats add column if not exists initiative_no text check (initiative_no is null or initiative_no ~ '^[0-9]{2}$');
alter table public.mk_chats add column if not exists initiative_name text;
create table if not exists public.mk_settings (key text primary key, value text, updated_at timestamptz not null default now());
alter table public.mk_settings enable row level security;
revoke all on public.mk_settings from anon, authenticated;
