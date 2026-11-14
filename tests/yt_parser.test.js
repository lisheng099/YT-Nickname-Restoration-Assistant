const test = require("node:test");
const assert = require("node:assert/strict");
const { YTParser } = require("../js/background/yt_parser.js");

function page(data, extra = "") {
  return `<html><head>${extra}</head><body><script>var ytInitialData = ${JSON.stringify(
    data
  )};</script></body></html>`;
}

function header(name, rows) {
  return {
    header: {
      pageHeaderRenderer: {
        content: {
          pageHeaderViewModel: {
            title: { dynamicTextViewModel: { text: { content: name } } },
            metadata: { contentMetadataViewModel: { metadataRows: rows } },
          },
        },
      },
    },
  };
}

const row = (...texts) => ({
  metadataParts: texts.map((t) => ({ text: { content: t } })),
});

test("標準版面：名稱與第二行的訂閱數", () => {
  const html = page(header("小明頻道", [row("@ming"), row("1.5萬位訂閱者", "20 部影片")]));
  assert.deepEqual(YTParser.parse(html), { nameRaw: "小明頻道", subs: 15000 });
});

test("簡約版面：在第一行以關鍵字找訂閱數", () => {
  const html = page(header("Ming", [row("@ming", "2.3K subscribers")]));
  assert.deepEqual(YTParser.parse(html), { nameRaw: "Ming", subs: 2300 });
});

test("名稱或描述含有 }; 時仍能完整解析", () => {
  const data = header("a}; b", [row("@x"), row("12萬位訂閱者")]);
  data.description = 'function(){ return "};" };';
  assert.deepEqual(YTParser.parse(page(data)), { nameRaw: "a}; b", subs: 120000 });
});

test("字串內的跳脫引號不影響括號配對", () => {
  const data = header('He said "hi" {', [row("@x"), row("900 subscribers")]);
  assert.deepEqual(YTParser.parse(page(data)), { nameRaw: 'He said "hi" {', subs: 900 });
});

test("500 以下的訂閱數視為 0", () => {
  const html = page(header("Tiny", [row("@t"), row("120 subscribers")]));
  assert.equal(YTParser.parse(html).subs, 0);
});

test("舊版 c4TabbedHeaderRenderer", () => {
  const html = page({
    header: {
      c4TabbedHeaderRenderer: {
        title: "Old Layout",
        subscriberCountText: { simpleText: "3.2M subscribers" },
      },
    },
  });
  assert.deepEqual(YTParser.parse(html), { nameRaw: "Old Layout", subs: 3200000 });
});

test("沒有 ytInitialData 時改用 og:title", () => {
  const html = '<html><head><meta property="og:title" content="Tom &amp; Jerry"></head></html>';
  assert.deepEqual(YTParser.parse(html), { nameRaw: "Tom &amp; Jerry", subs: 0 });
});

test("完全沒有名稱時回傳 null", () => {
  assert.equal(YTParser.parse("<html></html>"), null);
  assert.equal(YTParser.parse(""), null);
  assert.equal(YTParser.parse(page({ header: {} })), null);
});

test("parseSubsString 支援各語系單位", () => {
  const cases = [
    ["1.5萬位訂閱者", 15000],
    ["1.5万人", 15000],
    ["チャンネル登録者数 12.3万人", 123000],
    ["2億", 200000000],
    ["구독자 3.4만명", 34000],
    ["구독자 5천명", 5000],
    ["8千", 8000],
    ["1.2K subscribers", 1200],
    ["1.2M subscribers", 1200000],
    ["1.01B subscribers", 1010000000],
    ["1,234 subscribers", 1234],
    ["532 subscribers", 532],
    ["No subscribers", 0],
    ["", 0],
  ];
  for (const [input, expected] of cases) {
    assert.equal(YTParser.parseSubsString(input), expected, input);
  }
});
