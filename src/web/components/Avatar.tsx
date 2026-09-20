// LINE の profile スコープが無いと表示名・アイコンが空で保存されるので、そのときの見せ方もここで決める
export function nameOrPlaceholder(name: string): string {
  return name.trim() || "（名前なし）";
}

export function Avatar({ name, pictureUrl }: { name: string; pictureUrl: string | null }) {
  if (pictureUrl) {
    return <img className="member-icon" src={pictureUrl} alt="" width={40} height={40} />;
  }
  const initial = [...name.trim()][0] ?? "?";
  return (
    <span className="member-icon member-icon-fallback" aria-hidden="true">
      {initial}
    </span>
  );
}
