/**
 * v1.124.0（2026-11-21 開発部）：受け取ったファイルが本当に画像かを、先頭のバイトで確かめる。
 * 起きたこと：ドライブの非公開ファイルを download_url で渡すと、ドライブのログイン画面（HTML・約947KB）が返り、
 * それが .png / .jpg の名前で保存されて ok が返っていた（投稿 1794977325331496・2026-11-21 11:47〜12:24）。
 * 名前や Content-Type ではなく中身で決める。画像でなければ null。
 */
export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export function sniffImage(buf: ArrayBuffer | Uint8Array): ImageMime | null {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

/** Content-Type が画像でないとはっきり言っているか（text/html など）。空・octet-stream は中身で決める */
export function typeSaysNotImage(contentType: string | null | undefined): boolean {
  const t = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (!t || t === "application/octet-stream" || t === "binary/octet-stream") return false;
  return !t.startsWith("image/");
}

/** Google ドライブの住所からファイルの番号を取り出す（drive.google.com/file/d/<番号>/…・open?id=・uc?id=・docs.google.com/uc?id=）。違えば null */
export function driveIdFromUrl(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!/^(drive|docs)\.google\.com$/.test(u.hostname) && u.hostname !== "drive.usercontent.google.com") return null;
  const m = u.pathname.match(/\/file\/d\/([0-9A-Za-z_-]{10,100})/);
  const id = m?.[1] || u.searchParams.get("id") || "";
  return /^[0-9A-Za-z_-]{10,100}$/.test(id) ? id : null;
}
