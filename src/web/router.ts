import { useCallback, useEffect, useState } from "react";
import type { Tab } from "../shared/taskView";

export type Route =
  | { view: "home" }
  | { view: "new-project" }
  | { view: "project"; pid: string; tab: Tab }
  | { view: "task"; pid: string; ref: string }
  | { view: "new-task"; pid: string }
  | { view: "settings"; pid: string }
  | { view: "invite"; token: string };

function tabFromQuery(raw: string | null): Tab {
  if (raw === "done" || raw === "overdue") return raw;
  return "open";
}

export function parseRoute(search: string): Route {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const invite = q.get("invite");
  if (invite) return { view: "invite", token: invite };
  const pid = q.get("p");
  if (pid) {
    const ref = q.get("t");
    if (ref) return { view: "task", pid, ref };
    const view = q.get("view");
    if (view === "new") return { view: "new-task", pid };
    if (view === "settings") return { view: "settings", pid };
    return { view: "project", pid, tab: tabFromQuery(q.get("tab")) };
  }
  if (q.get("view") === "new-project") return { view: "new-project" };
  return { view: "home" };
}

export function routeToSearch(r: Route): string {
  switch (r.view) {
    case "home":
      return "";
    case "new-project":
      return "?view=new-project";
    case "project":
      return r.tab === "open"
        ? `?p=${encodeURIComponent(r.pid)}`
        : `?p=${encodeURIComponent(r.pid)}&tab=${r.tab}`;
    case "task":
      return `?p=${encodeURIComponent(r.pid)}&t=${encodeURIComponent(r.ref)}`;
    case "new-task":
      return `?p=${encodeURIComponent(r.pid)}&view=new`;
    case "settings":
      return `?p=${encodeURIComponent(r.pid)}&view=settings`;
    case "invite":
      return `?invite=${encodeURIComponent(r.token)}`;
  }
}

export function useRoute(): [Route, (r: Route, opts?: { replace?: boolean }) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.search));

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((r: Route, opts?: { replace?: boolean }) => {
    const url = `${window.location.pathname}${routeToSearch(r)}${window.location.hash}`;
    if (opts?.replace) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
    setRoute(r);
  }, []);

  return [route, navigate];
}
