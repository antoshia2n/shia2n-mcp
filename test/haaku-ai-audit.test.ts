import test from "node:test";
import assert from "node:assert/strict";
import { parseChanges } from "../src/haaku-ai-changes.js";
import { buildManagementChangePlan } from "../src/haaku-ai-model.js";
import { managementWriteAudit } from "../src/haaku-ai-audit.js";

const week="2026-10-12";
const changes=parseChanges(JSON.stringify([
  {kind:"phase",request_id:"audit-phase-00001",data:{
    title:"集客の土台",purpose:"登録が動く",projectId:"",
  }},
  {kind:"milestone",request_id:"audit-mile-00001",data:{
    title:"登録テスト",criterion:"正常保存",status:"doing",phaseId:"phase_audit-phase-00001",
  }},
  {kind:"strategy",request_id:"audit-strategy-00001",data:{
    name:"長期",goal:"目標を達成",approach:"改善する",plan:"作る",successCriteria:"確認する",
    sourceUrl:"https://whimsical.com/x",horizon:"long",
  }},
  {kind:"weekly",request_id:"audit-weekly-00001",week_start:week,data:{
    title:"今週の成果",criterion:"確認する",status:"planned",milestoneId:"milestone_audit-mile-00001",
  }},
]));
const values=buildManagementChangePlan(changes,{
  os_roadmap_v1:null,
  os_strategy_records_v1:null,
  ["os_weekly_commits_v1_"+week]:null,
},"2026-10-11T09:00:00Z").next;

test("MCPから書いた更新は3種類の既存履歴に記録され、1回で件数を取れる",()=>{
  const result=managementWriteAudit(values,week);
  assert.equal(result.ok,true);
  assert.deepEqual(result.counts,{roadmap:2,strategies:1,weekly:1,total:4});
  assert.equal(result.latest.length,4);
  assert.ok(result.latest.every(item=>item.request_id.startsWith("audit-")));
  assert.ok(result.latest.some(item=>item.kind==="strategy"&&item.title==="長期"));
  assert.ok(result.latest.some(item=>item.kind==="weekly"&&item.title==="今週の成果"));
});

test("週間履歴は指定した場合だけ取得する",()=>{
  const result=managementWriteAudit(values);
  assert.equal(result.counts.weekly,0);
  assert.equal(result.state.weekly,"not_requested");
  assert.equal(result.counts.total,3);
});

test("既存の手動変更履歴をAI操作に混ぜず、未登録と0件を区別する",()=>{
  const blank=managementWriteAudit({
    os_roadmap_v1:null,os_strategy_records_v1:null,
  });
  assert.equal(blank.state.roadmap,"not_configured");
  assert.equal(blank.state.strategies,"not_configured");
  const none=managementWriteAudit({
    os_roadmap_v1:{version:1,milestones:[],phases:[]},
    os_strategy_records_v1:{schemaVersion:1,records:[{
      id:"manual",revisions:[{id:"ui-revision",name:"手動",savedAt:"2026-10-11"}],
    }]},
  });
  assert.equal(none.counts.total,0);
  assert.equal(none.state.roadmap,"ready");
  assert.equal(none.state.strategies,"ready");
});

test("読めない形式を0件に読み替えない",()=>{
  assert.throws(()=>managementWriteAudit({
    os_roadmap_v1:{version:9},os_strategy_records_v1:null,
  }),/版/);
  assert.throws(()=>managementWriteAudit(values,"2026-10-11"),/月曜日/);
});
