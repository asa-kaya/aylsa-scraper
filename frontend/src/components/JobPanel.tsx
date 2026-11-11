import { useState } from "react";
import { downloadUrl } from "../api";
import type { JobDetail } from "../types";
import { STAT_LABELS, fmtMoney, fmtTime, isActive } from "../util";

/** Progress card for the current job. `job` is null until the first poll returns. */
export default function JobPanel({ job, error, onCancel }: {
  job: JobDetail | null; error: string | null; onCancel: () => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const v = job?.video;
  const status = job?.status ?? "queued";
  const active = isActive(status);
  const finished = status === "done" || status === "cancelled";

  let barClass = "bar", barWidth: string | undefined = "0";
  if (job) {
    if (job.progress == null) {
      if (active) { barClass += " indet"; barWidth = undefined; } else barWidth = "100%";
    } else barWidth = (job.progress * 100).toFixed(1) + "%";
  }

  let pos = "";
  if (job) {
    const dur = v && v.duration_seconds ? " / " + fmtTime(v.duration_seconds * 1000) : "";
    pos = status === "fetching" || status === "queued"
      ? "Reading video page…"
      : `Stream position ${fmtTime(job.offset_ms)}${dur}` + (job.progress != null ? ` (${(job.progress * 100).toFixed(1)}%)` : "");
    if (finished && job.file && status === "cancelled") pos += " — stopped early, file contains partial chat";
  }

  const s = job?.stats, bt = s?.by_type || {};
  const values: Record<string, number> = s ? {
    total: s.total_messages, superchat: bt.superchat || 0, supersticker: bt.supersticker || 0,
    membership: bt.membership || 0, gifts: s.gifted_memberships, authors: s.unique_authors,
  } : {};
  const money = Object.entries(s?.paid_totals_by_currency || {});
  const errorText = error ?? (status === "error" ? job?.error : null);
  const other = job?.format === "json" ? "csv" : "json";

  return (
    <section id="job" className="card">
      <div className="video">
        <img id="thumb" alt="" src={v?.thumbnail || undefined} />
        <div>
          <div className="title" id="title">{v ? v.title || v.video_id : "Loading video info…"}</div>
          <div className="meta" id="channel">{v ? `${v.channel} · ${v.chat_type}` : ""}</div>
          <div style={{ marginTop: 6 }}><span className={"status " + status} id="status">{status}</span></div>
        </div>
      </div>

      <div className={barClass} id="bar"><div style={{ width: barWidth }}></div></div>
      <div className="progress-text">
        <span id="pos">{pos}</span>
        <span id="elapsed">{job ? `Elapsed ${fmtTime(job.elapsed * 1000)}` : ""}</span>
      </div>

      <div className="stats" id="stats">
        {s && STAT_LABELS.map(([k, label]) => (
          <div className="stat" key={k}><b>{(values[k] || 0).toLocaleString()}</b><span>{label}</span></div>
        ))}
      </div>
      <div className="money" id="money">
        {money.length > 0 && <>Paid totals: {money.map(([cur, amt], i) => (
          <span key={cur}>{i > 0 && " · "}<b>{cur}{fmtMoney(amt)}</b></span>
        ))}</>}
      </div>
      {errorText && <div id="job-error" className="err">{errorText}</div>}

      <div className="actions">
        {(!job || active) && (
          <button type="button" className="ghost" id="cancel" disabled={cancelling}
                  onClick={() => { setCancelling(true); onCancel(); }}>
            Stop &amp; keep what's collected
          </button>
        )}
        {job && finished && job.file && (
          <>
            <a className="btn" id="download" href={downloadUrl(job.id, job.format)}>
              Download {job.format.toUpperCase()} ({job.stats.total_messages.toLocaleString()} messages)
            </a>
            <a className="link" id="download-alt" href={downloadUrl(job.id, other)}>also download as {other.toUpperCase()}</a>
          </>
        )}
      </div>
    </section>
  );
}
