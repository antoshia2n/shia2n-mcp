import test from "node:test";
import assert from "node:assert/strict";
import {
  approvalDocName,canCommitApprovedRecord,isApprovalExpired,
  type ApprovalRecord,
} from "../src/haaku-approval-record.js";
import {
  issueHumanApproval,readHumanApproval,decideHumanApproval,handleHaakuHumanApproval,
  HAAKU_APPROVAL_ORIGIN,
} from "../src/haaku-human-approval.js";
import { toFVal,fromVal } from "../src/taskmaster.js";
import type { Env } from "../src/index.js";

const NOW=Date.parse("2026-10-11T12:00:00Z"),uid="owner-uid-1234";
const previewId=String(NOW)+".a".repeat(64);
const requested={preview_id:previewId,expires_at:new Date(NOW+1800000).toISOString(),
  changes:[{kind:"phase",action:"create",title:"10月の基盤",changes:{title:{after:"10月の基盤",before:null}}}],
  affected_docs:["os_roadmap_v1"]};
const fake=(props:Partial<ApprovalRecord>={}):ApprovalRecord=>({
  uid,previewId,issuedAt:new Date(NOW).toISOString(),
  expiresAt:new Date(NOW+1800000).toISOString(),status:"pending",
  changes:requested.changes,affectedDocs:requested.affected_docs,...props,
});
function mock(){
  const state=new Map<string,{data:ApprovalRecord;version:string}>();
  let version=0,commits=0;
  const json=(body:unknown,status=200)=>Response.json(body,{status});
  const http=async (url:RequestInfo|URL,options?:RequestInit):Promise<Response>=>{
    const str=String(url),method=options?.method||"GET";
    if(str.endsWith(":beginTransaction"))return json({transaction:"test-txn"});
    if(str.endsWith(":rollback"))return json({});
    if(str.endsWith(":commit")){
      const body=JSON.parse(String(options?.body));
      if(body.writes?.length!==1)return json({},400);
      const write=body.writes[0],name=write.update?.name;
      const old=state.get(name);
      if(!old||old.version!==write.currentDocument?.updateTime)return json({},409);
      const data=fromVal(write.update.fields.value) as ApprovalRecord;
      state.set(name,{data,version:"2026-10-11T12:00:00."+String(++version).padStart(3,"0")+"Z"});
      commits++;return json({commitTime:"2026-10-11T12:00:00Z",writeResults:[{}]});
    }
    const parsed=new URL(str);
    if(method==="POST"&&parsed.searchParams.has("documentId")){
      const id=parsed.searchParams.get("documentId")!;
      const name=approvalDocName(uid,id);
      if(state.has(name))return json({},409);
      const data=fromVal(JSON.parse(String(options?.body)).fields.value) as ApprovalRecord;
      state.set(name,{data,version:"2026-10-11T12:00:00.000Z"});
      return json({name,updateTime:"2026-10-11T12:00:00.000Z"});
    }
    const name=parsed.pathname.slice(4); // /v1/{documentName}
    const doc=state.get(name);
    if(!doc)return json({},404);
    return json({name,updateTime:doc.version,fields:{value:toFVal(doc.data)}});
  };
  return {http:http as typeof fetch,state,counts:()=>commits};
}
test("ブラウザ本人の承認なしではpendingを保存へ使用できない",()=>{
  assert.equal(canCommitApprovedRecord(fake(),uid,previewId,NOW+1000),false);
  assert.equal(canCommitApprovedRecord(fake({status:"approved",approvedUid:uid,
    approvedAt:new Date(NOW+100).toISOString()}),uid,previewId,NOW+1000),true);
  assert.equal(canCommitApprovedRecord(fake({status:"approved",approvedUid:"other",
    approvedAt:new Date(NOW+100).toISOString()}),uid,previewId,NOW+1000),false);
  assert.equal(canCommitApprovedRecord(fake({status:"consumed",approvedUid:uid,
    approvedAt:new Date(NOW+100).toISOString()}),uid,previewId,NOW+1000),false);
  assert.equal(isApprovalExpired(fake(),NOW+1800001),true);
});
test("プレビューから承認申請だけを作り、対象の変更内容をブラウザで取り直す",async()=>{
  const db=mock();
  const result=await issueHumanApproval(db.http,"token",uid,requested,NOW);
  assert.match(result.approval_url,/^https:\/\/haaku\.shia2n\.jp\/\?approval=/);
  assert.equal(result.approval_record_created,true);
  assert.equal(db.state.size,1);
  const record=await readHumanApproval(db.http,"token",uid,result.approval_id);
  assert.equal(record.value.status,"pending");
  assert.equal(record.value.previewId,previewId);
  assert.equal(record.value.changes[0].title,"10月の基盤");
});
test("Googleログインを通った本人の承認後だけapprovedになり、再取得で確認する",async()=>{
  const db=mock();
  const result=await issueHumanApproval(db.http,"token",uid,requested,NOW);
  const approved=await decideHumanApproval(db.http,"token",uid,result.approval_id,"approve",NOW+1000);
  assert.equal(approved.status,"approved");
  const record=await readHumanApproval(db.http,"token",uid,result.approval_id);
  assert.equal(record.value.approvedUid,uid);
  assert.equal(canCommitApprovedRecord(record.value,uid,previewId,NOW+1001),true);
  assert.equal(db.counts(),1);
  await assert.rejects(()=>decideHumanApproval(db.http,"token",uid,result.approval_id,
    "approve",NOW+1002),/未承認の状態ではない/);
});
test("却下した承認は再度使えず、期限切れも拒否する",async()=>{
  const db=mock();
  const result=await issueHumanApproval(db.http,"token",uid,requested,NOW);
  const rejected=await decideHumanApproval(db.http,"token",uid,result.approval_id,"reject",NOW+1000);
  assert.equal(rejected.status,"rejected");
  const record=await readHumanApproval(db.http,"token",uid,result.approval_id);
  assert.equal(canCommitApprovedRecord(record.value,uid,previewId,NOW+1001),false);
  const next=await issueHumanApproval(db.http,"token",uid,requested,NOW);
  await assert.rejects(()=>decideHumanApproval(db.http,"token",uid,next.approval_id,
    "approve",NOW+1800001),/有効期限/);
});
test("Firebase認証前にOriginやBearerで拒否する",async()=>{
  const id="11111111-1111-4111-8111-111111111111";
  const path="https://shia2n-mcp.example/haaku/approvals/"+id;
  const minimal={} as Env;
  const disallowed=await handleHaakuHumanApproval(
    new Request(path,{headers:{Origin:"https://evil.example"}}),minimal);
  assert.equal(disallowed.status,403);
  const unauth=await handleHaakuHumanApproval(
    new Request(path,{headers:{Origin:HAAKU_APPROVAL_ORIGIN}}),minimal);
  assert.equal(unauth.status,401);
  const cors=await handleHaakuHumanApproval(
    new Request(path,{method:"OPTIONS",headers:{Origin:HAAKU_APPROVAL_ORIGIN}}),minimal);
  assert.equal(cors.status,204);
  assert.equal(cors.headers.get("Access-Control-Allow-Origin"),HAAKU_APPROVAL_ORIGIN);
});
