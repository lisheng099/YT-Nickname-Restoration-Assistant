// ===========================================================
// UI.js - 介面渲染管理器
// 用途：純粹的渲染引擎，負責將資料繪製到 DOM 上，不含業務判斷。
// ===========================================================

const TooltipManager = {
  tooltipEl: null,
  isActive: false,
  canCopy: false,
  ID_PREFIX: "yt-realname-",

  // === 核心初始化與設定 ===
  init: function () {
    if (this.isActive) return;
    this.isActive = true;
    document.addEventListener("mousemove", (e) => this.handleMouseMove(e), {
      passive: true,
      capture: true,
    });
  },

  setCopyEnabled: function (enabled) {
    this.canCopy = enabled;
  },

  // === 輔助功能：綁定數據與 Tooltip ===
  attachData: function (target, handle, name, subs, isExpired) {
    if (!target) return;
    this.init();
    target.dataset.rnHandle = handle || "";
    target.dataset.rnName = name || "";
    target.dataset.rnSubs =
      typeof subs === "number" ? subs : parseInt(subs || 0);
    if (isExpired) target.dataset.rnExpired = "true";
    else delete target.dataset.rnExpired;
    target.dataset.rnBound = "true";
  },

  // =======================================================
  // [模式 1] renderStandard (標準替換)
  // 用途：直接清空元素內容，換成「暱稱 + 徽章」。
  // =======================================================
  renderStandard: function (target, handle, displayName, subs, isExpired) {
    if (!target.isConnected) return;

    // 清空舊內容
    target.textContent = "";

    // 建立新內容
    const span = document.createElement("span");
    span.textContent = displayName;
    span.dataset.rnSpan = "1";
    this.applyTextStyle(target, span, isExpired);

    // 點擊複製功能
    if (this.canCopy) this.bindCopyEvent(span, handle);

    // 組合徽章
    const numSubs = typeof subs === "number" ? subs : parseInt(subs || 0);
    const badge = this.getBadgeIcon(numSubs);
    if (badge) {
      target.style.display = "inline-flex";
      target.style.alignItems = "center";
      target.style.gap = "4px";
      target.appendChild(span);
      target.appendChild(badge);
    } else {
      target.style.display = "";
      target.appendChild(span);
    }

    // 標記完成
    target.dataset.rnReplaced = "yes";
    this.attachData(target, handle, displayName, subs, isExpired);
  },

  // =======================================================
  // [模式 1-B] renderDual (雙節點替換，選用)
  // 用途：不動 YouTube 原本的文字節點，只將它隱藏，並在前方插入獨立的暱稱節點。
  // 好處：YouTube 重複使用元素或改寫文字時，原節點仍是它自己管理的內容，
  //       不會被我們清空；換人時只需更新獨立節點，不會殘留上一位的內容。
  // =======================================================
  DUAL_CLASS: "rn-restored-name",

  findDualNode: function (target) {
    const prev = target.previousElementSibling;
    return prev && prev.classList && prev.classList.contains(this.DUAL_CLASS)
      ? prev
      : null;
  },

  renderDual: function (target, handle, displayName, fullName, subs, isExpired) {
    if (!target.isConnected || !target.parentNode) return;

    let node = this.findDualNode(target);
    if (!node) {
      node = document.createElement("span");
      node.className = this.DUAL_CLASS;
      target.parentNode.insertBefore(node, target);
    }

    // 沿用原生節點的外觀 (擁有者藍色、管理員色、字體等由 YouTube 以 CSS 套在原生節點上)
    this.copyNativeStyle(target, node);

    node.textContent = "";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = displayName;
    nameSpan.dataset.rnSpan = "1";
    this.applyTextStyle(nameSpan, null, isExpired);
    if (this.canCopy) this.bindCopyEvent(nameSpan, handle);
    node.appendChild(nameSpan);

    const numSubs = typeof subs === "number" ? subs : parseInt(subs || 0);
    const badge = this.getBadgeIcon(numSubs);
    if (badge) {
      node.style.display = "inline-flex";
      node.style.alignItems = "center";
      node.style.gap = "4px";
      node.appendChild(badge);
    } else {
      node.style.display = "";
    }
    this.attachData(node, handle, fullName, subs, isExpired);

    // 隱藏原生節點 (內容保持原樣，仍可被 YouTube 與本工具讀取)
    target.style.setProperty("display", "none", "important");
    target.dataset.rnReplaced = "yes";
    target.dataset.rnDual = "1";
    if (isExpired) target.dataset.rnExpired = "true";
    else delete target.dataset.rnExpired;
  },

  NATIVE_STYLE_PROPS: [
    "color",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "line-height",
    "letter-spacing",
    "text-transform",
    "background-color",
    "padding",
    "border-radius",
  ],

  // 隱藏原生節點之前，把它的計算後樣式複製到獨立節點
  copyNativeStyle: function (from, to) {
    try {
      const cs = window.getComputedStyle(from);
      // 原生節點已被隱藏時 (顯示 none) 計算值仍可讀取顏色與字體
      this.NATIVE_STYLE_PROPS.forEach((prop) => {
        const v = cs.getPropertyValue(prop);
        if (v) to.style.setProperty(prop, v);
      });
    } catch (e) {
      // 取不到就沿用繼承樣式
    }
  },

  // 還原：移除獨立節點並顯示原生節點 (原生文字不是 handle 時使用)
  restoreDual: function (target) {
    const node = this.findDualNode(target);
    if (node) node.remove();
    target.style.removeProperty("display");
    delete target.dataset.rnDual;
    delete target.dataset.rnReplaced;
    delete target.dataset.rnExpired;
    delete target.dataset.rnTargetHandle;
  },

  // =======================================================
  // [模式 2] renderWrapper (包裹模式)
  // 用途：保留原元素，建立 Wrapper 將暱稱顯示在上方 (避免破壞版面)。
  // =======================================================
  renderWrapper: function (el, handle, displayName, fullName, subs, isExpired) {
    const parent = el.parentNode;

    // 檢查是否已經包裹過 (更新既有 Wrapper)
    if (parent.classList.contains("rn-poll-wrapper")) {
      const nameNode = parent.querySelector(".rn-poll-inserted-name");
      if (nameNode) {
        nameNode.textContent = displayName;
        this.applyTextStyle(nameNode, null, isExpired); // 更新樣式
        this.attachData(nameNode, handle, fullName, subs, isExpired);
      }
      el.dataset.rnReplaced = "yes";
      return;
    }

    // 建立新的 Wrapper 結構
    const wrapper = document.createElement("div");
    wrapper.className = "rn-poll-wrapper";
    Object.assign(wrapper.style, {
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "flex-start",
    });

    // 搬移 Margin 樣式
    const computedStyle = window.getComputedStyle(el);
    wrapper.style.marginLeft = computedStyle.marginLeft;
    wrapper.style.marginRight = computedStyle.marginRight;
    el.style.marginLeft = "0px";
    el.style.marginRight = "0px";

    // 建立名字節點
    const nameNode = document.createElement("div");
    nameNode.className = "rn-poll-inserted-name";
    nameNode.textContent = displayName;
    this.applyTextStyle(nameNode, null, isExpired);

    Object.assign(nameNode.style, {
      color: computedStyle.color,
      fontFamily: computedStyle.fontFamily,
      fontSize: computedStyle.fontSize,
      fontWeight: "bold",
      lineHeight: "1.4",
      marginBottom: "2px",
    });

    this.attachData(nameNode, handle, fullName, subs, isExpired);

    // DOM 操作：插入 Wrapper 並移動原元素
    parent.insertBefore(wrapper, el);
    wrapper.appendChild(nameNode);
    wrapper.appendChild(el);

    el.dataset.rnReplaced = "yes";
  },

  // =======================================================
  // [模式 3] renderEmbedded (嵌入模式)
  // 用途：在一段文字中精準替換中間的 Handle，保留前後文。
  // =======================================================
  renderEmbedded: function (
    target,
    handle,
    displayName,
    fullName,
    subs,
    isExpired
  ) {
    if (target.dataset.rnReplaced === "yes") return;

    const originalText = target.textContent;
    const parts = originalText.split(handle);
    if (parts.length < 2) return;

    target.textContent = "";

    // 插入前半段
    target.appendChild(document.createTextNode(parts[0]));

    // 插入名字
    const nameSpan = document.createElement("span");
    nameSpan.textContent = displayName;
    nameSpan.style.fontWeight = "bold";
    this.applyTextStyle(nameSpan, null, isExpired);

    this.attachData(nameSpan, handle, fullName, subs, isExpired);
    if (this.canCopy) this.bindCopyEvent(nameSpan, handle);
    target.appendChild(nameSpan);

    // 插入徽章
    const badge = this.getBadgeIcon(subs);
    if (badge) target.appendChild(badge);

    // 插入後半段
    target.appendChild(document.createTextNode(parts.slice(1).join(handle)));

    target.dataset.rnReplaced = "yes";
  },

  // === 通用樣式處理 ===
  applyTextStyle: function (element, wrapper, isExpired) {
    const target = wrapper || element;
    if (isExpired) {
      target.style.opacity = "0.7";
      target.style.textDecoration = "underline dotted #888";
    } else {
      target.style.opacity = "1";
      target.style.textDecoration = "none";
    }
  },

  // === Tooltip 顯示邏輯 ===

  bindCopyEvent: function (element, handle) {
    element.style.cursor = "pointer";
    element.title = I18n.t("copy_link");
    element.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(
          `https://www.youtube.com/${handle}`
        );
        this.showToast(I18n.t("copied"));
      } catch (err) {
        console.error(err);
      }
    });
  },

  showToast: function (msg) {
    if (!this.tooltipEl) this.createTooltipElement();
    if (this.tooltipEl) {
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

  getBadgeIcon: function (subs) {
    if (!subs || subs < 500) return null;
    const i = document.createElement("i");
    Object.assign(i.style, {
      display: "inline-block",
      width: "8px",
      height: "8px",
      borderRadius: "50%",
      marginLeft: "2px",
    });

    if (subs >= 1000000) {
      i.style.background = "#00BFA5";
      i.title = I18n.t("subs_million");
    } else if (subs >= 100000) {
      i.style.background = "#FFD700";
      i.title = I18n.t("subs_100k");
    } else if (subs >= 10000) {
      i.style.background = "#C0C0C0";
      i.title = I18n.t("subs_10k");
    } else if (subs >= 1000) {
      i.style.background = "#CD7F32";
      i.title = I18n.t("subs_1000"); 
    } else if (subs >= 500) {
      i.style.background = "#8D6E63";
      i.title = I18n.t("subs_potential");
    }
    return i;
  },

  createTooltipElement: function () {
    if (this.tooltipEl) return;
    const el = document.createElement("div");
    el.id = `${this.ID_PREFIX}tooltip-container`;
    Object.assign(el.style, {
      position: "fixed",
      zIndex: 2147483647,
      pointerEvents: "none",
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
      backdropFilter: "blur(8px)",
      webkitBackdropFilter: "blur(8px)",
      border: "1px solid rgba(255, 255, 255, 0.18)",
      background: "rgba(28, 28, 28, 0.85)",
      color: "#ffffff",
      textAlign: "left",
    });
    document.body.appendChild(el);
    this.tooltipEl = el;
  },

  updateTheme: function () {
    if (!this.tooltipEl) return;
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

  handleMouseMove: function (e) {
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

  show: function (e, target) {
    if (!this.tooltipEl) this.createTooltipElement();
    this.updateTheme();

    const name = target.dataset.rnName || I18n.t("loading");
    const handle = target.dataset.rnHandle || "";
    const subs = parseInt(target.dataset.rnSubs || "0");
    const isExpired = target.dataset.rnExpired === "true";

    this.tooltipEl.replaceChildren();

    const nameDiv = document.createElement("div");
    Object.assign(nameDiv.style, {
      fontWeight: "600",
      fontSize: "1.1em",
      marginBottom: "2px",
    });
    nameDiv.textContent = name;
    this.tooltipEl.appendChild(nameDiv);

    if (handle) {
      const handleDiv = document.createElement("div");
      Object.assign(handleDiv.style, {
        color: "inherit",
        opacity: "0.7",
        fontSize: "0.9em",
        fontFamily: "monospace",
      });
      handleDiv.textContent = handle;
      this.tooltipEl.appendChild(handleDiv);
    }

    if (subs > 0) {
      const subsDiv = document.createElement("div");
      Object.assign(subsDiv.style, {
        marginTop: "6px",
        fontSize: "0.85em",
        display: "flex",
        alignItems: "center",
        gap: "4px",
      });
      const iconSpan = document.createElement("span");
      iconSpan.textContent = "👥";
      const textSpan = document.createElement("span");
      textSpan.textContent = I18n.t("subs_count", { count: new Intl.NumberFormat().format(subs) });
      subsDiv.appendChild(iconSpan);
      subsDiv.appendChild(textSpan);
      this.tooltipEl.appendChild(subsDiv);
    }

    if (isExpired) {
      const expDiv = document.createElement("div");
      Object.assign(expDiv.style, {
        marginTop: "6px",
        paddingTop: "4px",
        borderTop: "1px dashed rgba(128,128,128,0.3)",
        color: "#ffab91",
        fontSize: "0.85em",
      });
      expDiv.textContent = I18n.t("data_expired");
      this.tooltipEl.appendChild(expDiv);
    }

    const rect = this.tooltipEl.getBoundingClientRect();
    const x = Math.min(e.clientX + 15, window.innerWidth - rect.width - 15);
    const y = Math.min(e.clientY + 15, window.innerHeight - rect.height - 15);
    this.tooltipEl.style.left = `${x}px`;
    this.tooltipEl.style.top = `${y}px`;
    this.tooltipEl.style.opacity = "1";
    this.tooltipEl.style.transform = "translateY(0)";
  },
};