import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./index.js";
import { handleTaskmasterTasks, handleTaskmasterAddTask } from "./taskmaster.js";

/**
 * TaskMaster ツールを登録する。
 * Firestore から Naoki の未完了タスク・プロジェクトを取得・追加する。
 * 命名規約：`taskmaster__<action>`（ダブルアンダースコアでアプリ名と機能を分離）
 */
export function registerTaskmasterTools(server: McpServer, env: Env): void {
  server.tool(
    "taskmaster__list_tasks",
    "TaskMasterに登録されているNaokiの未完了タスクとプロジェクト一覧を取得する。archived:false かつ completed:false のみ返す。秘書Claudeが毎朝起動時に呼び出す。戻り値は { tasks: [{id, title, status, priority, deadline, groupId, projectId}], projects: [{id, title, status, endDate}] }。",
    {},
    async () => {
      const res = await handleTaskmasterTasks(new Request("https://shia2n-mcp.internal/taskmaster/tasks"), env);
      const data = await res.json();
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );

  server.tool(
    "taskmaster__add_task",
    "TaskMasterに新しいタスクを追加する。Firestoreのtasksドキュメントにタスクを書き込む。戻り値は { ok: true, task: {id, title, status, priority, deadline, groupId, projectId} }。",
    {
      title: z
        .string()
        .describe("タスクのタイトル（必須）"),
      status: z
        .string()
        .optional()
        .describe("ステータス。例: \"todo\" / \"in_progress\" / \"done\"。省略時は \"todo\""),
      priority: z
        .string()
        .optional()
        .describe("優先度。例: \"high\" / \"medium\" / \"low\"。省略時は \"medium\""),
      deadline: z
        .string()
        .nullable()
        .optional()
        .describe("期限日（ISO 8601 形式。例: \"2026-05-14\"）。省略・null 可"),
      groupId: z
        .string()
        .nullable()
        .optional()
        .describe("グループ ID。省略・null 可"),
      projectId: z
        .string()
        .nullable()
        .optional()
        .describe("プロジェクト ID。省略・null 可"),
    },
    async (args) => {
      const res = await handleTaskmasterAddTask(
        new Request("https://shia2n-mcp.internal/taskmaster/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args),
        }),
        env
      );
      const data = await res.json();
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    }
  );
}
