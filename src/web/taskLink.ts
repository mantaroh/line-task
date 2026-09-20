// 「この件どうなった？」とトークに貼るための文字列。開かなくても何の件か分かるよう件名を付ける
export function taskLinkText(appUrl: string, id: string, title: string): string {
  const url = `${appUrl}${appUrl.includes("?") ? "&" : "?"}t=${encodeURIComponent(id)}`;
  const name = title.replace(/\s+/g, " ").trim();
  return name ? `【${id}】${name}\n${url}` : url;
}
