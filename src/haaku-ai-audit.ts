// Read-only diagnostics for AI-origin haAku management edits.
// 0 records (configured) is distinct from no source document (not configured).
import { assertWeekStart } from "./haaku-ai-changes.js";
import type { Stored } from "./haaku-ai-model.js";
import { initiativeEvents } from "./haaku-initiatives.js";

type Dict=Record<string,unknown>;
const asObject=(raw:unknown,label:string):Dict=>{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error(label+"の保存形式が不正です");
  return raw as Dict;
};
const asArray=(raw:unknown,label:string):Dict[]=>{
  if(!Array.isArray(raw)||raw.some(x=>!x||typeof x!=="object"||Array.isArray(x))){
    throw new Error(label+"の保存形式が不正です");
  }
  return raw as Dict[];
};
const text=(x:unknown)=>typeof x==="string"?x:"";
type Log={request_id:string;kind:string;target_id:string;at:string;title:string;reason:string};
function roadmapEvents(raw:unknown):{state:string;items:Log[]}{
  if(raw===null)return{state:"not_configured",items:[]};
  const state=asObject(raw,"ロードマップ");
  if(state.version!==1)throw new Error("ロードマップの版が不一致です");
  const all=state.aiChanges===undefined?[]:asArray(state.aiChanges,"ロードマップAI変更履歴");
  return{state:"ready",items:all.filter(x=>x.source==="approved_mcp_change").map(x=>({
    request_id:text(x.requestId),kind:text(x.kind),target_id:text(x.targetId),
    at:text(x.at),title:text((x.after as Dict|undefined)?.title),reason:text(x.action),
  }))};
}
function strategyEvents(raw:unknown):{state:string;items:Log[]}{
  if(raw===null)return{state:"not_configured",items:[]};
  const s=asObject(raw,"戦略");
  if(s.schemaVersion!==1)throw new Error("戦略の版が不一致です");
  const records=asArray(s.records,"戦略レコード");
  const result:Log[]=[];
  for(const row of records){
    const versions=asArray(row.revisions,"戦略改訂");
    for(const rev of versions){
      if(rev.source==="approved_mcp_change"){
        result.push({request_id:text(rev.requestId),kind:"strategy",
          target_id:text(row.id),at:text(rev.savedAt),title:text(rev.name),
          reason:text(rev.reason)});
      }
    }
  }
  return{state:"ready",items:result};
}
function weekEvents(raw:unknown,week:string):{state:string;items:Log[]}{
  if(raw===null)return{state:"not_configured",items:[]};
  const s=asObject(raw,"週間コミット");
  if(s.version!==1||s.weekStart!==week)throw new Error("週間コミットの版・週が異なります");
  const history=asArray(s.history,"週間履歴");
  return{state:"ready",items:history.filter(x=>x.source==="approved_mcp_change").map(x=>({
    request_id:text(x.requestId),kind:"weekly",target_id:text(x.commitmentId),
    at:text(x.at),title:text((x.after as Dict|undefined)?.title),reason:text(x.reason),
  }))};
}
export function managementWriteAudit(stored:Stored,weekStart?:string){
  if(weekStart)assertWeekStart(weekStart);
  const roadmap=roadmapEvents(stored.os_roadmap_v1??null);
  const strategies=strategyEvents(stored.os_strategy_records_v1??null);
  const weekly=weekStart?weekEvents(stored["os_weekly_commits_v1_"+weekStart]??null,weekStart):
    {state:"not_requested",items:[]};
  const initiatives=initiativeEvents(stored.os_initiatives_v1??null);
  const events=[...roadmap.items,...strategies.items,...initiatives.items,...weekly.items].sort((a,b)=>b.at.localeCompare(a.at));
  return{ok:true,readonly:true,
    state:{roadmap:roadmap.state,strategies:strategies.state,initiatives:initiatives.state,weekly:weekly.state},
    counts:{roadmap:roadmap.items.length,strategies:strategies.items.length,initiatives:initiatives.items.length,weekly:weekly.items.length,total:events.length},
    latest:events.slice(0,30),
    truncated:events.length>30,
    note:"週次履歴はweek_startで指定した週だけ取得します。ブラウザからの手動変更はAI操作として集計しません。",
  };
}
