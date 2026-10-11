/**
 * shia2n-mcp / src/github-core.ts / 新設（2026-10-11 v1.7.0 開発部）
 *
 * github__open_pr の中身のうち、GitHub に触らない計算だけをここに置く（試験で回せるようにするため）。
 * - applyEdits：探す文字列→置き換える文字列を上から順に当てる。1 か所に当たらなければ止める
 * - sha256Hex：上げる中身の指紋。手元の sha256sum と同じ値になる（同じバイト列なら一致）
 */

export class EditError extends Error {}

export function applyEdits(text: string, path: string, edits: { old_str: string; new_str: string }[]): string {
  let out = text;
  for (let i = 0; i < edits.length; i++) {
    const { old_str, new_str } = edits[i];
    const hits = out.split(old_str).length - 1;
    if (hits !== 1) throw new EditError(`${path} の ${i + 1} 番目の置き換え：探す文字列が ${hits} か所に当たりました（1 か所でないと止めます）`);
    out = out.replace(old_str, () => new_str);
  }
  return out;
}

export function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function decodeBase64Utf8(b64: string): string {
  return new TextDecoder("utf-8").decode(base64ToBytes(b64));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}
