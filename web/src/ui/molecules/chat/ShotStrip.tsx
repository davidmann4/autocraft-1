import type { ChatShot } from "../../../api/types";

/** Mock builds have no task artifacts, so they draw a plain placeholder. */
const mockImage = (taskId: number, name: string): string => {
  const after = taskId % 2 === 0;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="450" viewBox="0 0 720 450"><rect width="720" height="450" fill="#f4f1ea"/><rect x="40" y="40" width="640" height="370" rx="8" fill="#fff" stroke="#c9c2b4"/><text x="60" y="80" font-family="sans-serif" font-size="22" fill="#333">${name}: ${after ? "after" : "before"}</text>${[0, 1, 2, 3].map((i) => `<rect x="${after ? 380 + i * 60 : 120 + i * 60}" y="${after ? 330 : 200}" width="26" height="26" fill="${after ? "#c0392b" : "#2f6fed"}"/>`).join("")}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};
const srcOf = (s: ChatShot): string => (import.meta.env.VITE_MOCK === "1" ? mockImage(s.taskId, s.name) : `/api/tasks/${s.taskId}/artifacts/${encodeURIComponent(s.name)}`);

/** A screenshot run as a strip of thumbnails; each opens the full picture in a new tab. */
export function ShotStrip({ shots }: { shots: ChatShot[] }) {
  return (
    <ul className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
      {shots.map((s) => (
        <li key={`${s.taskId}:${s.name}`} className="w-40 shrink-0">
          <a href={srcOf(s)} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border border-line bg-sunken hover:border-line-strong">
            <img src={srcOf(s)} alt={`${s.label}: ${s.name}`} loading="lazy" className="block aspect-[16/10] w-full object-cover" />
          </a>
          <span className="mt-0.5 block truncate text-xs text-ink/70">{s.label}</span>
        </li>
      ))}
    </ul>
  );
}
