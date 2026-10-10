-- 土台 6 番：表を 1 本変えたときに壊れるものを引く（データベースの中の側）。2026-10-10 開発部
-- 道具 db__impact（shia2n-mcp）が呼ぶ。読むだけで、書く表は 0。新しい表は作らない。
-- 返すもの：その表を使うビュー・処理（関数）・引き金・守りの決まり（RLS）・外部キー（向かう先と向けられている元）・
--   ブラウザ側の立場（anon・authenticated）が持つ許可・定時の処理（pg_cron があるときだけ）。
-- 表が無いときは exists=false を返す（0 件と区別する）。
-- 何度流しても同じ結果になる（create or replace）。

create or replace function public.list_table_dependents(p_table text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_rel oid;
  v_out jsonb;
  v_cron jsonb := null;
begin
  if p_table is null or p_table !~ '^[a-z_][a-z0-9_]{0,62}$' then
    return jsonb_build_object('ok', false, 'error', 'bad_table_name');
  end if;

  v_rel := to_regclass('public.' || quote_ident(p_table));
  if v_rel is null then
    return jsonb_build_object('ok', true, 'table', p_table, 'exists', false);
  end if;

  -- 定時の処理（pg_cron が入っているときだけ。無ければ null＝「調べていない」）
  if to_regclass('cron.job') is not null then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object('jobname', jobname, 'schedule', schedule) order by jobname), '[]'::jsonb)
      from cron.job where command ~ ('\m' || $1 || '\M')
    $q$ into v_cron using p_table;
  end if;

  select jsonb_build_object(
    'ok', true,
    'table', p_table,
    'exists', true,
    'rows_estimate', (select c.reltuples::bigint from pg_class c where c.oid = v_rel),
    'rls_enabled', (select c.relrowsecurity from pg_class c where c.oid = v_rel),
    'views', coalesce((
      select jsonb_agg(distinct v.relname order by v.relname)
      from pg_depend d
      join pg_rewrite r on r.oid = d.objid
      join pg_class v on v.oid = r.ev_class
      where d.classid = 'pg_rewrite'::regclass and d.refobjid = v_rel and v.oid <> v_rel
    ), '[]'::jsonb),
    'functions', coalesce((
      select jsonb_agg(jsonb_build_object('name', p.proname, 'security_definer', p.prosecdef) order by p.proname)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prokind in ('f', 'p')
        and p.proname <> 'list_table_dependents'
        and p.prosrc ~ ('\m' || p_table || '\M')
    ), '[]'::jsonb),
    'triggers', coalesce((
      select jsonb_agg(jsonb_build_object('name', t.tgname, 'function', f.proname) order by t.tgname)
      from pg_trigger t
      join pg_proc f on f.oid = t.tgfoid
      where t.tgrelid = v_rel and not t.tgisinternal
    ), '[]'::jsonb),
    'policies', coalesce((
      select jsonb_agg(jsonb_build_object('name', pol.polname, 'command', pol.polcmd::text,
        'roles', (select coalesce(jsonb_agg(case when r = 0 then 'public' else (select rolname from pg_roles where oid = r) end), '[]'::jsonb)
                  from unnest(pol.polroles) as r)) order by pol.polname)
      from pg_policy pol
      where pol.polrelid = v_rel
    ), '[]'::jsonb),
    'foreign_keys_out', coalesce((
      select jsonb_agg(jsonb_build_object('name', c.conname, 'to', t.relname) order by c.conname)
      from pg_constraint c join pg_class t on t.oid = c.confrelid
      where c.contype = 'f' and c.conrelid = v_rel
    ), '[]'::jsonb),
    'foreign_keys_in', coalesce((
      select jsonb_agg(jsonb_build_object('name', c.conname, 'from', t.relname) order by t.relname, c.conname)
      from pg_constraint c join pg_class t on t.oid = c.conrelid
      where c.contype = 'f' and c.confrelid = v_rel and c.conrelid <> v_rel
    ), '[]'::jsonb),
    'browser_grants', coalesce((
      select jsonb_agg(jsonb_build_object('role', g.grantee, 'privilege', g.privilege_type) order by g.grantee, g.privilege_type)
      from information_schema.role_table_grants g
      where g.table_schema = 'public' and g.table_name = p_table and g.grantee in ('anon', 'authenticated')
    ), '[]'::jsonb),
    'cron_jobs', v_cron
  ) into v_out;

  return v_out;
end;
$$;

revoke all on function public.list_table_dependents(text) from public;
revoke all on function public.list_table_dependents(text) from anon, authenticated;
grant execute on function public.list_table_dependents(text) to service_role;

-- 確かめ（結果の 4 行が 1 行に並ぶ）：
--   ① 関数がある ② service_role だけが呼べる ③ ブラウザ側の立場は呼べない ④ 表が無いときは exists=false
select
  (select count(*) from pg_proc where proname = 'list_table_dependents') as fn,
  has_function_privilege('service_role', 'public.list_table_dependents(text)', 'execute') as service_role_can,
  has_function_privilege('anon', 'public.list_table_dependents(text)', 'execute') as anon_can,
  (public.list_table_dependents('zz_no_such_table') ->> 'exists') as missing_exists;
