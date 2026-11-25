const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn } = require("node:child_process");

const root = path.join(__dirname, "..");
for (const file of ["player.js", "tests/browser.js"]) {
  new vm.Script(fs.readFileSync(path.join(root, file), "utf8"), {filename: file});
}
const binary = process.env.ADBLOQER_BROWSER || "/Applications/Zen.app/Contents/MacOS/zen";
if (!fs.existsSync(binary)) {
  console.error("Set ADBLOQER_BROWSER to a Firefox/Zen executable.");
  process.exit(1);
}

let capture = {};
const capturePath = path.join(root, "player-full.har");
if (fs.existsSync(capturePath)) {
  const entries = JSON.parse(fs.readFileSync(capturePath, "utf8")).log.entries;
  const html = entries.find(entry => entry.response.content.text?.includes("window.adsConfig =") &&
    entry.response.content.text.includes("window.playerData ="))?.response.content.text;
  const bundle = entries.find(entry => entry.response.content.mimeType?.includes("javascript") &&
    entry.response.content.text?.includes("_initVastLinear(){"))?.response.content.text;
  if (html && bundle) {
    const init = "init(){window.dConf||(window.dConf={}),this._initVastLinear()}";
    const start = bundle.indexOf(init);
    const end = bundle.indexOf("}_resetVastBanners(){", start) + 1;
    if (start < 0 || end <= start) throw new Error("Captured ad manager format changed");
    capture = {html, methods: bundle.slice(start, end)};
  }
}

const files = new Map([
  ["/", ["tests/browser.html", "text/html; charset=utf-8"]],
  ["/player.js", ["player.js", "application/javascript"]],
  ["/browser.js", ["tests/browser.js", "application/javascript"]],
  ["/fixture", ["tests/fixtures/player.html", "text/plain; charset=utf-8"]],
]);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "adbloqer-browser-"));
fs.writeFileSync(path.join(profile, "user.js"), [
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("browser.startup.homepage_override.mstone", "ignore");',
  'user_pref("network.proxy.type", 1);',
  'user_pref("network.proxy.http", "127.0.0.1");',
  'user_pref("network.proxy.http_port", 9);',
  'user_pref("network.proxy.ssl", "127.0.0.1");',
  'user_pref("network.proxy.ssl_port", 9);',
  'user_pref("network.proxy.no_proxies_on", "localhost, 127.0.0.1");',
].join("\n"));

let browser;
let unexpected = 0;
let completed = false;
let stderr = "";
let timeout;
const requested = new Set();

function finish(error, results = []) {
  if (completed) return;
  completed = true;
  clearTimeout(timeout);
  if (error) console.error(`${error}\nLocal requests: ${[...requested].join(", ") || "none"}`);
  for (const result of results) console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}${result.error ? ": " + result.error : ""}`);
  process.exitCode = error || results.some(result => !result.passed) ? 1 : 0;
  if (browser && browser.exitCode === null) browser.kill("SIGTERM");
  server.close();
  if (!browser || browser.exitCode !== null) fs.rmSync(profile, {recursive: true, force: true});
  else browser.once("exit", () => fs.rmSync(profile, {recursive: true, force: true}));
}

const server = http.createServer((request, response) => {
  requested.add(request.url);
  if (request.url === "/results" && request.method === "POST") {
    let body = "";
    request.on("data", chunk => { body += chunk; if (body.length > 65536) request.destroy(); });
    request.on("end", () => {
      response.end("ok");
      try { finish(null, JSON.parse(body)); } catch (error) { finish(error.message); }
    });
    return;
  }
  if (request.url === "/capture" || request.url === "/counts") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url === "/capture" ? capture : {unexpected}));
    return;
  }
  if (request.url === "/unexpected-resource") unexpected++;
  const file = files.get(request.url);
  if (!file) { response.writeHead(404); response.end(); return; }
  response.setHeader("Content-Type", file[1]);
  response.end(fs.readFileSync(path.join(root, file[0])));
});
server.on("error", error => finish(error.message));
server.listen(0, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  browser = spawn(binary, ["--headless", "--no-remote", "--profile", profile, url], {stdio: ["ignore", "ignore", "pipe"]});
  browser.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-3000); });
  browser.on("error", error => finish(error.message));
  browser.on("exit", code => { if (!completed) finish(`Browser exited (${code}): ${stderr}`); });
  timeout = setTimeout(() => finish(`Browser checks timed out: ${stderr}`), 45000);
});
