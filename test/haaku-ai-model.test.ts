import test from "node:test";
import assert from "node:assert/strict";
import { parseChanges, newTargetId, neededKeys, writeKeys } from "../src/haaku-ai-changes.js";
import { buildManagementChangePlan,verifyPlannedValues } from "../src/haaku-ai-model.js";

const at="2026-10-11T10:00:00.000Z";
const op=(kind:string,request_id:string,data:Record<string,string>,week_start?:string)=>
  ({kind,request_id,data,...(week_start?{week_start}:{})});
const make=(items:unknown[])=>parseChanges(JSON.stringify(items));
const stage="phase_phase-request-00001";
const goal="milestone_mile-request-00001";
const start="2026-10-12";
const strategy=(name:string,horizon:string,extra:Record<string,string>={})=>({
  name,horizon,goal:"全体目標を達成",approach:"検証して改善する",plan:"土台から着手する",
  successCriteria:"成果を確認する",sourceUrl:"https://whimsical.com/board",
  ...extra
});
const basics=[
  op("phase","phase-request-00001",{title:"集客基盤",purpose:"動く状態",startDate:"2026-10-01",
    dueDate:"2026-10-31",projectId:""}),
  op("milestone","mile-request-00001",{title:"LP完成",criterion:"URLで動作を確認",
    dueDate:"2026-10-31",status:"doing",phaseId:stage,projectId:""}),
  op("strategy","strategy-long-001",strategy("長期","long")),
  op("strategy","strategy-medium-001",strategy("中期","medium",
    {parentRecordId:"strategy_strategy-long-001"})),
  op("strategy","strategy-short-001",strategy("短期","short",
    {parentRecordId:"strategy_strategy-medium-001",milestoneId:goal})),
  op("weekly","weekly-request-00001",{title:"LP検証",criterion:"申込をテスト",
    milestoneId:goal,status:"planned"},start),
];
const empty={"os_roadmap_v1":null,"os_strategy_records_v1":null,
  ["os_weekly_commits_v1_"+start]:null};

test("1回の承認でフェーズ・成果物・長中短期戦略・週間コミットを順に作成できる",()=>{
  const changes=make(basics);
  const initial=JSON.parse(JSON.stringify(empty));
  const plan=buildManagementChangePlan(changes,initial,at);
  assert.deepEqual(plan.changed,["os_roadmap_v1","os_strategy_records_v1",
    "os_weekly_commits_v1_"+start].sort());
  assert.deepEqual(plan.steps.map(s=>s.action),Array(6).fill("create"));
  assert.equal((plan.next.os_roadmap_v1 as any).phases[0].id,stage);
  assert.equal((plan.next.os_roadmap_v1 as any).milestones[0].phaseId,stage);
  assert.equal((plan.next.os_strategy_records_v1 as any).records.length,3);
  assert.equal((plan.next.os_weekly_commits_v1_2026_10_12 as any),undefined);
  assert.equal(((plan.next["os_weekly_commits_v1_"+start]) as any).commitments[0].milestoneId,goal);
  assert.equal(((plan.next["os_weekly_commits_v1_"+start]) as any).history.length,1);
  assert.equal((plan.next.os_roadmap_v1 as any).aiChanges.length,2);
  assert.deepEqual(initial,empty,"入力の元データは変更しない");
  verifyPlannedValues(plan.next,plan);
});
test("MCPは任意のFirestoreパスや危険なプロパティを受け付けない",()=>{
  assert.throws(()=>make([op("delete","some-request-001",{})]),/種類/);
  assert.throws(()=>make([op("phase","some-request-001",{title:"a",purpose:"b",value:"delete"})]),/許可されていない/);
  assert.throws(()=>make([{...basics[0],doc_path:"users/admin"}]),/種類/);
  assert.throws(()=>make([op("phase","too-short",{title:"a",purpose:"b"})]),/識別子/);
  assert.throws(()=>make(Array.from({length:13},(_,i)=>op("phase","request-id-"+String(i+1).padStart(3,"0"),{}))),/1〜12/);
  assert.throws(()=>make([basics[0],basics[0]]),/重複/);
});
test("週の開始日と保存形式のバリデーション",()=>{
  assert.throws(()=>make([op("weekly","valid-request-001",{}, "2026-10-11")]),/月曜日/);
  assert.throws(()=>make([op("weekly","valid-request-001",{}, "2026-02-30")]),/月曜日/);
  assert.throws(()=>make([op("phase","valid-request-001",{}, "2026-10-12")]),/week_start/);
  assert.deepEqual(neededKeys(make([basics[0]])),["os_roadmap_v1"]);
  assert.deepEqual(writeKeys(make([basics[2]])),["os_strategy_records_v1"]);
});
test("承認なしのAIが達成を勝手に設定できないよう、証拠なしのdoneを拒否",()=>{
  assert.throws(()=>buildManagementChangePlan(make([
    basics[0],{...basics[1],data:{...basics[1].data,status:"done"}},
  ]),empty,at),/証拠/);
  assert.throws(()=>buildManagementChangePlan(make([
    basics[0],basics[1],{...basics[5],data:{...basics[5].data,status:"done"}},
  ]),empty,at),/証拠/);
});
test("親のない中期戦略・存在しないマイルストーンを拒否",()=>{
  assert.throws(()=>buildManagementChangePlan(make([basics[3]]),empty,at),/上位戦略/);
  assert.throws(()=>buildManagementChangePlan(make([{
    ...basics[4],data:{...basics[4].data,milestoneId:"milestone-missing"},
  }]),empty,at),/上位戦略/);
  assert.throws(()=>buildManagementChangePlan(make([basics[2],basics[3],{
    ...basics[4],data:{...basics[4].data,milestoneId:"milestone-missing"},
  }]),empty,at),/マイルストーン/);
});
test("旧版を保持し、戦略変更理由なしでは改訂できない",()=>{
  const state=buildManagementChangePlan(make([basics[2]]),empty,at).next;
  const upd=op("strategy","strategy-change-001",
    {recordId:"strategy_strategy-long-001",goal:"変更後の目的"});
  assert.throws(()=>buildManagementChangePlan(make([upd]),state,at),/改訂には理由/);
  const result=buildManagementChangePlan(make([{...upd,data:{...upd.data,reason:"戦略を変更した"}}]),state,"2026-10-12T10:00:00Z");
  assert.equal((state.os_strategy_records_v1 as any).records[0].revisions.length,1);
  assert.equal((result.next.os_strategy_records_v1 as any).records[0].revisions.length,2);
  assert.equal((result.next.os_strategy_records_v1 as any).records[0].revisions[0].goal,"全体目標を達成");
  assert.equal((result.next.os_strategy_records_v1 as any).records[0].revisions[1].reason,"戦略を変更した");
});
test("名前の重複や依存関係の循環を拒否",()=>{
  assert.throws(()=>buildManagementChangePlan(make([basics[0],{
    ...basics[0],request_id:"phase-request-00002",
  }]),empty,at),/同名/);
  assert.throws(()=>buildManagementChangePlan(make([
    basics[0],basics[1],op("milestone","mile-request-00002",{
      title:"依存のテスト",criterion:"合格する",status:"todo",dependsOn:goal,
    }),
    op("milestone","mile-change-00001", {id:goal,dependsOn:"milestone_mile-request-00002"}),
  ]),empty,at),/循環/);
});
test("週次コミットは3件まで、変更時の理由は必須、履歴は追記する",()=>{
  const base=[basics[0],basics[1]];
  const w=(id:string)=>op("weekly",id,{title:id,criterion:"合格",milestoneId:goal,status:"planned"},start);
  const first=buildManagementChangePlan(make([...base,w("weekly-request-00001"),
    w("weekly-request-00002"),w("weekly-request-00003")]),empty,at).next;
  assert.equal(((first["os_weekly_commits_v1_"+start])as any).commitments.length,3);
  assert.throws(()=>buildManagementChangePlan(make([w("weekly-request-00004")]),first,at),/最大3件/);
  const edit=op("weekly","weekly-edit-request-01",
    {id:"weekly_weekly-request-00001",title:"合格条件の変更"},start);
  assert.throws(()=>buildManagementChangePlan(make([edit]),first,at),/変更には理由/);
  const next=buildManagementChangePlan(make([{
    ...edit,data:{...edit.data,changeReason:"判断を改めた"}
  }]),first,at).next;
  assert.equal(((next["os_weekly_commits_v1_"+start])as any).history.length,4);
  assert.equal(((first["os_weekly_commits_v1_"+start])as any).history.length,3);
});
test("同じrequest_idの再実行は二重登録しない",()=>{
  const first=buildManagementChangePlan(make([basics[0]]),empty,at).next;
  assert.throws(()=>buildManagementChangePlan(make([basics[0]]),first,at),/登録済み/);
});
test("未知バージョンと不正な保存形式を空に読み替えない",()=>{
  assert.throws(()=>buildManagementChangePlan(make([basics[0]]),{
    ...empty,os_roadmap_v1:{version:2,milestones:[],phases:[]}
  },at),/版/);
  assert.throws(()=>buildManagementChangePlan(make([basics[2]]),{
    ...empty,os_strategy_records_v1:{schemaVersion:2,records:[]}
  },at),/版/);
  assert.throws(()=>buildManagementChangePlan(make([basics[5]]),{
    ...empty,["os_weekly_commits_v1_"+start]:{version:2,commitments:[],history:[]}
  },at),/上位|版|関連マイルストーン/);
});
test("保存後の再取得値が異なれば成功扱いにしない",()=>{
  const plan=buildManagementChangePlan(make([basics[0]]),empty,at);
  const modified=JSON.parse(JSON.stringify(plan.next));
  (modified.os_roadmap_v1 as any).phases[0].purpose="別の状態";
  assert.throws(()=>verifyPlannedValues(modified,plan),/一致しません/);
});
