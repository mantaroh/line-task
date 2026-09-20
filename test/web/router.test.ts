import { describe, expect, it } from "vitest";
import { parseRoute, routeToSearch, type Route } from "../../src/web/router";

describe("router", () => {
  it.each([
    ["", { view: "home" }],
    ["?view=new-project", { view: "new-project" }],
    ["?p=abc", { view: "project", pid: "abc", tab: "open" }],
    ["?p=abc&tab=done", { view: "project", pid: "abc", tab: "done" }],
    ["?p=abc&t=T-012", { view: "task", pid: "abc", ref: "T-012" }],
    ["?p=abc&view=new", { view: "new-task", pid: "abc" }],
    ["?p=abc&view=settings", { view: "settings", pid: "abc" }],
    ["?invite=tok", { view: "invite", token: "tok" }],
  ])("parseRoute(%s)", (search, route) => {
    expect(parseRoute(search)).toEqual(route);
    expect(parseRoute(routeToSearch(route as Route))).toEqual(route);
  });
});
