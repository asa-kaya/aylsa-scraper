// Renders a scraped chat message (see scraper.parse_chat_item) as a YouTube-style card.
import type { JSX, Ref } from "react";
import type { ChatMessage, MessageDisplay } from "../types";
import "./ytchat.css";

const ICONS: Record<string, string> = {
  moderator: "M21.7 6.3a5.5 5.5 0 0 1-7.2 6.6l-7.8 7.8a2 2 0 0 1-2.8-2.8l7.8-7.8a5.5 5.5 0 0 1 6.6-7.2L15 6.2 15.6 8.4 17.8 9z",
  verified: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.6 14.6-4.2-4.2 1.4-1.4 2.8 2.8 5.9-5.9 1.4 1.4z",
};

function Img({ src, className, alt }: { src: string; className: string; alt?: string }) {
  return <img src={src} className={className} alt={alt || ""} title={alt || undefined} referrerPolicy="no-referrer" />;
}

function Icon({ kind, title }: { kind: string; title?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`yt-icon yt-icon-${kind}`}>
      {title && <title>{title}</title>}
      <path d={ICONS[kind]} />
    </svg>
  );
}

const display = (m: ChatMessage): MessageDisplay => m.display || {};

function hasMessage(m: ChatMessage) {
  const runs = display(m).runs;
  return (runs && runs.length > 0) || !!m.message;
}

function MessageRuns({ m }: { m: ChatMessage }) {
  const runs = display(m).runs;
  if (runs && runs.length) {
    return <>{runs.map((r, i) => r.emoji ? <Img key={i} src={r.emoji} className="yt-emoji" alt={r.alt} /> : r.text || "")}</>;
  }
  return <>{m.message}</>;
}

function Badges({ m }: { m: ChatMessage }) {
  return (
    <>
      {(display(m).badges || []).map((b, i) => {
        if (b.kind === "member" && b.url) return <Img key={i} src={b.url} className="yt-badge" alt={b.label} />;
        if (ICONS[b.kind]) return <Icon key={i} kind={b.kind} title={b.label} />;
        return null;
      })}
    </>
  );
}

function Avatar({ m, small }: { m: ChatMessage; small?: boolean }) {
  const cls = "yt-avatar" + (small ? " small" : "");
  return m.author_photo ? <Img src={m.author_photo} className={cls} /> : <span className={cls} />;
}

function Author({ m, color, roleColors }: { m: ChatMessage; color?: string; roleColors?: boolean }) {
  let cls = "yt-author";
  if (roleColors) cls += m.is_owner ? " is-owner" : m.is_moderator ? " is-mod" : m.is_member ? " is-member" : "";
  return (
    <span className="yt-author-wrap">
      <span className={cls} style={color ? { color } : undefined}>{m.author_name}</span>
      <Badges m={m} />
    </span>
  );
}

function Superchat({ m }: { m: ChatMessage }) {
  const d = display(m);
  return (
    <div className="yt-card yt-paid">
      <div className="yt-head" style={{ background: d.header_bg || m.color || "#1565c0" }}>
        <Avatar m={m} />
        <div className="yt-head-text">
          <Author m={m} color={d.author_text || "rgba(255,255,255,.7)"} />
          <div className="yt-amount" style={{ color: d.header_text || "#fff" }}>{m.amount_text}</div>
        </div>
      </div>
      {hasMessage(m) && (
        <div className="yt-body" style={{ background: d.body_bg || m.color || "#1e88e5", color: d.body_text || "#fff" }}>
          <MessageRuns m={m} />
        </div>
      )}
    </div>
  );
}

function Sticker({ m }: { m: ChatMessage }) {
  const d = display(m);
  return (
    <div className="yt-card yt-sticker" style={{ background: d.body_bg || m.color || "#1e88e5" }}>
      <div className="yt-head">
        <Avatar m={m} />
        <div className="yt-head-text">
          <Author m={m} color={d.author_text || "rgba(255,255,255,.7)"} />
          <span className="yt-chip" style={{ background: d.header_bg || "rgba(0,0,0,.2)", color: d.header_text || "#fff" }}>
            {m.amount_text}
          </span>
        </div>
        {m.sticker_url && <Img src={m.sticker_url} className="yt-sticker-img" alt={m.sticker_label} />}
      </div>
    </div>
  );
}

function Membership({ m }: { m: ChatMessage }) {
  const d = display(m);
  const withBody = hasMessage(m);
  return (
    <div className={"yt-card yt-member" + (withBody ? " has-body" : "")}>
      <div className="yt-head">
        <Avatar m={m} />
        <div className="yt-head-text">
          <Author m={m} color="#fff" />
          {d.header_primary && <div className="yt-primary">{d.header_primary}</div>}
          {d.header_sub && <div className="yt-sub">{d.header_sub}</div>}
          {!d.header_primary && !d.header_sub && m.header_text && <div className="yt-sub">{m.header_text}</div>}
        </div>
      </div>
      {withBody && <div className="yt-body"><MessageRuns m={m} /></div>}
    </div>
  );
}

function GiftPurchase({ m }: { m: ChatMessage }) {
  const d = display(m);
  return (
    <div className="yt-card yt-gift">
      <div className="yt-head">
        <Avatar m={m} />
        <div className="yt-head-text">
          <Author m={m} color="#fff" />
          <div className="yt-primary">{m.header_text}</div>
        </div>
        {d.gift_image && <Img src={d.gift_image} className="yt-gift-img" />}
      </div>
    </div>
  );
}

function ChatLine({ m }: { m: ChatMessage }) {
  let cls = "yt-card yt-text";
  if (m.type === "gift_redemption") cls += " yt-redeem";
  if (m.type === "system") cls += " yt-system";
  return (
    <div className={cls}>
      {m.author_name && <Avatar m={m} small />}
      <div className="yt-line">
        {m.author_name && <Author m={m} roleColors />}
        <span className="yt-message"><MessageRuns m={m} /></span>
      </div>
    </div>
  );
}

const RENDERERS: Record<string, (p: { m: ChatMessage }) => JSX.Element> = {
  superchat: Superchat, supersticker: Sticker, membership: Membership, gift_purchase: GiftPurchase,
};

export default function YtChatCard({ m, ref }: { m: ChatMessage; ref?: Ref<HTMLDivElement> }) {
  const Renderer = RENDERERS[m.type] || ChatLine;
  return <div className="yt-chat" ref={ref}><Renderer m={m} /></div>;
}
