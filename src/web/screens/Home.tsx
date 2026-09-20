import { useEffect, useState } from "react";
import type { ProjectSummary } from "../../shared/types";
import { api } from "../api";
import { ErrorView } from "../components/ErrorView";
import { BottomBar } from "../components/BottomBar";
import { Header } from "../components/Header";
import { Loading } from "../components/Loading";

function countsLabel(p: ProjectSummary): string {
  if (!p.sheetConnected) return "シート未接続";
  if (!p.counts) return "—";
  return `未完了 ${p.counts.open} ・期限切れ ${p.counts.overdue}`;
}

function ProjectCard({ project, onOpen }: { project: ProjectSummary; onOpen: (pid: string) => void }) {
  return (
    <li>
      <button type="button" className="project-card tap" onClick={() => onOpen(project.id)}>
        <span className="project-card-body">
          <span className="project-name">{project.name}</span>
          <span className="muted">{countsLabel(project)}</span>
        </span>
        <span className="chevron" aria-hidden="true">
          ›
        </span>
      </button>
    </li>
  );
}

export function Home({ onOpen, onNew }: { onOpen: (pid: string) => void; onNew: () => void }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    api<ProjectSummary[]>("GET", "/api/projects")
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <ErrorView error={error} />;
  if (!projects) return <Loading />;

  const active = projects.filter((p) => !p.archived);
  const archived = projects.filter((p) => p.archived);

  return (
    <>
      <Header title="ホーム" />
      <main className="main">
        {active.length === 0 ? <p className="muted">まだプロジェクトがありません</p> : null}
        <ul className="project-list">
          {active.map((p) => (
            <ProjectCard key={p.id} project={p} onOpen={onOpen} />
          ))}
        </ul>
        {archived.length > 0 ? (
          <details className="archived">
            <summary>アーカイブ済み（{archived.length}）</summary>
            <ul className="project-list">
              {archived.map((p) => (
                <ProjectCard key={p.id} project={p} onOpen={onOpen} />
              ))}
            </ul>
          </details>
        ) : null}
      </main>
      <BottomBar>
        <button type="button" className="btn btn-primary" onClick={onNew}>
          ＋ 新しいプロジェクト
        </button>
      </BottomBar>
    </>
  );
}
