// Mangarr UI: plain JS, hash routes, talks to /api/v1 (no key needed from local addresses).
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const page = $("#page");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const plain = (html) => {
  const d = document.createElement("div");
  d.innerHTML = String(html ?? "").replace(/<br\s*\/?>/gi, "\n");
  return d.textContent.trim();
};
const fmtCh = (n) => (n == null ? "–" : String(n));
const ago = (ms) => {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
};
const STATUS = { RELEASING: "Continuing", FINISHED: "Ended", HIATUS: "Hiatus", CANCELLED: "Cancelled", NOT_YET_RELEASED: "Upcoming" };

async function api(path, opts = {}) {
  const res = await fetch(`/api/v1${path}`, {
    method: opts.method ?? "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast${err ? " err" : ""}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), err ? 6000 : 3000);
}
const fail = (e) => toast(e.message, true);

// ---------- modal ----------
function modal(title, bodyHtml, buttons, wide = false) {
  const m = $("#modal");
  m.innerHTML = `<div class="dialog${wide ? " wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <header>${esc(title)}</header><div class="body">${bodyHtml}</div>
    <footer>${buttons.map((b, i) => `<button class="btn ${b.cls ?? ""}" data-i="${i}">${esc(b.label)}</button>`).join("")}</footer></div>`;
  m.hidden = false;
  const close = () => ((m.hidden = true), (m.innerHTML = ""));
  m.onclick = (e) => {
    if (e.target === m) return close();
    const b = e.target.closest("footer button");
    if (b) {
      const fn = buttons[b.dataset.i].onClick;
      fn ? fn(close, m) : close();
    }
  };
  document.onkeydown = (e) => e.key === "Escape" && !m.hidden && close();
  m.querySelector("input, button")?.focus();
  return { el: m, close };
}

// ---------- shared bits ----------
function barFor(s) {
  // Chapters asked for (from the start chapter on); AniList's count only before anything is known.
  const total = s.chaptersOnDisk + s.chaptersMissing || s.totalChapters || 0;
  const done = s.chaptersOnDisk;
  let color = s.anilistStatus === "FINISHED" ? "green" : "";
  if (s.chaptersMissing) color = s.monitored ? "red" : "orange";
  if (s.state === "no_match" || s.state === "error") color = "red";
  return `<div class="bar ${color}"><i style="width:${total ? Math.min(100, (done / total) * 100) : 0}%"></i><span>${done} / ${total}</span></div>`;
}
const stateLabel = (s) =>
  s.state === "no_match" ? `<span class="label red">No match</span>`
  : s.state === "error" ? `<span class="label red">Source error</span>`
  : s.state === "matching" ? `<span class="label">Matching…</span>`
  : !s.monitored ? `<span class="label orange">Unmonitored</span>`
  : s.chaptersMissing ? `<span class="label red">Missing ${s.chaptersMissing}</span>`
  : `<span class="label green">Up to date</span>`;
const tb = (id, icon, label, on = false) => `<button class="tb${on ? " on" : ""}" id="${id}"><span class="ic" aria-hidden="true">${icon}</span>${label}</button>`;

// ---------- pages ----------
const pages = {};
let poll = null;
const every = (ms, fn) => ((poll = setInterval(fn, ms)), fn());

pages.series = async () => {
  const view = localStorage.view ?? "posters";
  const q = ($("#search").value || "").toLowerCase();
  page.innerHTML = `<div class="toolbar">${tb("t-refresh", "⟳", "Update All")}${tb("t-add", "＋", "Add New")}<span class="spacer"></span>
    ${tb("t-posters", "▦", "Posters", view === "posters")}${tb("t-table", "☰", "Table", view === "table")}</div><div class="content" id="list"></div>`;
  $("#t-refresh").onclick = () => api("/command/refresh", { method: "POST" }).then(() => toast("Checking every series for new chapters"), fail);
  $("#t-add").onclick = () => (location.hash = "#/add");
  $("#t-posters").onclick = () => ((localStorage.view = "posters"), pages.series());
  $("#t-table").onclick = () => ((localStorage.view = "table"), pages.series());
  const all = await api("/series");
  const list = all.filter((s) => !q || s.titles.some((t) => t.toLowerCase().includes(q)));
  const el = $("#list");
  if (!all.length) {
    el.innerHTML = `<div class="empty">No series yet.<br><a class="btn primary" href="#/add">Add New Series</a></div>`;
    return;
  }
  if (!list.length) return (el.innerHTML = `<div class="empty">Nothing matches “${esc(q)}”.</div>`);
  if (view === "table") {
    el.innerHTML = `<table><thead><tr><th>Title</th><th>Status</th><th>Source</th><th style="width:200px">Chapters</th><th>Latest</th><th>Added</th></tr></thead><tbody>
      ${list.map((s) => `<tr><td><a href="#/series/${s.anilistId}">${esc(s.title)}</a></td><td>${stateLabel(s)}</td><td>${esc(s.sourceName ?? "–")}</td>
        <td>${barFor(s)}</td><td>${fmtCh(s.latestChapter)}</td><td>${ago(s.added)}</td></tr>`).join("")}</tbody></table>`;
  } else {
    el.innerHTML = `<div class="posters">${list
      .map((s) => `<a class="poster" href="#/series/${s.anilistId}">
        ${s.state === "no_match" || s.state === "error" ? `<span class="ribbon err">${s.state === "error" ? "Error" : "No match"}</span>` : !s.monitored ? `<span class="ribbon">Unmonitored</span>` : ""}
        <img loading="lazy" src="${esc(s.cover ?? "")}" alt="">${barFor(s)}
        <div class="meta"><div class="t" title="${esc(s.title)}">${esc(s.title)}</div><div class="s">${esc(s.sourceName ?? "no source")}</div></div></a>`)
      .join("")}</div>`;
  }
};

pages.detail = async (id) => {
  const [s, chapters, queue] = await Promise.all([api(`/series/${id}`), api(`/series/${id}/chapters`), api("/queue").catch(() => ({ items: [] }))]);
  const q = new Map(queue.items.filter((i) => i.anilistId === s.anilistId).map((i) => [i.chapter, i]));
  page.innerHTML = `<div class="toolbar">${tb("t-refresh", "⟳", "Refresh")}${tb("t-edit", "✎", "Edit")}${tb("t-source", "⇄", "Change Source")}
      <span class="spacer"></span>${tb("t-delete", "🗑", "Delete")}</div>
    <section class="hero"><div class="bg" style="background-image:url('${esc(s.banner ?? s.cover ?? "")}')"></div>
      <img src="${esc(s.cover ?? "")}" alt="">
      <div class="info">
        <h1><button class="mon${s.monitored ? "" : " off"}" id="mon" title="${s.monitored ? "Monitored: click to unmonitor" : "Unmonitored: click to monitor"}" aria-pressed="${s.monitored}">${s.monitored ? "★" : "☆"}</button>${esc(s.title)}</h1>
        <div class="muted">${[s.year, STATUS[s.anilistStatus] ?? s.anilistStatus, s.author, s.genres.slice(0, 4).join(", ")].filter(Boolean).map(esc).join(" · ")}</div>
        <div class="chips">
          <span class="chip"><b>Path</b>${esc(s.path)}</span>
          <span class="chip"><b>Source</b>${esc(s.sourceName ?? "none")}</span>
          <span class="chip"><b>Chapters</b>${s.chaptersOnDisk} on disk${s.chaptersMissing ? `, ${s.chaptersMissing} missing` : ""}${s.totalChapters ? ` (AniList: ${s.totalChapters})` : ""}</span>
          <span class="chip"><b>From</b>${s.startChapter ? `chapter ${s.startChapter}` : "the start"}</span>
          <span class="chip"><b>Checked</b>${ago(s.lastChecked)}</span>
          <span class="chip"><a href="https://anilist.co/manga/${s.anilistId}" target="_blank" rel="noreferrer">AniList ↗</a></span>
        </div>
        ${s.error ? `<div class="err-box">${esc(s.error)}</div>` : ""}
        <div class="desc">${esc(plain(s.description))}</div>
      </div></section>
    <div class="content"><div class="card"><h2>Chapters</h2>${
      chapters.length
        ? `<table><thead><tr><th>#</th><th>Title</th><th>File</th><th>Status</th><th>Imported</th></tr></thead><tbody>${[...chapters]
            .reverse()
            .map((c) => {
              const d = q.get(c.number);
              const st = c.onDisk ? `<span class="label green">On disk</span>`
                : d ? (d.state === "DOWNLOADING" ? `<div class="bar purple thin" title="${Math.round(d.progress * 100)}%"><i style="width:${d.progress * 100}%"></i></div>` : `<span class="label purple">${d.state === "ERROR" ? "Error" : "Queued"}</span>`)
                : `<span class="label ${s.monitored ? "red" : "orange"}">Missing</span>`;
              return `<tr><td class="num">${fmtCh(c.number)}</td><td>${esc(c.name ?? "")}</td><td class="mono muted">${esc(c.file ?? "")}</td><td>${st}</td><td>${c.imported ? ago(c.imported) : ""}</td></tr>`;
            })
            .join("")}</tbody></table>`
        : `<div class="empty">${s.state === "no_match" ? "No enabled source has this title. Try <b>Change Source</b>, or enable more sources in Settings." : "No chapters known yet. Refresh checks the source."}</div>`
    }</div></div>`;

  $("#mon").onclick = () => api(`/series/${id}`, { method: "PATCH", body: { monitored: !s.monitored } }).then(() => pages.detail(id), fail);
  $("#t-refresh").onclick = () => api(`/series/${id}/refresh`, { method: "POST" }).then(() => toast(`Checking ${s.title}`), fail);
  $("#t-edit").onclick = () =>
    modal(`Edit – ${s.title}`,
      `<label class="row"><span>Monitored</span><input type="checkbox" id="e-mon" ${s.monitored ? "checked" : ""}></label>
       <label class="row"><span>Start from chapter</span><input type="number" id="e-start" min="0" step="any" value="${s.startChapter}"></label>
       <p class="muted">0 = the whole series. Lowering it downloads the earlier chapters; raising it only stops new downloads below it (files on disk stay).</p>`,
      [{ label: "Cancel" }, { label: "Save", cls: "primary", onClick: (close, m) =>
        api(`/series/${id}`, { method: "PATCH", body: { monitored: $("#e-mon", m).checked, startChapter: Number($("#e-start", m).value || 0) } })
          .then(() => (close(), pages.detail(id)), fail) }]);
  $("#t-delete").onclick = () =>
    modal(`Delete – ${s.title}`,
      `<p>Remove <b>${esc(s.title)}</b> from Mangarr?</p><label class="row"><input type="checkbox" id="d-files"> Also delete the folder <code>${esc(s.path)}</code> and every chapter in it</label>`,
      [{ label: "Cancel" }, { label: "Delete", cls: "danger", onClick: (close, m) =>
        api(`/series/${id}?deleteFiles=${$("#d-files", m).checked}`, { method: "DELETE" }).then(() => (close(), toast(`${s.title} removed`), (location.hash = "#/")), fail) }]);
  $("#t-source").onclick = async () => {
    const { el, close } = modal(`Change Source – ${s.title}`, `<p class="muted">Searching every enabled source…</p>`, [{ label: "Close" }], true);
    try {
      const c = await api(`/series/${id}/candidates`);
      $(".body", el).innerHTML = c.length
        ? `<p class="muted">Files already on disk stay. Missing chapters come from the new source.</p><table><tbody>${c
            .map((x, i) => `<tr><td style="width:60px">${x.thumbnail ? `<img src="${esc(x.thumbnail)}" alt="" style="width:46px;aspect-ratio:2/3;object-fit:cover;border-radius:3px">` : ""}</td>
              <td>${esc(x.title)} ${x.exact ? `<span class="label green">exact title</span>` : ""}<div class="muted">${esc(x.sourceName)}</div></td>
              <td style="text-align:right">${x.current ? `<span class="label blue">Current</span>` : `<button class="btn small primary" data-c="${i}">Use this</button>`}</td></tr>`)
            .join("")}</tbody></table>`
        : `<div class="empty">No results on any enabled source.</div>`;
      $(".body", el).onclick = (e) => {
        const b = e.target.closest("[data-c]");
        if (!b) return;
        const x = c[b.dataset.c];
        api(`/series/${id}`, { method: "PATCH", body: { sourceId: x.sourceId, mangaId: x.mangaId } }).then(() => (close(), toast(`Now using ${x.sourceName}`), pages.detail(id)), fail);
      };
    } catch (e) {
      $(".body", el).innerHTML = `<div class="err-box">${esc(e.message)}</div>`;
    }
  };
  // Keep the page live while something is happening (matching, downloading); stop once it settles.
  if (s.state === "matching" || q.size || (s.monitored && s.chaptersMissing))
    poll = setTimeout(() => !$("#modal").innerHTML && location.hash === `#/series/${id}` && route(), 4000);
};

pages.add = async () => {
  page.innerHTML = `<div class="content"><h2>Add New Series</h2>
    <input class="field big-search" type="search" id="term" placeholder="Search AniList for a manga, e.g. Frieren" aria-label="Search AniList" autofocus>
    <div id="results" style="margin-top:20px"></div></div>`;
  const term = $("#term");
  let t;
  const run = async () => {
    const v = term.value.trim();
    if (!v) return ($("#results").innerHTML = "");
    $("#results").innerHTML = `<p class="muted">Searching…</p>`;
    try {
      const r = await api(`/lookup?term=${encodeURIComponent(v)}`);
      if (v !== term.value.trim()) return;
      $("#results").innerHTML = r.length
        ? r.map((m, i) => `<div class="result"><img src="${esc(m.cover ?? "")}" alt="" loading="lazy"><div class="body">
            <h3>${esc(m.title)} ${m.year ? `<span class="muted">(${m.year})</span>` : ""}</h3>
            <div class="muted">${[m.title !== m.romaji ? m.romaji : null, m.format, STATUS[m.status] ?? m.status, m.chapters ? `${m.chapters} chapters` : null].filter(Boolean).map(esc).join(" · ")}</div>
            <div class="d">${esc(plain(m.description))}</div>
            <div class="actions">${m.added
              ? `<a class="btn" href="#/series/${m.anilistId}">Already added: open</a>`
              : `<label>Start from chapter <input type="number" min="0" step="any" value="0" style="width:90px" data-start="${i}"></label>
                 <button class="btn primary" data-add="${i}">Add ${esc(m.title)}</button>`}</div></div></div>`).join("")
        : `<div class="empty">Nothing on AniList for “${esc(v)}”.</div>`;
      $("#results").onclick = (e) => {
        const b = e.target.closest("[data-add]");
        if (!b) return;
        const m = r[b.dataset.add];
        b.disabled = true;
        api("/series", { method: "POST", body: { anilistId: m.anilistId, startChapter: Number($(`[data-start="${b.dataset.add}"]`).value || 0) } })
          .then(() => (toast(`${m.title} added, looking for a source`), (location.hash = `#/series/${m.anilistId}`)), (e) => ((b.disabled = false), fail(e)));
      };
    } catch (e) {
      $("#results").innerHTML = `<div class="err-box">${esc(e.message)}</div>`;
    }
  };
  term.oninput = () => (clearTimeout(t), (t = setTimeout(run, 400)));
  term.focus();
};

pages.queue = async () => {
  page.innerHTML = `<div class="toolbar">${tb("t-refresh", "⟳", "Refresh")}</div><div class="content" id="q"></div>`;
  $("#t-refresh").onclick = () => route();
  every(3000, async () => {
    const q = await api("/queue").catch((e) => ({ error: e.message, items: [] }));
    if (!$("#q")) return;
    $("#q").innerHTML = q.error ? `<div class="err-box">${esc(q.error)}</div>`
      : !q.items.length ? `<div class="empty">Queue is empty</div>`
      : `<p class="muted">Downloader: ${esc(q.state)}</p><table><thead><tr><th>Series</th><th>Chapter</th><th>Status</th><th style="width:240px">Progress</th></tr></thead><tbody>${q.items
          .map((i) => `<tr><td>${i.anilistId ? `<a href="#/series/${i.anilistId}">${esc(i.title)}</a>` : esc(i.title)}</td><td>${fmtCh(i.chapter)} <span class="muted">${esc(i.name)}</span></td>
            <td><span class="label ${i.state === "ERROR" ? "red" : i.state === "DOWNLOADING" ? "purple" : ""}">${esc(i.state.toLowerCase())}${i.tries > 1 ? ` (try ${i.tries})` : ""}</span></td>
            <td><div class="bar purple"><i style="width:${i.progress * 100}%"></i><span>${Math.round(i.progress * 100)}%</span></div></td></tr>`)
          .join("")}</tbody></table>`;
  });
};

pages.history = async () => {
  const h = await api("/history");
  page.innerHTML = `<div class="content">${h.length
    ? `<table><thead><tr><th>Series</th><th>Chapter</th><th>File</th><th>Imported</th></tr></thead><tbody>${h
        .map((r) => `<tr><td><a href="#/series/${r.anilistId}">${esc(r.title)}</a></td><td>${fmtCh(r.chapter)}</td><td class="mono muted">${esc(r.file)}</td><td>${ago(r.imported)}</td></tr>`)
        .join("")}</tbody></table>`
    : `<div class="empty">Nothing imported yet</div>`}</div>`;
};

pages.wanted = async () => {
  const w = await api("/wanted");
  page.innerHTML = `<div class="toolbar">${tb("t-search", "⌕", "Search All")}</div><div class="content">${w.length
    ? `<table><thead><tr><th>Series</th><th>Chapter</th><th>Title</th><th>Status</th></tr></thead><tbody>${w
        .map((r) => `<tr><td><a href="#/series/${r.anilistId}">${esc(r.title)}</a></td><td>${fmtCh(r.chapter)}</td><td>${esc(r.name ?? "")}</td>
          <td><span class="label ${r.monitored ? "red" : "orange"}">${r.monitored ? "Missing" : "Unmonitored"}</span></td></tr>`)
        .join("")}</tbody></table>`
    : `<div class="empty">Nothing missing</div>`}</div>`;
  $("#t-search").onclick = () => api("/command/refresh", { method: "POST" }).then(() => toast("Checking every series"), fail);
};

pages.sources = async () => {
  page.innerHTML = `<div class="content"><div class="grid2">
      <div class="card"><h2>Enabled sources</h2><p class="muted">Searched top to bottom when a series is added. The first exact title match wins.</p><ul class="srclist" id="enabled"></ul>
        <div class="actions" style="margin-top:12px"><button class="btn primary" id="save" disabled>Save order</button></div></div>
      <div class="card"><h2>Installed, not enabled</h2><ul class="srclist" id="disabled"></ul></div>
    </div>
    <div class="card"><h2>Install extension</h2><p class="muted">From the keiyoushi repository, the same extensions Mihon uses.</p>
      <div class="filters"><input class="field" type="search" id="ext-q" placeholder="Filter by name" aria-label="Filter extensions"><select id="ext-lang" aria-label="Language"></select>
        <label><input type="checkbox" id="ext-nsfw"> show NSFW</label></div><div class="scroll" id="exts"><p class="muted">Loading the extension list…</p></div></div></div>`;
  let enabled = await api("/sources");
  const installed = await api("/sources/installed").catch(() => []);
  const icon = (u) => (u ? `<img class="icon" src="/api/v1/icon?u=${encodeURIComponent(u)}" alt="" onerror="this.style.visibility='hidden'">` : "");
  const draw = () => {
    $("#enabled").innerHTML = enabled.length
      ? enabled.map((s, i) => `<li><span class="prio">${i + 1}</span>${icon(s.icon)}<span class="grow">${esc(s.name)} <span class="muted">${esc(s.lang)}</span></span>
          <button class="btn small" data-up="${i}" aria-label="Move ${esc(s.name)} up" ${i ? "" : "disabled"}>▲</button>
          <button class="btn small" data-down="${i}" aria-label="Move ${esc(s.name)} down" ${i < enabled.length - 1 ? "" : "disabled"}>▼</button>
          <button class="btn small" data-off="${i}">Disable</button></li>`).join("")
      : `<li class="muted">None yet: install an extension below, or enable an installed source.</li>`;
    const ids = new Set(enabled.map((s) => s.id));
    const off = installed.filter((s) => !ids.has(s.id));
    $("#disabled").innerHTML = off.length
      ? off.map((s) => `<li>${icon(s.iconUrl)}<span class="grow">${esc(s.displayName)}</span><button class="btn small" data-on="${esc(s.id)}">Enable</button></li>`).join("")
      : `<li class="muted">Every installed source is enabled.</li>`;
  };
  draw();
  const dirty = () => (($("#save").disabled = false), draw());
  page.querySelector(".grid2").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const d = b.dataset;
    if (d.up) [enabled[d.up - 1], enabled[d.up]] = [enabled[d.up], enabled[d.up - 1]];
    else if (d.down) [enabled[+d.down + 1], enabled[d.down]] = [enabled[d.down], enabled[+d.down + 1]];
    else if (d.off) enabled.splice(d.off, 1);
    else if (d.on) {
      const s = installed.find((x) => x.id === d.on);
      enabled.push({ id: s.id, name: s.displayName, lang: s.lang, icon: s.iconUrl });
    } else return;
    dirty();
  };
  $("#save").onclick = () =>
    api("/sources", { method: "PUT", body: { ids: enabled.map((s) => s.id) } }).then((r) => ((enabled = r), ($("#save").disabled = true), draw(), toast("Source order saved")), fail);

  let exts;
  try {
    exts = await api("/extensions");
  } catch (e) {
    return ($("#exts").innerHTML = `<div class="err-box">${esc(e.message)}</div>`);
  }
  const langs = [...new Set(exts.map((x) => x.lang))].sort();
  $("#ext-lang").innerHTML = `<option value="">All languages</option>${langs.map((l) => `<option ${l === (localStorage.extLang ?? "en") ? "selected" : ""}>${esc(l)}</option>`).join("")}`;
  const drawExts = () => {
    const q = $("#ext-q").value.toLowerCase();
    const lang = ($("#ext-lang").value);
    localStorage.extLang = lang;
    const nsfw = $("#ext-nsfw").checked;
    const list = exts.filter((x) => (!lang || x.lang === lang || x.lang === "all") && (!q || x.name.toLowerCase().includes(q)) && (nsfw || x.contentWarning !== "NSFW"));
    $("#exts").innerHTML = `<table><tbody>${list
      .slice(0, 300)
      .map((x) => `<tr><td style="width:40px">${icon(x.iconUrl)}</td><td>${esc(x.name)} ${x.contentWarning === "NSFW" ? `<span class="label red">NSFW</span>` : ""}</td><td class="muted">${esc(x.lang)}</td>
        <td style="text-align:right">${x.isInstalled ? `<span class="label green">Installed</span>` : `<button class="btn small primary" data-pkg="${esc(x.pkgName)}">Install</button>`}</td></tr>`)
      .join("")}</tbody></table>${list.length > 300 ? `<p class="muted">${list.length - 300} more: narrow the filter.</p>` : ""}`;
  };
  $("#ext-q").oninput = $("#ext-lang").onchange = $("#ext-nsfw").onchange = drawExts;
  drawExts();
  $("#exts").onclick = (e) => {
    const b = e.target.closest("[data-pkg]");
    if (!b) return;
    b.disabled = true;
    b.textContent = "Installing…";
    api("/extensions/install", { method: "POST", body: { pkgName: b.dataset.pkg } }).then(() => (toast("Installed and enabled"), pages.sources()), (e) => ((b.disabled = false), (b.textContent = "Install"), fail(e)));
  };
};

pages.general = async () => {
  const s = await api("/status");
  const row = (k, v) => `<label class="row"><span>${k}</span><code>${esc(v)}</code></label>`;
  page.innerHTML = `<div class="content"><div class="card"><h2>Security</h2>
      <label class="row"><span>API key</span><span class="keybox"><input type="text" id="key" readonly value="${esc(s.apiKey)}" aria-label="API key"><button class="btn small" id="copy">Copy</button></span></label>
      <p class="muted">Jellyshelf (or anything not on a local address) sends this as <code>X-Api-Key</code>. Local addresses (LAN, Docker, NetBird) need no key. Stored in <code>/config/api-key</code>.</p></div>
    <div class="card"><h2>Paths and services</h2><p class="muted">Set through environment variables in the compose file.</p>
      ${row("Library", s.library)}${row("Downloads (Suwayomi)", s.downloads)}${row("Suwayomi", s.suwayomiUrl)}${row("Check for new chapters", `every ${s.syncMinutes} min`)}</div></div>`;
  $("#copy").onclick = () => {
    $("#key").select();
    // Clipboard API needs https; plain-http LAN pages fall back to execCommand.
    (navigator.clipboard?.writeText(s.apiKey) ?? Promise.reject()).catch(() => document.execCommand("copy")).finally(() => toast("Copied"));
  };
};

pages.status = async () => {
  const s = await api("/status");
  page.innerHTML = `<div class="toolbar">${tb("t-sync", "⟳", "Check All Now")}</div><div class="content"><div class="card"><h2>Status</h2><table><tbody>
    <tr><td>Version</td><td>${esc(s.version)}</td></tr>
    <tr><td>Suwayomi</td><td>${s.suwayomi.ok ? `<span class="label green">Connected</span> ${esc(s.suwayomi.version)}` : `<span class="label red">Unreachable</span> ${esc(s.suwayomi.error)}`} <span class="muted">${esc(s.suwayomiUrl)}</span></td></tr>
    <tr><td>Last full check</td><td>${s.syncing ? "running now" : ago(s.lastSync)}</td></tr>
    <tr><td>Library</td><td><code>${esc(s.library)}</code></td></tr></tbody></table></div></div>`;
  $("#t-sync").onclick = () => api("/command/refresh", { method: "POST" }).then(() => toast("Checking every series"), fail);
};

pages.logs = async () => {
  page.innerHTML = `<div class="toolbar">${tb("t-refresh", "⟳", "Refresh")}</div><div class="content"><div class="logs mono" id="logs"></div></div>`;
  $("#t-refresh").onclick = () => route();
  const l = await api("/log");
  $("#logs").textContent = l.join("\n") || "Empty";
};

// ---------- router ----------
const table = [
  [/^\/?$/, "series", pages.series],
  [/^\/series\/(\d+)$/, "series", pages.detail],
  [/^\/add$/, "series", pages.add],
  [/^\/activity\/queue$/, "activity", pages.queue],
  [/^\/activity\/history$/, "activity", pages.history],
  [/^\/wanted$/, "wanted", pages.wanted],
  [/^\/settings\/sources$/, "settings", pages.sources],
  [/^\/settings\/general$/, "settings", pages.general],
  [/^\/system\/status$/, "system", pages.status],
  [/^\/system\/logs$/, "system", pages.logs],
];
async function route() {
  clearInterval(poll);
  clearTimeout(poll);
  const path = location.hash.slice(1) || "/";
  const [re, nav, fn] = table.find(([re]) => re.test(path)) ?? table[0];
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === nav));
  document.querySelectorAll("[data-sub]").forEach((d) => d.classList.toggle("open", d.dataset.sub === nav));
  document.querySelectorAll(".sub a").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === `#${path}`));
  $("#sidebar").classList.remove("show");
  try {
    await fn(...(re.exec(path) ?? []).slice(1));
  } catch (e) {
    page.innerHTML = `<div class="content"><div class="err-box">${esc(e.message)}</div></div>`;
  }
}
window.addEventListener("hashchange", route);
$("#burger").onclick = () => $("#sidebar").classList.toggle("show");
let st;
$("#search").oninput = () => {
  clearTimeout(st);
  st = setTimeout(() => (location.hash === "" || location.hash === "#/" ? pages.series() : (location.hash = "#/")), 200);
};
route();
