// ===========================================================
// Manager.js - 觀眾資料頁 (純 DOM 安全渲染)
// 用途：把頻道名稱快取與自訂暱稱 / 備註合成一份以人為單位的清單：
//       可搜尋 (名稱 / @handle / 頻道 ID / 暱稱 / 備註)、每列直接編輯暱稱與備註、手動新增一位觀眾。
//       快取只是名稱來源；兩種資料仍分開儲存，備份檔格式不變。
// ===========================================================

const els = {
  stats: document.getElementById("statsText"),
  themeSelect: document.getElementById("themeSelect"),

  listBody: document.getElementById("listBody"),
  emptyState: document.getElementById("emptyState"),
  tableWrapper: document.getElementById("tableWrapper"),
  search: document.getElementById("searchInput"),
  filter: document.getElementById("filterSelect"),
  addBtn: document.getElementById("addBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  pagination: document.getElementById("paginationControl"),
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  pageInfo: document.getElementById("pageInfo"),
  sortHeaders: document.querySelectorAll("th.sortable"),
  selectAll: document.getElementById("selectAll"),
  batchActions: document.getElementById("batchActions"),
  batchDeleteBtn: document.getElementById("batchDeleteBtn"),
  batchExpireBtn: document.getElementById("batchExpireBtn"),

  // 名稱快取清除
  clearBtn: document.getElementById("clearBtn"),

  // 暱稱與備註備份
  notesExportBtn: document.getElementById("notesExportBtn"),
  notesImportBtn: document.getElementById("notesImportBtn"),
  notesImportFile: document.getElementById("notesImportFile"),
  notesClearBtn: document.getElementById("notesClearBtn"),

  // 編輯 / 新增視窗
  noteEditModal: document.getElementById("noteEditModal"),
  editModalTitle: document.getElementById("editModalTitle"),
  editNoteIdentity: document.getElementById("editNoteIdentity"),
  addIdentityBox: document.getElementById("addIdentityBox"),
  addIdentityInput: document.getElementById("addIdentityInput"),
  addIdentityHint: document.getElementById("addIdentityHint"),
  editNickInput: document.getElementById("editNickInput"),
  editNickSaveBtn: document.getElementById("editNickSaveBtn"),
  editNoteInput: document.getElementById("editNoteInput"),
  editNoteAddBtn: document.getElementById("editNoteAddBtn"),
  editNotesList: document.getElementById("editNotesList"),
  editNoteDeleteBtn: document.getElementById("editNoteDeleteBtn"),
  editNoteCloseBtn: document.getElementById("editNoteCloseBtn"),
};

const ITEMS_PER_PAGE = 20;
let cacheList = [];
let noteRecords = [];
let rows = [];
let currentPage = 1;
let sortConfig = { key: "recent", direction: "desc" };
let pendingImportData = null;

// 編輯中的對象：{ identity: { channelId, handle }, record, label }；新增模式下 identity 可能為 null
let editing = null;
let addMode = false;

function sendMsg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError || !res) resolve(null);
      else resolve(res);
    });
  });
}

function appendHighlighted(parent, text, term) {
  const str = String(text ?? "");
  if (!term) {
    parent.textContent = str;
    return;
  }
  const lower = str.toLowerCase();
  const needle = term.toLowerCase();
  let idx = 0;
  while (idx < str.length) {
    const hit = lower.indexOf(needle, idx);
    if (hit === -1) {
      parent.appendChild(document.createTextNode(str.slice(idx)));
      break;
    }
    if (hit > idx) parent.appendChild(document.createTextNode(str.slice(idx, hit)));
    const span = document.createElement("span");
    span.className = "highlight";
    span.textContent = str.slice(hit, hit + needle.length);
    parent.appendChild(span);
    idx = hit + needle.length;
  }
}


// ==================== 載入與清單 ====================

async function loadAll() {
  const [list, res] = await Promise.all([DataManager.getAllList(), sendMsg({ type: "NOTES_LIST" })]);
  cacheList = list || [];
  noteRecords = res && Array.isArray(res.records) ? res.records : [];
  rows = PeopleList.buildRows(cacheList, noteRecords);
  els.stats.textContent = I18n.t("people_stats", {
    count: rows.length,
    cache: cacheList.length,
    notes: noteRecords.length,
  });
  renderList();
}

function labelOf(row) {
  return row.name || row.handle || row.channelId || "";
}

function renderList() {
  const term = els.search.value.trim();
  const termLower = term.toLowerCase();
  els.selectAll.checked = false;
  els.batchActions.style.display = "none";

  const filtered = PeopleList.sortRows(
    PeopleList.filterRows(rows, term, els.filter.value),
    sortConfig.key,
    sortConfig.direction
  );

  const totalItems = filtered.length;
  const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE) || 1;
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;
  const pageItems = filtered.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

  if (totalItems === 0) {
    els.tableWrapper.style.display = "none";
    els.emptyState.style.display = "flex";
    els.emptyState.textContent = term || els.filter.value !== "all" ? I18n.t("empty_search_result") : I18n.t("people_empty");
    els.pagination.style.display = "none";
    updateSortUI();
    return;
  }
  els.tableWrapper.style.display = "block";
  els.emptyState.style.display = "none";

  const fragment = document.createDocumentFragment();
  for (const row of pageItems) {
    const tr = document.createElement("tr");
    tr.dataset.rowKey = row.rowKey;

    const tdCheck = document.createElement("td");
    tdCheck.className = "col-check";
    if (row.inCache) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "row-check";
      cb.value = String(row.cacheId);
      cb.onchange = updateBatchState;
      tdCheck.appendChild(cb);
    }

    const tdPerson = document.createElement("td");
    tdPerson.className = "col-person";
    const nameDiv = document.createElement("div");
    nameDiv.className = "person-name";
    if (row.name) appendHighlighted(nameDiv, row.name, termLower);
    else {
      nameDiv.classList.add("muted");
      nameDiv.textContent = I18n.t("people_name_unknown");
    }
    tdPerson.appendChild(nameDiv);
    for (const idText of [row.handle, row.channelId]) {
      if (!idText) continue;
      const idDiv = document.createElement("div");
      idDiv.className = "person-id";
      appendHighlighted(idDiv, idText, termLower);
      tdPerson.appendChild(idDiv);
    }

    const note = row.note;
    const tdNick = document.createElement("td");
    tdNick.className = "col-nick editable";
    tdNick.title = I18n.t("notes_edit");
    if (note && note.customNickname) appendHighlighted(tdNick, note.customNickname, termLower);
    else {
      tdNick.textContent = "-";
      tdNick.classList.add("muted");
    }
    tdNick.onclick = () => openEditModal(row);

    const tdNotes = document.createElement("td");
    tdNotes.className = "col-notes editable";
    tdNotes.title = I18n.t("notes_edit");
    const notes = note && Array.isArray(note.notes) ? note.notes : [];
    if (notes.length === 0) {
      const dash = document.createElement("span");
      dash.textContent = "-";
      dash.className = "muted";
      tdNotes.appendChild(dash);
    } else {
      for (const n of notes) {
        const pill = document.createElement("span");
        pill.className = "note-pill";
        appendHighlighted(pill, n, termLower);
        tdNotes.appendChild(pill);
      }
    }
    tdNotes.onclick = () => openEditModal(row);

    const tdSubs = document.createElement("td");
    tdSubs.className = "col-subs";
    tdSubs.textContent = row.subs > 0 ? new Intl.NumberFormat().format(row.subs) : "-";

    const tdStatus = document.createElement("td");
    tdStatus.className = "col-time";
    tdStatus.appendChild(statusNode(row));

    const tdAction = document.createElement("td");
    tdAction.className = "col-action";
    const editBtn = document.createElement("button");
    editBtn.className = "btn btn-sm btn-io edit-btn";
    editBtn.textContent = I18n.t("notes_edit");
    editBtn.onclick = () => openEditModal(row);
    tdAction.appendChild(editBtn);
    const refetchTarget = row.handle || (row.cacheId && row.cacheId.startsWith("@") ? row.cacheId : "");
    if (refetchTarget) {
      const refetchBtn = document.createElement("button");
      refetchBtn.className = "btn btn-sm refetch-btn";
      refetchBtn.textContent = "↻";
      refetchBtn.title = I18n.t("scraper_lab") || "重新抓取頻道名稱";
      refetchBtn.onclick = () => refetchHandle(refetchTarget, refetchBtn);
      tdAction.appendChild(refetchBtn);
    }
    if (row.inCache) {
      if (!row.isExpired) {
        const expBtn = document.createElement("button");
        expBtn.className = "btn btn-sm btn-warning expire-btn";
        expBtn.textContent = I18n.t("btn_expire");
        expBtn.title = I18n.t("people_expire_title");
        expBtn.onclick = () => expireItem(row.cacheId);
        tdAction.appendChild(expBtn);
      }
      const delBtn = document.createElement("button");
      delBtn.className = "btn btn-sm btn-danger del-btn";
      delBtn.textContent = I18n.t("people_delete_cache");
      delBtn.title = I18n.t("people_delete_cache_title");
      delBtn.onclick = () => deleteItem(row.cacheId);
      tdAction.appendChild(delBtn);
    }

    tr.append(tdCheck, tdPerson, tdNick, tdNotes, tdSubs, tdStatus, tdAction);
    fragment.appendChild(tr);
  }

  els.listBody.replaceChildren(fragment);
  updatePaginationUI(totalPages, totalItems);
  updateSortUI();
}

function statusNode(row) {
  if (!row.inCache) {
    const span = document.createElement("span");
    span.className = "muted";
    span.textContent = I18n.t("people_not_cached");
    return span;
  }
  if (row.isExpired) {
    const wrap = document.createElement("div");
    const tag = document.createElement("span");
    tag.className = "expired-tag";
    tag.textContent = I18n.t("status_expired");
    const hint = document.createElement("div");
    hint.style.fontSize = "11px";
    hint.style.marginTop = "2px";
    if (row.daysUntilDelete <= 0) {
      hint.style.color = "#d32f2f";
      hint.textContent = I18n.t("status_deleting");
    } else {
      hint.style.color = "#888";
      hint.textContent = `(${row.daysUntilDelete} ${I18n.t("status_days_left")})`;
    }
    wrap.append(tag, hint);
    return wrap;
  }
  const badge = document.createElement("span");
  badge.style.color = "#2e7d32";
  badge.style.background = "#e8f5e9";
  badge.style.padding = "2px 6px";
  badge.style.borderRadius = "4px";
  badge.style.fontSize = "12px";
  badge.textContent = I18n.t("status_valid");
  return badge;
}

// ==================== 名稱快取操作 ====================

async function deleteItem(id) {
  await DataManager.deleteItems(id);
  loadAll();
}
async function expireItem(id) {
  await DataManager.expireItems(id);
  loadAll();
}
async function batchDelete() {
  const ids = getCheckedIds();
  if (ids.length === 0) return;
  if (confirm(I18n.t("confirm_delete_batch", { count: ids.length }))) {
    await DataManager.deleteItems(ids);
    loadAll();
  }
}
async function batchExpire() {
  const ids = getCheckedIds();
  if (ids.length > 0) {
    await DataManager.expireItems(ids);
    loadAll();
  }
}
async function clearAllData() {
  if (confirm(I18n.t("confirm_clear_all"))) {
    await DataManager.clearAll();
    loadAll();
  }
}
function getCheckedIds() {
  return Array.from(document.querySelectorAll(".row-check:checked")).map((cb) => cb.value);
}
function updateBatchState() {
  const count = document.querySelectorAll(".row-check:checked").length;
  els.batchActions.style.display = count > 0 ? "inline-flex" : "none";
  if (count > 0) {
    els.batchDeleteBtn.textContent = `${I18n.t("batch_delete")} (${count})`;
    els.batchExpireBtn.textContent = `${I18n.t("batch_expire")} (${count})`;
    els.batchDeleteBtn.style.padding = "5px 10px";
    els.batchExpireBtn.style.padding = "5px 10px";
  }
}
function handleSort(key) {
  if (sortConfig.key === key) {
    sortConfig.direction = sortConfig.direction === "asc" ? "desc" : "asc";
  } else {
    sortConfig.key = key;
    sortConfig.direction = key === "subs" || key === "recent" ? "desc" : "asc";
  }
  renderList();
}
function updateSortUI() {
  els.sortHeaders.forEach((th) => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.sort === sortConfig.key) th.classList.add(`sort-${sortConfig.direction}`);
  });
}
function updatePaginationUI(totalPages, totalItems) {
  if (totalItems <= ITEMS_PER_PAGE) {
    els.pagination.style.display = "none";
    return;
  }
  els.pagination.style.display = "flex";
  els.pageInfo.textContent = `${currentPage} / ${totalPages}`;
  els.prevBtn.disabled = currentPage === 1;
  els.nextBtn.disabled = currentPage === totalPages;
}

// ==================== 編輯 / 新增視窗 ====================

function openEditModal(row) {
  addMode = false;
  const identity = { channelId: row.channelId || null, handle: row.handle || null };
  editing = {
    identity,
    record: row.note ? { ...row.note, notes: (row.note.notes || []).slice() } : null,
    label: labelOf(row),
  };
  showEditModal();
}

function openAddModal() {
  addMode = true;
  editing = { identity: null, record: null, label: "" };
  els.addIdentityInput.value = "";
  els.addIdentityHint.textContent = "";
  showEditModal();
  els.addIdentityInput.focus();
}

function showEditModal() {
  els.editModalTitle.textContent = I18n.t(addMode ? "people_add_title" : "notes_edit_title");
  els.addIdentityBox.style.display = addMode ? "block" : "none";
  refreshEditHeader();
  els.editNickInput.value = (editing.record && editing.record.customNickname) || "";
  els.editNoteInput.value = "";
  renderEditModalNotes();
  els.noteEditModal.classList.add("active");
  if (!addMode) els.editNickInput.focus();
}

function refreshEditHeader() {
  // 頻道名稱一行，@handle 與頻道 ID 各自一行
  const box = els.editNoteIdentity;
  box.replaceChildren();
  const identity = editing && editing.identity;
  const ids = identity ? [identity.handle, identity.channelId].filter(Boolean) : [];
  if (editing && editing.label && !ids.includes(editing.label)) {
    const nameDiv = document.createElement("div");
    nameDiv.className = "edit-identity-name";
    nameDiv.textContent = editing.label;
    box.appendChild(nameDiv);
  }
  for (const id of ids) {
    const idDiv = document.createElement("div");
    idDiv.className = "edit-identity-id";
    idDiv.textContent = id;
    box.appendChild(idDiv);
  }
  els.editNoteDeleteBtn.style.display = editing && editing.record ? "" : "none";
}

/** 新增模式：解析輸入的身分，對到既有的人就帶入他的暱稱與備註。 */
function onAddIdentityInput() {
  const identity = PeopleList.parseIdentityInput(els.addIdentityInput.value);
  if (!identity) {
    editing.identity = null;
    editing.record = null;
    editing.label = "";
    els.addIdentityHint.textContent = els.addIdentityInput.value.trim() ? I18n.t("people_add_invalid") : "";
    refreshEditHeader();
    renderEditModalNotes();
    return;
  }
  const hit = PeopleList.findRow(rows, identity);
  editing.identity = {
    channelId: identity.channelId || (hit && hit.channelId) || null,
    handle: identity.handle || (hit && hit.handle) || null,
  };
  editing.record = hit && hit.note ? { ...hit.note, notes: (hit.note.notes || []).slice() } : null;
  editing.label = hit ? labelOf(hit) : "";
  els.addIdentityHint.textContent = hit
    ? I18n.t("people_add_found", { name: labelOf(hit) })
    : I18n.t("people_add_new");
  els.editNickInput.value = (editing.record && editing.record.customNickname) || "";
  refreshEditHeader();
  renderEditModalNotes();
}

function requireIdentity() {
  if (editing && editing.identity) return editing.identity;
  els.addIdentityHint.textContent = I18n.t("people_add_invalid");
  els.addIdentityInput.focus();
  return null;
}

async function saveNotesPatch(patch) {
  const identity = requireIdentity();
  if (!identity) return null;
  const out = await sendMsg({ type: "NOTES_SAVE", identity, patch });
  if (!out) {
    alert(I18n.t("people_save_failed"));
    return null;
  }
  editing.record = out.record || null;
  if (out.record) {
    editing.identity = { channelId: out.record.channelId || null, handle: out.record.handle || null };
  }
  refreshEditHeader();
  loadAll();
  return out;
}

function renderEditModalNotes() {
  els.editNotesList.replaceChildren();
  const notes = editing && editing.record && Array.isArray(editing.record.notes) ? editing.record.notes : [];
  if (notes.length === 0) {
    const li = document.createElement("li");
    li.style.opacity = "0.6";
    li.textContent = I18n.t("local_notes_empty");
    els.editNotesList.appendChild(li);
    return;
  }
  for (const n of notes) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = n;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "edit-note-del";
    del.textContent = "×";
    del.onclick = async () => {
      await saveNotesPatch({ removeNote: n });
      renderEditModalNotes();
    };
    li.append(span, del);
    els.editNotesList.appendChild(li);
  }
}

async function saveEditedNick() {
  await saveNotesPatch({ customNickname: els.editNickInput.value });
}

async function addEditedNote() {
  const text = els.editNoteInput.value.trim();
  if (!text) return;
  const out = await saveNotesPatch({ addNote: text });
  if (out) els.editNoteInput.value = "";
  renderEditModalNotes();
}

async function deleteEditedNotes() {
  if (!editing || !editing.record) return;
  if (!confirm(I18n.t("notes_confirm_delete"))) return;
  await sendMsg({ type: "NOTES_DELETE", key: editing.record.key });
  editing.record = null;
  els.editNickInput.value = "";
  refreshEditHeader();
  renderEditModalNotes();
  loadAll();
}

function closeEditModal() {
  els.noteEditModal.classList.remove("active");
  editing = null;
  addMode = false;
}

// ==================== 單列強制重新抓取 ====================

async function refetchHandle(handle, btn) {
  if (!handle) return;
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const res = await sendMsg({ type: "FETCH_CHANNEL_INFO", handle, refresh: true });
    if (res && res.success) {
      await loadAll();
    } else {
      const err = (res && res.error) || "Unknown";
      alert(`${I18n.t("status_fail") || "抓取失敗"}: ${err}`);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

// ==================== 備份：自訂暱稱與備註 (格式不變) ====================

async function handleNotesExport() {
  const res = await sendMsg({ type: "NOTES_LIST" });
  const records = (res && Array.isArray(res.records) ? res.records : []);
  const payload = {
    meta: {
      type: "yt_viewer_local_notes",
      version: chrome.runtime.getManifest().version,
      generatedAt: Date.now(),
    },
    records,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `yt_notes_backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function handleNotesImportFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const json = JSON.parse(e.target.result);
      const records = Array.isArray(json) ? json : Array.isArray(json.records) ? json.records : null;
      if (!records) throw new Error("invalid");
      const out = await sendMsg({ type: "NOTES_IMPORT", records });
      if (!out || out.error) throw new Error("store");
      alert(I18n.t("notes_import_success", { count: (out && out.count) || 0 }));
      loadAll();
    } catch {
      alert(I18n.t("import_fail") + I18n.t("import_format_error"));
    } finally {
      els.notesImportFile.value = "";
    }
  };
  reader.readAsText(file);
}

// ==================== EVENTS ====================

if (els.themeSelect && window.ThemeManager) {
  els.themeSelect.onchange = (e) => window.ThemeManager.setMode(e.target.value);
}

els.sortHeaders.forEach((th) => (th.onclick = () => handleSort(th.dataset.sort)));
els.selectAll.onchange = (e) => {
  document.querySelectorAll(".row-check").forEach((cb) => (cb.checked = e.target.checked));
  updateBatchState();
};
els.batchDeleteBtn.onclick = batchDelete;
els.batchExpireBtn.onclick = batchExpire;
els.clearBtn.onclick = clearAllData;
els.refreshBtn.onclick = loadAll;
els.addBtn.onclick = openAddModal;

let searchTimeout;
els.search.oninput = () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    currentPage = 1;
    renderList();
  }, 250);
};
els.filter.onchange = () => {
  currentPage = 1;
  renderList();
};
els.prevBtn.onclick = () => {
  if (currentPage > 1) {
    currentPage--;
    renderList();
  }
};
els.nextBtn.onclick = () => {
  currentPage++;
  renderList();
};

els.notesExportBtn.onclick = handleNotesExport;
els.notesImportBtn.onclick = () => els.notesImportFile.click();
els.notesImportFile.onchange = handleNotesImportFile;
els.notesClearBtn.onclick = async () => {
  if (!confirm(I18n.t("notes_confirm_clear"))) return;
  await sendMsg({ type: "NOTES_CLEAR" });
  loadAll();
};

let identityTimeout;
els.addIdentityInput.oninput = () => {
  clearTimeout(identityTimeout);
  identityTimeout = setTimeout(onAddIdentityInput, 150);
};
els.addIdentityInput.onkeydown = (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(identityTimeout);
    onAddIdentityInput();
    if (editing && editing.identity) els.editNickInput.focus();
  }
};
els.editNickSaveBtn.onclick = saveEditedNick;
els.editNickInput.onkeydown = (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveEditedNick();
  }
};
els.editNoteAddBtn.onclick = addEditedNote;
els.editNoteInput.onkeydown = (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addEditedNote();
  }
};
els.editNoteDeleteBtn.onclick = deleteEditedNotes;
els.editNoteCloseBtn.onclick = closeEditModal;
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && els.noteEditModal.classList.contains("active")) closeEditModal();
});

function isBusy() {
  return (
    els.modal.classList.contains("active") ||
    els.noteEditModal.classList.contains("active") ||
    document.querySelectorAll(".row-check:checked").length > 0
  );
}

// 名稱快取由背景持續寫入，定期重新整理 (編輯中或有勾選時不動)
setInterval(() => {
  if (document.hidden || isBusy()) return;
  loadAll();
}, 15000);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !isBusy()) loadAll();
});

// 聊天室裡改了暱稱或備註時，這頁跟著更新
if (chrome.storage && chrome.storage.onChanged) {
  const revKey = (window.AppConfig && window.AppConfig.NOTES_REV_KEY) || "sm_viewer_notes_rev";
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[revKey] && !isBusy()) loadAll();
  });
}

(async () => {
  await I18n.init();
  I18n.render();
  if (window.ThemeManager) {
    const mode = await window.ThemeManager.init();
    if (els.themeSelect) els.themeSelect.value = mode;
    window.ThemeManager.onChange((_resolved, nextMode) => {
      if (els.themeSelect && els.themeSelect.value !== nextMode) {
        els.themeSelect.value = nextMode;
      }
    });
  }
  // 聊天室編輯視窗的「在觀眾資料頁查看」會帶 ?q=
  const q = new URLSearchParams(location.search).get("q");
  if (q) els.search.value = q;
  await loadAll();
})();
