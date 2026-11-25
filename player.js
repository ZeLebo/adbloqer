"use strict";

const AdbloqerPlayer = (() => {
  function disableAds() {
    const config = window.dConf || (window.dConf = {});
    // The ad detector can otherwise re-enable the ad manager after startup.
    const disabled = { get: () => false, set() {}, configurable: false, enumerable: true };
    Object.defineProperty(config, "showRadish", disabled);
    Object.defineProperty(window, "adallow", disabled);
  }

  const bootstrap = `\n;/* Adbloqer */(${disableAds.toString()})();\n`;

  function assignment(script, name) {
    if (script.hasAttribute("src")) return null;
    const type = script.getAttribute("type")?.trim().toLowerCase();
    if (type && type !== "text/javascript" && type !== "application/javascript") return null;
    const match = script.textContent.match(new RegExp(`^\\s*window\\.${name}\\s*=\\s*(\\{[\\s\\S]*\\})\\s*;?\\s*$`));
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }

  function rewrite(html) {
    if (!html.includes("window.playerData") || !html.includes("window.adsConfig")) return html;

    // A detached template parses HTML without running scripts or fetching resources.
    const template = document.createElement("template");
    template.innerHTML = html;
    if ([...template.content.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]')]
      .some(meta => /'sha(?:256|384|512)-/i.test(meta.content))) return html;

    const scripts = [...template.content.querySelectorAll("script")];
    const playerIndex = scripts.findIndex(script => {
      const data = assignment(script, "playerData");
      return typeof data?.config?.video === "string" && data.config.video.length > 0 &&
        typeof data.config.duration === "number" && data.playlist?.current != null;
    });
    if (playerIndex < 0) return html;

    const script = scripts.slice(playerIndex + 1).find(script => {
      const data = assignment(script, "adsConfig");
      return data?.rolls?.startroll != null && data.rolls.midroll != null &&
        data.rolls.pauseroll != null && data.film != null;
    });
    if (!script) return html;

    // Native HTML parsing normalizes line endings; keep the original response bytes.
    const normalized = html.replace(/\r\n?/g, "\n");
    const source = script.textContent;
    const start = normalized.indexOf(source);
    if (start < 0 || normalized.indexOf(source, start + 1) >= 0) return html;
    let end = start + source.length;
    for (let i = 0; i < end; i++) {
      if (html[i] === "\r" && html[i + 1] === "\n") {
        end++;
        i++;
      }
    }
    return html.slice(0, end) + bootstrap + html.slice(end);
  }

  return { rewrite };
})();
