// ===========================================================
// Manager.js - 快取管理頁面邏輯
// 用途：提供完整的資料管理功能，包含列表檢視、搜尋、排序、批次操作與匯入/匯出。
// 架構：採用 Client-Side Rendering，將 Storage 資料全數載入記憶體後進行操作。
// ===========================================================

const { CACHE_KEY, TTL } = window.AppConfig;
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
  
  // 批次與 IO 操作 UI 參考
  selectAll: document.getElementById("selectAll"),
  batchActions: document.getElementById("batchActions"),
  batchDeleteBtn: document.getElementById("batchDeleteBtn"),
  batchExpireBtn: document.getElementById("batchExpireBtn"),
  exportBtn: document.getElementById("exportBtn"),
  importBtn: document.getElementById("importBtn"),
  importFile: document.getElementById("importFile"),

  // Modal 相關元素
  modal: document.getElementById("importModal"),
  importCount: document.getElementById("importCount"),
  btnTrust: document.getElementById("btnTrust"),
  btnSafe: document.getElementById("btnSafe"),
  btnCancel: document.getElementById("btnCancel")
};

// 狀態管理變數
let allData = [];
let currentPage = 1;
const ITEMS_PER_PAGE = 15;
let sortConfig = {
  key: "id",
  direction: "asc"
};

// 暫存匯入資料 (等待使用者選擇模式)
let pendingImportData = null;

// 格式化位元組大小 (用於顯示資料佔用空間)
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

// 載入資料主流程
function loadData() {
  chrome.storage.local.get(CACHE_KEY, (res) => {
    const raw = res[CACHE_KEY] || {};
    let validRaw = {}; 
    
    allData = [];

    // 資料轉換與驗證：Object -> Array
    for (const [id, data] of Object.entries(raw)) {
      if (!data) continue;
      const name = data.name || (typeof data === "string" ? data : null);
      if (!name) continue;

      const ts = data.ts || 0;
      const subs = data.subs || 0;

      validRaw[id] = data;
      allData.push({ id, name, subs, ts });
    }

    // 若發現資料結構有修正，同步回寫 Storage
    if (Object.keys(raw).length !== Object.keys(validRaw).length) {
      chrome.storage.local.set({ [CACHE_KEY]: validRaw });
    }

    // 計算 JSON 資料大小
    const jsonSize = new Blob([JSON.stringify(validRaw)]).size;
    els.stats.textContent = `共 ${allData.length} 筆資料 (佔用 ${formatBytes(jsonSize)})`;
    
    renderData();
  });
}

// 處理排序邏輯
function handleSort(key) {
  if (sortConfig.key === key) {
    // 同欄位點擊切換升降冪
    sortConfig.direction = sortConfig.direction === "asc" ? "desc" : "asc";
  } else {
    // 切換欄位，重置為升冪 (數字類預設降冪較直觀)
    sortConfig.key = key;
    sortConfig.direction = "asc";
    if (key === "subs" || key === "ts") {
        sortConfig.direction = "desc";
    }
  }
  renderData();
  updateSortUI();
}

// 更新排序圖示
function updateSortUI() {
  els.sortHeaders.forEach(th => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.sort === sortConfig.key) {
      th.classList.add(`sort-${sortConfig.direction}`);
    }
  });
}

// 搜尋關鍵字高亮
function highlightText(text, term) {
  if (!term || !text) return escapeHtml(text);
  const safeTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${safeTerm})`, 'gi');
  return text.split(regex).map(part => {
    if (part.toLowerCase() === term.toLowerCase()) {
      return `<span class="highlight">${escapeHtml(part)}</span>`;
    } else {
      return escapeHtml(part);
    }
  }).join('');
}

// 核心渲染函式 (過濾 -> 排序 -> 分頁 -> HTML 生成)
function renderData() {
  const now = Date.now();
  const searchTerm = els.search.value.trim().toLowerCase();
  
  els.selectAll.checked = false;
  els.batchActions.style.display = "none";

  // 1. 搜尋過濾
  let filteredData = allData;
  if (searchTerm) {
    filteredData = allData.filter(item => 
      item.id.toLowerCase().includes(searchTerm) || 
      item.name.toLowerCase().includes(searchTerm)
    );
  }

  // 2. 排序
  filteredData.sort((a, b) => {
    const valA = a[sortConfig.key];
    const valB = b[sortConfig.key];
    
    let comparison = 0;
    if (typeof valA === "string") {
      comparison = valA.localeCompare(valB);
    } else {
      comparison = valA - valB;
    }

    return sortConfig.direction === "asc" ? comparison : -comparison;
  });

  // 3. 分頁計算
  const totalItems = filteredData.length;
  const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE) || 1;

  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;

  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = startIndex + ITEMS_PER_PAGE;
  const pageItems = filteredData.slice(startIndex, endIndex);

  // 空狀態處理
  if (totalItems === 0) {
    els.tableWrapper.style.display = "none";
    els.emptyState.style.display = "flex";
    els.emptyState.textContent = searchTerm ? "找不到符合搜尋條件的資料" : "目前沒有快取資料";
    els.pagination.style.display = "none";
    return;
  } else {
    els.tableWrapper.style.display = "block";
    els.emptyState.style.display = "none";
  }

  // 4. HTML 生成
  let html = "";
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

    const expireBtn = isExpired 
        ? '' 
        : `<button class="btn btn-sm btn-warning expire-btn" data-id="${escapeHtml(item.id)}" title="強制標記為過期以測試自動更新">過期</button>`;

    html += `<tr>
      <td class="col-check">
        <input type="checkbox" class="row-check" value="${escapeHtml(item.id)}">
      </td>
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

// 綁定列表內的事件 (刪除、過期、Checkbox)
function bindRowEvents() {
  document.querySelectorAll(".del-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      deleteItem(e.target.dataset.id);
    });
  });

  document.querySelectorAll(".expire-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      expireItem(e.target.dataset.id);
    });
  });

  const checkboxes = document.querySelectorAll(".row-check");
  checkboxes.forEach(cb => {
    cb.addEventListener("change", updateBatchState);
  });
}

function updateBatchState() {
  const checkboxes = document.querySelectorAll(".row-check");
  const checkedCount = document.querySelectorAll(".row-check:checked").length;
  
  if (checkedCount > 0) {
    els.batchActions.style.display = "inline-flex";
    els.batchActions.style.gap = "4px";
    els.batchDeleteBtn.textContent = `刪除選取 (${checkedCount})`;
    els.batchExpireBtn.textContent = `標記過期 (${checkedCount})`;
  } else {
    els.batchActions.style.display = "none";
  }

  els.selectAll.checked = checkboxes.length > 0 && checkedCount === checkboxes.length;
}

// === 功能邏輯：Checksum 與 匯出/匯入 ===

// 計算資料雜湊 (SHA-256)
async function computeChecksum(data) {
    const orderedData = {};
    Object.keys(data).sort().forEach(key => {
        orderedData[key] = data[key];
    });
    
    const msgUint8 = new TextEncoder().encode(JSON.stringify(orderedData));
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// 匯出功能 (含 Checksum)
async function handleExport() {
  chrome.storage.local.get(CACHE_KEY, async (res) => {
    const raw = res[CACHE_KEY] || {};
    
    // 計算雜湊
    const checksum = await computeChecksum(raw);
    
    // 建立新的匯出結構
    const exportObj = {
        meta: {
            version: chrome.runtime.getManifest().version, // 改成動態讀取
            generatedAt: Date.now(),
            checksum: checksum
        },
        data: raw
    };

    const jsonStr = JSON.stringify(exportObj, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    
    // 建立臨時連結觸發下載
    const a = document.createElement("a");
    a.href = url;
    const dateStr = new Date().toISOString().slice(0, 10);
    a.download = `yt_names_backup_${dateStr}.json`;
    a.click();
    
    URL.revokeObjectURL(url);
  });
}

// 步驟 1: 讀取檔案 -> 驗證完整性 -> 顯示彈窗
function handleImport(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const json = JSON.parse(e.target.result);
      if (typeof json !== "object" || json === null) {
        throw new Error("格式錯誤");
      }
      
      let dataToImport = json;

      // 檢查是否為包含 Meta 的新格式
      if (json.meta && json.data) {
          // 驗證 Checksum
          const calculatedHash = await computeChecksum(json.data);
          if (calculatedHash !== json.meta.checksum) {
              if (!confirm("⚠️ 警告：檔案完整性驗證失敗！\n\n此檔案的內容可能已損毀或遭到修改。\n您確定仍要嘗試匯入嗎？")) {
                  els.importFile.value = "";
                  return;
              }
          }
          dataToImport = json.data;
      }

      // 計算有效筆數
      let count = 0;
      for (const val of Object.values(dataToImport)) {
          if (val && (val.name || typeof val === "string")) count++;
      }

      if (count === 0) {
        alert("檔案中沒有有效的資料！");
        els.importFile.value = ""; 
        return;
      }

      // 儲存至暫存區並開啟彈窗
      pendingImportData = dataToImport;
      els.importCount.textContent = count;
      els.modal.classList.add("active");

    } catch (err) {
      console.error(err);
      alert("匯入失敗：檔案格式不正確 (必須是 JSON)");
      els.importFile.value = "";
    }
  };
  reader.readAsText(file);
}

// 步驟 2: 根據使用者選擇 (Trust/Safe) 執行匯入
function finalizeImport(isTrusted) {
  if (!pendingImportData) return;
  
  // 關閉彈窗
  els.modal.classList.remove("active");
  
  const now = Date.now();
  const forcedExpiredTs = now - TTL - 60000;
  let validCount = 0;
  const cleanData = {};

  for (const [key, val] of Object.entries(pendingImportData)) {
    const entry = val || {};
    const name = entry.name || (typeof entry === "string" ? entry : null);
    
    if (!name) continue;

    let finalTs;
    if (isTrusted) {
        // [信任模式] 
        const originTs = entry.ts || now;
        
        // 檢查是否有訂閱數紀錄-> 強制過期 (確保重要資料更新)
        const hasSubs = entry.subs && entry.subs > 0;

        if (originTs > now) {
            finalTs = forcedExpiredTs; // 未來時間視為異常 -> 強制過期
        } else if (hasSubs) {
            // 即使是信任匯入，若包含訂閱數，強制標記為過期
            // 目的：讓系統在下次遇到該使用者時，自動重新抓取最新的訂閱數與稱號
            finalTs = forcedExpiredTs;
        } else {
            // 沒訂閱數的一般帳號 -> 保留原始時間 (信任)
            finalTs = originTs;
        }
    } else {
        // [安全模式] 強制過期
        finalTs = forcedExpiredTs;
    }

    cleanData[key] = {
        name: name,
        subs: entry.subs || 0,
        ts: finalTs 
    };
    validCount++;
  }

  // 寫入 Storage
  chrome.storage.local.get(CACHE_KEY, (res) => {
    const currentData = res[CACHE_KEY] || {};
    const mergedData = { ...currentData, ...cleanData };

    chrome.storage.local.set({ [CACHE_KEY]: mergedData }, () => {
      alert(`成功匯入 ${validCount} 筆資料！`);
      els.importFile.value = ""; 
      pendingImportData = null; // 清除暫存
      loadData(); 
    });
  });
}

// 取消匯入
function cancelImport() {
  els.modal.classList.remove("active");
  els.importFile.value = "";
  pendingImportData = null;
}

// 單筆過期操作
function expireItem(targetId) {
  chrome.storage.local.get(CACHE_KEY, (res) => {
    const raw = res[CACHE_KEY] || {};
    if (raw[targetId]) {
      raw[targetId].ts = Date.now() - TTL - 10000;
      chrome.storage.local.set({ [CACHE_KEY]: raw });
    }
  });
}

// 批次過期操作
function batchExpire() {
  const checkedBoxes = document.querySelectorAll(".row-check:checked");
  if (checkedBoxes.length === 0) return;
  const idsToExpire = Array.from(checkedBoxes).map(cb => cb.value);

  chrome.storage.local.get(CACHE_KEY, (res) => {
    const raw = res[CACHE_KEY] || {};
    let changed = false;
    const pastTime = Date.now() - TTL - 10000;
    
    idsToExpire.forEach(id => {
      if (raw[id]) {
        raw[id].ts = pastTime;
        changed = true;
      }
    });

    if (changed) chrome.storage.local.set({ [CACHE_KEY]: raw });
  });
}

// 批次刪除操作
function batchDelete() {
  const checkedBoxes = document.querySelectorAll(".row-check:checked");
  if (checkedBoxes.length === 0) return;
  if (!confirm(`確定要刪除這 ${checkedBoxes.length} 筆資料嗎？`)) return;

  const idsToDelete = Array.from(checkedBoxes).map(cb => cb.value);

  chrome.storage.local.get(CACHE_KEY, (res) => {
    const raw = res[CACHE_KEY] || {};
    let changed = false;
    idsToDelete.forEach(id => {
      if (raw[id]) {
        delete raw[id];
        changed = true;
      }
    });
    if (changed) chrome.storage.local.set({ [CACHE_KEY]: raw });
  });
}

// 更新分頁控制項狀態
function updatePaginationUI(totalPages, totalItems) {
  if (totalItems <= ITEMS_PER_PAGE && els.search.value === "") {
    els.pagination.style.display = "none";
    return;
  }
  els.pagination.style.display = "flex";
  els.pageInfo.textContent = `${currentPage} / ${totalPages} 頁 (共 ${totalItems} 筆)`;
  els.prevBtn.disabled = currentPage === 1;
  els.nextBtn.disabled = currentPage === totalPages;
}

// 單筆刪除
function deleteItem(targetId) {
  chrome.storage.local.get(CACHE_KEY, (res) => {
    const raw = res[CACHE_KEY] || {};
    if (raw[targetId]) {
      delete raw[targetId];
      chrome.storage.local.set({ [CACHE_KEY]: raw });
    }
  });
}

// 事件監聽區
els.sortHeaders.forEach(th => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (key) handleSort(key);
  });
});

els.selectAll.addEventListener("change", (e) => {
  const isChecked = e.target.checked;
  document.querySelectorAll(".row-check").forEach(cb => {
    cb.checked = isChecked;
  });
  updateBatchState();
});

els.batchDeleteBtn.addEventListener("click", batchDelete);
els.batchExpireBtn.addEventListener("click", batchExpire);

// 綁定匯入匯出事件
els.exportBtn.addEventListener("click", handleExport);
els.importBtn.addEventListener("click", () => els.importFile.click()); // 觸發隱藏的 input
els.importFile.addEventListener("change", handleImport);

// Modal 事件綁定
els.btnTrust.addEventListener("click", () => finalizeImport(true));
els.btnSafe.addEventListener("click", () => finalizeImport(false));
els.btnCancel.addEventListener("click", cancelImport);

// 搜尋防抖 (Debounce)：延遲 300ms 執行
let searchTimeout;
els.search.addEventListener("input", () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    currentPage = 1;
    renderData();
  }, 300);
});

els.prevBtn.addEventListener("click", () => {
  if (currentPage > 1) {
    currentPage--;
    renderData();
  }
});

els.nextBtn.addEventListener("click", () => {
  currentPage++;
  renderData();
});

// 監聽 Storage 變更，即時同步列表
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[CACHE_KEY]) {
    loadData();
  }
});

els.clearBtn.addEventListener("click", () => {
  if (confirm("確定要清空所有資料嗎？")) {
    chrome.storage.local.remove(CACHE_KEY); 
  }
});

els.refreshBtn.addEventListener("click", loadData);

loadData();