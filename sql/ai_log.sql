-- AI の利用ログ（2026-10-26 開発部・shia2n-mcp v1.45.0 の道具 ai_log__add・ai_log__list が使う）
-- 新しいテーブルを 1 本作るだけ。既にあるテーブルには触らない。何度流しても同じ結果になる。
-- ブラウザ側（anon・authenticated）からは読めも書けもしない。読み書きは shia2n-mcp の管理者キーだけ。

create table if not exists public.ai_log (
  id      uuid primary key default gen_random_uuid(),
  at      timestamptz not null default now(),
  role    text not null check (char_length(role) between 1 and 30),
  surface text not null check (surface in ('claude.ai', 'Claude Code', 'GPT', '予約タスク')),
  title   text not null check (char_length(title) between 1 and 200)
);

create index if not exists ai_log_at_idx on public.ai_log (at);

alter table public.ai_log enable row level security;
revoke all on public.ai_log from anon, authenticated;

comment on table public.ai_log is 'AI の利用ログ。1 行＝AI の会話 1 本の始まり。shia2n-mcp の ai_log__add が書き、ai_log__list が読む';

-- 確かめ：exists が true、rls が true、行は 0 件
select to_regclass('public.ai_log') is not null as exists,
       (select relrowsecurity from pg_class where oid = 'public.ai_log'::regclass) as rls,
       (select count(*) from public.ai_log) as rows;
