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
      if (target.dataset.rnInPlaceDual === "1") {
        const wrap = document.createElement("span");
        wrap.style.display = "inline-flex";
        wrap.style.alignItems = "center";
        wrap.style.gap = "4px";
        wrap.appendChild(span);
        wrap.appendChild(badge);
        target.appendChild(wrap);
      } else {
        target.style.display = "inline-flex";
        target.style.alignItems = "center";
        target.style.gap = "4px";
        target.appendChild(span);
        target.appendChild(badge);
      }
    } else {
      if (target.dataset.rnInPlaceDual !== "1") target.style.display = "";
      target.appendChild(span);
    }

    // 標記完成
    target.dataset.rnReplaced = "yes";
    this.attachData(target, handle, displayName, subs, isExpired);
  },

  // =======================================================
  // [模式 1-B] renderDual (雙節點替換)
  // 用途：不動 YouTube 原本的文字節點，只將它隱藏，並在前方插入獨立的暱稱節點。
  // 好處：YouTube 重複使用元素或改寫文字時，原節點仍是它自己管理的內容，
  //       不會被我們清空；換人時只需更新獨立節點，不會殘留上一位的內容。
  // =======================================================
  DUAL_CLASS: "rn-restored-name",
  NATIVE_HIDDEN_CLASS: "rn-native-hidden",

  findDualNode: function (target) {
    if (target.dataset && target.dataset.rnDual === "inside") {
      return target.querySelector(":scope > ." + this.DUAL_CLASS);
    }
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

  // =======================================================
  // [模式 1-C] renderDualInside (容器內雙節點替換)
  // 用途：保留原生目標元素本身的定位與 CSS (如頂部跑馬燈 #text 在
  //       #animation-container 內的間距、置中與 #stats-bar 切換動畫)，
  //       改於目標元素內部以隱藏容器封裝原有子節點，避免在父容器插入兄弟節點造成跑版。
  // =======================================================
  renderDualInside: function (target, handle, displayName, fullName, subs, isExpired) {
    if (!target.isConnected) return;

    const sibling = target.previousElementSibling;
    if (sibling && sibling.classList && sibling.classList.contains(this.DUAL_CLASS)) {
      sibling.remove();
      target.style.removeProperty("display");
    }

    let node = target.querySelector(":scope > ." + this.DUAL_CLASS);
    let hidden = target.querySelector(":scope > ." + this.NATIVE_HIDDEN_CLASS);
    const hadHidden = !!hidden;

    if (!hidden) {
      hidden = document.createElement("span");
      hidden.className = this.NATIVE_HIDDEN_CLASS;
      hidden.style.setProperty("display", "none", "important");
    }

    const toMove = [];
    for (const child of Array.from(target.childNodes)) {
      if (child !== node && child !== hidden) toMove.push(child);
    }
    if (toMove.length > 0) {
      if (hadHidden) hidden.textContent = "";
      toMove.forEach((child) => hidden.appendChild(child));
    }

    if (!node) {
      node = document.createElement("span");
      node.className = this.DUAL_CLASS;
      target.insertBefore(node, target.firstChild);
    }
    if (!hidden.parentNode) {
      target.appendChild(hidden);
    }

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
    delete target.dataset.rnBound;
    this.attachData(node, handle, fullName, subs, isExpired);

    target.dataset.rnReplaced = "yes";
    target.dataset.rnDual = "inside";
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
    if (target.dataset && target.dataset.rnDual === "inside") {
      const node = target.querySelector(":scope > ." + this.DUAL_CLASS);
      if (node) node.remove();
      const hidden = target.querySelector(":scope > ." + this.NATIVE_HIDDEN_CLASS);
      if (hidden) {
        while (hidden.firstChild) {
          target.insertBefore(hidden.firstChild, hidden);
        }
        hidden.remove();
      }
      delete target.dataset.rnDual;
      delete target.dataset.rnReplaced;
      delete target.dataset.rnExpired;
      delete target.dataset.rnTargetHandle;
      return;
    }
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

  // =======================================================
  // 標籤 (主播公開的自訂標籤與記憶標籤)
  // 用途：在作者名稱後方插入一排小標籤；同一個元素換人時先清掉舊的。
  // =======================================================
  TAG_CLASS: "sm-viewer-tags",

  clearTags: function (target) {
    const next = target && target.nextElementSibling;
    if (next && next.classList && next.classList.contains(this.TAG_CLASS)) {
      next.remove();
    }
    if (target) delete target.dataset.smTagHandle;
  },

  NICK_CLASS: "sm-viewer-nick",

  // customNickname：主播公開的自訂暱稱。主名稱維持官方頻道名稱，暱稱以括號附在名稱後方。
  renderTags: function (target, handle, chips, customNickname) {
    if (!target || !target.isConnected) return;
    this.clearTags(target);
    target.dataset.smTagHandle = handle;
    if (!Array.isArray(chips)) chips = [];
    if (chips.length === 0 && !customNickname) return;

    const box = document.createElement("span");
    box.className = this.TAG_CLASS;
    Object.assign(box.style, {
      display: "inline-flex",
      flexWrap: "wrap",
      alignItems: "center",
      gap: "3px",
      marginLeft: "4px",
      marginRight: "4px",
      verticalAlign: "middle",
    });

    if (customNickname) {
      const nick = document.createElement("span");
      nick.className = this.NICK_CLASS;
      nick.textContent = "[" + customNickname + "]";
      nick.title = I18n.t("streamer_nickname");
      Object.assign(nick.style, {
        fontSize: "12px",
        lineHeight: "16px",
        opacity: "0.85",
        whiteSpace: "nowrap",
        maxWidth: "160px",
        overflow: "hidden",
        textOverflow: "ellipsis",
      });
      box.appendChild(nick);
    }

    chips.slice(0, 8).forEach((chip) => {
      const el = document.createElement("span");
      el.textContent = chip.label;
      Object.assign(el.style, {
        display: "inline-block",
        padding: "0 5px",
        borderRadius: "8px",
        fontSize: "11px",
        lineHeight: "16px",
        fontWeight: "500",
        whiteSpace: "nowrap",
        maxWidth: "140px",
        overflow: "hidden",
        textOverflow: "ellipsis",
      });
      if (chip.color) {
        el.style.background = chip.color;
        el.style.color = this.contrastText(chip.color);
      } else {
        el.style.background = "rgba(128, 128, 128, 0.25)";
        el.style.color = "inherit";
      }
      box.appendChild(el);
    });

    target.insertAdjacentElement("afterend", box);
  },

  // 依背景色亮度選擇黑字或白字
  contrastText: function (hex) {
    let h = hex.replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 >= 150 ? "#111111" : "#ffffff";
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
    // 不設原生 title：名稱只顯示擴充功能自己的一個提示
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

  // 徽章不設原生 title，避免滑鼠經過時同時出現瀏覽器提示與擴充功能的提示
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
      i.setAttribute("aria-label", I18n.t("subs_million"));
    } else if (subs >= 100000) {
      i.style.background = "#FFD700";
      i.setAttribute("aria-label", I18n.t("subs_100k"));
    } else if (subs >= 10000) {
      i.style.background = "#C0C0C0";
      i.setAttribute("aria-label", I18n.t("subs_10k"));
    } else if (subs >= 1000) {
      i.style.background = "#CD7F32";
      i.setAttribute("aria-label", I18n.t("subs_1000")); 
    } else if (subs >= 500) {
      i.style.background = "#8D6E63";
      i.setAttribute("aria-label", I18n.t("subs_potential"));
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

  // 額外的懸停資訊來源 (例如聊天室名稱的本機暱稱與備註)：回傳 info 物件即由它決定提示內容，回傳 null 則交給下一個
  hoverProviders: [],

  addHoverProvider: function (fn) {
    if (typeof fn !== "function") return;
    this.init();
    this.hoverProviders.push(fn);
  },

  hide: function () {
    if (this.tooltipEl && this.tooltipEl.style.opacity !== "0") {
      this.tooltipEl.style.opacity = "0";
      this.tooltipEl.style.transform = "translateY(5px)";
    }
  },

  handleMouseMove: function (e) {
    for (const provider of this.hoverProviders) {
      let info = null;
      try {
        info = provider(e);
      } catch {
        info = null;
      }
      if (info) {
        this.showInfo(e, info);
        return;
      }
    }
    const target = e.target && e.target.closest ? e.target.closest('[data-rn-bound="true"]') : null;
    if (!target) {
      this.hide();
      return;
    }
    this.show(e, target);
  },

  show: function (e, target) {
    this.showInfo(e, {
      name: target.dataset.rnName || I18n.t("loading"),
      handle: target.dataset.rnHandle || "",
      subs: parseInt(target.dataset.rnSubs || "0"),
      isExpired: target.dataset.rnExpired === "true",
    });
  },

  /**
   * info: { name, handle, subs, isExpired, original?, member?, notes?, hint? }
   * original：顯示自訂暱稱時的原頻道名稱；member：會員徽章文字 (例如「會員 (6 個月)」)；
   * notes：本機備註 (最多顯示 3 則)；hint：底部的操作提示。
   */
  showInfo: function (e, info) {
    if (!this.tooltipEl) this.createTooltipElement();
    this.updateTheme();

    const name = info.name || I18n.t("loading");
    const handle = info.handle || "";
    const subs = parseInt(info.subs || 0) || 0;
    const isExpired = !!info.isExpired;

    this.tooltipEl.replaceChildren();

    const nameDiv = document.createElement("div");
    Object.assign(nameDiv.style, {
      fontWeight: "600",
      fontSize: "1.1em",
      marginBottom: "2px",
    });
    nameDiv.textContent = name;
    this.tooltipEl.appendChild(nameDiv);

    if (info.original) {
      const origDiv = document.createElement("div");
      Object.assign(origDiv.style, { fontSize: "0.9em", opacity: "0.85" });
      origDiv.textContent = I18n.t("tooltip_original_name", { name: info.original });
      this.tooltipEl.appendChild(origDiv);
    }

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

    const addLine = (icon, text) => {
      const div = document.createElement("div");
      Object.assign(div.style, {
        marginTop: "6px",
        fontSize: "0.85em",
        display: "flex",
        alignItems: "center",
        gap: "4px",
      });
      const iconSpan = document.createElement("span");
      iconSpan.textContent = icon;
      const textSpan = document.createElement("span");
      textSpan.textContent = text;
      div.append(iconSpan, textSpan);
      this.tooltipEl.appendChild(div);
    };

    if (subs > 0) {
      addLine("👥", I18n.t("subs_count", { count: new Intl.NumberFormat().format(subs) }));
    }
    if (info.member) {
      addLine("🎖️", info.member);
    }

    const notes = Array.isArray(info.notes) ? info.notes.filter(Boolean) : [];
    if (notes.length > 0) {
      const box = document.createElement("div");
      Object.assign(box.style, {
        marginTop: "6px",
        paddingTop: "4px",
        borderTop: "1px dashed rgba(128,128,128,0.3)",
        fontSize: "0.85em",
      });
      const head = document.createElement("div");
      head.style.fontWeight = "600";
      head.textContent = "📝 " + I18n.t("local_notes_title");
      box.appendChild(head);
      notes.slice(0, 3).forEach((n) => {
        const line = document.createElement("div");
        line.textContent = "• " + (n.length > 80 ? n.slice(0, 80) + "…" : n);
        box.appendChild(line);
      });
      if (notes.length > 3) {
        const more = document.createElement("div");
        more.style.opacity = "0.7";
        more.textContent = I18n.t("tooltip_more_notes", { count: notes.length - 3 });
        box.appendChild(more);
      }
      this.tooltipEl.appendChild(box);
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

    if (info.hint) {
      const hintDiv = document.createElement("div");
      Object.assign(hintDiv.style, { marginTop: "6px", fontSize: "0.8em", opacity: "0.65" });
      hintDiv.textContent = info.hint;
      this.tooltipEl.appendChild(hintDiv);
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