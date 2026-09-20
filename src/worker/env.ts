import type { SessionUser } from "./auth";
import type { Deps } from "./deps";
import type { ProjectRow } from "./db";

export type AppEnv = { Bindings: Env; Variables: { deps: Deps; user: SessionUser; project: ProjectRow } };
