import { useState } from "react";
import type { ChatType, Format, JobSummary } from "../types";
import { fmtTime, isActive } from "../util";

interface Props {
  url: string;
  onUrl: (v: string) => void;
  chatType: ChatType;
  onChatType: (v: ChatType) => void;
  format: Format;
  onFormat: (v: Format) => void;
  error: string | null;
  busy: boolean;
  resumable: JobSummary | null;
  jobList: JobSummary[];
  currentId: string | null;
  onSubmit: () => void;
  onResume: () => Promise<void>;
  onLoadJob: (j: JobSummary) => void;
  onRemoveJob: (j: JobSummary) => void;
}

export default function ScrapeForm(p: Props) {
  const [resuming, setResuming] = useState(false);

  async function resume() {
    setResuming(true);
    await p.onResume();
    setResuming(false);
  }

  return (
    <form id="form" className="card" onSubmit={(e) => { e.preventDefault(); p.onSubmit(); }}>
      <label className="lbl" htmlFor="url">Stream URL</label>
      <input type="text" id="url" placeholder="https://www.youtube.com/watch?v=... or /live/..." required autoComplete="off"
             value={p.url} onChange={(e) => p.onUrl(e.target.value)} />
      <JobChips jobs={p.jobList} currentId={p.currentId} onLoad={p.onLoadJob} onRemove={p.onRemoveJob} />
      <div className="row">
        <div>
          <label className="lbl">Chat</label>
          <div className="opt">
            <input type="radio" name="chat_type" id="ct-all" value="all" checked={p.chatType === "all"}
                   onChange={() => p.onChatType("all")} /><label htmlFor="ct-all">All messages</label>
            <input type="radio" name="chat_type" id="ct-top" value="top" checked={p.chatType === "top"}
                   onChange={() => p.onChatType("top")} /><label htmlFor="ct-top">Top chat only</label>
          </div>
        </div>
        <div>
          <label className="lbl">Save as</label>
          <div className="opt">
            <input type="radio" name="format" id="f-json" value="json" checked={p.format === "json"}
                   onChange={() => p.onFormat("json")} /><label htmlFor="f-json">JSON</label>
            <input type="radio" name="format" id="f-csv" value="csv" checked={p.format === "csv"}
                   onChange={() => p.onFormat("csv")} /><label htmlFor="f-csv">CSV</label>
          </div>
        </div>
        <div className="grow"></div>
        {p.resumable && (
          <button type="button" id="resume" disabled={resuming} onClick={resume}>
            Resume from {fmtTime(p.resumable.offset_ms)}
          </button>
        )}
        <button type="submit" id="start" className={p.resumable ? "ghost" : undefined} disabled={p.busy}>
          {p.resumable ? "Start over" : "Start scraping"}
        </button>
      </div>
      {p.error && <div id="form-error" className="err">{p.error}</div>}
    </form>
  );
}

function JobChips({ jobs, currentId, onLoad, onRemove }: {
  jobs: JobSummary[]; currentId: string | null;
  onLoad: (j: JobSummary) => void; onRemove: (j: JobSummary) => void;
}) {
  return (
    <div className="job-chips" id="job-chips">
      {jobs.map((j) => (
        <div key={j.id} className={"job-chip" + (j.id === currentId ? " current" : "")}
             title={`${j.url}\n${j.chat_type === "top" ? "Top chat" : "All messages"} · ${j.status}`}
             onClick={() => onLoad(j)}>
          <span className={"dot " + (isActive(j.status) ? "active" : j.status)}></span>
          <span className="name">{j.title || j.video_id}</span>
          <span className="count">{j.total.toLocaleString()} msgs</span>
          <button type="button" className="x" title="Remove from this session"
                  onClick={(e) => { e.stopPropagation(); onRemove(j); }}>×</button>
        </div>
      ))}
    </div>
  );
}
