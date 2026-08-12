import type { Env } from "./index.js";

/**
 * Cloudflare Access（入口の関門）を機械から通るための見出しを作る。
 *
 * 2026-08-12 新設。
 *   売上管理（sales-manager.shia2n.jp）の住所の手前に Access の関門を置くため、
 *   shia2n-mcp からの呼び出しがブラウザのログインを通らずに抜けられる形が要る。
 *   Cloudflare の決まりでは、サービス用の合言葉 2 つを
 *   CF-Access-Client-Id と CF-Access-Client-Secret という見出しに載せて送る。
 *   出典：https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
 *
 * 2 つとも入っているときだけ見出しを付ける。
 *   片方だけ設定されている状態で送っても関門は通れず、
 *   何が足りないのかが分かりにくい失敗になるため。
 *
 * 関門がまだ無い住所へ送っても害は無い（余分な見出しとして無視される）。
 *   これにより「先に呼び出し側へ入れてから関門をかける」順番が採れる。
 */
export function cfAccessHeaders(env: Env): Record<string, string> {
  const id = env.CF_ACCESS_CLIENT_ID;
  const secret = env.CF_ACCESS_CLIENT_SECRET;
  if (!id || !secret) return {};
  return {
    "CF-Access-Client-Id": id,
    "CF-Access-Client-Secret": secret,
  };
}

/**
 * サービス用の合言葉が 2 つそろっているかどうか。
 * 値そのものは返さない（点検の口に出すのは有無だけ）。
 */
export function hasCfAccessCredentials(env: Env): boolean {
  return Boolean(env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET);
}
