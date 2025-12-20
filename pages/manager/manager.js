// ===========================================================
// Manager.js - 快取管理頁面邏輯 [重構版]
// 用途：專注於 UI 互動與畫面渲染，資料邏輯已委派給 DataManager。
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
  
  exportBtn: document.getElementById("exportBtn"),
  importBtn: document.getElementById("importBtn"),
  importFile: document.getElementById("importFile"),

  modal: document.getElementById("importModal"),
  importCount: document.getElementById("importCount"),
  btnTrust: document.getElementById("btnTrust"),
  btnSafe: document.getElementById("btnSafe"),
  btnCancel: document.getElementById("btnCancel")
};

// 狀態變數
let allData = [];
let currentPage = 1;
const ITEMS_PER_PAGE = 15;
let sortConfig = { key: "id", direction: "asc" };
let pendingImportData = null; // 暫存匯入資料

// 格式化位元組
function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

// === 核心流程：讀取與渲染 ===
async function loadData() {
  // 1. 透過 DataManager 取得資料列表
  allData = await DataManager.getAllList();
  
  // 2. 計算大小 (估算值)
  const jsonSize = new Blob([JSON.stringify(allData)]).size;
  els.stats.textContent = `共 ${allData.length} 筆資料 (佔用 ${formatBytes(jsonSize)})`;

  // 3. 渲染畫面
  renderData();
}

function renderData() {
  const now = Date.now();
  const searchTerm = els.search.value.trim().toLowerCase();
  
  els.selectAll.checked = false;
  els.batchActions.style.display = "none";

  // 過濾
  let filteredData = allData;
  if (searchTerm) {
    filteredData = allData.filter(item => 
      item.id.toLowerCase().includes(searchTerm) || 
      item.name.toLowerCase().includes(searchTerm)
    );
  }

  // 排序
  filteredData.sort((a, b) => {
    const valA = a[sortConfig.key];
    const valB = b[sortConfig.key];
    const comp = (typeof valA === "string") ? valA.localeCompare(valB) : valA - valB;
    return sortConfig.direction === "asc" ? comp : -comp;
  });

  // 分頁
  const totalItems = filteredData.length;
  const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE) || 1;
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;

  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const pageItems = filteredData.slice(startIndex, startIndex + ITEMS_PER_PAGE);

  // 顯示空狀態
  if (totalItems === 0) {
    els.tableWrapper.style.display = "none";
    els.emptyState.style.display = "flex";
    els.emptyState.textContent = searchTerm ? "找不到符合搜尋條件的資料" : "目前沒有快取資料";
    els.pagination.style.display = "none";
    return;
  }
  els.tableWrapper.style.display = "block";
  els.emptyState.style.display = "none";

  // 生成 HTML
  let html = "";
  const TTL = DataManager.TTL;

  pageItems.forEach(item => {
    const isExpired = (now - item.ts) > TTL;
    
    let statusHtml;
    if (isExpired) {
        statusHtml = `<span class="expired-tag">已過期</span>`;
    } else {
        const timeLeft = Math.max(0, TTL - (now - item.ts));
        const hoursLeft = Math.ceil(timeLeft / (1000 * 60 * 60));
        statusHtml = hoursLeft > 24 ? `${Math.floor(hoursLeft/24)}天後過期` : `${hoursLeft}小時後過期`;
    }

    const subStr = item.subs > 0 ? new Intl.NumberFormat().format(item.subs) : "-";
    const displayName = highlightText(item.name, searchTerm);
    const displayId = highlightText(item.id, searchTerm);
    
    // 按鈕 UI
    const expireBtn = isExpired ? '' : 
        `<button class="btn btn-sm btn-warning expire-btn" data-id="${escapeHtml(item.id)}">過期</button>`;

    html += `<tr>
      <td class="col-check"><input type="checkbox" class="row-check" value="${escapeHtml(item.id)}"></td>
      <td class="col-id" title="${escapeHtml(item.id)}">${displayId}</td>
      <td class="col-name" title="${escapeHtml(item.name)}">${displayName}</td>
      <td class="col-subs">${subStr}</td>
      <td class="col-time">${statusHtml}</td>
      <td class="col-action">
        ${expireBtn}
        <button class="btn btn-sm btn-danger del-btn" data-id="${escapeHtml(item.id)}">刪除</button>
      </td>
    </tr>`;
  });

  els.listBody.innerHTML = html;
  bindRowEvents();
  updatePaginationUI(totalPages, totalItems);
  updateSortUI();
}

// === UI 事件處理 (委派 DataManager 執行) ===

// 匯出
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

// 匯入 (讀取檔案 -> 驗證 -> 顯示彈窗)
function handleImportFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const json = JSON.parse(e.target.result);
      let dataToImport = json;

      // 檢查新版格式與 Checksum
      if (json.meta && json.data) {
          const isValid = await DataManager.verifyChecksum(json);
          if (!isValid) {
              if (!confirm("⚠️ 警告：檔案完整性驗證失敗！\n\n內容可能已損毀或遭到修改，是否繼續？")) {
                  els.importFile.value = "";
                  return;
              }
          }
          dataToImport = json.data;
      }

      // 計算筆數
      let count = 0;
      for (const val of Object.values(dataToImport)) {
          if (val && (val.name || typeof val === "string")) count++;
      }

      if (count === 0) throw new Error("無效資料");

      pendingImportData = dataToImport;
      els.importCount.textContent = count;
      els.modal.classList.add("active");

    } catch (err) {
      alert("匯入失敗：檔案格式錯誤");
      els.importFile.value = "";
    }
  };
  reader.readAsText(file);
}

// 確認匯入 (信任/安全)
async function finalizeImport(isTrusted) {
  if (!pendingImportData) return;
  els.modal.classList.remove("active");
  
  const count = await DataManager.importData(pendingImportData, isTrusted);
  alert(`成功匯入 ${count} 筆資料！`);
  
  els.importFile.value = "";
  pendingImportData = null;
  // loadData 會由 storage.onChanged 觸發
}

// 刪除與過期操作
async function deleteItem(id) {
    await DataManager.deleteItems(id);
}
async function expireItem(id) {
    await DataManager.expireItems(id);
}
async function batchDelete() {
    const ids = getCheckedIds();
    if (ids.length === 0) return;
    if (confirm(`刪除 ${ids.length} 筆資料？`)) {
        await DataManager.deleteItems(ids);
    }
}
async function batchExpire() {
    const ids = getCheckedIds();
    if (ids.length > 0) await DataManager.expireItems(ids);
}
async function clearAllData() {
    if (confirm("確定清空所有資料？")) {
        await DataManager.clearAll();
    }
}

// === 輔助函式 ===
function getCheckedIds() {
    return Array.from(document.querySelectorAll(".row-check:checked")).map(cb => cb.value);
}
function updateBatchState() {
    const count = document.querySelectorAll(".row-check:checked").length;
    els.batchActions.style.display = count > 0 ? "inline-flex" : "none";
    if (count > 0) {
        els.batchDeleteBtn.textContent = `刪除選取 (${count})`;
        els.batchExpireBtn.textContent = `標記過期 (${count})`;
    }
}
function highlightText(text, term) {
  if (!term || !text) return escapeHtml(text);
  const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return text.split(regex).map(p => p.toLowerCase() === term ? `<span class="highlight">${escapeHtml(p)}</span>` : escapeHtml(p)).join('');
}
function handleSort(key) {
    if (sortConfig.key === key) {
        sortConfig.direction = sortConfig.direction === "asc" ? "desc" : "asc";
    } else {
        sortConfig.key = key;
        sortConfig.direction = (key === "subs" || key === "ts") ? "desc" : "asc";
    }
    renderData();
    updateSortUI();
}
function updateSortUI() {
    els.sortHeaders.forEach(th => {
        th.classList.remove("sort-asc", "sort-desc");
        if (th.dataset.sort === sortConfig.key) th.classList.add(`sort-${sortConfig.direction}`);
    });
}
function bindRowEvents() {
    document.querySelectorAll(".del-btn").forEach(b => b.onclick = (e) => deleteItem(e.target.dataset.id));
    document.querySelectorAll(".expire-btn").forEach(b => b.onclick = (e) => expireItem(e.target.dataset.id));
    document.querySelectorAll(".row-check").forEach(cb => cb.onchange = updateBatchState);
}
function updatePaginationUI(totalPages, totalItems) {
    if (totalItems <= ITEMS_PER_PAGE && els.search.value === "") {
        els.pagination.style.display = "none"; return;
    }
    els.pagination.style.display = "flex";
    els.pageInfo.textContent = `${currentPage} / ${totalPages} 頁 (共 ${totalItems} 筆)`;
    els.prevBtn.disabled = currentPage === 1;
    els.nextBtn.disabled = currentPage === totalPages;
}

// === 事件綁定 ===
els.sortHeaders.forEach(th => th.onclick = () => handleSort(th.dataset.sort));
els.selectAll.onchange = (e) => {
    document.querySelectorAll(".row-check").forEach(cb => cb.checked = e.target.checked);
    updateBatchState();
};
els.batchDeleteBtn.onclick = batchDelete;
els.batchExpireBtn.onclick = batchExpire;
els.exportBtn.onclick = handleExport;
els.importBtn.onclick = () => els.importFile.click();
els.importFile.onchange = handleImportFile;
els.btnTrust.onclick = () => finalizeImport(true);
els.btnSafe.onclick = () => finalizeImport(false);
els.btnCancel.onclick = () => { els.modal.classList.remove("active"); els.importFile.value = ""; };
els.clearBtn.onclick = clearAllData;
els.refreshBtn.onclick = loadData;

let searchTimeout;
els.search.oninput = () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => { currentPage = 1; renderData(); }, 300);
};
els.prevBtn.onclick = () => { if (currentPage > 1) { currentPage--; renderData(); }};
els.nextBtn.onclick = () => { currentPage++; renderData(); };

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[DataManager.CACHE_KEY]) loadData();
});

// 初始化
loadData();