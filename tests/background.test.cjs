const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");

function harness(rewrite = html => html) {
  const writes = [];
  const timers = new Map();
  const filter = {
    disconnected: 0,
    write(data) { writes.push(Buffer.from(data)); },
    disconnect() { this.disconnected++; },
  };
  let listener;
  let created = 0;
  let registration;
  const context = vm.createContext({
    TextDecoder, TextEncoder, URL, Uint8Array,
    console: { warn() {}, info() {} },
    setTimeout(fn) { const id = timers.size + 1; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    AdbloqerPlayer: { rewrite },
    browser: { webRequest: {
      onHeadersReceived: { addListener(fn, ...args) { listener = fn; registration = args; } },
      filterResponseData() { created++; return filter; },
    } },
  });
  vm.runInContext(source, context);
  return {
    filter, timers,
    get created() { return created; },
    get registration() { return JSON.parse(JSON.stringify(registration)); },
    output() { return Buffer.concat(writes); },
    start(overrides = {}) {
      listener({requestId: "test", url: "https://new-player.example.test/frame", method: "GET", statusCode: 200,
        responseHeaders: [{name: "content-type", value: "text/html; charset=UTF-8"}], ...overrides});
    },
    data(bytes) {
      const copy = Uint8Array.from(bytes);
      filter.ondata({data: copy.buffer});
    },
  };
}

test("requests all HTTPS documents, without hostname rules or media interception", () => {
  const h = harness();
  assert.deepEqual(h.registration, [
    {urls: ["https://*/*"], types: ["main_frame", "sub_frame"]},
    ["blocking", "responseHeaders"],
  ]);
});

test("does not filter media, redirects, other encodings, or CSP hashes", () => {
  for (const overrides of [
    {statusCode: 302}, {method: "POST"},
    {responseHeaders: [{name: "content-type", value: "video/mp2t"}]},
    {responseHeaders: [{name: "content-type", value: "application/vnd.apple.mpegurl"}]},
    {responseHeaders: [{name: "content-type", value: "text/html; charset=windows-1251"}]},
    {responseHeaders: [{name: "content-type", value: "text/html"},
      {name: "content-security-policy", value: "script-src 'sha256-fixture'"}]},
  ]) {
    const h = harness();
    h.start(overrides);
    assert.equal(h.created, 0);
  }
});

test("passes unrelated HTML through byte for byte, including BOM and split UTF-8", () => {
  const h = harness();
  const input = Buffer.from("\uFEFF<html>Видео 😀\r\n</html>");
  h.start();
  for (const byte of input) h.data([byte]);
  h.filter.onstop();
  assert.deepEqual(h.output(), input);
  assert.equal(h.filter.disconnected, 1);
  assert.equal(h.timers.size, 0);
});

test("preserves pending UTF-8 bytes when the document is prepared mid-chunk", () => {
  const h = harness(html => html.includes("</script>") ? html.replace("</script>", ";disabled();</script>") : html);
  const input = Buffer.from("<script>config();</script>Я");
  h.start();
  h.data(input.subarray(0, -1));
  // The rest arrives after disconnect and is forwarded by the browser.
  const output = Buffer.concat([h.output(), input.subarray(-1)]);
  assert.equal(output.toString(), "<script>config();;disabled();</script>Я");
  assert.equal(h.filter.disconnected, 1);
});

test("releases buffered HTML when the byte budget or timeout is reached", () => {
  for (const timeout of [false, true]) {
    const h = harness();
    const input = Buffer.alloc(timeout ? 100 : 65537, 65);
    h.start();
    h.data(input);
    if (timeout) [...h.timers.values()][0]();
    assert.deepEqual(h.output(), input);
    assert.equal(h.filter.disconnected, 1);
    assert.equal(h.timers.size, 0);
  }
});

test("invalid UTF-8 and processing errors preserve the original response", () => {
  for (const [input, rewrite] of [
    [Buffer.from([0xff, 0xfe, 0x41]), html => html],
    [Buffer.from("<html>unchanged</html>"), () => { throw new Error("fixture"); }],
  ]) {
    const h = harness(rewrite);
    h.start();
    h.data(input);
    assert.deepEqual(h.output(), input);
    assert.equal(h.filter.disconnected, 1);
  }
});

test("cancelled responses clear their timer without writing to an errored stream", () => {
  const h = harness();
  h.start();
  h.data(Buffer.from("<html>"));
  h.filter.error = "NS_BINDING_ABORTED";
  h.filter.onerror();
  assert.equal(h.timers.size, 0);
  assert.equal(h.output().length, 0);
  h.filter.onstop();
  assert.equal(h.filter.disconnected, 0);
});
