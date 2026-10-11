// Firestore REST write gate: dry-run -> user approval -> same-snapshot transaction -> re-read.
// Official v1 API: documents:beginTransaction, GET ?transaction=, documents:commit.
import { fsGetOrNull, fromVal, toFVal, type FVal } from "./taskmaster.js";
import { type Change, neededKeys, canonical } from "./haaku-ai-changes.js";
import { buildManagementChangePlan, verifyPlannedValues, type Stored } from "./haaku-ai-model.js";

const DB = "projects/gen-lang-client-0371348401/databases/ai-studio-622b9a97-52df-425a-85c6-1a2670c54e0a";
const API = "https://firestore.googleapis.com/v1/" + DB + "/documents";
const MAX_AGE_MS = 30 * 60 * 1000;
export type Snapshot = { store: Stored; versions: Record<string,string|null> };
type Doc = { name: string; updateTime?:string; fields?:Record<string,FVal> };
type Http = typeof fetch;

function fullName(uid:string,key:string):string {
  if(!/^[A-Za-z0-9_-]{4,180}$/.test(uid) ||
    !/^os_(?:roadmap_v1|strategy_records_v1|weekly_commits_v1_\d{4}-\d{2}-\d{2})$/.test(key)) {
    throw new Error("Firestoreの保存先が許可されたhaAkuの文書ではありません");
  }
  return DB + "/documents/users/" + uid + "/app_data/" + key;
}
async function jsonRequest(http:Http,url:string,token:string,method:string,body?:unknown):Promise<unknown>{
  const response=await http(url,{
    method,
    headers:{Authorization:"Bearer "+token,...(body!==undefined?{"Content-Type":"application/json"}:{})},
    ...(body!==undefined?{body:JSON.stringify(body)}:{}),
  });
  if(!response.ok) {
    throw new Error("Firestore "+method+" のHTTP "+response.status+"。操作を中断しました");
  }
  try {return await response.json();}
  catch {throw new Error("Firestore応答を解析できません。保存結果を推測しません");}
}
async function readOne(http:Http,token:string,uid:string,key:string,transaction?:string):
Promise<{value:unknown|null;version:string|null}> {
  const name=fullName(uid,key);
  if(!transaction){
    // 404は未登録、403/ネットワーク障害は失敗。既存ヘルパーを利用。
    // テストでは transaction なしの読みもmock可能なよう直接同等に処理する。
    const res=await http(API+"/users/"+uid+"/app_data/"+key,{
      headers:{Authorization:"Bearer "+token},
    });
    if(res.status===404)return{value:null,version:null};
    if(!res.ok)throw new Error("Firestore取得 "+key+" のHTTP "+res.status+"。未登録とみなしません");
    const doc=await res.json() as Doc;
    return extract(doc,key);
  }
  const res=await http(API+"/users/"+uid+"/app_data/"+key+"?transaction="+encodeURIComponent(transaction),{
    headers:{Authorization:"Bearer "+token},
  });
  if(res.status===404)return{value:null,version:null};
  if(!res.ok)throw new Error("トランザクション読取 "+key+" のHTTP "+res.status+"。中断しました");
  return extract(await res.json() as Doc,key);
}
function extract(doc:Doc,key:string):{value:unknown|null;version:string|null}{
  if(!doc.updateTime || typeof doc.updateTime!=="string") {
    throw new Error(key+"のupdateTimeが取得できません。更新を停止しました");
  }
  if(!doc.fields || !Object.hasOwn(doc.fields,"value")) {
    throw new Error(key+"のvalue欄がありません。空とみなさず停止しました");
  }
  const value=fromVal(doc.fields.value);
  if(value===null)throw new Error(key+"のvalueがnullです。未登録とはみなさず停止しました");
  return {value,version:doc.updateTime};
}
export async function readSnapshot(
  http:Http,token:string,uid:string,keys:string[],transaction?:string,
):Promise<Snapshot>{
  const rows=await Promise.all(keys.map(key=>readOne(http,token,uid,key,transaction)));
  return {
    store:Object.fromEntries(keys.map((key,i)=>[key,rows[i].value])),
    versions:Object.fromEntries(keys.map((key,i)=>[key,rows[i].version])),
  };
}
function hex(buffer:ArrayBuffer):string {
  return Array.from(new Uint8Array(buffer)).map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function digest(ops:Change[],snap:Snapshot,uid:string,issuedAt:number):Promise<string>{
  const input=canonical({ uid,operations:ops,versions:snap.versions,issuedAt });
  return hex(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(input)));
}
async function tokenFor(ops:Change[],snap:Snapshot,uid:string,issuedAt:number):Promise<string>{
  return issuedAt+"."+await digest(ops,snap,uid,issuedAt);
}
function previewIdTime(previewId:string,now:number):number {
  const match=/^(\d{13})\.([a-f0-9]{64})$/.exec(previewId);
  if(!match)throw new Error("承認するプレビューIDが不正です");
  const ts=Number(match[1]);
  if(ts>now || now-ts>MAX_AGE_MS)throw new Error("確認済みプレビューの有効期限が切れています。もう一度プレビューしてください");
  return ts;
}
function visibleStep(step:{kind:string;action:string;id:string;title:string;before:Record<string,unknown>|null;after:Record<string,unknown>}){
  const skip=new Set(["createdAt","updatedAt","doneAt","savedAt","id","number","order"]);
  const keys=new Set([...Object.keys(step.before||{}),...Object.keys(step.after)]);
  const diff=Object.fromEntries([...keys].filter(key=>!skip.has(key) &&
    canonical(step.before?.[key]??null)!==canonical(step.after[key]??null)
  ).map(key=>[key,{before:step.before?.[key]??null,after:step.after[key]??null}]));
  return {kind:step.kind,action:step.action,id:step.id,title:step.title,changes:diff};
}
export async function previewManagementChanges(
  http:Http,token:string,uid:string,ops:Change[],now=Date.now(),
){
  const keys=neededKeys(ops);
  const snap=await readSnapshot(http,token,uid,keys);
  const plan=buildManagementChangePlan(ops,snap.store,new Date(now).toISOString());
  return {
    ok:true,mode:"preview",writes_performed:0,
    preview_id:await tokenFor(ops,snap,uid,now),
    expires_at:new Date(now+MAX_AGE_MS).toISOString(),
    affected_docs:plan.changed,
    changes:plan.steps.map(visibleStep),
    required_user_action:"変更案を本人に全文提示して承認を得てください。未承認ではapplyを呼ばないこと。",
  };
}
export async function applyManagementChanges(
  http:Http,token:string,uid:string,ops:Change[],previewId:string,approved:boolean,now=Date.now(),
){
  if(approved!==true)throw new Error("本人の明示承認がないため書き込みません");
  const issuedAt=previewIdTime(previewId,now);
  const keys=neededKeys(ops);
  let transaction:string|null=null;
  let committed=false;
  try {
    const begin=await jsonRequest(http,API+":beginTransaction",token,"POST",{options:{readWrite:{}}}) as {transaction?:string};
    if(typeof begin.transaction!=="string"||!begin.transaction)throw new Error("Firestoreトランザクションを開始できません");
    transaction=begin.transaction;
    // 全ての参照先を同じRead-Writeトランザクション内で読む。
    const snap=await readSnapshot(http,token,uid,keys,transaction);
    if(previewId!==await tokenFor(ops,snap,uid,issuedAt)) {
      throw new Error("プレビュー後にデータまたは変更案が変わりました。再確認が必要です。書き込みはしていません");
    }
    const plan=buildManagementChangePlan(ops,snap.store,new Date(now).toISOString());
    const writes=plan.changed.map(key=>({
      update:{name:fullName(uid,key),fields:{value:toFVal(plan.next[key])}},
      updateMask:{fieldPaths:["value"]},
      currentDocument:snap.versions[key] ? {updateTime:snap.versions[key]} : {exists:false},
    }));
    // Writes apply atomically. Firestore also checks all documents read by this transaction.
    const result=await jsonRequest(http,API+":commit",token,"POST",{transaction,writes}) as
      {commitTime?:string;writeResults?:unknown[]};
    committed=true;
    transaction=null;
    if(!result.commitTime || !Array.isArray(result.writeResults) ||
       result.writeResults.length!==plan.changed.length){
      throw new Error("Firestoreのcommit結果が不完全です。保存された可能性があります。自動再試行しないでください");
    }
    const after=await readSnapshot(http,token,uid,plan.changed);
    verifyPlannedValues(after.store,plan);
    return {ok:true,mode:"applied",state:"verified",verified:plan.changed,
      commit_time:result.commitTime,changes:plan.steps.map(visibleStep),
      note:"更新対象の文書を保存後に再取得して一致を確認しました"};
  }catch(e){
    const reason=(e as Error)?.message||String(e);
    if(committed)throw new Error("Firestoreへの書き込み後に確認失敗："+reason+"。二重登録を避けるため自動再試行しないでください");
    throw e;
  }finally{
    if(transaction){
      // Error prior to commit -> release lock. No user data modified.
      try {await jsonRequest(http,API+":rollback",token,"POST",{transaction});}catch{/* preserve original error */}
    }
  }
}
