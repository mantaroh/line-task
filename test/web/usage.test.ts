import { describe, expect, it } from "vitest";
import type { Route } from "../../src/web/router";
import { routeToUsage, usageKey } from "../../src/web/usage";

describe("routeToUsage", () => {
  it.each([
    [{ view: "home" }, { view: "home" }],
    [{ view: "new-project" }, { view: "new-project" }],
    [{ view: "project", pid: "p1", tab: "open" }, { view: "project", pid: "p1" }],
    [{ view: "task", pid: "p1", ref: "T-012" }, { view: "task", pid: "p1" }],
    [{ view: "new-task", pid: "p1" }, { view: "new-task", pid: "p1" }],
    [{ view: "settings", pid: "p1" }, { view: "settings", pid: "p1" }],
    [{ view: "invite", token: "tok" }, { view: "invite" }],
  ] as [Route, { view: string; pid?: string }][])("routeToUsage(%o)", (route, expected) => {
    expect(routeToUsage(route)).toEqual(expected);
  });

  it("project の tab を結果に含めない", () => {
    const result = routeToUsage({ view: "project", pid: "p1", tab: "done" });
    expect(result).not.toHaveProperty("tab");
  });

  it("invite に pid を付けない", () => {
    const result = routeToUsage({ view: "invite", token: "tok" });
    expect(result).not.toHaveProperty("pid");
  });
});

describe("usageKey", () => {
  it("project の tab だけが違っても同じキー", () => {
    const a = usageKey({ view: "project", pid: "p1", tab: "open" });
    const b = usageKey({ view: "project", pid: "p1", tab: "done" });
    expect(a).toBe(b);
  });

  it("task の ref だけが違っても同じキー", () => {
    const a = usageKey({ view: "task", pid: "p1", ref: "T-001" });
    const b = usageKey({ view: "task", pid: "p1", ref: "T-002" });
    expect(a).toBe(b);
  });

  it("view が違えば別のキー", () => {
    const a = usageKey({ view: "home" });
    const b = usageKey({ view: "new-project" });
    expect(a).not.toBe(b);
  });

  it("pid が違えば別のキー", () => {
    const a = usageKey({ view: "project", pid: "p1", tab: "open" });
    const b = usageKey({ view: "project", pid: "p2", tab: "open" });
    expect(a).not.toBe(b);
  });
});
