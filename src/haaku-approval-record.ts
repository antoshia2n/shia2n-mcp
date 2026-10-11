// haAku approvals: a separate, human-authenticated record must be atomically consumed.
// Firestore transactions (strong consistency) are required for one-use consent:
// Workers KV is eventually consistent and is not appropriate for a one-use gate.
export const HAAKU_DB =
  "projects/gen-lang-client-0371348401/databases/ai-studio-622b9a97-52df-425a-85c6-1a2670c54e0a";
export const HAAKU_DOCS_URL = "https://firestore.googleapis.com/v1/" + HAAKU_DB + "/documents";
export const HAAKU_APPROVAL_MAX_AGE_MS = 30 * 60 * 1000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UID = /^[A-Za-z0-9_-]{4,180}$/;
export type ApprovalStatus = "pending" | "approved" | "rejected" | "consumed";

export interface ApprovalRecord {
  uid: string;
  previewId: string;
  issuedAt: string;
  expiresAt: string;
  status: ApprovalStatus;
  changes: unknown[];
  affectedDocs: string[];
  approvedUid?: string;
  approvedAt?: string;
  consumedAt?: string;
}

export function approvalDocName(uid:string, approvalId:string):string {
  if(!UID.test(uid) || !ID.test(approvalId)) throw new Error("承認申請の識別情報が不正です");
  return HAAKU_DB+"/documents/users/"+uid+"/haaku_approvals/"+approvalId.toLowerCase();
}
export function approvalUrl(uid:string,approvalId:string):string {
  return HAAKU_DOCS_URL+"/users/"+uid+"/haaku_approvals/"+approvalId.toLowerCase();
}
export function isApprovalExpired(value:ApprovalRecord,now=Date.now()):boolean {
  const issued=Date.parse(value.issuedAt), expires=Date.parse(value.expiresAt);
  return !Number.isFinite(issued) || !Number.isFinite(expires) ||
    issued > now || expires < now || expires - issued > HAAKU_APPROVAL_MAX_AGE_MS;
}
export function canCommitApprovedRecord(
  value:ApprovalRecord,uid:string,previewId:string,now=Date.now(),
):boolean {
  const stamp=Date.parse(value.approvedAt||"");
  return value.uid===uid && value.previewId===previewId &&
    value.status==="approved" && value.approvedUid===uid &&
    Number.isFinite(stamp) && stamp>=Date.parse(value.issuedAt) &&
    stamp<=now && !isApprovalExpired(value,now);
}
export function isApprovalRecord(raw:unknown):raw is ApprovalRecord {
  if(!raw || typeof raw!=="object" || Array.isArray(raw)) return false;
  const x=raw as Record<string,unknown>;
  return typeof x.uid==="string" && typeof x.previewId==="string" &&
    typeof x.issuedAt==="string" && typeof x.expiresAt==="string" &&
    ["pending","approved","rejected","consumed"].includes(String(x.status)) &&
    Array.isArray(x.changes) && Array.isArray(x.affectedDocs) &&
    x.affectedDocs.every(y=>typeof y==="string");
}
