// Renders a scraped chat message (see scraper.parse_chat_item) as a YouTube-style card.
// Usage: element = YtChat.render(message)
(function () {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICONS = {
    moderator: "M21.7 6.3a5.5 5.5 0 0 1-7.2 6.6l-7.8 7.8a2 2 0 0 1-2.8-2.8l7.8-7.8a5.5 5.5 0 0 1 6.6-7.2L15 6.2 15.6 8.4 17.8 9z",
    verified: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.6 14.6-4.2-4.2 1.4-1.4 2.8 2.8 5.9-5.9 1.4 1.4z",
  };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function img(src, cls, alt) {
    const i = el("img", cls);
    i.src = src;
    i.alt = alt || "";
    if (alt) i.title = alt;
    i.referrerPolicy = "no-referrer";
    return i;
  }

  function icon(kind, title) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", `yt-icon yt-icon-${kind}`);
    if (title) {
      const t = document.createElementNS(SVG_NS, "title");
      t.textContent = title;
      svg.append(t);
    }
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", ICONS[kind]);
    svg.append(path);
    return svg;
  }

  function display(m) {
    return m.display || {};
  }

  function hasMessage(m) {
    const runs = display(m).runs;
    return (runs && runs.length > 0) || !!m.message;
  }

  function messageRuns(m) {
    const frag = document.createDocumentFragment();
    const runs = display(m).runs;
    if (runs && runs.length) {
      for (const r of runs) {
        frag.append(r.emoji ? img(r.emoji, "yt-emoji", r.alt) : document.createTextNode(r.text || ""));
      }
    } else if (m.message) {
      frag.append(m.message);
    }
    return frag;
  }

  function badges(m) {
    const out = [];
    for (const b of display(m).badges || []) {
      if (b.kind === "member" && b.url) out.push(img(b.url, "yt-badge", b.label));
      else if (ICONS[b.kind]) out.push(icon(b.kind, b.label));
    }
    return out;
  }

  function avatar(m, small) {
    const cls = "yt-avatar" + (small ? " small" : "");
    return m.author_photo ? img(m.author_photo, cls) : el("span", cls);
  }

  function author(m, color, roleColors) {
    const wrap = el("span", "yt-author-wrap");
    let cls = "yt-author";
    if (roleColors) cls += m.is_owner ? " is-owner" : m.is_moderator ? " is-mod" : m.is_member ? " is-member" : "";
    const name = el("span", cls, m.author_name);
    if (color) name.style.color = color;
    wrap.append(name, ...badges(m));
    return wrap;
  }

  function superchat(m) {
    const d = display(m);
    const card = el("div", "yt-card yt-paid");
    const head = el("div", "yt-head");
    head.style.background = d.header_bg || m.color || "#1565c0";
    const text = el("div", "yt-head-text");
    const amount = el("div", "yt-amount", m.amount_text);
    amount.style.color = d.header_text || "#fff";
    text.append(author(m, d.author_text || "rgba(255,255,255,.7)"), amount);
    head.append(avatar(m), text);
    card.append(head);
    if (hasMessage(m)) {
      const body = el("div", "yt-body");
      body.style.background = d.body_bg || m.color || "#1e88e5";
      body.style.color = d.body_text || "#fff";
      body.append(messageRuns(m));
      card.append(body);
    }
    return card;
  }

  function sticker(m) {
    const d = display(m);
    const card = el("div", "yt-card yt-sticker");
    card.style.background = d.body_bg || m.color || "#1e88e5";
    const head = el("div", "yt-head");
    const text = el("div", "yt-head-text");
    const chip = el("span", "yt-chip", m.amount_text);
    chip.style.background = d.header_bg || "rgba(0,0,0,.2)";
    chip.style.color = d.header_text || "#fff";
    text.append(author(m, d.author_text || "rgba(255,255,255,.7)"), chip);
    head.append(avatar(m), text);
    if (m.sticker_url) head.append(img(m.sticker_url, "yt-sticker-img", m.sticker_label));
    card.append(head);
    return card;
  }

  function membership(m) {
    const d = display(m);
    const withBody = hasMessage(m);
    const card = el("div", "yt-card yt-member" + (withBody ? " has-body" : ""));
    const head = el("div", "yt-head");
    const text = el("div", "yt-head-text");
    text.append(author(m, "#fff"));
    if (d.header_primary) text.append(el("div", "yt-primary", d.header_primary));
    if (d.header_sub) text.append(el("div", "yt-sub", d.header_sub));
    if (!d.header_primary && !d.header_sub && m.header_text) text.append(el("div", "yt-sub", m.header_text));
    head.append(avatar(m), text);
    card.append(head);
    if (withBody) {
      const body = el("div", "yt-body");
      body.append(messageRuns(m));
      card.append(body);
    }
    return card;
  }

  function giftPurchase(m) {
    const d = display(m);
    const card = el("div", "yt-card yt-gift");
    const head = el("div", "yt-head");
    const text = el("div", "yt-head-text");
    text.append(author(m, "#fff"), el("div", "yt-primary", m.header_text));
    head.append(avatar(m), text);
    if (d.gift_image) head.append(img(d.gift_image, "yt-gift-img"));
    card.append(head);
    return card;
  }

  function chatLine(m) {
    let cls = "yt-card yt-text";
    if (m.type === "gift_redemption") cls += " yt-redeem";
    if (m.type === "system") cls += " yt-system";
    const row = el("div", cls);
    if (m.time_in_video) row.append(el("span", "yt-time", m.time_in_video));
    if (m.author_name) row.append(avatar(m, true));
    const line = el("div", "yt-line");
    if (m.author_name) line.append(author(m, null, true));
    const msg = el("span", "yt-message");
    msg.append(messageRuns(m));
    line.append(msg);
    row.append(line);
    return row;
  }

  const RENDERERS = {superchat, supersticker: sticker, membership, gift_purchase: giftPurchase};

  function render(m) {
    const wrap = el("div", "yt-chat");
    wrap.append((RENDERERS[m.type] || chatLine)(m));
    return wrap;
  }

  window.YtChat = {render};
})();
