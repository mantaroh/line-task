const USERS = [
  { id: "dev-alice", label: "Alice" },
  { id: "dev-bob", label: "Bob" },
  { id: "dev-carol", label: "Carol" },
] as const;

const DEV_USER_KEY = "ltb-dev-user";
const SESSION_KEY = "ltb-session";

export function DevUserSwitcher() {
  const current = localStorage.getItem(DEV_USER_KEY) ?? "dev-alice";

  function switchTo(id: string) {
    localStorage.setItem(DEV_USER_KEY, id);
    sessionStorage.removeItem(SESSION_KEY);
    location.reload();
  }

  return (
    <div className="dev-switcher">
      {USERS.map((u) => (
        <button key={u.id} type="button" className="btn" disabled={u.id === current} onClick={() => switchTo(u.id)}>
          {u.label}
        </button>
      ))}
    </div>
  );
}
