import { useLayoutEffect, useRef } from "react";
import type { ChatMessage } from "../types";
import { messageText, roleClass } from "../util";

/** Latest messages while a scrape runs; sticks to the bottom unless the user scrolled up. */
export default function LiveFeed({ msgs }: { msgs: ChatMessage[] }) {
  const feed = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const f = feed.current;
    if (f && stick.current) f.scrollTop = f.scrollHeight;
  }, [msgs]);

  return (
    <section id="feed-card" className="card">
      <label className="lbl">Latest messages</label>
      <div className="feed" id="feed" ref={feed}
           onScroll={(e) => {
             const f = e.currentTarget;
             stick.current = f.scrollHeight - f.scrollTop - f.clientHeight < 40;
           }}>
        {msgs.length ? msgs.map((m, i) => <FeedMsg key={m.id || i} m={m} />)
                     : <div className="empty">Waiting for messages…</div>}
      </div>
    </section>
  );
}

function FeedMsg({ m }: { m: ChatMessage }) {
  const paid = m.type === "superchat" || m.type === "supersticker";
  return (
    <div className={`msg ${m.type}${paid ? " paid" : ""}`} style={paid && m.color ? { background: m.color } : undefined}>
      <span className="t">{m.time_in_video}</span>
      {m.type !== "text_message" && !paid && m.type !== "system" && <span className="tag">{m.type.replace("_", " ")}</span>}
      {paid && <span className="amt">{m.amount_text}</span>}
      {m.author_name && <span className={"a " + roleClass(m)}>{m.author_name}</span>}
      {messageText(m)}
    </div>
  );
}
