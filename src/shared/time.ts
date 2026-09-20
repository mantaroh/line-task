// JST（UTC+9）専用の時刻ヘルパー。Intl には頼らず、+9 時間ずらして UTC として読む。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, "0");

function jstParts(now: Date) {
  const d = new Date(now.getTime() + JST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
  };
}

export function todayJst(now: Date): string {
  const p = jstParts(now);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function nowIso(now: Date): string {
  const p = jstParts(now);
  return `${todayJst(now)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}+09:00`;
}

export function sheetDateTime(now: Date): string {
  const p = jstParts(now);
  return `${todayJst(now)} ${pad(p.h)}:${pad(p.mi)}`;
}

export function normalizeDate(s: string): string {
  const m = s.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  return m ? `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}` : s.trim();
}

export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
