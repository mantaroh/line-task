// 画面ごとのアクセスの記録。失敗しても画面には影響させない。
import type { UsageView } from "../shared/types";
import { api } from "./api";
import type { Route } from "./router";

export function routeToUsage(route: Route): { view: UsageView; pid?: string } {
  switch (route.view) {
    case "home":
    case "new-project":
    case "invite":
      return { view: route.view };
    case "project":
    case "task":
    case "new-task":
    case "settings":
      return { view: route.view, pid: route.pid };
  }
}

export function sendUsage(route: Route): void {
  api("POST", "/api/usage", routeToUsage(route)).catch(() => {});
}

// routeToUsage の結果を、変化を見分けるためのキーにする。
// タブの切り替えやタスクの ref だけが変わるルートの遷移では、同じキーになる。
export function usageKey(route: Route): string {
  return JSON.stringify(routeToUsage(route));
}
