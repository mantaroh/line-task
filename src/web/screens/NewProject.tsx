import { useState, type FormEvent } from "react";
import type { ProjectDetail } from "../../shared/types";
import { api, ApiError } from "../api";
import { BottomBar } from "../components/BottomBar";
import { Header } from "../components/Header";
import { PartiesEditor } from "../components/PartiesEditor";
import { SheetSetup } from "../components/SheetSetup";

export function NewProject({
  serviceAccountEmail,
  onDone,
  onCancel,
}: {
  serviceAccountEmail: string;
  onDone: (pid: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [parties, setParties] = useState(["", ""]);
  const [created, setCreated] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const detail = await api<ProjectDetail>("POST", "/api/projects", {
        name,
        parties: parties.map((p) => p.trim()),
      });
      setCreated(detail);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "エラーが発生しました");
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <>
        <Header title={created.name} />
        <main className="main">
          <SheetSetup
            pid={created.id}
            serviceAccountEmail={serviceAccountEmail}
            onBound={() => onDone(created.id)}
            onSkip={() => onDone(created.id)}
          />
        </main>
        <BottomBar onBack={onCancel} />
      </>
    );
  }

  return (
    <>
      <Header title="新しいプロジェクト" />
      <main className="main">
        <form onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="project-name">名前</label>
            <input
              id="project-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              required
            />
          </div>
          <PartiesEditor parties={parties} onChange={setParties} disabled={busy} />
          {error ? <p className="error">{error}</p> : null}
          <button type="submit" className="btn btn-primary" disabled={busy}>
            作成
          </button>
        </form>
      </main>
      <BottomBar onBack={onCancel} />
    </>
  );
}
