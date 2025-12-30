// ===========================================================
// Manager.js - UI 邏輯 (配合 IDB 調整)
// ===========================================================

const els = {
  stats: document.getElementById("statsText"),
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
  labBtn: document.getElementById("labBtn"),
  exportBtn: document.getElementById("exportBtn"),
  importBtn: document.getElementById("importBtn"),
  importFile: document.getElementById("importFile"),
  modal: document.getElementById("importModal"),
  importCount: document.getElementById("importCount"),
  btnTrust: document.getElementById("btnTrust"),
  btnSafe: document.getElementById("btnSafe"),
  btnCancel: document.getElementById("btnCancel"),
};

let allData = [];
let currentPage = 1;
const ITEMS_PER_PAGE = 15;
let sortConfig = { key: "id", direction: "asc" };
let pendingImportData = null;

async function loadData() {
  // 1. 從資料庫讀取所有資料
  allData = await DataManager.getAllList();
  
  // 2. 顯示筆數，讓使用者立刻看到結果 (不計算大小)
  els.stats.textContent = I18n.t("manager_stats_calculating", { count: allData.length });

  // 3. 渲染列表，讓畫面有內容
  renderData();

  // 4. 將耗時的「大小計算」丟到 setTimeout 裡非同步執行
  // 這樣做可以讓主執行緒先去畫畫面，不會因為 JSON.stringify 卡住
  setTimeout(() => {
    // 防呆：如果資料被清空了就不算
    if (!allData || allData.length === 0) {
        els.stats.textContent = I18n.t("manager_stats_zero");
        return;
    }

    try {
        // 這行最耗時：將巨大物件轉字串並計算 Byte
        const jsonSize = new Blob([JSON.stringify(allData)]).size;
        
        // 計算完畢後，更新 UI 加上大小資訊
        // 注意：這裡需再次確認 allData.length，確保數字一致
        els.stats.textContent = I18n.t("manager_stats_done", { count: allData.length, size: formatBytes(jsonSize) });

    } catch (err) {
        console.warn("計算資料大小失敗:", err);
        // 出錯時至少保留筆數顯示
        els.stats.textContent = I18n.t("manager_stats_basic", { count: allData.length });
    }
  }, 200); // 延遲 200ms，確保介面已經渲染完成後再執行
}

function renderData() {
  const now = Date.now();
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

  // 排序邏輯
  filteredData.sort((a, b) => {
    const valA = a[sortConfig.key];
    const valB = b[sortConfig.key];
    const comp =
      typeof valA === "string" ? valA.localeCompare(valB) : valA - valB;
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

  let html = "";

  // 移除舊的 TTL 變數，改用 item 內建的屬性
  pageItems.forEach((item) => {
    // 依賴 DataManager 算好的 isExpired 屬性
    const isExpired = item.isExpired;

    let statusHtml;
    if (isExpired) {
      // === 過期狀態處理 ===
      const daysLeft = item.daysUntilDelete;
      let deleteHint = "";

      if (daysLeft <= 0) {
        deleteHint = `<div style="font-size: 11px; color: #d32f2f; margin-top: 2px;">${I18n.t("status_deleting")}</div>`;
      } else {
        deleteHint = `<div style="font-size: 11px; color: #888; margin-top: 2px;">(${daysLeft} ${I18n.t("status_days_left")})</div>`;
      }

      statusHtml = `<span class="expired-tag">${I18n.t("status_expired")}</span>${deleteHint}`;
    } else {
      // === 有效狀態處理 ===
      // 這裡簡單顯示有效即可，確保準確
      statusHtml = `<span style="color: #2e7d32; background: #e8f5e9; padding: 2px 6px; border-radius: 4px; font-size: 12px;">${I18n.t("status_valid")}</span>`;
    }

    const subStr =
      item.subs > 0 ? new Intl.NumberFormat().format(item.subs) : "-";
    const displayName = highlightText(item.name, searchTerm);
    const displayId = highlightText(item.id, searchTerm);

    const expireBtn = isExpired
      ? ""
      : `<button class="btn btn-sm btn-warning expire-btn" data-id="${escapeHtml(
          item.id
        )}">${I18n.t("btn_expire")}</button>`; 

    html += `<tr>
      <td class="col-check"><input type="checkbox" class="row-check" value="${escapeHtml(
        item.id
      )}"></td>
      <td class="col-id" title="${escapeHtml(item.id)}">${displayId}</td>
      <td class="col-name" title="${escapeHtml(item.name)}">${displayName}</td>
      <td class="col-subs">${subStr}</td>
      <td class="col-time">${statusHtml}</td>
      <td class="col-action">
        ${expireBtn}
        <button class="btn btn-sm btn-danger del-btn" data-id="${escapeHtml(
          item.id
        )}">${I18n.t("btn_delete")}</button>
      </td>
    </tr>`; 
  });

  els.listBody.innerHTML = html;
  bindRowEvents();
  updatePaginationUI(totalPages, totalItems);
  updateSortUI();
}

async function handleExport() {
  const backup = await DataManager.generateBackup();
  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: "application/json",
  });
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
        if (
          !isValid &&
          !confirm(I18n.t("import_checksum_fail_confirm"))
        ) {
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
      els.importCount.textContent = count;
      els.modal.classList.add("active");
    } catch (err) {
      alert(I18n.t("import_fail") + I18n.t("import_format_error")); 
      els.importFile.value = "";
    }
  };
  reader.readAsText(file);
}

async function finalizeImport(isTrusted) {
  if (!pendingImportData) return;

  // 1. 鎖定 UI：防止重複點擊，並給予視覺回饋
  const processingBtn = isTrusted ? els.btnTrust : els.btnSafe;
  const originalText = processingBtn.innerHTML; // 暫存原本按鈕文字
  
  // 停用所有動作按鈕
  els.btnTrust.disabled = true;
  els.btnSafe.disabled = true;
  els.btnCancel.disabled = true;
  
  // 改變按鈕顯示
  processingBtn.textContent = I18n.t("importing"); 
  processingBtn.style.opacity = "0.7";

  try {
    // 2. 執行耗時的匯入作業 (讓 UI 有機會渲染，所以稍微讓出執行緒，雖非必須但在單執行緒環境是好習慣)
    await new Promise(r => requestAnimationFrame(r));
    
    const count = await DataManager.importData(pendingImportData, isTrusted);

    // 3. 匯入完成：關閉視窗並重置
    els.modal.classList.remove("active");
    
    // 稍微延遲 alert 讓畫面先變回原狀，體驗較好
    setTimeout(() => {
        alert(I18n.t("import_success", { count })); 
        loadData(); // 重新讀取列表
    }, 50);

  } catch (err) {
    console.error(err);
    alert(I18n.t("import_fail") + err.message); 
  } finally {
    // 4. 清理與復原狀態 (無論成功失敗都要做)
    els.importFile.value = "";
    pendingImportData = null;
    
    // 復原按鈕狀態 (下次打開才不會壞掉)
    els.btnTrust.disabled = false;
    els.btnSafe.disabled = false;
    els.btnCancel.disabled = false;
    processingBtn.innerHTML = originalText;
    processingBtn.style.opacity = "1";
    
    // 確保視窗關閉
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
  return Array.from(document.querySelectorAll(".row-check:checked")).map(
    (cb) => cb.value
  );
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
function highlightText(text, term) {
  if (!term || !text) return escapeHtml(text);
  const regex = new RegExp(
    `(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
    "gi"
  );
  return text
    .split(regex)
    .map((p) =>
      p.toLowerCase() === term
        ? `<span class="highlight">${escapeHtml(p)}</span>`
        : escapeHtml(p)
    )
    .join("");
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
    if (th.dataset.sort === sortConfig.key)
      th.classList.add(`sort-${sortConfig.direction}`);
  });
}
function bindRowEvents() {
  document
    .querySelectorAll(".del-btn")
    .forEach((b) => (b.onclick = (e) => deleteItem(e.target.dataset.id)));
  document
    .querySelectorAll(".expire-btn")
    .forEach((b) => (b.onclick = (e) => expireItem(e.target.dataset.id)));
  document
    .querySelectorAll(".row-check")
    .forEach((cb) => (cb.onchange = updateBatchState));
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

els.sortHeaders.forEach(
  (th) => (th.onclick = () => handleSort(th.dataset.sort))
);
els.selectAll.onchange = (e) => {
  document
    .querySelectorAll(".row-check")
    .forEach((cb) => (cb.checked = e.target.checked));
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

// 自動重新整理 (可選)
setInterval(() => {
  const isModalOpen = els.modal.classList.contains("active");
  const hasChecks = document.querySelectorAll(".row-check:checked").length > 0;
  if (!isModalOpen && !hasChecks) {
    loadData();
  }
}, 5000);

// 初始化流程
I18n.init().then(() => {
  I18n.render();
  loadData();
});