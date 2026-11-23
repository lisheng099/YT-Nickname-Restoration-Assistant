// ===========================================================
// Manager.js - 快取管理與自訂暱稱/備註維護 UI 邏輯 (純 DOM 安全渲染)
// ===========================================================

const els = {
  stats: document.getElementById("statsText"),
  themeSelect: document.getElementById("themeSelect"),
  tabCacheBtn: document.getElementById("tabCacheBtn"),
  tabNotesBtn: document.getElementById("tabNotesBtn"),
  cacheCard: document.getElementById("cacheCard"),
  notesCard: document.getElementById("notesCard"),

  // Cache tab
  listBody: document.getElementById("listBody"),
  emptyState: document.getElementById("emptyState"),
  tableWrapper: document.getElementById("tableWrapper"),
  clearBtn: document.getElementById("clearBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  search: document.getElementById("searchInput"),
  pagination: document.getElementById("paginationControl"),
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  pageInfo: document.getElementById("pageInfo"),
  sortHeaders: document.querySelectorAll("th.sortable"),
  selectAll: document.getElementById("selectAll"),
  batchActions: document.getElementById("batchActions"),
  batchDeleteBtn: document.getElementById("batchDeleteBtn"),
  batchExpireBtn: document.getElementById("batchExpireBtn"),
  exportBtn: document.getElementById("exportBtn"),
  importBtn: document.getElementById("importBtn"),
  importFile: document.getElementById("importFile"),
  modal: document.getElementById("importModal"),
  importCount: document.getElementById("importCount"),
  btnTrust: document.getElementById("btnTrust"),
  btnSafe: document.getElementById("btnSafe"),
  btnCancel: document.getElementById("btnCancel"),

  // Notes tab
  notesSearch: document.getElementById("notesSearchInput"),
  notesExportBtn: document.getElementById("notesExportBtn"),
  notesImportBtn: document.getElementById("notesImportBtn"),
  notesImportFile: document.getElementById("notesImportFile"),
  notesRefreshBtn: document.getElementById("notesRefreshBtn"),
  notesClearBtn: document.getElementById("notesClearBtn"),
  notesTableWrapper: document.getElementById("notesTableWrapper"),
  notesListBody: document.getElementById("notesListBody"),
  notesEmptyState: document.getElementById("notesEmptyState"),

  // Note edit modal
  noteEditModal: document.getElementById("noteEditModal"),
  editNoteIdentity: document.getElementById("editNoteIdentity"),
  editNickInput: document.getElementById("editNickInput"),
  editNickSaveBtn: document.getElementById("editNickSaveBtn"),
  editNoteInput: document.getElementById("editNoteInput"),
  editNoteAddBtn: document.getElementById("editNoteAddBtn"),
  editNotesList: document.getElementById("editNotesList"),
  editNoteCloseBtn: document.getElementById("editNoteCloseBtn"),
};

let activeTab = "cache";
let allData = [];
let currentPage = 1;
const ITEMS_PER_PAGE = 15;
let sortConfig = { key: "id", direction: "asc" };
let pendingImportData = null;

let allNotes = [];
let editingRecord = null;

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

function switchTab(tab) {
  activeTab = tab;
  const isCache = tab === "cache";
  els.tabCacheBtn.classList.toggle("active", isCache);
  els.tabNotesBtn.classList.toggle("active", !isCache);
  els.cacheCard.style.display = isCache ? "flex" : "none";
  els.notesCard.style.display = isCache ? "none" : "flex";
  if (isCache) {
    loadData();
  } else {
    loadNotes();
  }
}

// ==================== TAB 1: CHANNEL CACHE ====================

async function loadData() {
  allData = await DataManager.getAllList();
  if (activeTab === "cache") {
    els.stats.textContent = I18n.t("manager_stats_calculating", { count: allData.length });
  }
  renderData();

  setTimeout(() => {
    if (activeTab !== "cache") return;
    if (!allData || allData.length === 0) {
      els.stats.textContent = I18n.t("manager_stats_zero");
      return;
    }
    try {
      const jsonSize = new Blob([JSON.stringify(allData)]).size;
      els.stats.textContent = I18n.t("manager_stats_done", {
        count: allData.length,
        size: formatBytes(jsonSize),
      });
    } catch {
      els.stats.textContent = I18n.t("manager_stats_basic", { count: allData.length });
    }
  }, 200);
}

function renderData() {
  const searchTerm = els.search.value.trim().toLowerCase();

  els.selectAll.checked = false;
  els.batchActions.style.display = "none";

  let filteredData = allData;
  if (searchTerm) {
    filteredData = allData.filter(
      (item) =>
        item.id.toLowerCase().includes(searchTerm) ||
        item.name.toLowerCase().includes(searchTerm)
    );
  }

  filteredData.sort((a, b) => {
    const valA = a[sortConfig.key];
    const valB = b[sortConfig.key];
    const comp = typeof valA === "string" ? valA.localeCompare(valB) : valA - valB;
    return sortConfig.direction === "asc" ? comp : -comp;
  });

  const totalItems = filteredData.length;
  const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE) || 1;
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;

  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const pageItems = filteredData.slice(startIndex, startIndex + ITEMS_PER_PAGE);

  if (totalItems === 0) {
    els.tableWrapper.style.display = "none";
    els.emptyState.style.display = "flex";
    els.emptyState.textContent = searchTerm
      ? I18n.t("empty_search_result")
      : I18n.t("empty_no_data");
    els.pagination.style.display = "none";
    return;
  }
  els.tableWrapper.style.display = "block";
  els.emptyState.style.display = "none";

  const fragment = document.createDocumentFragment();

  pageItems.forEach((item) => {
    const tr = document.createElement("tr");

    const tdCheck = document.createElement("td");
    tdCheck.className = "col-check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "row-check";
    cb.value = String(item.id ?? "");
    tdCheck.appendChild(cb);

    const tdId = document.createElement("td");
    tdId.className = "col-id";
    tdId.title = String(item.id ?? "");
    appendHighlighted(tdId, item.id, searchTerm);

    const tdName = document.createElement("td");
    tdName.className = "col-name";
    tdName.title = String(item.name ?? "");
    appendHighlighted(tdName, item.name, searchTerm);

    const tdSubs = document.createElement("td");
    tdSubs.className = "col-subs";
    tdSubs.textContent = item.subs > 0 ? new Intl.NumberFormat().format(item.subs) : "-";

    const tdTime = document.createElement("td");
    tdTime.className = "col-time";
    if (item.isExpired) {
      const tag = document.createElement("span");
      tag.className = "expired-tag";
      tag.textContent = I18n.t("status_expired");
      tdTime.appendChild(tag);

      const hint = document.createElement("div");
      hint.style.fontSize = "11px";
      hint.style.marginTop = "2px";
      if (item.daysUntilDelete <= 0) {
        hint.style.color = "#d32f2f";
        hint.textContent = I18n.t("status_deleting");
      } else {
        hint.style.color = "#888";
        hint.textContent = `(${item.daysUntilDelete} ${I18n.t("status_days_left")})`;
      }
      tdTime.appendChild(hint);
    } else {
      const badge = document.createElement("span");
      badge.style.color = "#2e7d32";
      badge.style.background = "#e8f5e9";
      badge.style.padding = "2px 6px";
      badge.style.borderRadius = "4px";
      badge.style.fontSize = "12px";
      badge.textContent = I18n.t("status_valid");
      tdTime.appendChild(badge);
    }

    const tdAction = document.createElement("td");
    tdAction.className = "col-action";
    if (!item.isExpired) {
      const expBtn = document.createElement("button");
      expBtn.className = "btn btn-sm btn-warning expire-btn";
      expBtn.dataset.id = String(item.id ?? "");
      expBtn.textContent = I18n.t("btn_expire");
      tdAction.appendChild(expBtn);
      tdAction.appendChild(document.createTextNode(" "));
    }
    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-sm btn-danger del-btn";
    delBtn.dataset.id = String(item.id ?? "");
    delBtn.textContent = I18n.t("btn_delete");
    tdAction.appendChild(delBtn);

    tr.append(tdCheck, tdId, tdName, tdSubs, tdTime, tdAction);
    fragment.appendChild(tr);
  });

  els.listBody.replaceChildren(fragment);
  bindRowEvents();
  updatePaginationUI(totalPages, totalItems);
  updateSortUI();
}

async function handleExport() {
  const backup = await DataManager.generateBackup();
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `yt_names_backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function handleImportFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const json = JSON.parse(e.target.result);
      let dataToImport = json;
      if (json.meta && json.data) {
        const isValid = await DataManager.verifyChecksum(json);
        if (!isValid && !confirm(I18n.t("import_checksum_fail_confirm"))) {
          els.importFile.value = "";
          return;
        }
        dataToImport = json.data;
      }
      let count = 0;
      for (const val of Object.values(dataToImport)) {
        if (val && (val.name || typeof val === "string")) count++;
      }
      if (count === 0) throw new Error(I18n.t("import_invalid_data"));
      pendingImportData = dataToImport;
      els.importCount.textContent = String(count);
      els.modal.classList.add("active");
    } catch {
      alert(I18n.t("import_fail") + I18n.t("import_format_error"));
      els.importFile.value = "";
    }
  };
  reader.readAsText(file);
}

async function finalizeImport(isTrusted) {
  if (!pendingImportData) return;

  const processingBtn = isTrusted ? els.btnTrust : els.btnSafe;
  const originalNodes = Array.from(processingBtn.childNodes).map((n) => n.cloneNode(true));

  els.btnTrust.disabled = true;
  els.btnSafe.disabled = true;
  els.btnCancel.disabled = true;

  processingBtn.textContent = I18n.t("importing");
  processingBtn.style.opacity = "0.7";

  try {
    await new Promise((r) => requestAnimationFrame(r));
    const count = await DataManager.importData(pendingImportData, isTrusted);
    els.modal.classList.remove("active");

    setTimeout(() => {
      alert(I18n.t("import_success", { count }));
      loadData();
    }, 50);
  } catch (err) {
    console.error(err);
    alert(I18n.t("import_fail") + err.message);
  } finally {
    els.importFile.value = "";
    pendingImportData = null;

    els.btnTrust.disabled = false;
    els.btnSafe.disabled = false;
    els.btnCancel.disabled = false;
    processingBtn.replaceChildren(...originalNodes);
    processingBtn.style.opacity = "1";
    els.modal.classList.remove("active");
  }
}

async function deleteItem(id) {
  await DataManager.deleteItems(id);
  loadData();
}
async function expireItem(id) {
  await DataManager.expireItems(id);
  loadData();
}
async function batchDelete() {
  const ids = getCheckedIds();
  if (ids.length === 0) return;
  if (confirm(I18n.t("confirm_delete_batch", { count: ids.length }))) {
    await DataManager.deleteItems(ids);
    loadData();
  }
}
async function batchExpire() {
  const ids = getCheckedIds();
  if (ids.length > 0) {
    await DataManager.expireItems(ids);
    loadData();
  }
}
async function clearAllData() {
  if (confirm(I18n.t("confirm_clear_all"))) {
    await DataManager.clearAll();
    loadData();
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
    sortConfig.direction = key === "subs" || key === "ts" ? "desc" : "asc";
  }
  renderData();
  updateSortUI();
}
function updateSortUI() {
  els.sortHeaders.forEach((th) => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.sort === sortConfig.key) {
      th.classList.add(`sort-${sortConfig.direction}`);
    }
  });
}
function bindRowEvents() {
  document.querySelectorAll(".del-btn").forEach((b) => (b.onclick = (e) => deleteItem(e.target.dataset.id)));
  document.querySelectorAll(".expire-btn").forEach((b) => (b.onclick = (e) => expireItem(e.target.dataset.id)));
  document.querySelectorAll(".row-check").forEach((cb) => (cb.onchange = updateBatchState));
}
function updatePaginationUI(totalPages, totalItems) {
  if (totalItems <= ITEMS_PER_PAGE && els.search.value === "") {
    els.pagination.style.display = "none";
    return;
  }
  els.pagination.style.display = "flex";
  els.pageInfo.textContent = `${currentPage} / ${totalPages}`;
  els.prevBtn.disabled = currentPage === 1;
  els.nextBtn.disabled = currentPage === totalPages;
}

// ==================== TAB 2: CUSTOM NICKNAMES & NOTES ====================

async function loadNotes() {
  const res = await sendMsg({ type: "NOTES_LIST" });
  allNotes = (res && Array.isArray(res.records) ? res.records : []);
  if (activeTab === "notes") {
    els.stats.textContent = I18n.t("notes_stats", { count: allNotes.length });
  }
  renderNotes();
}

function renderNotes() {
  const term = els.notesSearch.value.trim().toLowerCase();
  let filtered = allNotes;
  if (term) {
    filtered = allNotes.filter((r) => {
      const idStr = `${r.key || ""} ${r.handle || ""} ${r.channelId || ""}`.toLowerCase();
      const nickStr = (r.customNickname || "").toLowerCase();
      const notesStr = (Array.isArray(r.notes) ? r.notes.join(" ") : "").toLowerCase();
      return idStr.includes(term) || nickStr.includes(term) || notesStr.includes(term);
    });
  }

  if (filtered.length === 0) {
    els.notesTableWrapper.style.display = "none";
    els.notesEmptyState.style.display = "flex";
    els.notesEmptyState.textContent = term ? I18n.t("empty_search_result") : I18n.t("notes_empty");
    return;
  }
  els.notesTableWrapper.style.display = "block";
  els.notesEmptyState.style.display = "none";

  const fragment = document.createDocumentFragment();
  for (const rec of filtered) {
    const tr = document.createElement("tr");

    const tdId = document.createElement("td");
    tdId.className = "col-id";
    const primaryLabel = rec.handle || rec.key;
    appendHighlighted(tdId, primaryLabel, term);
    if (rec.channelId && rec.handle) {
      const sub = document.createElement("div");
      sub.style.fontSize = "11px";
      sub.style.opacity = "0.7";
      appendHighlighted(sub, rec.channelId, term);
      tdId.appendChild(sub);
    }

    const tdNick = document.createElement("td");
    tdNick.className = "col-name";
    if (rec.customNickname) {
      appendHighlighted(tdNick, rec.customNickname, term);
    } else {
      tdNick.textContent = "-";
      tdNick.style.opacity = "0.5";
    }

    const tdNotes = document.createElement("td");
    const notes = Array.isArray(rec.notes) ? rec.notes : [];
    if (notes.length === 0) {
      const dash = document.createElement("span");
      dash.textContent = "-";
      dash.style.opacity = "0.5";
      tdNotes.appendChild(dash);
    } else {
      for (const n of notes) {
        const pill = document.createElement("span");
        pill.className = "note-pill";
        appendHighlighted(pill, n, term);
        tdNotes.appendChild(pill);
      }
    }

    const tdTime = document.createElement("td");
    tdTime.className = "col-time";
    tdTime.textContent = rec.updatedAt ? new Date(rec.updatedAt).toLocaleDateString() : "-";

    const tdAction = document.createElement("td");
    tdAction.className = "col-action";
    const editBtn = document.createElement("button");
    editBtn.className = "btn btn-sm btn-io";
    editBtn.textContent = I18n.t("notes_edit");
    editBtn.onclick = () => openNoteEditModal(rec);
    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-sm btn-danger";
    delBtn.textContent = I18n.t("btn_delete");
    delBtn.onclick = async () => {
      if (!confirm(I18n.t("notes_confirm_delete"))) return;
      await sendMsg({ type: "NOTES_DELETE", key: rec.key });
      loadNotes();
    };
    tdAction.append(editBtn, document.createTextNode(" "), delBtn);

    tr.append(tdId, tdNick, tdNotes, tdTime, tdAction);
    fragment.appendChild(tr);
  }
  els.notesListBody.replaceChildren(fragment);
}

function renderEditModalNotes() {
  els.editNotesList.replaceChildren();
  const notes = editingRecord && Array.isArray(editingRecord.notes) ? editingRecord.notes : [];
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
      if (!editingRecord) return;
      const out = await sendMsg({
        type: "NOTES_SAVE",
        identity: { channelId: editingRecord.channelId, handle: editingRecord.handle || editingRecord.key },
        patch: { removeNote: n },
      });
      editingRecord = out && out.record
        ? out.record
        : { ...editingRecord, notes: notes.filter((x) => x !== n) };
      renderEditModalNotes();
      loadNotes();
    };
    li.append(span, del);
    els.editNotesList.appendChild(li);
  }
}

function openNoteEditModal(rec) {
  editingRecord = { ...rec, notes: Array.isArray(rec.notes) ? rec.notes.slice() : [] };
  els.editNoteIdentity.textContent = [rec.handle, rec.channelId].filter(Boolean).join(" / ") || rec.key;
  els.editNickInput.value = rec.customNickname || "";
  els.editNoteInput.value = "";
  renderEditModalNotes();
  els.noteEditModal.classList.add("active");
  els.editNickInput.focus();
}

async function saveEditedNick() {
  if (!editingRecord) return;
  const out = await sendMsg({
    type: "NOTES_SAVE",
    identity: { channelId: editingRecord.channelId, handle: editingRecord.handle || editingRecord.key },
    patch: { customNickname: els.editNickInput.value },
  });
  editingRecord = out && out.record
    ? out.record
    : { ...editingRecord, customNickname: els.editNickInput.value.trim() };
  loadNotes();
}

async function addEditedNote() {
  if (!editingRecord) return;
  const text = els.editNoteInput.value.trim();
  if (!text) return;
  const out = await sendMsg({
    type: "NOTES_SAVE",
    identity: { channelId: editingRecord.channelId, handle: editingRecord.handle || editingRecord.key },
    patch: { addNote: text },
  });
  els.editNoteInput.value = "";
  if (out && out.record) editingRecord = out.record;
  renderEditModalNotes();
  loadNotes();
}

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
      loadNotes();
    } catch {
      alert(I18n.t("import_fail") + I18n.t("import_format_error"));
    } finally {
      els.notesImportFile.value = "";
    }
  };
  reader.readAsText(file);
}

// ==================== EVENTS ====================

els.tabCacheBtn.onclick = () => switchTab("cache");
els.tabNotesBtn.onclick = () => switchTab("notes");

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
els.exportBtn.onclick = handleExport;
els.importBtn.onclick = () => els.importFile.click();
els.importFile.onchange = handleImportFile;
els.btnTrust.onclick = () => finalizeImport(true);
els.btnSafe.onclick = () => finalizeImport(false);
els.btnCancel.onclick = () => {
  els.modal.classList.remove("active");
  els.importFile.value = "";
};
els.clearBtn.onclick = clearAllData;
els.refreshBtn.onclick = loadData;

let searchTimeout;
els.search.oninput = () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    currentPage = 1;
    renderData();
  }, 300);
};
els.prevBtn.onclick = () => {
  if (currentPage > 1) {
    currentPage--;
    renderData();
  }
};
els.nextBtn.onclick = () => {
  currentPage++;
  renderData();
};

// Notes tab events
let notesSearchTimeout;
els.notesSearch.oninput = () => {
  clearTimeout(notesSearchTimeout);
  notesSearchTimeout = setTimeout(renderNotes, 200);
};
els.notesRefreshBtn.onclick = loadNotes;
els.notesExportBtn.onclick = handleNotesExport;
els.notesImportBtn.onclick = () => els.notesImportFile.click();
els.notesImportFile.onchange = handleNotesImportFile;
els.notesClearBtn.onclick = async () => {
  if (!confirm(I18n.t("notes_confirm_clear"))) return;
  await sendMsg({ type: "NOTES_CLEAR" });
  loadNotes();
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
els.editNoteCloseBtn.onclick = () => {
  els.noteEditModal.classList.remove("active");
  editingRecord = null;
};

setInterval(() => {
  if (document.hidden) return;
  if (activeTab === "cache") {
    const isModalOpen = els.modal.classList.contains("active");
    const hasChecks = document.querySelectorAll(".row-check:checked").length > 0;
    if (!isModalOpen && !hasChecks) loadData();
  }
}, 15000);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    if (activeTab === "cache") loadData();
    else loadNotes();
  }
});

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
  loadData();
})();
