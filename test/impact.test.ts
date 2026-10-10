// 土台 6 番 db__impact のコードの中を探す部分の試験。走らせ方：node --test test/impact.test.ts（Node 22.18 以上）
// 固まりは git archive で作る（GitHub の codeload と同じ tar.gz・最初の 1 段がリポジトリ名-版の形）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { untarSources, gunzip, findInRepo, targetsFromSystems, TABLE_RE } from "../src/impact-core.ts";

function tarball(files: Record<string, string>): Uint8Array {
  const dir = execFileSync("mktemp", ["-d"]).toString().trim();
  execFileSync("git", ["init", "-q", dir]);
  for (const [p, body] of Object.entries(files)) {
    execFileSync("mkdir", ["-p", `${dir}/${p.split("/").slice(0, -1).join("/") || "."}`]);
    execFileSync("sh", ["-c", `cat > "${dir}/${p}"`], { input: body });
  }
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "t"]);
  return new Uint8Array(execFileSync("git", ["-C", dir, "archive", "--format=tar.gz", "--prefix=antoshia2n-x-abc1234/", "HEAD"]));
}

test("表の名前の決まり", () => {
  assert.ok(TABLE_RE.test("member"));
  assert.ok(TABLE_RE.test("b_events"));
  assert.ok(!TABLE_RE.test("Member"));
  assert.ok(!TABLE_RE.test("member; drop"));
});

test("固まりをほどき、ソースだけを最初の 1 段を外して返す（node_modules と画像は外す）", async () => {
  const gz = tarball({
    "src/a.js": "x",
    "functions/api/b.ts": "y",
    "node_modules/z/index.js": "no",
    "public/logo.png": "png",
    "supabase/c.sql": "select 1;",
  });
  const files = untarSources(await gunzip(gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) as ArrayBuffer));
  assert.deepEqual(files.map((f) => f.path).sort(), ["functions/api/b.ts", "src/a.js", "supabase/c.sql"]);
});

test("拾う：引用符の中・URL の中・public.名前・.sql・読み替えの左。拾わない：似た名前・変数・ただの語", async () => {
  const gz = tarball({
    "src/a.js": [
      "const r = await supabase.from('member').select('*');",          // 1 拾う
      "fetch(`${url}/rest/v1/member?select=id`);",                      // 2 拾う
      "db(env, 'GET', 'member_entitlement?select=*');",                 // 3 拾わない（似た名前）
      "const member = row.member;",                                     // 4 拾わない（変数）
      "// member の人数を数える",                                        // 5 拾わない（ただの語）
      "const map = { customers: \"member\" };",                         // 6 拾う（name）
      "db(env, 'GET', 'customers?select=id');",                         // 7 拾う（alias:customers）
    ].join("\n"),
    "supabase/x.sql": "create view v as select * from member m;\nselect * from member_entitlement;",
    "src/b.ts": "await sql`insert into public.member (id) values (1)`;",
  });
  const files = untarSources(await gunzip(gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) as ArrayBuffer));
  const r = findInRepo(files, "member");
  const flat = r.files.flatMap((f) => f.lines.map((l) => `${f.path}:${l.n}:${l.via}`));
  assert.deepEqual(flat, ["src/a.js:1:name", "src/a.js:2:name", "src/a.js:6:name", "src/a.js:7:alias:customers", "src/b.ts:1:public", "supabase/x.sql:1:sql"]);
  assert.equal(r.total_lines, 6);
  assert.equal(r.total_files, 3);
  assert.deepEqual(r.aliases, ["customers"]);
});

test("Systems の行から読む先を決める：稼働中と開発中だけ・GitHub の住所だけ・同じリポジトリは 1 回", () => {
  const row = (name: string, use: string | null, url: string | null) => ({ properties: { "システム名": { title: [{ plain_text: name }] }, "使用": { select: use ? { name: use } : null }, "リポジトリURL": { url } } });
  const t = targetsFromSystems([
    row("会員管理くん", "稼働中", "https://github.com/antoshia2n/kaiin-kanri"),
    row("B", "開発中", "https://github.com/antoshia2n/utage-alt-demo.git"),
    row("古い", "廃止", "https://github.com/antoshia2n/old"),
    row("住所なし", "稼働中", null),
    row("重なり", "稼働中", "https://github.com/antoshia2n/Kaiin-Kanri/"),
  ]);
  assert.deepEqual(t.map((x) => x.repo), ["antoshia2n/kaiin-kanri", "antoshia2n/utage-alt-demo"]);
});
