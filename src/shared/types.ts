export const TASK_STATUSES = ["未着手", "対応中", "完了", "取り下げ"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const CLOSED_STATUSES: readonly string[] = ["完了", "取り下げ"];

export type TaskField =
  | "id"
  | "title"
  | "ball"
  | "assignee"
  | "status"
  | "due"
  | "source"
  | "next"
  | "memo"
  | "createdAt"
  | "updatedAt"
  | "updatedBy";
export const FIELD_HEADERS: Record<TaskField, string> = {
  id: "ID",
  title: "件名",
  ball: "ボール",
  assignee: "担当",
  status: "状態",
  due: "期限",
  source: "発生元",
  next: "次にやること",
  memo: "メモ",
  createdAt: "作成日",
  updatedAt: "更新日",
  updatedBy: "更新者",
};
export const HEADER_ORDER: TaskField[] = [
  "id",
  "title",
  "ball",
  "assignee",
  "status",
  "due",
  "source",
  "next",
  "memo",
  "createdAt",
  "updatedAt",
  "updatedBy",
];
export const REQUIRED_FIELDS: TaskField[] = ["id", "title", "ball", "status"];
export const EDITABLE_FIELDS = ["title", "ball", "assignee", "status", "due", "source", "next", "memo"] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];
export const FIELD_LIMITS: Record<EditableField, number> = {
  title: 100,
  ball: 12,
  assignee: 200,
  status: 10,
  due: 10,
  source: 200,
  next: 200,
  memo: 1000,
};

export type Task = {
  ref: string; // "T-012"。ID が無い行は "row-15"
  row: number; // シートの行番号（1 始まり。表示と ID の無い行の確認にだけ使う）
  id: string | null;
  readonly: boolean; // ID が重複している下の行
  title: string;
  ball: string;
  assignee: string;
  status: string;
  due: string;
  source: string;
  next: string;
  memo: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
};
export type TaskChanges = Partial<Record<EditableField, string>>;
export type TasksResponse = {
  tasks: Task[];
  fields: TaskField[];
  parties: string[];
  today: string;
  imageCounts: Record<string, number>;
  mediaCounts: MediaCounts;
  fileCounts: Record<string, number>;
};

export type UserRef = { lineUserId: string; displayName: string; pictureUrl: string | null };
export type Member = UserRef & { joinedAt: string; party: string | null };  // party は関係者に無ければ null
export type ProjectSummary = {
  id: string;
  name: string;
  archived: boolean;
  sheetConnected: boolean;
  counts: { open: number; overdue: number } | null; // 読めなければ null（画面は「—」）
};
export type ProjectDetail = {
  id: string;
  name: string;
  parties: string[];
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;
  archivedAt: string | null;
  createdAt: string;
  members: Member[];
  appUrl: string;
};
export type InviteSummary = { id: string; createdBy: UserRef; createdAt: string; expiresAt: string; useCount: number };
export type InvitePreview = {
  projectId: string;
  projectName: string;
  invitedBy: string;
  expiresAt: string;
  status: "valid" | "expired" | "revoked" | "archived";
  alreadyMember: boolean;
};
export type TaskImage = {
  id: string;
  taskId: string;
  width: number;
  height: number;
  size: number;
  createdBy: UserRef;
  createdAt: string;
};
export type MediaKind = "video" | "audio";
export type TaskMedia = {
  id: string;
  taskId: string;
  kind: MediaKind;
  contentType: string;
  size: number;
  durationMs: number | null;
  url: string; // 署名つき。1〜2 時間で切れる
  thumbUrl: string | null;
  createdBy: UserRef;
  createdAt: string;
};
export type TaskFile = {
  id: string;
  taskId: string;
  name: string;
  contentType: string;
  size: number;
  url: string; // 署名つき。1〜2 時間で切れる
  createdBy: UserRef;
  createdAt: string;
};
export type MediaCounts = Record<string, { video: number; audio: number }>;
export type ActivityItem = { id: number; actor: UserRef; action: string; detail: unknown; at: string };
export type SessionResponse = { token: string; user: UserRef; isNew: boolean };
export type ConfigResponse = { serviceAccountEmail: string; appUrlBase: string; devMocks: boolean };
export type ApiErrorBody = { error: string; message: string; [k: string]: unknown };
export type MemberSettings = { notify: boolean; party: string | null };
export type LineFriendResponse = { friend: boolean | null; addFriendUrl: string | null };

export const USAGE_VIEWS = ["home", "new-project", "project", "task", "new-task", "settings", "invite"] as const;
export type UsageView = (typeof USAGE_VIEWS)[number];
export const PROJECT_USAGE_VIEWS: readonly UsageView[] = ["project", "task", "new-task", "settings"];
