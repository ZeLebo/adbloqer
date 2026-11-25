const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const directory = path.join(__dirname, "../search");

function frame() {
  const window = {};
  const context = vm.createContext({ window });
  vm.runInContext(fs.readFileSync(path.join(directory, "player.js"), "utf8"), context);
  return { window, context };
}

test("Search installs the script before the player starts in its own frame", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.content_scripts, [{
    matches: ["https://ceramet.net/bil/*"],
    js: ["player.js"],
    all_frames: true,
    run_at: "document_start",
    world: "MAIN"
  }]);
});

test("recognised player skips the ad bootstrap and keeps its media configuration", () => {
  const { window, context } = frame();
  vm.runInContext(`
    window.playerData = { config: { video: "stream", duration: 90 }, playlist: { current: 1 } };
    window.adsConfig = { rolls: { startroll: {}, midroll: {}, pauseroll: {} }, film: {} };
    window.adallow = true;
    window.dConf.showRadish = true;
    window.startsAds = !(window.adallow === false && window.dConf.showRadish === false);
  `, context);
  assert.equal(window.startsAds, false);
  assert.equal(window.playerData.config.video, "stream");
  assert.ok(window.adsConfig.rolls.startroll);
  assert.equal(Object.getOwnPropertyDescriptor(window, "adsConfig").writable, true);
});

test("an unrecognised page retains its assignment and advertising flags", () => {
  const { window } = frame();
  window.playerData = { config: { video: "stream" } };
  const config = { rolls: { startroll: {} } };
  window.adsConfig = config;
  assert.equal(window.adsConfig, config);
  assert.equal("dConf" in window, false);
  assert.equal("adallow" in window, false);
});
