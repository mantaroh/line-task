// 期限の通知で使う型。

export type NotifyKind = "before" | "due" | "after3";

export type NotifyTarget = {
  lineUserId: string;
  projectId: string;
  projectName: string;
  parties: string[];
  spreadsheetId: string;
  party: string | null;
};

export type NotificationKey = { lineUserId: string; projectId: string; taskKey: string; kind: NotifyKind; due: string };
