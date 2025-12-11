// ===========================================================
// UI.js - 介面渲染管理器
// 用途：負責 DOM 元素的操作與懸浮提示 (Tooltip) 的顯示。
// ===========================================================

const TooltipManager = {
  tooltipEl: null, // Tooltip DOM 實例 (Singleton Pattern)
  isActive: false, 
  canCopy: false, 
  ID_PREFIX: "yt-realname-", 

  // 初始化事件監聽
  init: function() {
    if (this.isActive) return;
    this.isActive = true;
    // 使用 capture: true 確保優先捕捉事件，避免被頁面其他腳本攔截
    document.addEventListener("mousemove", (e) => this.handleMouseMove(e), { passive: true, capture: true });
  },
  
  setCopyEnabled: function(enabled) {
      this.canCopy = enabled;
  },

  // 建立 Tooltip 容器
  createTooltipElement: function() {
    if (this.tooltipEl) return;
    const el = document.createElement("div");
    el.id = `${this.ID_PREFIX}tooltip-container`;
    
    // 設定樣式
    // 注意：直接操作 style 物件而非 class，確保樣式優先級並避免被 YouTube 全域樣式污染
    Object.assign(el.style, {
      position: "fixed", 
      zIndex: 2147483647, // Max Z-Index
      pointerEvents: "none", // 允許滑鼠穿透，避免阻擋下方元素互動
      padding: "10px 14px", 
      borderRadius: "12px", 
      fontFamily: "'Roboto', sans-serif", 
      fontSize: "13px",
      lineHeight: "1.5", 
      whiteSpace: "normal", 
      maxWidth: "300px",
      wordBreak: "break-word", 
      transition: "opacity 0.2s cubic-bezier(0.2, 0, 0.2, 1), transform 0.2s", 
      opacity: 0, 
      transform: "translateY(5px)", 
      boxShadow: "0 8px 32px 0 rgba(0, 0, 0, 0.25)", 
      backdropFilter: "blur(8px)", // Glassmorphism 效果
      webkitBackdropFilter: "blur(8px)",
      border: "1px solid rgba(255, 255, 255, 0.18)", 
      background: "rgba(28, 28, 28, 0.85)", 
      color: "#ffffff",
      textAlign: "left"
    });
    document.body.appendChild(el);
    this.tooltipEl = el;
  },

  // 主題適配 (Dark/Light Mode)
  updateTheme: function() {
    if (!this.tooltipEl) return;
    // 偵測 YouTube 根元素的 dark 屬性
    const isDark = document.documentElement.getAttribute("dark") !== null;
    if (isDark) {
        this.tooltipEl.style.background = "rgba(20, 20, 20, 0.9)";
        this.tooltipEl.style.color = "#f0f0f0";
        this.tooltipEl.style.border = "1px solid rgba(255, 255, 255, 0.1)";
    } else {
        this.tooltipEl.style.background = "rgba(255, 255, 255, 0.95)";
        this.tooltipEl.style.color = "#333333";
        this.tooltipEl.style.border = "1px solid rgba(0, 0, 0, 0.05)";
    }
  },

  // 綁定資料至 DOM 元素 (Dataset)
  // 用途：將資料暫存於元素屬性中，供 Tooltip 讀取，避免重複查詢 Cache
  attachData: function(target, handle, name, subs, isExpired) {
    if (!target) return;
    this.init();
    target.dataset.rnHandle = handle || "";
    target.dataset.rnName = name || "";
    target.dataset.rnSubs = subs || 0;
    if (isExpired) target.dataset.rnExpired = "true";
    else delete target.dataset.rnExpired;
    target.dataset.rnBound = "true";
  },

  // 渲染文字節點 (一般情況)
  renderText: function(target, handle, displayName, subs, isExpired) {
    if (!target.isConnected) return; // 若元素已從 DOM 移除則停止操作
    
    const currentText = (target.textContent || "").trim();
    const isShowingHandle = currentText.startsWith("@");

    // 避免重複渲染：若已替換且資料未過期，則不執行
    if (target.dataset.rnReplaced === "yes" && !isShowingHandle) {
        const isCurrentlyExpired = target.dataset.rnExpired === "true";
        if (!isCurrentlyExpired && !isExpired) return;
    }

    target.textContent = "";

    const span = document.createElement("span");
    span.textContent = displayName;
    
    // 過期樣式處理
    if (isExpired) {
        target.style.opacity = "0.7";
        target.style.textDecoration = "underline dotted #888";
    } else {
        target.style.opacity = "1";
        target.style.textDecoration = "none";
    }

    if (this.canCopy) {
        this.bindCopyEvent(span, handle);
    }
    
    const badge = this.getBadgeIcon(subs);
    if (badge) {
        target.style.display = "inline-flex";
        target.style.alignItems = "center";
        target.style.gap = "4px";
        target.appendChild(span);
        target.appendChild(badge);
    } else {
        target.appendChild(span);
    }

    target.dataset.rnReplaced = "yes";
    this.attachData(target, handle, displayName, subs, isExpired);
  },

  // 渲染投票欄位 (Poll) 的特殊包裹結構
  // 用途：解決投票欄位 Metadata 無法直接替換文字的問題，需建立 Wrapper 調整版面
  renderPollWrapper: function(el, handle, displayName, fullName, subs, isExpired) {
      const parent = el.parentNode;

      // 檢查：是否已經包裹過了？
      // 如果 parent 有我們特定的 class，代表已經處理過結構
      if (parent.classList.contains('rn-poll-wrapper')) {
          // 只需要更新裡面的名字節點
          const nameNode = parent.querySelector('.rn-poll-inserted-name');
          if (nameNode) {
              nameNode.textContent = displayName;
              this.attachData(nameNode, handle, fullName, subs, isExpired);
          }
          // 標記 el 狀態
          el.dataset.rnReplaced = "yes";
          return;
      }

      // --- 尚未包裹，開始進行 DOM 結構重組 ---

      // 1. 建立 Wrapper
      const wrapper = document.createElement('div');
      wrapper.className = 'rn-poll-wrapper';
      // 樣式設定
      Object.assign(wrapper.style, {
          display: 'flex',
          flexDirection: 'column', // 內部垂直排列
          justifyContent: 'center',
          alignItems: 'flex-start'
      });
      
      // 2. 處理邊距 (Margin)
      // 投票欄位通常文字與頭像有間距 (Margin-left)，我們要將這個間距移到 Wrapper 上
      const computedStyle = window.getComputedStyle(el);
      wrapper.style.marginLeft = computedStyle.marginLeft;
      wrapper.style.marginRight = computedStyle.marginRight;
      
      // 清除原本元素的邊距，因為它現在在 Wrapper 內部
      el.style.marginLeft = '0px';
      el.style.marginRight = '0px';

      // 3. 建立 Name Node (新名字)
      const nameNode = document.createElement('div');
      nameNode.className = 'rn-poll-inserted-name';
      nameNode.textContent = displayName;
      
      // 複製字體樣式並微調
      Object.assign(nameNode.style, {
          color: computedStyle.color,
          fontFamily: computedStyle.fontFamily,
          fontSize: computedStyle.fontSize,
          fontWeight: "bold",
          lineHeight: "1.4",
          marginBottom: "2px"
      });

      // 綁定 Tooltip
      this.attachData(nameNode, handle, fullName, subs, isExpired);

      // 4. 執行插入與搬移
      // (A) 將 Wrapper 插在原本 el 的前面
      parent.insertBefore(wrapper, el);
      // (B) 將新名字放入 Wrapper
      wrapper.appendChild(nameNode);
      // (C) 將原本的 metadata 元素 (el) 移動到 Wrapper 內部 (這會自動從原父層移除)
      wrapper.appendChild(el);

      // 標記
      el.dataset.rnReplaced = "yes";
  },
  
  // 綁定點擊複製事件
  bindCopyEvent: function(element, handle) {
      element.style.cursor = "pointer"; 
      element.title = "點擊複製連結";
      element.addEventListener("click", async (e) => {
          e.preventDefault(); 
          e.stopPropagation(); // 阻止事件冒泡，防止觸發 YouTube 原有的導航行為
          const url = `https://www.youtube.com/${handle}`;
          try {
              await navigator.clipboard.writeText(url);
              this.showToast("已複製連結");
          } catch(err) {
              console.error(err);
          }
      });
  },
  
  // 顯示操作回饋 (Toast)
  showToast: function(msg) {
     if (this.tooltipEl) {
         // 使用 replaceChildren 清空內容，取代 innerHTML
         this.tooltipEl.replaceChildren(); 
         
         const span = document.createElement("span");
         span.style.color = "#4caf50";
         span.textContent = "✔ " + msg;
         this.tooltipEl.appendChild(span);

         this.tooltipEl.style.opacity = 1;
         this.tooltipEl.style.transform = "translateY(0)";
         setTimeout(() => {
             this.tooltipEl.style.opacity = 0;
         }, 1500);
     }
  },

  // 生成訂閱數標記 (Badge)
  getBadgeIcon: function(subs) {
      if (!subs || subs < 500) return null; 

      const i = document.createElement("i");
      i.style.display = "inline-block";
      i.style.width = "8px"; 
      i.style.height = "8px";
      i.style.borderRadius = "50%";
      i.style.marginLeft = "2px";
      
      // 根據訂閱數量級顯示不同顏色
      if (subs >= 1000000) {      
          i.style.background = "#00BFA5"; // 百萬
          i.title = "百萬訂閱頻道";
      } else if (subs >= 100000) { 
          i.style.background = "#FFD700"; // 十萬
          i.title = "十萬訂閱頻道";
      } else if (subs >= 10000) {  
          i.style.background = "#C0C0C0"; // 萬
          i.title = "萬人訂閱頻道";
      } else if (subs >= 1000) {   
          i.style.background = "#CD7F32"; // 千
          i.title = "千人訂閱頻道";
      } else {
          i.style.background = "#8D6E63"; // 其他
          i.title = "潛力頻道";
      }
      
      return i;
  },

  // Tooltip 顯示邏輯
  handleMouseMove: function(e) {
    const target = e.target.closest('[data-rn-bound="true"]');
    if (!target) {
      if (this.tooltipEl && this.tooltipEl.style.opacity !== "0") {
        this.tooltipEl.style.opacity = "0";
        this.tooltipEl.style.transform = "translateY(5px)";
      }
      return;
    }
    this.show(e, target);
  },

  show: function(e, target) {
    if (!this.tooltipEl) this.createTooltipElement();
    this.updateTheme();

    const name = target.dataset.rnName || "Loading...";
    const handle = target.dataset.rnHandle || "";
    const subs = parseInt(target.dataset.rnSubs || "0");
    const isExpired = target.dataset.rnExpired === "true";

    // 使用 DOM API 構建內容，避免 Trusted Types 錯誤
    this.tooltipEl.replaceChildren();

    // 1. 顯示名稱
    const nameDiv = document.createElement("div");
    Object.assign(nameDiv.style, {
        fontWeight: "600",
        fontSize: "1.1em",
        marginBottom: "2px"
    });
    nameDiv.textContent = name;
    this.tooltipEl.appendChild(nameDiv);

    // 2. 顯示 Handle ID
    if (handle) {
        const handleDiv = document.createElement("div");
        Object.assign(handleDiv.style, {
            color: "inherit",
            opacity: "0.7",
            fontSize: "0.9em",
            fontFamily: "monospace"
        });
        handleDiv.textContent = handle;
        this.tooltipEl.appendChild(handleDiv);
    }

    // 3. 顯示訂閱數
    if (subs > 0) {
        const subsDiv = document.createElement("div");
        Object.assign(subsDiv.style, {
            marginTop: "6px",
            fontSize: "0.85em",
            display: "flex",
            alignItems: "center",
            gap: "4px"
        });

        const iconSpan = document.createElement("span");
        iconSpan.textContent = "👥";
        
        const textSpan = document.createElement("span");
        textSpan.textContent = `${new Intl.NumberFormat().format(subs)} 訂閱`;

        subsDiv.appendChild(iconSpan);
        subsDiv.appendChild(textSpan);
        this.tooltipEl.appendChild(subsDiv);
    }

    // 4. 顯示過期警告
    if (isExpired) {
        const expDiv = document.createElement("div");
        Object.assign(expDiv.style, {
            marginTop: "6px",
            paddingTop: "4px",
            borderTop: "1px dashed rgba(128,128,128,0.3)",
            color: "#ffab91",
            fontSize: "0.85em"
        });
        expDiv.textContent = "⚠ 資料已過期，等待更新...";
        this.tooltipEl.appendChild(expDiv);
    }

    // 動態計算位置，防止 Tooltip 超出視窗邊界
    const rect = this.tooltipEl.getBoundingClientRect();
    const x = Math.min(e.clientX + 15, window.innerWidth - rect.width - 15);
    const y = Math.min(e.clientY + 15, window.innerHeight - rect.height - 15);

    this.tooltipEl.style.left = `${x}px`;
    this.tooltipEl.style.top = `${y}px`;
    
    this.tooltipEl.style.opacity = "1";
    this.tooltipEl.style.transform = "translateY(0)";
  }
};