// ===========================================================
// viewers.js - 觀眾筆記管理頁
// 用途：搜尋與編輯觀眾的標籤、備註、評分與自訂暱稱，管理標籤定義，
//       並以 JSON 檔案備份與還原。所有讀寫都經由背景服務。
// ===========================================================

const SETTINGS_KEY = "yt_viewer_notes_settings";
const REV_KEY = "yt_viewer_notes_rev";
const PAGE_SIZE = 50;

const $ = (id) => document.getElementById(id);
const state = { viewers: [], tags: [], reactionDefs: ViewerModel.defaultReactionDefs(), page: 0, editing: null };

function reactionDisplay(key) {
  const def = state.reactionDefs.find((d) => d.id === key) || state.reactionDefs.find((d) => d.icon === key);
  return def ? { icon: def.icon, label: def.label } : { icon: key, label: key };
}

function reactionIconNode(icon, label) {
  if (ViewerModel.isImageIcon(icon)) {
    const img = document.createElement("img");
    img.src = icon;
    img.alt = label || "";
    img.style.width = "16px";
    img.style.height = "16px";
    img.style.objectFit = "contain";
    img.style.verticalAlign = "middle";
    img.style.marginRight = "4px";
    return img;
  }
  const span = document.createElement("span");
  span.textContent = icon + " ";
  return span;
}

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError || !response) reject(new Error("unavailable"));
      else if (!response.ok) reject(new Error(response.error || "error"));
      else resolve(response.data);
    });
  });
}

function setStatus(text) {
  $("status").textContent = text;
}

function contrastText(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 >= 150 ? "#111111" : "#ffffff";
}

function chip(label, color, ext) {
  const el = document.createElement("span");
  el.className = "chip" + (ext ? " ext" : "");
  el.textContent = label;
  if (color) {
    el.style.background = color;
    el.style.color = contrastText(color);
  }
  return el;
}

const displayName = (v) => v.customNickname || v.name || (v.ext && v.ext.name) || v.handle || v.channelId;

function filtered() {
  const q = $("search").value.trim().toLowerCase();
  const labels = new Map(state.tags.map((t) => [t.id, t.label.toLowerCase()]));
  let list = state.viewers;
  if (q) {
    list = list.filter((v) =>
      [
        v.customNickname,
        v.name,
        v.handle,
        v.channelId,
        ...v.notes,
        ...v.tagIds.map((id) => labels.get(id) || ""),
        ...(v.ext ? [v.ext.name, ...v.ext.aiTags, ...v.ext.tags.map((t) => t.label)] : []),
      ].some((s) => s && String(s).toLowerCase().includes(q))
    );
  }
  const sort = $("sort").value;
  const sorted = [...list];
  if (sort === "score") {
    sorted.sort(
      (a, b) =>
        ViewerModel.totalReactions(b) - ViewerModel.totalReactions(a) ||
        b.score - a.score ||
        b.updatedAt - a.updatedAt
    );
  } else if (sort === "name") {
    sorted.sort((a, b) => displayName(a).localeCompare(displayName(b)));
  } else {
    sorted.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return sorted;
}

function renderRows() {
  const list = filtered();
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages - 1);
  const slice = list.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
  const defs = new Map(state.tags.map((t) => [t.id, t]));
  const body = $("rows");
  body.replaceChildren();

  for (const v of slice) {
    const tr = document.createElement("tr");

    const who = document.createElement("td");
    const name = document.createElement("div");
    name.textContent = displayName(v);
    name.style.fontWeight = "600";
    who.appendChild(name);
    if (v.customNickname && (v.name || (v.ext && v.ext.name))) {
      const original = document.createElement("div");
      original.className = "muted";
      original.textContent = v.name || v.ext.name;
      who.appendChild(original);
    }
    const id = document.createElement("div");
    id.className = "id";
    id.textContent = [v.handle, v.channelId].filter(Boolean).join(" · ");
    who.appendChild(id);
    tr.appendChild(who);

    const tags = document.createElement("td");
    v.tagIds.forEach((tid) => {
      const def = defs.get(tid);
      if (def) tags.appendChild(chip(def.label, def.color));
    });
    if (v.ext) {
      v.ext.tags.forEach((t) => tags.appendChild(chip(t.label, t.color, true)));
      v.ext.aiTags.forEach((t) => tags.appendChild(chip(t, "", true)));
    }
    tr.appendChild(tags);

    const reactCell = document.createElement("td");
    const entries = Object.entries(v.reactions || {}).sort((a, b) => b[1] - a[1]);
    if (entries.length > 0) {
      entries.forEach(([k, cnt]) => {
        const d = reactionDisplay(k);
        const el = document.createElement("span");
        el.className = "chip";
        if (ViewerModel.isImageIcon(d.icon)) {
          el.appendChild(reactionIconNode(d.icon, d.label));
          el.appendChild(document.createTextNode(`${d.label} ${cnt}`));
        } else {
          el.textContent = d.label !== d.icon ? `${d.icon} ${d.label} ${cnt}` : `${d.label} ${cnt}`;
        }
        reactCell.appendChild(el);
      });
    } else if (v.score !== 0) {
      reactCell.textContent = v.score > 0 ? "+" + v.score : String(v.score);
    } else {
      const zero = document.createElement("span");
      zero.className = "muted";
      zero.textContent = "—";
      reactCell.appendChild(zero);
    }
    tr.appendChild(reactCell);

    const notes = document.createElement("td");
    v.notes.slice(0, 3).forEach((n) => {
      const line = document.createElement("div");
      line.textContent = "📌 " + n;
      notes.appendChild(line);
    });
    if (v.notes.length > 3) {
      const more = document.createElement("div");
      more.className = "muted";
      more.textContent = "+" + (v.notes.length - 3);
      notes.appendChild(more);
    }
    tr.appendChild(notes);

    const action = document.createElement("td");
    action.style.whiteSpace = "nowrap";
    const edit = document.createElement("button");
    edit.textContent = I18n.t("vn_edit");
    edit.addEventListener("click", () => openEditor(v));
    const del = document.createElement("button");
    del.className = "danger";
    del.style.marginLeft = "6px";
    del.textContent = I18n.t("btn_delete");
    del.addEventListener("click", async () => {
      if (!confirm(I18n.t("vnm_confirm_delete", { name: displayName(v) }))) return;
      await send({ type: "VN_REMOVE", key: v.key });
    });
    action.append(edit, del);
    tr.appendChild(action);

    body.appendChild(tr);
  }

  $("stats").textContent = I18n.t("vnm_stats", { count: state.viewers.length, shown: list.length });
  $("empty").hidden = list.length > 0;
  $("empty").textContent = I18n.t(state.viewers.length === 0 ? "vnm_empty" : "empty_search_result");
  $("pager").hidden = pages <= 1;
  $("pageInfo").textContent = `${state.page + 1} / ${pages}`;
  $("prev").disabled = state.page === 0;
  $("next").disabled = state.page >= pages - 1;
}

function renderTagDefs() {
  const box = $("tagDefs");
  box.replaceChildren();
  state.tags.forEach((def) => {
    const row = document.createElement("div");
    row.className = "tagdef";
    const label = document.createElement("input");
    label.type = "text";
    label.maxLength = ViewerModel.LIMITS.TAG_LABEL;
    label.value = def.label;
    label.setAttribute("aria-label", I18n.t("vn_tags"));
    const color = document.createElement("input");
    color.type = "color";
    color.value = def.color || "#9e9e9e";
    const commit = () => {
      const next = state.tags.map((t) =>
        t.id === def.id ? { ...t, label: label.value.trim() || def.label, color: color.value } : t
      );
      send({ type: "VN_TAGS_SET", tags: next });
    };
    label.addEventListener("change", commit);
    color.addEventListener("change", commit);
    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = I18n.t("btn_delete");
    del.addEventListener("click", () => {
      if (!confirm(I18n.t("vnm_confirm_delete_tag", { name: def.label }))) return;
      send({ type: "VN_TAGS_SET", tags: state.tags.filter((t) => t.id !== def.id) });
    });
    row.append(label, color, del);
    box.appendChild(row);
  });
  if (state.tags.length === 0) {
    const none = document.createElement("div");
    none.className = "muted";
    none.style.marginBottom = "8px";
    none.textContent = I18n.t("vnm_no_tags");
    box.appendChild(none);
  }
}

function renderReactionDefs() {
  const box = $("reactionDefs");
  box.replaceChildren();
  state.reactionDefs.forEach((def) => {
    const row = document.createElement("div");
    row.className = "tagdef";
    if (ViewerModel.isImageIcon(def.icon)) {
      const preview = reactionIconNode(def.icon, def.label);
      preview.style.width = "22px";
      preview.style.height = "22px";
      preview.style.flexShrink = "0";
      row.appendChild(preview);
    }
    const icon = document.createElement("input");
    icon.type = "text";
    icon.maxLength = ViewerModel.LIMITS.REACTION_ICON;
    icon.value = def.icon;
    icon.style.flex = "0 0 150px";
    icon.setAttribute("aria-label", I18n.t("vnm_reaction_icon_ph"));
    const label = document.createElement("input");
    label.type = "text";
    label.maxLength = ViewerModel.LIMITS.REACTION_LABEL;
    label.value = def.label;
    label.setAttribute("aria-label", I18n.t("vnm_reaction_label_ph"));
    const commit = () => {
      const nextIcon = icon.value.trim() || def.icon;
      const nextLabel = label.value.trim() || nextIcon;
      const next = state.reactionDefs.map((d) => (d.id === def.id ? { ...d, icon: nextIcon, label: nextLabel } : d));
      send({ type: "VN_REACTION_DEFS_SET", reactionDefs: next });
    };
    icon.addEventListener("change", commit);
    label.addEventListener("change", commit);
    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = I18n.t("btn_delete");
    del.addEventListener("click", () => {
      if (!confirm(I18n.t("vnm_confirm_delete_tag", { name: def.label }))) return;
      send({ type: "VN_REACTION_DEFS_SET", reactionDefs: state.reactionDefs.filter((d) => d.id !== def.id) });
    });
    row.append(icon, label, del);
    box.appendChild(row);
  });
}

function renderChannelEmotes(list) {
  const wrap = $("channelEmotesWrap");
  const box = $("channelEmotes");
  if (!wrap || !box) return;
  const emotes = Array.isArray(list) ? list.filter((e) => e && ViewerModel.isImageIcon(e.src)) : [];
  wrap.hidden = emotes.length === 0;
  box.replaceChildren();
  emotes.forEach((em) => {
    const b = document.createElement("button");
    b.type = "button";
    b.style.padding = "3px 6px";
    b.title = em.alt || em.src;
    const img = document.createElement("img");
    img.src = em.src;
    img.alt = em.alt || "";
    img.style.width = "20px";
    img.style.height = "20px";
    img.style.objectFit = "contain";
    img.style.verticalAlign = "middle";
    b.appendChild(img);
    b.addEventListener("click", () => {
      $("newReactionIcon").value = em.src;
      if (!$("newReactionLabel").value.trim() && em.alt) $("newReactionLabel").value = em.alt;
      $("newReactionLabel").focus();
    });
    box.appendChild(b);
  });
}

async function reload() {
  try {
    const data = await send({ type: "VN_LIST" });
    state.viewers = data.viewers;
    state.tags = data.tags;
    if (Array.isArray(data.reactionDefs)) state.reactionDefs = data.reactionDefs;
    renderRows();
    renderReactionDefs();
    renderTagDefs();
    chrome.storage.local.get("yt_channel_emotes", (res) => renderChannelEmotes(res.yt_channel_emotes));
  } catch (e) {
    setStatus(I18n.t("vnm_unavailable"));
  }
}

let editingReactions = {};

function renderEditorReactions() {
  const box = $("edReactions");
  box.replaceChildren();
  state.reactionDefs.forEach((def) => {
    const cnt = editingReactions[def.id] || 0;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.style.borderRadius = "999px";
    btn.style.padding = "3px 10px";
    if (cnt > 0) {
      btn.style.borderColor = "var(--accent)";
      btn.style.fontWeight = "600";
    }
    btn.title = I18n.t("vn_reactions_hint");
    if (ViewerModel.isImageIcon(def.icon)) {
      btn.appendChild(reactionIconNode(def.icon, def.label));
      btn.appendChild(document.createTextNode(cnt > 0 ? `${def.label} ${cnt}` : def.label));
    } else {
      const caption = def.label !== def.icon ? `${def.icon} ${def.label}` : def.label;
      btn.textContent = cnt > 0 ? `${caption} ${cnt}` : caption;
    }
    btn.addEventListener("click", () => {
      editingReactions[def.id] = (editingReactions[def.id] || 0) + 1;
      renderEditorReactions();
    });
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if ((editingReactions[def.id] || 0) > 1) editingReactions[def.id]--;
      else delete editingReactions[def.id];
      renderEditorReactions();
    });
    box.appendChild(btn);
  });
}

$("edReactionReset").addEventListener("click", () => {
  editingReactions = {};
  renderEditorReactions();
});

$("addReaction").addEventListener("click", async () => {
  const icon = $("newReactionIcon").value.trim();
  const label = $("newReactionLabel").value.trim() || icon;
  if (!icon) return;
  const def = { id: ViewerModel.newReactionId(state.reactionDefs), icon, label };
  await send({ type: "VN_REACTION_DEFS_SET", reactionDefs: [...state.reactionDefs, def] });
  $("newReactionIcon").value = "";
  $("newReactionLabel").value = "";
});
[$("newReactionIcon"), $("newReactionLabel")].forEach((el) =>
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("addReaction").click();
  })
);

// ---------------------------------------------------------------- 編輯
function openEditor(viewer) {
  state.editing = viewer;
  $("editorTitle").textContent = viewer ? displayName(viewer) : I18n.t("vnm_add_viewer");
  $("identityFields").hidden = !!viewer;
  $("edHandle").value = "";
  $("edNick").value = viewer ? viewer.customNickname : "";
  editingReactions = { ...(viewer && viewer.reactions ? viewer.reactions : {}) };
  renderEditorReactions();
  $("edNotes").value = viewer ? viewer.notes.join("\n") : "";
  $("edError").textContent = "";
  const active = new Set(viewer ? viewer.tagIds : []);
  const box = $("edTags");
  box.replaceChildren();
  state.tags.forEach((def) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = def.id;
    input.checked = active.has(def.id);
    label.append(input, chip(def.label, def.color));
    box.appendChild(label);
  });
  if (state.tags.length === 0) {
    const none = document.createElement("span");
    none.className = "muted";
    none.textContent = I18n.t("vnm_no_tags");
    box.appendChild(none);
  }
  $("editor").showModal();
}

$("editorForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  let identity;
  if (state.editing) {
    identity = { channelId: state.editing.channelId, handle: state.editing.handle };
  } else {
    const raw = $("edHandle").value.trim();
    const channelId = ViewerModel.normalizeChannelId(raw);
    identity = channelId ? { channelId } : { handle: ViewerModel.normalizeHandle(raw) };
    if (!identity.channelId && !identity.handle) {
      $("edError").textContent = I18n.t("vnm_identity_invalid");
      return;
    }
  }
  const patch = {
    customNickname: $("edNick").value,
    reactions: editingReactions,
    tagIds: [...$("edTags").querySelectorAll("input:checked")].map((i) => i.value),
    notes: $("edNotes").value.split("\n"),
  };
  try {
    await send({ type: "VN_PATCH", identity, patch });
    $("editor").close();
  } catch (err) {
    $("edError").textContent = I18n.t("vnm_unavailable");
  }
});
$("edCancel").addEventListener("click", () => $("editor").close());

// ---------------------------------------------------------------- 事件
$("search").addEventListener("input", () => {
  state.page = 0;
  renderRows();
});
$("sort").addEventListener("change", renderRows);
$("prev").addEventListener("click", () => {
  state.page--;
  renderRows();
});
$("next").addEventListener("click", () => {
  state.page++;
  renderRows();
});
$("addViewer").addEventListener("click", () => openEditor(null));

$("addTag").addEventListener("click", async () => {
  const label = $("newTagLabel").value.trim();
  if (!label) return;
  const def = { id: ViewerModel.newTagId(state.tags), label, color: $("newTagColor").value };
  await send({ type: "VN_TAGS_SET", tags: [...state.tags, def] });
  $("newTagLabel").value = "";
});
$("newTagLabel").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("addTag").click();
});

$("exportBtn").addEventListener("click", async () => {
  const data = await send({ type: "VN_EXPORT" });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `viewer-notes-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  setStatus(I18n.t("vnm_exported", { count: data.viewers.length }));
});

let importMode = "merge";
$("importMerge").addEventListener("click", () => {
  importMode = "merge";
  $("importFile").click();
});
$("importReplace").addEventListener("click", () => {
  if (!confirm(I18n.t("vnm_confirm_replace"))) return;
  importMode = "replace";
  $("importFile").click();
});
$("importFile").addEventListener("change", async () => {
  const file = $("importFile").files[0];
  $("importFile").value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const result = await send({ type: "VN_IMPORT", data, mode: importMode });
    setStatus(I18n.t("vnm_imported", { count: result.imported, skipped: result.skipped }));
  } catch (err) {
    setStatus(I18n.t("vnm_import_failed"));
  }
});

$("clearBtn").addEventListener("click", async () => {
  if (!confirm(I18n.t("vnm_confirm_clear"))) return;
  await send({ type: "VN_CLEAR" });
  setStatus(I18n.t("vnm_cleared"));
});

$("enabled").addEventListener("change", () => {
  chrome.storage.local.get(SETTINGS_KEY, (res) => {
    chrome.storage.local.set({ [SETTINGS_KEY]: { ...(res[SETTINGS_KEY] || {}), enabled: $("enabled").checked } });
  });
});
$("openCache").addEventListener("click", () => {
  location.href = chrome.runtime.getURL("pages/manager/manager.html");
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[REV_KEY]) reload();
});

(async function init() {
  await I18n.init();
  I18n.render();
  document.documentElement.lang = I18n.currentLang;
  chrome.storage.local.get(SETTINGS_KEY, (res) => {
    $("enabled").checked = !(res[SETTINGS_KEY] && res[SETTINGS_KEY].enabled === false);
  });
  // 擴充功能另有選項頁時 (附加模組)，提供入口
  const options = chrome.runtime.getManifest().options_page || "";
  if (options && !options.endsWith("pages/viewers/viewers.html")) {
    $("openOptions").hidden = false;
    $("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
  }
  reload();
})();
