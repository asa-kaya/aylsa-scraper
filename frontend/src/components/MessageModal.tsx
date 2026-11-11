import { useEffect, useRef, useState, type ReactNode } from "react";
import { cardFilename, cardToPng } from "../lib/exportCard";
import type { ChatMessage, Video } from "../types";
import YtChatCard from "./YtChatCard";

interface Props {
  rows: ChatMessage[];
  index: number;
  position: number;  // 1-based position across all pages
  total: number;
  video: Video | null;
  onIndex: (i: number) => void;
  onClose: () => void;
}

const PNG_LABEL = "Download as PNG";

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}

/** Popup showing one message as a YouTube-style card, with ←/→ browsing and PNG export. */
export default function MessageModal({ rows, index, position, total, video, onIndex, onClose }: Props) {
  const m = rows[index];
  const card = useRef<HTMLDivElement>(null);
  const [png, setPng] = useState({ busy: false, label: PNG_LABEL });
  const resetTimer = useRef<number>(undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && index < rows.length - 1) onIndex(index + 1);
      else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, rows.length, onIndex, onClose]);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  async function downloadCard() {
    if (!card.current) return;
    setPng({ busy: true, label: "Saving…" });
    let label = "Saved";
    try {
      const url = await cardToPng(card.current);
      const a = document.createElement("a");
      a.href = url;
      a.download = cardFilename(m);
      a.click();
    } catch (err) {
      console.error(err);
      label = "Failed — retry";
    }
    setPng({ busy: false, label });
    clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setPng({ busy: false, label: PNG_LABEL }), 1500);
  }

  const t = Math.max(0, Math.floor((m.video_offset_ms || 0) / 1000));
  const links = [
    video && <Ext key="v" href={`https://www.youtube.com/watch?v=${video.video_id}&t=${t}s`}>
      {`Open stream at ${m.time_in_video || "0:00"}`}
    </Ext>,
    m.author_channel_id && <Ext key="c" href={`https://www.youtube.com/channel/${m.author_channel_id}`}>Author's channel</Ext>,
  ].filter(Boolean);

  return (
    <div id="modal" className="modal" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box" role="dialog" aria-modal="true" aria-label="Chat message">
        <button type="button" className="modal-close" id="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div id="yt-card"><YtChatCard m={m} ref={card} /></div>
        <div className="card-actions">
          <button type="button" className="ghost" id="card-png" disabled={png.busy} onClick={downloadCard}>{png.label}</button>
        </div>
        <div className="modal-meta" id="modal-meta">
          {m.timestamp && <div><b>Sent: </b>{new Date(m.timestamp).toLocaleString()}</div>}
          {m.time_in_video && <div><b>Stream time: </b>{m.time_in_video}</div>}
          {m.author_badges && m.author_badges.length > 0 && <div><b>Badges: </b>{m.author_badges.join(", ")}</div>}
          {links.length > 0 && <div>{links.flatMap((l, i) => (i ? [" · ", l] : [l]))}</div>}
        </div>
        <div className="modal-nav">
          <span>← → browse · Esc close</span>
          <span id="modal-pos">{`${position.toLocaleString()} of ${total.toLocaleString()}`}</span>
        </div>
      </div>
    </div>
  );
}
