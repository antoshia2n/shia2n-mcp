/**
 * スキル 1 本を zip にまとめる。計算だけ（2026-11-15 v1.103.0 開発部・スキルズの管理 3便目「生徒に届ける口」）。
 * claude.ai の「スキルを上げる」は、フォルダ 1 つ（中に SKILL.md）を入れた zip を受け取る。
 * 圧縮はしない（無圧縮の zip）。スキルは数十 KB なので、束ねる部品を増やさないほうを選んだ。
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 日付を zip の形（DOS の日付と時刻）に。日本時間で入れる */
function dosTime(d: Date): { time: number; date: number } {
  const j = new Date(d.getTime() + 9 * 3600 * 1000);
  const y = Math.max(1980, j.getUTCFullYear());
  return {
    time: (j.getUTCHours() << 11) | (j.getUTCMinutes() << 5) | (j.getUTCSeconds() >> 1),
    date: ((y - 1980) << 9) | ((j.getUTCMonth() + 1) << 5) | j.getUTCDate(),
  };
}

export type ZipEntry = { path: string; bytes: Uint8Array };

/** entries を root フォルダの下に入れた無圧縮の zip を作る */
export function buildZip(root: string, entries: ZipEntry[], at: Date = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const { time, date } = dosTime(at);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(`${root}/${e.path}`);
    const crc = crc32(e.bytes);
    const size = e.bytes.length;
    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // 名前は UTF-8
    lv.setUint16(8, 0, true); // 無圧縮
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    lh.set(name, 30);
    locals.push(lh, e.bytes);

    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    ch.set(name, 46);
    centrals.push(ch);
    offset += lh.length + size;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const x of parts) { out.set(x, p); p += x.length; }
  return out;
}

/** 生徒に見せてよいか：見せる相手（audience）にその人の権利のキーが 1 つでも入っているか。admin は全部 */
export function audienceOpen(audience: string[], keys: string[] | null): boolean {
  if (keys === null) return true;
  const k = new Set(keys);
  return audience.some((a) => k.has(a));
}

/** 本人・事業部は社内の印で、生徒の権利ではない。生徒に出す先として数えるのはそれ以外 */
export const INTERNAL_AUDIENCE = ["本人", "事業部"];
export function studentAudience(audience: string[]): string[] {
  return audience.filter((a) => !INTERNAL_AUDIENCE.includes(a));
}
