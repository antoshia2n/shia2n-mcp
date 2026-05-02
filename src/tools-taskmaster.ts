import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./index.js";
import { handleTaskmasterTasks } from "./taskmaster.js";

/**
 * TaskMaster ツールを登録する。
 * Firestore から Naoki の未完了タスク・プロジェクトを取得する。
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
}
