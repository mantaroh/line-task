import { FIELD_HEADERS, FIELD_LIMITS, TASK_STATUSES, type EditableField, type Task, type TaskChanges, type TaskField } from "../../shared/types";
import { MemoField } from "./MemoField";

export type TaskFormValues = Record<EditableField, string>;

export const CREATE_FIELDS: TaskField[] = ["title", "ball", "assignee", "due", "source", "next"];

export function emptyValues(): TaskFormValues {
  return {
    title: "",
    ball: "",
    assignee: "",
    status: "未着手",
    due: "",
    source: "",
    next: "",
    memo: "",
  };
}

export function valuesFromTask(task: Pick<Task, EditableField>): TaskFormValues {
  return {
    title: task.title,
    ball: task.ball,
    assignee: task.assignee,
    status: task.status,
    due: task.due,
    source: task.source,
    next: task.next,
    memo: task.memo,
  };
}

export function toChanges(values: TaskFormValues): TaskChanges {
  return {
    title: values.title,
    ball: values.ball,
    assignee: values.assignee,
    status: values.status,
    due: values.due,
    source: values.source,
    next: values.next,
    memo: values.memo,
  };
}

export function diffChanges(current: TaskFormValues, original: TaskFormValues): TaskChanges {
  const changes: TaskChanges = {};
  (Object.keys(current) as EditableField[]).forEach((field) => {
    if (current[field] !== original[field]) changes[field] = current[field];
  });
  return changes;
}

function show(fields: TaskField[], field: TaskField): boolean {
  return fields.includes(field);
}

function dateValue(due: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : "";
}

export function TaskForm({
  values,
  onChange,
  fields,
  parties,
  assigneeSuggestions,
  disabled,
  meta,
}: {
  values: TaskFormValues;
  onChange: (patch: Partial<TaskFormValues>) => void;
  fields: TaskField[];
  parties: string[];
  assigneeSuggestions: string[];
  disabled?: boolean;
  meta?: { id: string | null; createdAt: string; updatedAt: string; updatedBy: string };
}) {
  const listId = "assignee-suggestions";
  const statusOptions = TASK_STATUSES.includes(values.status as (typeof TASK_STATUSES)[number])
    ? TASK_STATUSES
    : ([values.status, ...TASK_STATUSES] as readonly string[]);

  return (
    <div className="task-form">
      {meta && show(fields, "id") ? (
        <div className="field">
          <span>{FIELD_HEADERS.id}</span>
          <p>{meta.id ?? "—"}</p>
        </div>
      ) : null}

      {show(fields, "title") ? (
        <div className="field">
          <label htmlFor="task-title">{FIELD_HEADERS.title}</label>
          <input
            id="task-title"
            type="text"
            value={values.title}
            onChange={(e) => onChange({ title: e.target.value })}
            maxLength={FIELD_LIMITS.title}
            required
            disabled={disabled}
          />
        </div>
      ) : null}

      {show(fields, "ball") ? (
        <fieldset className="field">
          <legend>{FIELD_HEADERS.ball}</legend>
          <p className="hint">今どちらが動く番か（会社・チーム）</p>
          <div className="choice-row" role="group" aria-label={FIELD_HEADERS.ball}>
            {parties.map((p) => (
              <button
                key={p}
                type="button"
                className={values.ball === p ? "btn btn-choice is-selected" : "btn btn-choice"}
                aria-pressed={values.ball === p}
                disabled={disabled}
                onClick={() => onChange({ ball: p })}
              >
                {p}
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}

      {show(fields, "assignee") ? (
        <div className="field">
          <label htmlFor="task-assignee">{FIELD_HEADERS.assignee}</label>
          <p className="hint">その側で対応する人（任意）</p>
          <input
            id="task-assignee"
            type="text"
            value={values.assignee}
            onChange={(e) => onChange({ assignee: e.target.value })}
            maxLength={FIELD_LIMITS.assignee}
            list={listId}
            disabled={disabled}
          />
          <datalist id={listId}>
            {assigneeSuggestions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
      ) : null}

      {show(fields, "status") ? (
        <div className="field">
          <label htmlFor="task-status">{FIELD_HEADERS.status}</label>
          <select
            id="task-status"
            value={values.status}
            onChange={(e) => onChange({ status: e.target.value })}
            disabled={disabled}
          >
            {statusOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {show(fields, "due") ? (
        <div className="field">
          <label htmlFor="task-due">{FIELD_HEADERS.due}</label>
          <input
            id="task-due"
            type="date"
            value={dateValue(values.due)}
            onChange={(e) => onChange({ due: e.target.value })}
            disabled={disabled}
          />
        </div>
      ) : null}

      {show(fields, "source") ? (
        <div className="field">
          <label htmlFor="task-source">{FIELD_HEADERS.source}</label>
          <input
            id="task-source"
            type="text"
            value={values.source}
            onChange={(e) => onChange({ source: e.target.value })}
            maxLength={FIELD_LIMITS.source}
            disabled={disabled}
          />
        </div>
      ) : null}

      {show(fields, "next") ? (
        <div className="field">
          <label htmlFor="task-next">{FIELD_HEADERS.next}</label>
          <input
            id="task-next"
            type="text"
            value={values.next}
            onChange={(e) => onChange({ next: e.target.value })}
            maxLength={FIELD_LIMITS.next}
            disabled={disabled}
          />
        </div>
      ) : null}

      {show(fields, "memo") ? (
        <MemoField
          id="task-memo"
          label={FIELD_HEADERS.memo}
          value={values.memo}
          maxLength={FIELD_LIMITS.memo}
          disabled={disabled}
          onChange={(memo) => onChange({ memo })}
        />
      ) : null}

      {meta && show(fields, "createdAt") ? (
        <div className="field">
          <span>{FIELD_HEADERS.createdAt}</span>
          <p className="muted">{meta.createdAt || "—"}</p>
        </div>
      ) : null}
      {meta && show(fields, "updatedAt") ? (
        <div className="field">
          <span>{FIELD_HEADERS.updatedAt}</span>
          <p className="muted">{meta.updatedAt || "—"}</p>
        </div>
      ) : null}
      {meta && show(fields, "updatedBy") ? (
        <div className="field">
          <span>{FIELD_HEADERS.updatedBy}</span>
          <p className="muted">{meta.updatedBy || "—"}</p>
        </div>
      ) : null}
    </div>
  );
}
