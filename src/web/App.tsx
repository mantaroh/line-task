import { useEffect, useState } from "react";
import type { ConfigResponse, SessionResponse, UserRef } from "../shared/types";
import { api, setIdTokenProvider } from "./api";
import { ErrorView } from "./components/ErrorView";
import { Loading } from "./components/Loading";
import { Notice } from "./components/Notice";
import { DevUserSwitcher } from "./dev/DevUserSwitcher";
import { getIdToken, initLiff } from "./liff";
import { useRoute, type Route } from "./router";
import { Home } from "./screens/Home";
import { Invite } from "./screens/Invite";
import { NewProject } from "./screens/NewProject";
import { Project } from "./screens/Project";
import { Settings } from "./screens/Settings";
import { TaskDetail } from "./screens/TaskDetail";
import { TaskNew } from "./screens/TaskNew";
import { sendUsage, usageKey } from "./usage";

export function App() {
  const [route, navigate] = useRoute();
  const [boot, setBoot] = useState<"loading" | "ready" | "error">("loading");
  const [bootError, setBootError] = useState<unknown>(null);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [user, setUser] = useState<UserRef | null>(null);
  const [canShare, setCanShare] = useState(false);
  const [showNotice, setShowNotice] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const liffSession = await initLiff();
        setIdTokenProvider(getIdToken);
        const session = await api<SessionResponse>("POST", "/api/session", { idToken: liffSession.idToken });
        const cfg = await api<ConfigResponse>("GET", "/api/config");
        if (cancelled) return;
        setShowNotice(session.isNew);
        setUser(session.user);
        setCanShare(liffSession.canShare);
        setConfig(cfg);
        setBoot("ready");
      } catch (e) {
        if (cancelled) return;
        setBootError(e);
        setBoot("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const routeUsageKey = usageKey(route);

  useEffect(() => {
    if (boot !== "ready") return;
    // view・pid が変わったときだけ記録する。タブの切り替えや、ID 割り当てで
    // 同じタスクの ref が変わるだけの遷移は、ここでは重複として記録しない。
    sendUsage(route);
  }, [boot, routeUsageKey]);

  if (boot === "loading") return <Loading />;
  if (boot === "error" || !config || !user) return <ErrorView error={bootError} />;

  return (
    <div className="app">
      {showNotice ? (
        <Notice onClose={() => setShowNotice(false)}>
          LINE の表示名とアイコン、開いた画面と日時をこのアプリに保存します
        </Notice>
      ) : null}
      <Screen route={route} config={config} user={user} canShare={canShare} navigate={navigate} />
      {config.devMocks ? <DevUserSwitcher /> : null}
    </div>
  );
}

function Screen({
  route,
  config,
  user,
  canShare,
  navigate,
}: {
  route: Route;
  config: ConfigResponse;
  user: UserRef;
  canShare: boolean;
  navigate: (r: Route, opts?: { replace?: boolean }) => void;
}) {
  switch (route.view) {
    case "home":
      return (
        <Home
          onOpen={(pid) => navigate({ view: "project", pid, tab: "open" })}
          onNew={() => navigate({ view: "new-project" })}
        />
      );
    case "new-project":
      return (
        <NewProject
          serviceAccountEmail={config.serviceAccountEmail}
          onDone={(pid) => navigate({ view: "project", pid, tab: "open" })}
          onCancel={() => navigate({ view: "home" })}
        />
      );
    case "project":
      return (
        <Project
          pid={route.pid}
          lineUserId={user.lineUserId}
          tab={route.tab}
          onBack={() => navigate({ view: "home" })}
          onTab={(tab) => navigate({ view: "project", pid: route.pid, tab })}
          onSettings={() => navigate({ view: "settings", pid: route.pid })}
          onTask={(ref) => navigate({ view: "task", pid: route.pid, ref })}
          onNew={() => navigate({ view: "new-task", pid: route.pid })}
        />
      );
    case "task":
      return (
        <TaskDetail
          pid={route.pid}
          taskRef={route.ref}
          onBack={() => navigate({ view: "project", pid: route.pid, tab: "open" })}
          onRefChanged={(ref) => navigate({ view: "task", pid: route.pid, ref }, { replace: true })}
        />
      );
    case "new-task":
      return (
        <TaskNew
          pid={route.pid}
          onBack={() => navigate({ view: "project", pid: route.pid, tab: "open" })}
          onCreated={() => navigate({ view: "project", pid: route.pid, tab: "open" })}
        />
      );
    case "settings":
      return (
        <Settings
          pid={route.pid}
          lineUserId={user.lineUserId}
          canShare={canShare}
          serviceAccountEmail={config.serviceAccountEmail}
          onBack={() => navigate({ view: "project", pid: route.pid, tab: "open" })}
          onLeft={() => navigate({ view: "home" })}
        />
      );
    case "invite":
      return (
        <Invite
          token={route.token}
          onOpen={(pid) => navigate({ view: "project", pid, tab: "open" })}
          onBack={() => navigate({ view: "home" })}
        />
      );
  }
}
