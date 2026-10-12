// haAkuの現行Web UIの保存形式を尊重するMCP用モデル。
// 1件でも無効なら変更全体を拒否。元データの配列・未知フィールドは削除しない。
import { type Change, newTargetId, validDate, assertWeekStart, writeKeys, canonical } from "./haaku-ai-changes.js";
import { writeInitiative, unlinkMilestone, projectList, assertUniqueProjects } from "./haaku-initiatives.js";
import { depsOf, parseDepIds, ancestorsOf } from "./haaku-deps.js";

type Obj = Record<string, unknown>;
type Item = Record<string, unknown>;
export type Stored = Record<string, unknown | null>;
export type StepView = {
  kind: Change["kind"]; action: "create" | "update" | "delete";
  id: string; title: string; before: Obj | null; after: Obj;
};
export type ChangePlan = { next: Stored; changed: string[]; steps: StepView[] };

const object = (raw: unknown, label: string): Obj => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(label + "の保存形式が不正です。変更を停止しました");
  }
  return raw as Obj;
};
const str = (value: unknown) => typeof value === "string" ? value.trim() : "";
const list = (value: unknown, label: string): Item[] => {
  if (!Array.isArray(value) || value.some(v => !v || typeof v !== "object" || Array.isArray(v))) {
    throw new Error(label + "の一覧を確認できません。変更を停止しました");
  }
  return value as Item[];
};
const titleCase = (x: unknown) => str(x).toLocaleLowerCase("ja");
const limit = (value: unknown, label: string, max: number): string => {
  const v = str(value);
  if (v.length > max) throw new Error(label + "は" + max + "文字以内にしてください");
  return v;
};
const validUrl = (raw: unknown): boolean => {
  try { const u = new URL(str(raw)); return u.protocol === "https:" && !!u.hostname && !u.username && !u.password; }
  catch { return false; }
};
const maybeDate = (date: string, label: string): void => {
  if (date && !validDate(date)) throw new Error(label + "の日付が不正です");
};
const bytes = (data: unknown) => new TextEncoder().encode(JSON.stringify(data)).byteLength;
const copy = <T>(data: T): T => JSON.parse(JSON.stringify(data)) as T;
const MILESTONE_STATUS = ["todo", "doing", "review", "blocked", "done"];
const WEEK_STATUS = ["planned", "doing", "blocked", "done"];
const HORIZON = ["long", "medium", "short"];
const PARENT: Record<string,string> = { medium: "long", short: "medium" };
const MAX_HISTORY = 300;
const REQUIRED_STRATEGY: Record<string,number> = {
  name: 90, goal: 500, approach: 1600, plan: 1400, successCriteria: 700,
  sourceUrl: 600, milestoneId: 180, horizon: 16, parentRecordId: 180, reason: 600,
};
const SNAP_FIELDS = ["title","criterion","milestoneId","status","note","evidence"];

function roadmap(value: unknown): Obj {
  const out = value === null ? {
    version: 1, northStar: "", northDetail: "", strategyUrl: "",
    focusMilestoneId: "", milestones: [], phases: [],
  } : object(value, "ロードマップ");
  if (out.version !== undefined && out.version !== 1) throw new Error("ロードマップの版が不一致です");
  if (out.milestones !== undefined) list(out.milestones, "マイルストーン");
  if (out.phases !== undefined) list(out.phases, "フェーズ");
  const phases = (out.phases || []) as Item[];
  const milestones = (out.milestones || []) as Item[];
  if (phases.length > 50 || new Set(phases.map(v=>v.id)).size !== phases.length ||
      phases.some(v=>!str(v.id)||!str(v.title)||!str(v.purpose)||!Number.isInteger(v.order))) {
    throw new Error("フェーズの形式・件数が不正です");
  }
  if (new Set(milestones.map(v=>v.id)).size !== milestones.length ||
      milestones.some(v=>!str(v.id)||!MILESTONE_STATUS.includes(str(v.status)))) {
    throw new Error("マイルストーンのID・状態が不正です");
  }
  if (milestones.some(v=>v.dependsOnIds!==undefined &&
      (!Array.isArray(v.dependsOnIds)||v.dependsOnIds.some(x=>typeof x!=="string")))) {
    throw new Error("マイルストーンの前のマス（dependsOnIds）が文字列の配列ではありません");
  }
  if (out.aiChanges !== undefined &&
      (!Array.isArray(out.aiChanges) || out.aiChanges.length > MAX_HISTORY)) {
    throw new Error("ロードマップのAI変更履歴を確認できません");
  }
  return { ...out, version: 1, milestones, phases };
}

function strategyStore(value: unknown): Obj {
  const out = value === null ? { schemaVersion: 1, records: [] } : object(value, "戦略記録");
  if (out.schemaVersion !== 1) throw new Error("戦略記録の版が不一致です");
  const records = list(out.records, "戦略");
  if (new Set(records.map(v=>v.id)).size !== records.length ||
      records.some(v=>!str(v.id)||!Array.isArray(v.revisions)||
        !v.revisions.length || (v.revisions as unknown[]).some(r=>!r||typeof r!=="object"||Array.isArray(r)))) {
    throw new Error("戦略記録のIDまたは改訂履歴が不正です");
  }
  return { ...out, records };
}

function weeklyStore(value: unknown, weekStart: string): Obj {
  assertWeekStart(weekStart);
  const out = value === null ?
    { version: 1, weekStart, commitments: [], history: [] } : object(value, "週間コミット");
  if (out.version !== 1 || out.weekStart !== weekStart) throw new Error("週間コミットの版・対象週が異なります");
  const commitments = list(out.commitments, "週間コミット");
  const history = list(out.history, "週間コミット履歴");
  if (commitments.length > 3 || history.length > MAX_HISTORY ||
      new Set(commitments.map(c=>c.id)).size !== commitments.length ||
      new Set(history.map(c=>c.id)).size !== history.length ||
      commitments.some(c=>!str(c.id)||!str(c.title)||!str(c.criterion)||!str(c.milestoneId)||
        !WEEK_STATUS.includes(str(c.status))||(c.status==="done"&&!str(c.evidence)))) {
    throw new Error("週間コミットの登録件数・保存形式が不正です");
  }
  return { ...out, commitments, history };
}

function snapshot(item: Item): Obj {
  return Object.fromEntries(SNAP_FIELDS.map(k=>[k,item[k]??""]));
}
function changesetAudit(road: Obj, op: Change, result: StepView, at: string): void {
  const hist = road.aiChanges === undefined ? [] : list(road.aiChanges,"ロードマップAI変更履歴");
  if (hist.length >= MAX_HISTORY) throw new Error("ロードマップのAI変更履歴が上限です。消さずに開発部へ確認してください");
  if (hist.some(e=>e.requestId===op.request_id)) {
    throw new Error("同じ操作IDが既に反映されています。二重登録を停止しました");
  }
  road.aiChanges = [...hist, {
    requestId: op.request_id, kind: op.kind, targetId: result.id,
    action: result.action, at, source: "approved_mcp_change",
    before: result.before, after: result.after,
  }];
  road.updatedAt = at;
}

function writeStrategy(state: Stored, op: Change, at: string): StepView {
  const doc = strategyStore(state.os_strategy_records_v1);
  const records = doc.records as Item[];
  const id = str(op.data.recordId) || newTargetId("strategy",op.request_id);
  const current = records.find(row=>row.id===id);
  if (op.data.recordId && !current) throw new Error("更新する戦略IDが存在しません");
  if (!op.data.recordId && current) throw new Error("戦略は既に登録済みです");
  const revisions = (current?.revisions || []) as Obj[];
  if (records.some(row=>(row.revisions as Obj[]).some(rev=>rev.id==="ai_revision_"+op.request_id))) {
    throw new Error("同じ操作IDが戦略履歴に既に存在します");
  }
  const previous = revisions.length ? revisions[revisions.length-1] : null;
  const values: Record<string,string> = {};
  for(const [key,max] of Object.entries(REQUIRED_STRATEGY)) {
    values[key] = limit(op.data[key] ?? previous?.[key],key,max);
  }
  if (["name","goal","approach","plan","successCriteria","sourceUrl"].some(k=>!values[k])) {
    throw new Error("戦略の名称・目的・方針・計画・検証条件・元資料URLが必要です");
  }
  if (!validUrl(values.sourceUrl)) throw new Error("戦略の元資料URLは安全なhttpsにしてください");
  if (!HORIZON.includes(values.horizon)) throw new Error("期間区分を長期・中期・短期から選んでください");
  if (values.horizon === "long" && values.parentRecordId) throw new Error("長期戦略に上位戦略は設定できません");
  if (values.horizon !== "long") {
    const parent = records.find(row=>row.id===values.parentRecordId);
    const last = ((parent?.revisions as Obj[] | undefined) || []).at(-1);
    if (id === values.parentRecordId || str(last?.horizon)!==PARENT[values.horizon]) {
      throw new Error("中期・短期の上位戦略が未登録か期間区分が違います");
    }
  }
  if (values.horizon === "short" && !values.milestoneId) {
    throw new Error("短期戦略には実在するマイルストーンが必要です");
  }
  const road = roadmap(state.os_roadmap_v1);
  if (values.milestoneId && !(road.milestones as Item[]).some(item=>item.id===values.milestoneId)) {
    throw new Error("戦略が参照するマイルストーンが見つかりません");
  }
  if (records.some(row=>row.id!==id &&
    titleCase(((row.revisions as Obj[]).at(-1))?.name)===titleCase(values.name))) {
    throw new Error("同名の戦略が登録済みです。IDで改訂してください");
  }
  if (previous) {
    // 以前の理由を使い回して改訂することを禁止。毎回、新しく明示された理由が必要。
    if (!str(op.data.reason)) throw new Error("戦略改訂には理由が必要です");
    if (Object.keys(REQUIRED_STRATEGY).filter(k=>k!=="reason").every(k=>
      str(previous[k])===values[k])) throw new Error("前の戦略と内容が変わっていません");
    if (str(previous.horizon)!==values.horizon && records.some(row=>row.id!==id && 
      ((row.revisions as Obj[]).at(-1))?.parentRecordId === id &&
      PARENT[str(((row.revisions as Obj[]).at(-1))?.horizon)] !== values.horizon)) {
      throw new Error("下位の戦略が紐づくため期間区分を変更できません");
    }
  }
  const revision = { id: "ai_revision_"+op.request_id, number: revisions.length+1,
    savedAt: at, requestId: op.request_id, source: "approved_mcp_change",
    ...values, reason: previous ? values.reason : (values.reason||"初回記録") };
  const record = current ? { ...current, revisions: [...revisions,revision] } :
    { id, revisions: [revision] };
  doc.records = current ? records.map(r=>r.id===id?record:r) : [...records,record];
  if (bytes(doc) > 700000) throw new Error("戦略履歴の保存容量が上限に達しました");
  state.os_strategy_records_v1 = doc;
  return {kind:"strategy",action:current?"update":"create",id,title:values.name,
    before:previous ? { ...previous } : null,after:{ ...revision }};
}

function writePhase(state: Stored, op: Change, at: string): StepView {
  const road = roadmap(state.os_roadmap_v1);
  const phases = road.phases as Item[], milestones = road.milestones as Item[];
  const id = str(op.data.id) || newTargetId("phase",op.request_id);
  const old = phases.find(p=>p.id===id);
  if (op.data.id && !old) throw new Error("更新するフェーズIDが見つかりません");
  if (!op.data.id && old) throw new Error("同じ操作IDのフェーズは登録済みです");
  const title=limit(op.data.title??old?.title,"フェーズ名",90);
  const purpose=limit(op.data.purpose??old?.purpose,"フェーズの目的",550);
  const projectId=limit(op.data.projectId??old?.projectId,"プロジェクトID",180);
  const startDate=limit(op.data.startDate??old?.startDate,"開始日",10);
  const dueDate=limit(op.data.dueDate??old?.dueDate,"期限",10);
  if(!title||!purpose)throw new Error("フェーズ名・到達状態が必要です");
  if (phases.length>=50&&!old)throw new Error("フェーズ上限50件を超えます");
  maybeDate(startDate,"フェーズ開始日");maybeDate(dueDate,"フェーズ期限");
  if(startDate&&dueDate&&startDate>dueDate)throw new Error("フェーズ期限は開始日より後です");
  if (phases.some(p=>p.id!==id && str(p.projectId)===projectId && titleCase(p.title)===titleCase(title))) {
    throw new Error("同じプロジェクトに同名のフェーズがあります");
  }
  if(old && str(old.projectId)!==projectId && milestones.some(m=>m.phaseId===id)) {
    throw new Error("成果物が紐づくフェーズのプロジェクトは変更できません");
  }
  const candidate: Item = { ...old, id,title,purpose,projectId,startDate,dueDate,
    order: old?.order ?? Math.max(-1,...phases.map(p=>Number(p.order)) )+1,
    createdAt:old?.createdAt??at,updatedAt:at };
  if(old&&["title","purpose","projectId","startDate","dueDate"].every(k=>str(old[k])===str(candidate[k]))) {
    throw new Error("フェーズの内容が変わっていません");
  }
  const result:StepView={kind:"phase",action:old?"update":"create",id,title,
    before:old?{...old}:null,after:{...candidate}};
  road.phases=old?phases.map(p=>p.id===id?candidate:p):[...phases,candidate];
  changesetAudit(road,op,result,at);
  if(bytes(road)>700000)throw new Error("ロードマップの保存容量が上限に達しました");
  state.os_roadmap_v1=road;
  return result;
}

// v1.14.0：マスのリンク。JSON の文字列で [{"title":"…","url":"https://…"}, …]（0〜20 件・題名は 200 文字まで・空可・https だけ・同じ URL は 1 回）
export function parseMilestoneLinks(raw:unknown):{title:string;url:string}[]{
  const text=str(raw);
  if(!text)return [];
  let v:unknown;
  try{v=JSON.parse(text);}catch{throw new Error("links は [{\"title\":\"…\",\"url\":\"https://…\"}] の JSON の文字列で渡してください");}
  if(!Array.isArray(v))throw new Error("links は配列にしてください");
  if(v.length>20)throw new Error("links は 20 件までです");
  const seen=new Set<string>();
  return v.map((x,i)=>{
    if(!x||typeof x!=="object"||Array.isArray(x)||Object.keys(x).some(k=>k!=="title"&&k!=="url")){
      throw new Error("links の "+(i+1)+" 件目は {title, url} だけにしてください");
    }
    const o=x as Obj;
    if(o.title!==undefined&&typeof o.title!=="string")throw new Error("links の "+(i+1)+" 件目の title は文字列にしてください");
    const title=limit(o.title,"links の "+(i+1)+" 件目の title",200);
    const url=limit(o.url,"links の "+(i+1)+" 件目の url",600);
    if(!validUrl(url))throw new Error("links の "+(i+1)+" 件目の url は https で始まる住所にしてください");
    if(seen.has(url))throw new Error("links に同じ url が 2 回あります："+url);
    seen.add(url);
    return {title,url};
  });
}

function writeMilestone(state:Stored,op:Change,at:string):StepView{
  const road=roadmap(state.os_roadmap_v1), milestones=road.milestones as Item[];
  const phases=road.phases as Item[], id=str(op.data.id)||newTargetId("milestone",op.request_id);
  const old=milestones.find(m=>m.id===id);
  if(op.data.id&&!old)throw new Error("更新するマイルストーンIDがありません");
  if(!op.data.id&&old)throw new Error("同じ操作IDのマイルストーンが登録済みです");
  const fields:Record<string,string>={};
  for(const [key,max] of Object.entries({
    title:140,criterion:1000,dueDate:10,status:16,area:80,owner:80,
    projectId:180,phaseId:180,notionUrl:600,dependsOn:180,evidence:2000,
  }))fields[key]=limit(op.data[key]??old?.[key],key,max);
  if(!fields.title||!fields.criterion)throw new Error("成果物名・合格条件が必要です");
  if(!MILESTONE_STATUS.includes(fields.status))throw new Error("成果物の状態が不正です");
  maybeDate(fields.dueDate,"マイルストーン期限");
  if(fields.notionUrl&&!validUrl(fields.notionUrl))throw new Error("関連資料はhttps URLだけ指定できます");
  if(fields.status==="done"&&!fields.evidence)throw new Error("達成には証拠が必要です");
  const phase=phases.find(p=>p.id===fields.phaseId);
  if(fields.phaseId&&!phase)throw new Error("所属フェーズが見つかりません");
  if(phase && str(phase.projectId) && str(phase.projectId)!==fields.projectId) {
    throw new Error("成果物とフェーズのプロジェクトが異なります");
  }
  if(milestones.some(m=>m.id!==id && titleCase(m.title)===titleCase(fields.title) &&
    str(m.projectId)===fields.projectId && str(m.phaseId)===fields.phaseId)) {
    throw new Error("同一の対象とフェーズに同名の成果物があります");
  }
  // v1.11.0：前のマスは配列（dependsOnIds）が正。dependsOn には 1 つ目を入れる（いまの haAku 本体の画面が読むため）
  const oldDeps=depsOf(old).ids;
  let deps:string[];
  if(op.data.dependsOnIds!==undefined){
    deps=parseDepIds(op.data.dependsOnIds);
    if(op.data.dependsOn!==undefined&&str(op.data.dependsOn)!==(deps[0]??"")){
      throw new Error("dependsOn と dependsOnIds の 1 つ目が違います。dependsOnIds だけを渡してください");
    }
  }else if(op.data.dependsOn!==undefined){
    deps=str(op.data.dependsOn)?[str(op.data.dependsOn)]:[];
  }else deps=oldDeps;
  fields.dependsOn=deps[0]??"";
  const map=new Map(milestones.map(m=>[m.id,m]));
  for(const dep of deps){
    if(dep===id)throw new Error("成果物の前提関係が循環しています（自分を前にしています）");
    if(!map.has(dep))throw new Error("前提マイルストーンが存在しません："+dep);
  }
  const graph=new Map(milestones.map(m=>[str(m.id),depsOf(m).ids]));
  graph.set(id,deps);
  try{ancestorsOf(graph,id);}
  catch{throw new Error("成果物の前提関係が循環しています");}
  if(fields.status==="done"&&deps.some(dep=>map.get(dep)?.status!=="done")) {
    throw new Error("前提マイルストーンが未達成です");
  }
  // v1.14.0：着手日（startDate）は画面が書く。AI が期限を動かすときだけ、着手日より前の期限を断る
  const start=str(old?.startDate);
  if(op.data.dueDate!==undefined&&fields.dueDate&&validDate(start)&&fields.dueDate<start){
    throw new Error("期限（"+fields.dueDate+"）がこのマスの着手日（"+start+"）より前です。着手日は haAku の画面で直してください");
  }
  // v1.14.0：メモとリンク。渡したときだけ書き換える（渡さなければ今の値のまま）
  const extra:Item={};
  if(op.data.notes!==undefined)extra.notes=limit(op.data.notes,"メモ（notes）",5000);
  if(op.data.links!==undefined)extra.links=parseMilestoneLinks(op.data.links);
  const extraSame=Object.keys(extra).every(k=>JSON.stringify(k==="notes"?str(old?.notes):(old?.links??[]))===JSON.stringify(extra[k]));
  if(old&&Object.keys(fields).every(k=>str(old[k])===fields[k])&&
    JSON.stringify(oldDeps)===JSON.stringify(deps)&&extraSame)throw new Error("成果物の内容が変わっていません");
  const candidate:Item={...old,id,...fields,dependsOnIds:deps,...extra,
    createdAt:old?.createdAt??at,updatedAt:at,
    doneAt:fields.status==="done" ? (old?.status==="done"&&old.doneAt?old.doneAt:at) : ""};
  const result:StepView={kind:"milestone",action:old?"update":"create",id,
    title:fields.title,before:old?{...old}:null,after:{...candidate}};
  road.milestones=old?milestones.map(m=>m.id===id?candidate:m):[...milestones,candidate];
  changesetAudit(road,op,result,at);
  if(bytes(road)>700000)throw new Error("ロードマップの保存容量が上限に達しました");
  state.os_roadmap_v1=road;
  return result;
}

// v1.11.0：承認つきでマイルストーンを消す。消す前の中身はロードマップの aiChanges に残す（before に全部・after に消した時刻と理由）
function deleteMilestone(state:Stored,op:Change,at:string):StepView[]{
  const road=roadmap(state.os_roadmap_v1), milestones=road.milestones as Item[];
  const id=str(op.data.id);
  const reason=limit(op.data.reason,"消す理由",600);
  if(!id)throw new Error("消すマイルストーンの data.id が必要です");
  if(!reason)throw new Error("マイルストーンを消すには理由（data.reason）が必要です");
  const old=milestones.find(m=>m.id===id);
  if(!old)throw new Error("消すマイルストーンが見つかりません："+id);
  const after=milestones.filter(m=>depsOf(m).ids.includes(id));
  if(after.length)throw new Error("ほかのマイルストーンの前になっているため消せません："+
    after.map(m=>str(m.title)+"（"+str(m.id)+"）").join("、"));
  const rawLinks=state.os_task_links_v1??null;
  if(rawLinks!==null){
    const links=(rawLinks as Obj)?.links;
    if(!rawLinks||typeof rawLinks!=="object"||!Array.isArray(links)){
      throw new Error("タスクの結び（os_task_links_v1）の形が読めません。消さずに止めました");
    }
    const n=(links as Item[]).filter(l=>str(l?.milestoneId)===id).length;
    if(n)throw new Error("タスクが "+n+" 件結ばれているため消せません。先に haAku__link_tasks で外してください");
  }
  const rawStrategy=state.os_strategy_records_v1??null;
  if(rawStrategy!==null){
    const used=(strategyStore(rawStrategy).records as Item[]).filter(r=>
      str(((r.revisions as Obj[]).at(-1))?.milestoneId)===id);
    if(used.length)throw new Error("戦略が参照しているため消せません："+used.map(r=>str(r.id)).join("、"));
  }
  if(str(road.focusMilestoneId)===id)throw new Error("重点のマイルストーンに選ばれているため消せません");
  const rawKpis=state.os_kpis??null;
  if(rawKpis!==null&&!Array.isArray(rawKpis))throw new Error("KPIの保存形式が不正です。変更を停止しました");
  const kpis=rawKpis===null?[]:list(rawKpis,"KPI");
  const title=str(old.title);
  const initiativeViews=unlinkMilestone(state,id,title,op.request_id,reason,at,milestones,kpis);
  const result:StepView={kind:"milestone",action:"delete",id,title,
    before:{...old},after:{deletedAt:at,reason}};
  road.milestones=milestones.filter(m=>m.id!==id);
  changesetAudit(road,op,result,at);
  if(bytes(road)>700000)throw new Error("ロードマップの保存容量が上限に達しました");
  state.os_roadmap_v1=road;
  return [result,...initiativeViews];
}

function writeWeekly(state:Stored,op:Change,at:string):StepView{
  const week=op.week_start??"";
  const key="os_weekly_commits_v1_"+week;
  const doc=weeklyStore(state[key],week);
  const commitments=doc.commitments as Item[], history=doc.history as Item[];
  const id=str(op.data.id)||newTargetId("weekly",op.request_id);
  const old=commitments.find(c=>c.id===id);
  if(op.data.id&&!old)throw new Error("更新する週間コミットIDがありません");
  if(!op.data.id&&old)throw new Error("同じ操作IDの週間コミットは登録済みです");
  if(!old&&commitments.length>=3)throw new Error("週間コミットは最大3件です");
  if(history.length>=MAX_HISTORY)throw new Error("週間コミット履歴の上限に達しました");
  if(history.some(h=>h.id==="ai_change_"+op.request_id))throw new Error("同じ操作IDが週間履歴に既にあります");
  const fields:Record<string,string>={};
  for(const [k,max] of Object.entries({
    title:140,criterion:600,milestoneId:180,status:16,evidence:1000,note:600,
  }))fields[k]=limit(op.data[k]??old?.[k],k,max);
  if(!fields.title||!fields.criterion||!fields.milestoneId) {
    throw new Error("週間コミットには成果名・合格条件・マイルストーンが必要です");
  }
  const road=roadmap(state.os_roadmap_v1);
  if(!(road.milestones as Item[]).some(m=>m.id===fields.milestoneId)) {
    throw new Error("週間コミットの関連マイルストーンがありません");
  }
  if(!WEEK_STATUS.includes(fields.status))throw new Error("週間コミット状態が不正です");
  if(fields.status==="done"&&!fields.evidence)throw new Error("週間達成には確認した証拠が必要です");
  if(fields.status==="blocked"&&!fields.note)throw new Error("停止中の理由が必要です");
  if(!old&&commitments.some(c=>titleCase(c.title)===titleCase(fields.title))) {
    throw new Error("同じ週に同名の週間コミットがあります");
  }
  const reason=limit(op.data.changeReason,"変更理由",600);
  const changed=!!old&&["title","criterion","milestoneId"].some(k=>str(old[k])!==fields[k]);
  if(changed&&!reason)throw new Error("週間コミットの計画変更には理由が必要です");
  if(old&&Object.keys(fields).every(k=>str(old[k])===fields[k]))throw new Error("週間コミットに変更がありません");
  const candidate:Item={...old,id,...fields,createdAt:old?.createdAt??at,updatedAt:at};
  const nextHistory={id:"ai_change_"+op.request_id,requestId:op.request_id,
    source:"approved_mcp_change",commitmentId:id,at,
    reason:reason||(!old?"今週の成果として登録":"進捗・状況を更新"),
    before:old?snapshot(old):null,after:snapshot(candidate)};
  doc.commitments=old?commitments.map(c=>c.id===id?candidate:c):[...commitments,candidate];
  doc.history=[...history,nextHistory];
  doc.updatedAt=at;
  if(bytes(doc)>700000)throw new Error("週間コミットの保存容量が上限に達しました");
  state[key]=doc;
  return {kind:"weekly",action:old?"update":"create",id,
    title:fields.title,before:old?{...old}:null,after:{...candidate}};
}
// v1.9.0：取り組み。マイルストーンは同じ変更の束で先に作ったものも結べる（state の今の値を渡す）。KPI は読むだけ
function writeInitiativeStep(state:Stored,op:Change,at:string):StepView{
  const road=roadmap(state.os_roadmap_v1);
  const rawKpis=state.os_kpis??null;
  if(rawKpis!==null&&!Array.isArray(rawKpis))throw new Error("KPIの保存形式が不正です。変更を停止しました");
  const kpis=rawKpis===null?[]:list(rawKpis,"KPI");
  // v1.12.0：TaskMaster のプロジェクト一覧は、プロジェクトを付ける変更があるときだけ読んである（neededKeys）。読むだけ
  const projects=projectList(state.projects??null);
  return writeInitiative(state,op,at,road.milestones as Item[],kpis,projects);
}
export function buildManagementChangePlan(
  operations:Change[], stored:Stored, at:string,
):ChangePlan {
  if(!Number.isFinite(Date.parse(at)))throw new Error("操作日時が不正です");
  const state=copy(stored),steps:StepView[]=[];
  // 全ての入力を検証してから、変更された文書の値を組み立てる。まだ外部書き込みは行わない。
  for(const op of operations){
    if(op.kind==="milestone_delete"){steps.push(...deleteMilestone(state,op,at));continue;}
    const row=op.kind==="strategy" ? writeStrategy(state,op,at) :
      op.kind==="initiative" ? writeInitiativeStep(state,op,at) :
      op.kind==="phase" ? writePhase(state,op,at) :
      op.kind==="milestone" ? writeMilestone(state,op,at) : writeWeekly(state,op,at);
    steps.push(row);
  }
  // v1.12.0：1 つのプロジェクトは 1 つの取り組みにだけ。束を当て終えた形で確かめる（同じ束での付け替えを通すため）
  if(operations.some(op=>op.kind==="initiative")){
    assertUniqueProjects(state.os_initiatives_v1??null,projectList(state.projects??null)??[]);
  }
  // 中身が変わらなかった文書は書かない（消すときに結びを外す取り組みが 0 件だった場合など）。
  // ほかの種類は変わらなければ断るので、この絞り込みで書く先が減ることはない
  const changed=writeKeys(operations).filter(key=>
    state[key]===undefined||canonical(state[key])!==canonical(stored[key]??null));
  for(const key of changed){
    if(state[key]===undefined||bytes(state[key])>700000)throw new Error("保存容量または状態が不正です："+key);
  }
  return {next:state,changed,steps};
}
export function verifyPlannedValues(actual:Stored,planned:ChangePlan):void {
  for(const key of planned.changed){
    if(canonical(actual[key])!==canonical(planned.next[key])) {
      throw new Error("保存後の再取得で一致しません："+key+"。成功とは報告しません");
    }
  }
}
