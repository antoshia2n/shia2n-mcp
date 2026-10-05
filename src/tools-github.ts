/**
 * shia2n-mcp / src/tools-github.ts / 初版（2026-10-05 開発部）
 *
 * 開発部が直しを本番へ出す道。新しい枝にファイルを上げ、プルリクを作るところまで。
 * 結合（Merge）は Naoki が GitHub の画面で押す。ここからはしない。
 *
 * 守ること
 * - 書けるのは「claude/」で始まる新しい枝だけ。main など既にある枝には書かない（既にある名前ならエラー）
 * - 書いてよいリポジトリは GITHUB_ALLOWED_REPOS（カンマ区切り）。未設定なら antoshia2n/content-os だけ
 * - ファイルを消す・名前を変える・結合する・強制で書き換える、はしない
 * - 鍵（GITHUB_TOKEN）は Workers の秘密の値に置く。返す値には出さない
 *
 * 調べる手段（技術鉄則集 §10.2）
 * - 成功は { ok: true, pr_url, ... }。失敗は { ok: false, step, status, message } で、どの段で落ちたかを返す
 * - 書いた記録は GitHub のプルリク一覧に 1 件ずつ残る
 *
 * 命名規約：`github__<action>`
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";

const API = "https://api.github.com";
const DEFAULT_REPOS = ["antoshia2n/content-os"];
const BRANCH_PREFIX = "claude/";
const MAX_FILES = 40;

function allowedRepos(env: Env): string[] {
  const raw = (env.GITHUB_ALLOWED_REPOS ?? "").trim();
  if (!raw) return DEFAULT_REPOS;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

class StepError extends Error {
  constructor(public step: string, public status: number, message: string) {
    super(message);
  }
}

async function gh(env: Env, step: string, method: string, path: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "shia2n-mcp",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new StepError(step, 0, "GitHub につながりませんでした");
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const msg = typeof data?.message === "string" ? data.message : `HTTP ${res.status}`;
    throw new StepError(step, res.status, msg);
  }
  return data;
}

function checkRepo(env: Env, repo: string): string | null {
  if (!env.GITHUB_TOKEN) return "鍵が設定されていません（GITHUB_TOKEN）";
  if (!allowedRepos(env).includes(repo)) return `書いてよいリポジトリではありません（許可：${allowedRepos(env).join(", ")}）`;
  return null;
}

export function registerGithubTools(server: McpServer, env: Env): void {
  server.tool(
    "github__open_pr",
    "許可されたリポジトリに、claude/ で始まる新しい枝を作ってファイルを上げ、プルリクを 1 本作る。結合（Merge）はしない（Naoki が GitHub の画面で押す）。files に渡したファイルだけが、置き換えか新規として入る。消す・名前を変えることはできない。文字のファイルは content、画像などは content_base64 で渡す。既にある枝の名前を渡すとエラーで止まる。戻り値: 成功 { ok: true, pr_url, pr_number, branch, base, commit_sha, files }／失敗 { ok: false, step, status, message }。",
    {
      repo:   z.string().describe("owner/name の形。例 antoshia2n/content-os"),
      branch: z.string().describe("新しく作る枝の名前。claude/ で始める。例 claude/contentos-light-load"),
      title:  z.string().describe("プルリクとコミットの題名"),
      body:   z.string().optional().describe("プルリクの本文（何を・なぜ・確かめ方）"),
      base:   z.string().optional().describe("元にする枝。省略時は main"),
      files:  z.array(z.object({
        path:           z.string().describe("リポジトリの根からの道すじ。例 src/App.jsx"),
        content:        z.string().optional().describe("文字のファイルの全文（UTF-8）"),
        content_base64: z.string().optional().describe("画像などの中身（base64）"),
      })).min(1).max(MAX_FILES).describe(`上げるファイル（1〜${MAX_FILES} 個）`),
    },
    async (args) => {
      const bad = checkRepo(env, args.repo);
      if (bad) return asMcpTextResult({ ok: false, step: "check", status: 0, message: bad });
      if (!args.branch.startsWith(BRANCH_PREFIX) || args.branch.length <= BRANCH_PREFIX.length) {
        return asMcpTextResult({ ok: false, step: "check", status: 0, message: `枝の名前は ${BRANCH_PREFIX} で始めてください` });
      }
      for (const f of args.files) {
        const n = (f.content !== undefined ? 1 : 0) + (f.content_base64 !== undefined ? 1 : 0);
        if (n !== 1) return asMcpTextResult({ ok: false, step: "check", status: 0, message: `${f.path}：content と content_base64 のどちらか 1 つだけを渡してください` });
        if (f.path.startsWith("/") || f.path.includes("..")) return asMcpTextResult({ ok: false, step: "check", status: 0, message: `${f.path}：道すじはリポジトリの根からの相対で書いてください` });
      }
      const base = args.base ?? "main";
      const r = `/repos/${args.repo}`;
      try {
        const ref = await gh(env, "read_base", "GET", `${r}/git/ref/heads/${encodeURIComponent(base)}`);
        const baseSha: string = ref.object.sha;
        const baseCommit = await gh(env, "read_base", "GET", `${r}/git/commits/${baseSha}`);
        const tree = [];
        for (const f of args.files) {
          const blob = await gh(env, "blob", "POST", `${r}/git/blobs`,
            f.content !== undefined ? { content: f.content, encoding: "utf-8" } : { content: f.content_base64, encoding: "base64" });
          tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
        }
        const newTree = await gh(env, "tree", "POST", `${r}/git/trees`, { base_tree: baseCommit.tree.sha, tree });
        const commit = await gh(env, "commit", "POST", `${r}/git/commits`, { message: args.title, tree: newTree.sha, parents: [baseSha] });
        await gh(env, "branch", "POST", `${r}/git/refs`, { ref: `refs/heads/${args.branch}`, sha: commit.sha });
        const pr = await gh(env, "pull_request", "POST", `${r}/pulls`, { title: args.title, head: args.branch, base, body: args.body ?? "" });
        return asMcpTextResult({
          ok: true, pr_url: pr.html_url, pr_number: pr.number, branch: args.branch, base,
          commit_sha: commit.sha, files: args.files.map((f) => f.path),
        });
      } catch (e) {
        if (e instanceof StepError) {
          const hint = e.step === "branch" && e.status === 422 ? "（同じ名前の枝が既にあります。別の名前にしてください）" : "";
          return asMcpTextResult({ ok: false, step: e.step, status: e.status, message: e.message + hint });
        }
        return asMcpTextResult({ ok: false, step: "unknown", status: 0, message: String(e) });
      }
    }
  );

  server.tool(
    "github__pr_status",
    "プルリク 1 本の状態を返す（開いている・結合済み・閉じた）。結合済みなら main に入ったコミットの番号と住所も返す。戻り値: { ok, state, merged, merged_at, merge_commit_sha, merge_commit_url, pr_url, head, base }。",
    {
      repo:      z.string().describe("owner/name の形"),
      pr_number: z.number().int().positive().describe("プルリクの番号"),
    },
    async (args) => {
      const bad = checkRepo(env, args.repo);
      if (bad) return asMcpTextResult({ ok: false, step: "check", status: 0, message: bad });
      try {
        const pr = await gh(env, "read_pr", "GET", `/repos/${args.repo}/pulls/${args.pr_number}`);
        const sha = pr.merged ? pr.merge_commit_sha : null;
        return asMcpTextResult({
          ok: true, state: pr.state, merged: !!pr.merged, merged_at: pr.merged_at ?? null,
          merge_commit_sha: sha, merge_commit_url: sha ? `https://github.com/${args.repo}/commit/${sha}` : null,
          pr_url: pr.html_url, head: pr.head?.ref, base: pr.base?.ref,
        });
      } catch (e) {
        if (e instanceof StepError) return asMcpTextResult({ ok: false, step: e.step, status: e.status, message: e.message });
        return asMcpTextResult({ ok: false, step: "unknown", status: 0, message: String(e) });
      }
    }
  );
}
