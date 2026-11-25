"use strict";

(async () => {
  const results = [];
  function assert(value, message) {
    if (!value) throw new Error(message);
  }
  function scripts(html) {
    const template = document.createElement("template");
    template.innerHTML = html;
    return [...template.content.querySelectorAll("script")].map(script => script.textContent);
  }
  async function check(name, fn) {
    try {
      await fn();
      results.push({name, passed: true});
    } catch (error) {
      results.push({name, passed: false, error: error.message});
    }
  }

  try {
    const fixture = await (await fetch("/fixture")).text();
    const prepared = AdbloqerPlayer.rewrite(fixture);
    await check("prepares a player on any domain, preserving all original HTML", () => {
      assert(prepared.includes("/* Adbloqer */"), "bootstrap missing");
      const original = scripts(fixture);
      const changed = scripts(prepared);
      assert(changed.length === original.length, "script count changed");
      assert(changed[0] === original[0], "video configuration changed");
      assert(changed[1].startsWith(original[1]), "ad configuration was replaced");
      assert(changed[2] === original[2], "loader changed");
      assert(prepared.replace(changed[1], original[1]) === fixture, "unrelated HTML changed");
    });
    await check("disables ad initialization and prevents later re-enabling", () => {
      const page = {};
      new Function("window", scripts(prepared).slice(0, 2).join("\n"))(page);
      assert(page.dConf.showRadish === false && page.adallow === false, "ad flags active");
      new Function("window", '"use strict"; window.adallow = true; window.dConf.showRadish = true;')(page);
      assert(page.dConf.showRadish === false && page.adallow === false, "ad detector re-enabled ads");
      assert(page.playerData.config.with_ads === 0, "unrelated with_ads flag changed");
    });
    await check("preserves CRLF line endings and remains idempotent", () => {
      const crlf = fixture.replaceAll("\n", "\r\n");
      const output = AdbloqerPlayer.rewrite(crlf);
      assert(output !== crlf, "CRLF fixture not recognized");
      assert(output.replace(/\n;\/\* Adbloqer \*\/[\s\S]*?\}\)\(\);\n/, "") === crlf, "line endings changed");
      assert(AdbloqerPlayer.rewrite(output) === output, "bootstrap duplicated");
    });
    await check("ignores unrelated, inert, incomplete, and hash-protected configurations", () => {
      const inert = [
        "<!doctype html><title>ordinary site</title><p>Видео</p>",
        "<!--" + fixture + "-->",
        "<template>" + fixture + "</template>",
        "<textarea>" + fixture + "</textarea>",
        "<noscript>" + fixture + "</noscript>",
        fixture.replace("window.adsConfig =", "window.otherConfig ="),
        fixture.replace('"startroll":{', '"otherroll":{'),
        fixture.replace("window.adsConfig =", "window.adsConfig = invalid"),
        fixture.replace("<script>window.adsConfig", '<script type="application/json">window.adsConfig'),
        fixture.replace("<script>window.adsConfig", '<script src="/external.js">window.adsConfig'),
        fixture.replace("<head>", '<head><meta http-equiv="Content-Security-Policy" content="script-src &#39;sha256-fixture&#39;">'),
      ];
      for (const html of inert) assert(AdbloqerPlayer.rewrite(html) === html, "unrelated or protected HTML changed");
    });
    await check("template inspection does not execute code or request resources", async () => {
      window.unexpectedExecution = false;
      const html = fixture.replace("</body>", '<script>window.unexpectedExecution = true;</script><img src="/unexpected-resource"></body>');
      AdbloqerPlayer.rewrite(html);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert(window.unexpectedExecution === false, "script executed during inspection");
      const counts = await (await fetch("/counts")).json();
      assert(counts.unexpected === 0, "inspection fetched a resource");
    });

    const capture = await (await fetch("/capture")).json();
    if (capture.html) {
      await check("real HAR player keeps media configuration and skips the original ad manager", () => {
        const output = AdbloqerPlayer.rewrite(capture.html);
        assert(output !== capture.html, "captured player not recognized");
        const originalScripts = scripts(capture.html);
        const preparedScripts = scripts(output);
        assert(originalScripts[0] === preparedScripts[0], "captured media configuration changed");
        const probe = new Function("window", `class Probe { ${capture.methods} _createInitVastEl(){throw new Error('AD_INIT_REACHED')} } try {new Probe().init(); return 'SKIPPED'} catch(e){if(e.message !== 'AD_INIT_REACHED') throw e; return e.message}`);
        const originalPage = {};
        new Function("window", originalScripts.slice(0, 2).join("\n"))(originalPage);
        assert(probe(originalPage) === "AD_INIT_REACHED", "original ad init did not reproduce");
        const preparedPage = {};
        new Function("window", preparedScripts.slice(0, 2).join("\n"))(preparedPage);
        assert(probe(preparedPage) === "SKIPPED", "captured ad manager initialized");
        assert(JSON.stringify(originalPage.playerData) === JSON.stringify(preparedPage.playerData), "captured video data changed");
      });
    }
  } catch (error) {
    results.push({name: "browser harness", passed: false, error: error.message});
  }
  await fetch("/results", {method: "POST", body: JSON.stringify(results)});
})();
