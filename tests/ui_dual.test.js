const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createFakeDom() {
  class FakeStyle {
    constructor() {
      this._props = new Map();
    }
    setProperty(k, v) {
      this._props.set(k, v);
      const camel = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this[camel] = v;
    }
    getPropertyValue(k) {
      return this._props.get(k) || "";
    }
    removeProperty(k) {
      this._props.delete(k);
      const camel = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      delete this[camel];
    }
  }

  class FakeClassList {
    constructor(el) {
      this._el = el;
    }
    _list() {
      return (this._el.className || "").trim().split(/\s+/).filter(Boolean);
    }
    contains(c) {
      return this._list().includes(c);
    }
  }

  class FakeText {
    constructor(text) {
      this.nodeType = 3;
      this.data = String(text);
      this.parentNode = null;
    }
    get textContent() {
      return this.data;
    }
    set textContent(v) {
      this.data = String(v);
    }
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
  }

  class FakeElement {
    constructor(tag) {
      this.nodeType = 1;
      this.tagName = tag.toUpperCase();
      this.id = "";
      this.className = "";
      this.classList = new FakeClassList(this);
      this.dataset = {};
      this.style = new FakeStyle();
      this.childNodes = [];
      this.parentNode = null;
      this.isConnected = true;
    }
    get firstChild() {
      return this.childNodes[0] || null;
    }
    get previousElementSibling() {
      if (!this.parentNode) return null;
      const idx = this.parentNode.childNodes.indexOf(this);
      for (let i = idx - 1; i >= 0; i--) {
        if (this.parentNode.childNodes[i].nodeType === 1) return this.parentNode.childNodes[i];
      }
      return null;
    }
    get textContent() {
      return this.childNodes.map((c) => c.textContent).join("");
    }
    set textContent(v) {
      for (const c of this.childNodes) c.parentNode = null;
      this.childNodes = [];
      if (v !== "" && v != null) this.appendChild(new FakeText(v));
    }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    insertBefore(child, ref) {
      if (!ref) return this.appendChild(child);
      if (child.parentNode) child.parentNode.removeChild(child);
      const idx = this.childNodes.indexOf(ref);
      if (idx === -1) return this.appendChild(child);
      child.parentNode = this;
      this.childNodes.splice(idx, 0, child);
      return child;
    }
    removeChild(child) {
      const idx = this.childNodes.indexOf(child);
      if (idx !== -1) {
        this.childNodes.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    }
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
    querySelector(sel) {
      const directClass = sel.match(/^:scope\s*>\s*\.([a-zA-Z0-9_-]+)$/);
      if (directClass) {
        return (
          this.childNodes.find(
            (c) => c.nodeType === 1 && c.classList.contains(directClass[1])
          ) || null
        );
      }
      return null;
    }
    addEventListener() {}
  }

  const document = {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (t) => new FakeText(t),
    addEventListener: () => {},
  };
  const window = {
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
  };

  return { document, window, FakeElement, FakeText };
}

function loadTooltipManager() {
  const dom = createFakeDom();
  const ctx = vm.createContext({
    document: dom.document,
    window: dom.window,
    I18n: { t: (k) => k },
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout,
    console,
  });
  const src = fs.readFileSync(
    path.resolve(__dirname, "../js/content/ui.js"),
    "utf8"
  );
  vm.runInContext(`${src}\nthis.TooltipManager = TooltipManager;`, ctx);
  return { TooltipManager: ctx.TooltipManager, ...dom };
}

test("renderDualInside：跑馬燈 #text 保留在父容器原位，不插入兄弟節點影響 #stats-bar 排版", () => {
  const { TooltipManager, document } = loadTooltipManager();

  const anim = document.createElement("div");
  anim.id = "animation-container";
  const textEl = document.createElement("div");
  textEl.id = "text";
  const origTextNode = document.createTextNode("@comar775");
  textEl.appendChild(origTextNode);
  const statsBar = document.createElement("div");
  statsBar.id = "stats-bar";
  anim.appendChild(textEl);
  anim.appendChild(statsBar);

  TooltipManager.renderDualInside(textEl, "@comar775", "comar", "comar", 0, false);

  // 父容器 #animation-container 僅維持原本的 2 個子節點 (#text 與 #stats-bar)
  assert.deepEqual(anim.childNodes, [textEl, statsBar]);
  // #text 本身不被隱藏，維持原生定位與動畫樣式
  assert.equal(textEl.style.getPropertyValue("display"), "");
  assert.equal(textEl.dataset.rnDual, "inside");
  assert.equal(textEl.dataset.rnReplaced, "yes");

  // 還原名稱在 #text 內部，且原始 TextNode 完整保留在隱藏容器中 (不破壞 Polymer 綁定)
  const restored = TooltipManager.findDualNode(textEl);
  assert.ok(restored);
  assert.equal(restored.parentNode, textEl);
  assert.equal(restored.textContent, "comar");
  assert.equal(restored.dataset.rnBound, "true");

  const hidden = textEl.querySelector(":scope > .rn-native-hidden");
  assert.ok(hidden);
  assert.equal(hidden.style.getPropertyValue("display"), "none");
  assert.equal(hidden.firstChild, origTextNode);
  assert.equal(hidden.textContent, "@comar775");

  // 重複更新名稱時不重複插入節點
  TooltipManager.renderDualInside(textEl, "@comar775", "Comar New", "Comar New", 12000, false);
  assert.equal(textEl.childNodes.length, 2);
  assert.equal(TooltipManager.findDualNode(textEl).textContent, "Comar New");
  assert.equal(hidden.firstChild, origTextNode);

  // 還原回原生狀態時，將原 TextNode 搬回 #text 並清除擴充節點
  TooltipManager.restoreDual(textEl);
  assert.deepEqual(textEl.childNodes, [origTextNode]);
  assert.equal(textEl.textContent, "@comar775");
  assert.equal(textEl.dataset.rnDual, undefined);
  assert.equal(textEl.dataset.rnReplaced, undefined);
});

test("renderStandard：標記 rnInPlaceDual 且有訂閱徽章時不覆寫目標元素本身的 display", () => {
  const { TooltipManager, document } = loadTooltipManager();
  const textEl = document.createElement("div");
  textEl.id = "text";
  textEl.dataset.rnInPlaceDual = "1";
  textEl.textContent = "@comar775";

  TooltipManager.renderStandard(textEl, "@comar775", "comar", 50000, false);
  assert.equal(textEl.style.display, undefined);
  assert.equal(textEl.textContent, "comar");
  assert.equal(textEl.dataset.rnReplaced, "yes");
});
