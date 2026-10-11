// haAku browser approval. A signed Firebase ID token from the logged-in haAku
// owner is required; MCP's Boolean flag and its OAuth consent screen are not proof.
import { getFirestoreToken, fromVal, toFVal, type FVal } from "./taskmaster.js";
import { verifyIdToken } from "./gate.js";
import type { Env } from "./index.js";
import {
  approvalDocName, approvalUrl, HAAKU_DOCS_URL,
  isApprovalExpired, isApprovalRecord, type ApprovalRecord,
} from "./haaku-approval-record.js";

type Http=typeof fetch;
type Document={name:string;updateTime?:string;fields?:Record<string,FVal>};
export const HAAKU_APPROVAL_ORIGIN="https://haaku.shia2n.jp";

function response(data:unknown,status=200):Response{
  return Response.json(data,{status,headers:{
    "Access-Control-Allow-Origin":HAAKU_APPROVAL_ORIGIN,
    "Vary":"Origin", "Cache-Control":"no-store",
    "Referrer-Policy":"no-referrer", "X-Content-Type-Options":"nosniff",
  }});
}
const authHeaders=(token:string)=>({Authorization:"Bearer "+token,"Content-Type":"application/json"});
function readFields(doc:Document):ApprovalRecord{
  if(!doc.updateTime || !doc.fields || !doc.fields.value)throw new Error("承認記録の形式が読めません");
  const value=fromVal(doc.fields.value) as unknown;
  if(!isApprovalRecord(value))throw new Error("承認記録が不正です");
  return value;
}
async function requestJson(http:Http,url:string,token:string,method:string,body?:unknown):Promise<unknown>{
  const res=await http(url,{method,headers:authHeaders(token),...(body!==undefined?{body:JSON.stringify(body)}:{})});
  if(!res.ok)throw new Error("承認記録へのアクセスがHTTP "+res.status+"で失敗しました");
  return res.json() as Promise<unknown>;
}
export async function readHumanApproval(
  http:Http,token:string,uid:string,approvalId:string,transaction?:string,
):Promise<{value:ApprovalRecord;version:string}>{
  const name=approvalDocName(uid,approvalId);
  const url=approvalUrl(uid,approvalId)+(transaction?"?transaction="+encodeURIComponent(transaction):"");
  const res=await http(url,{headers:authHeaders(token)});
  if(res.status===404)throw new Error("承認申請が存在しません");
  if(!res.ok)throw new Error("承認申請を確認できません。HTTP "+res.status);
  const doc=await res.json() as Document;
  if(doc.name!==name||!doc.updateTime)throw new Error("承認申請の場所と版を確認できません");
  const value=readFields(doc);
  if(value.uid!==uid)throw new Error("承認記録のユーザーが一致しません");
  return {value,version:doc.updateTime};
}
export async function issueHumanApproval(
  http:Http,token:string,uid:string,
  preview:{
    preview_id:string;expires_at:string;changes:unknown[];affected_docs:string[];
  },now=Date.now(),
):Promise<{approval_id:string;approval_url:string;approval_record_created:true}>{
  const id=crypto.randomUUID();
  approvalDocName(uid,id);
  const value:ApprovalRecord={
    uid, previewId:preview.preview_id,issuedAt:new Date(now).toISOString(),
    expiresAt:preview.expires_at,status:"pending",
    changes:preview.changes,affectedDocs:preview.affected_docs,
  };
  if(isApprovalExpired(value,now))throw new Error("承認申請の期限が不正です");
  const doc=await requestJson(http,
    HAAKU_DOCS_URL+"/users/"+uid+"/haaku_approvals?documentId="+encodeURIComponent(id),
    token,"POST",{fields:{value:toFVal(value)}}) as Document;
  if(doc.name!==approvalDocName(uid,id)||!doc.updateTime){
    throw new Error("承認申請の作成結果が確認できません。適用を停止しました");
  }
  return {
    approval_id:id,
    approval_url:HAAKU_APPROVAL_ORIGIN+"/?approval="+encodeURIComponent(id),
    approval_record_created:true,
  };
}
export async function decideHumanApproval(
  http:Http,token:string,uid:string,approvalId:string,
  decision:"approve"|"reject",now=Date.now(),
):Promise<{status:"approved"|"rejected";approvedAt?:string}>{
  let txn:string|null=null;
  let committed=false;
  try {
    const begin=await requestJson(http,
      HAAKU_DOCS_URL+":beginTransaction",token,"POST",{options:{readWrite:{}}}) as {transaction?:string};
    if(!begin.transaction)throw new Error("承認用トランザクションを開始できません");
    txn=begin.transaction;
    const existing=await readHumanApproval(http,token,uid,approvalId,txn);
    if(existing.value.status!=="pending"||isApprovalExpired(existing.value,now)){
      throw new Error("承認申請は未承認の状態ではないか、有効期限が切れています");
    }
    const status=decision==="approve"?"approved":"rejected";
    const approvedAt=decision==="approve"?new Date(now).toISOString():undefined;
    const value:ApprovalRecord={...existing.value,status,
      ...(approvedAt?{approvedUid:uid,approvedAt}:{})};
    const name=approvalDocName(uid,approvalId);
    const result=await requestJson(http,HAAKU_DOCS_URL+":commit",token,"POST",{
      transaction:txn,
      writes:[{update:{name,fields:{value:toFVal(value)}},
        updateMask:{fieldPaths:["value"]},
        currentDocument:{updateTime:existing.version}}],
    }) as {commitTime?:string;writeResults?:unknown[]};
    committed=true;txn=null;
    if(!result.commitTime||result.writeResults?.length!==1)
      throw new Error("承認結果を確認できません");
    const check=await readHumanApproval(http,token,uid,approvalId);
    if(check.value.status!==status || (approvedAt&&check.value.approvedAt!==approvedAt)){
      throw new Error("承認状態の読み直しが一致しません");
    }
    return{status,...(approvedAt?{approvedAt}:{})};
  }catch(error){
    if(committed)throw new Error("承認を書いた可能性があります。画面を再読込して状態を確認してください："+String(error));
    throw error;
  }finally{
    if(txn)try{
      await requestJson(http,HAAKU_DOCS_URL+":rollback",token,"POST",{transaction:txn});
    }catch{/* original error wins */}
  }
}
export async function handleHaakuHumanApproval(request:Request,env:Env):Promise<Response>{
  const origin=request.headers.get("Origin");
  if(origin!==HAAKU_APPROVAL_ORIGIN)return Response.json({error:"origin_not_allowed"},{status:403});
  if(request.method==="OPTIONS"){
    return new Response(null,{status:204,headers:{
      "Access-Control-Allow-Origin":HAAKU_APPROVAL_ORIGIN,"Vary":"Origin",
      "Access-Control-Allow-Methods":"GET,POST,OPTIONS",
      "Access-Control-Allow-Headers":"Authorization,Content-Type",
      "Access-Control-Max-Age":"300",
    }});
  }
  if(!["GET","POST"].includes(request.method))return response({error:"method_not_allowed"},405);
  const match=/^\/haaku\/approvals\/([a-z0-9-]+)$/.exec(new URL(request.url).pathname);
  if(!match)return response({error:"invalid_approval_id"},404);
  const auth=request.headers.get("Authorization")||"";
  if(!auth.startsWith("Bearer "))return response({error:"missing_firebase_token"},401);
  let identity;
  try{identity=await verifyIdToken(auth.slice(7));}
  catch{return response({error:"firebase_auth_failed"},503);}
  if(!identity||!env.NAOKI_UID||identity.uid!==env.NAOKI_UID){
    return response({error:"not_authorized_owner"},403);
  }
  if(!env.FIREBASE_SA_EMAIL||!env.FIREBASE_SA_PRIVATE_KEY){
    return response({error:"server_not_configured"},503);
  }
  try{
    const token=await getFirestoreToken(env);
    if(request.method==="GET"){
      const doc=await readHumanApproval(fetch,token,identity.uid,match[1]);
      return response({status:doc.value.status,changes:doc.value.changes,
        issued_at:doc.value.issuedAt,expires_at:doc.value.expiresAt,
        expired:isApprovalExpired(doc.value),affected_docs:doc.value.affectedDocs});
    }
    if(request.headers.get("Content-Type")?.split(";")[0]!=="application/json"){
      return response({error:"content_type_required"},415);
    }
    const raw=await request.text();
    if(raw.length>1024)return response({error:"body_too_large"},413);
    let data:unknown;
    try{data=JSON.parse(raw);}catch{return response({error:"invalid_json"},400);}
    if(!data||typeof data!=="object"||Array.isArray(data)||
      Object.keys(data).length!==1||!["approve","reject"].includes(
        String((data as Record<string,unknown>).decision))) {
      return response({error:"invalid_decision"},400);
    }
    const decision=(data as {decision:"approve"|"reject"}).decision;
    return response(await decideHumanApproval(fetch,token,identity.uid,match[1],decision));
  }catch(error){
    // Do not expose internals or Firebase tokens to the browser.
    return response({error:"approval_unavailable",message:String((error as Error).message||"更新に失敗")},409);
  }
}
