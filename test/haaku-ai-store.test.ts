import test from "node:test";
import assert from "node:assert/strict";
import { parseChanges } from "../src/haaku-ai-changes.js";
import { previewManagementChanges,applyManagementChanges } from "../src/haaku-ai-store.js";
import { toFVal,fromVal } from "../src/taskmaster.js";
import { approvalDocName } from "../src/haaku-approval-record.js";

const NOW=Date.parse("2026-10-11T10:00:00.000Z");
const uid="test-uid-2026";
const APPROVAL_ID="11111111-1111-4111-8111-111111111111";
const approvalKey="approval_"+APPROVAL_ID;
const phase={kind:"phase",request_id:"phase-test-001",data:{
  title:"集客の土台",purpose:"入口が動作する",startDate:"2026-10-01",dueDate:"2026-10-31",
}};
const milestone={kind:"milestone",request_id:"milestone-test-001",data:{
  title:"LP検証",criterion:"実機で確認",status:"doing",
  phaseId:"phase_phase-test-001",
}};
const strategy={kind:"strategy",request_id:"strategy-test-001",data:{
  name:"長期",goal:"成果につながる",approach:"改善を繰り返す",plan:"土台を築く",
  successCriteria:"結果を検証",sourceUrl:"https://whimsical.com/123",horizon:"long",
}};
const weekly={kind:"weekly",request_id:"weekly-test-001",week_start:"2026-10-12",data:{
  title:"LP動作確認",criterion:"正常表示",status:"planned",
  milestoneId:"milestone_milestone-test-001",
}};
const ops=parseChanges(JSON.stringify([phase,milestone,strategy,weekly]));
const onlyPhase=parseChanges(JSON.stringify([phase]));

function mock(){
  const docs=new Map<string,{value:unknown;version:string}>();
  const calls:{method:string;url:string}[]=[];
  let nextVersion=1;
  let deniedKey="";
  let failCommit=false;
  let corruptAfterCommit=false;
  let commits=0,committed=false,rollbacks=0;
  let readCount=0;
  const respond=(o:unknown,status=200)=>Response.json(o,{status});
  const keyFor=(path:string)=>path.includes("/haaku_approvals/")?
    "approval_"+path.split("/haaku_approvals/").pop() : path.split("/app_data/").pop();
  const http=async (req:RequestInfo|URL,opts?:RequestInit):Promise<Response>=>{
    const url=String(req),method=opts?.method||"GET";
    calls.push({url,method});
    if(url.endsWith(":beginTransaction")){
      return respond({transaction:"mock-tx"});
    }
    if(url.endsWith(":rollback")){rollbacks++;return respond({});}
    if(url.endsWith(":commit")){
      commits++;
      if(failCommit)return respond({error:"ABORTED"},409);
      const body=JSON.parse(String(opts?.body));
      for(const w of body.writes){
        const key=keyFor(String(w.update.name));
        const old=docs.get(key);
        if((w.currentDocument?.exists===false && !!old) ||
          (w.currentDocument?.updateTime && old?.version!==w.currentDocument.updateTime)){
          return respond({error:"stale"},409);
        }
      }
      for(const w of body.writes){
        const key=keyFor(String(w.update.name));
        const val=fromVal(w.update.fields.value);
        docs.set(key,{value:val,version:"2026-10-11T11:00:"+String(nextVersion++).padStart(2,"0")+"Z"});
      }
      committed=true;
      return respond({commitTime:"2026-10-11T11:00:00Z",writeResults:body.writes.map(()=>({updateTime:"2026-10-11T11:00:00Z"}))});
    }
    const key=keyFor(new URL(url).pathname)||"";
    readCount++;
    if(key===deniedKey)return respond({error:"access denied"},403);
    const doc=docs.get(key);
    if(!doc)return respond({error:"not found"},404);
    const value=corruptAfterCommit&&committed ? {...(doc.value as any),unexpected:"changed"}:doc.value;
    return respond({name:key.startsWith("approval_")?approvalDocName(uid,key.slice(9)):
      "projects/test/documents/users/"+uid+"/app_data/"+key,
      updateTime:doc.version,fields:{value:toFVal(value)}});
  };
  return {
    http:http as typeof fetch,docs,calls,
    deny:(key:string)=>{deniedKey=key},
    fail:()=>{failCommit=true},
    corrupt:()=>{corruptAfterCommit=true},
    mutate:(key:string,value:unknown)=>{
      docs.set(key,{value,version:"2026-10-11T09:00:00.000Z"});
    },
    approve:(previewId:string,overrides:Record<string,unknown>={})=>{
      const record={
        uid,previewId,issuedAt:new Date(NOW).toISOString(),
        expiresAt:new Date(NOW+30*60000).toISOString(),
        status:"approved",approvedUid:uid,approvedAt:new Date(NOW).toISOString(),
        changes:[],affectedDocs:[],
      };
      docs.set(approvalKey,{value:{...record,...overrides},version:"2026-10-11T09:00:00.000Z"});
    },
    counts:()=>({commits,rollbacks,readCount}),
  };
}

test("プレビューはFirestoreへの書き込みを一切行わず全変更を提示する",async()=>{
  const server=mock();
  const p=await previewManagementChanges(server.http,"test-token",uid,ops,NOW);
  assert.equal(p.ok,true);
  assert.equal(p.writes_performed,0);
  assert.equal(p.changes.length,4);
  assert.equal(p.affected_docs.length,3);
  assert.match(p.preview_id,/^\d{13}\.[a-f0-9]{64}$/);
  assert.equal(server.counts().commits,0);
  assert.equal(server.docs.size,0);
});

test("明示承認がなければ、トランザクション開始や書き込みは不可",async()=>{
  const server=mock();
  const p=await previewManagementChanges(server.http,"token",uid,onlyPhase,NOW);
  await assert.rejects(()=>applyManagementChanges(server.http,"token",uid,onlyPhase,p.preview_id,"",NOW+1),/承認申請/);
  assert.equal(server.counts().commits,0);
  assert.equal(server.calls.filter(c=>c.url.endsWith(":beginTransaction")).length,0);
});

test("承認後は複数文書を一括コミット、値を再取得して一致確認",async()=>{
  const server=mock();
  const p=await previewManagementChanges(server.http,"token",uid,ops,NOW);
  server.approve(p.preview_id);
  const result=await applyManagementChanges(server.http,"token",uid,ops,p.preview_id,APPROVAL_ID,NOW+3000);
  assert.equal(result.state,"verified");
  assert.equal(result.verified.length,3);
  assert.equal(server.counts().commits,1);
  const r=server.docs.get("os_roadmap_v1")?.value as any;
  assert.equal(r.phases[0].title,"集客の土台");
  assert.equal(r.milestones[0].phaseId,r.phases[0].id);
  assert.equal((server.docs.get("os_strategy_records_v1")?.value as any).records.length,1);
  assert.equal((server.docs.get("os_weekly_commits_v1_2026-10-12")?.value as any).commitments.length,1);
  assert.equal(server.calls.filter(c=>c.method==="POST"&&c.url.endsWith(":commit")).length,1);
});

test("保存案がプレビュー後に変わったら書き込み前に停止",async()=>{
  const server=mock();
  const p=await previewManagementChanges(server.http,"token",uid,onlyPhase,NOW);
  server.approve(p.preview_id);
  const changed=parseChanges(JSON.stringify([{...phase,data:{...phase.data,title:"別の名前"}}]));
  await assert.rejects(()=>applyManagementChanges(server.http,"token",uid,changed,p.preview_id,APPROVAL_ID,NOW+1),/再確認/);
  assert.equal(server.counts().commits,0);
  assert.equal(server.counts().rollbacks,1);
});

test("別端末の更新が入った場合、プレビューを再提出するまで停止",async()=>{
  const server=mock();
  const p=await previewManagementChanges(server.http,"token",uid,onlyPhase,NOW);
  server.approve(p.preview_id);
  server.mutate("os_roadmap_v1",{version:1,milestones:[],phases:[],northStar:"変更"});
  await assert.rejects(()=>applyManagementChanges(server.http,"token",uid,onlyPhase,p.preview_id,APPROVAL_ID,NOW+1),/再確認/);
  assert.equal(server.counts().commits,0);
});

test("有効期限経過と読取エラーを未登録に読み替えない",async()=>{
  const server=mock();
  const p=await previewManagementChanges(server.http,"token",uid,onlyPhase,NOW);
  await assert.rejects(()=>applyManagementChanges(server.http,"token",uid,onlyPhase,p.preview_id,APPROVAL_ID,NOW+31*60000),/有効期限/);
  server.deny("os_roadmap_v1");
  await assert.rejects(()=>previewManagementChanges(server.http,"token",uid,onlyPhase,NOW),/403/);
});

test("Firestoreが競合・権限拒否なら成功報告しない",async()=>{
  const server=mock();
  const p=await previewManagementChanges(server.http,"token",uid,onlyPhase,NOW);
  server.approve(p.preview_id);
  server.fail();
  await assert.rejects(()=>applyManagementChanges(server.http,"token",uid,onlyPhase,p.preview_id,APPROVAL_ID,NOW+1),/HTTP 409/);
  assert.equal(server.docs.size,1);
});

test("commit成功でも保存後の再取得に失敗したら再実行せず警告",async()=>{
  const server=mock();
  const p=await previewManagementChanges(server.http,"token",uid,onlyPhase,NOW);
  server.approve(p.preview_id);
  server.corrupt();
  await assert.rejects(()=>applyManagementChanges(server.http,"token",uid,onlyPhase,p.preview_id,APPROVAL_ID,NOW+1),/自動再試行しない/);
  assert.equal(server.counts().commits,1);
  assert.equal(server.docs.size,2);
});

test("haAku本人の承認申請がなければ適用できない",async()=>{
  const server=mock();
  const p=await previewManagementChanges(server.http,"token",uid,onlyPhase,NOW);
  await assert.rejects(()=>applyManagementChanges(
    server.http,"token",uid,onlyPhase,p.preview_id,APPROVAL_ID,NOW+1000
  ),/承認申請が存在しません/);
  assert.equal(server.counts().commits,0);
});
test("別人や未承認の記録では書き込まない",async()=>{
  const server=mock();
  const p=await previewManagementChanges(server.http,"token",uid,onlyPhase,NOW);
  server.approve(p.preview_id,{approvedUid:"someone-else"});
  await assert.rejects(()=>applyManagementChanges(
    server.http,"token",uid,onlyPhase,p.preview_id,APPROVAL_ID,NOW+1000
  ),/本人の承認/);
  server.approve(p.preview_id,{status:"pending"});
  await assert.rejects(()=>applyManagementChanges(
    server.http,"token",uid,onlyPhase,p.preview_id,APPROVAL_ID,NOW+1000
  ),/本人の承認/);
  assert.equal(server.counts().commits,0);
});
test("承認は保存と同じcommitで消費され二重利用できない",async()=>{
  const server=mock();
  const p=await previewManagementChanges(server.http,"token",uid,onlyPhase,NOW);
  server.approve(p.preview_id);
  const result=await applyManagementChanges(
    server.http,"token",uid,onlyPhase,p.preview_id,APPROVAL_ID,NOW+1000);
  assert.equal(result.ok,true);
  assert.equal((server.docs.get(approvalKey)?.value as any).status,"consumed");
  await assert.rejects(()=>applyManagementChanges(
    server.http,"token",uid,onlyPhase,p.preview_id,APPROVAL_ID,NOW+1001
  ),/本人の承認/);
  assert.equal(server.counts().commits,1);
});
