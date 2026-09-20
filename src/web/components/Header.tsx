// 上部はタイトルだけ。戻る・設定などの操作は BottomBar に置く
export function Header({ title }: { title: string }) {
  return (
    <header className="header">
      <h1>{title}</h1>
    </header>
  );
}
