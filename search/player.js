"use strict";

(() => {
  if (Object.hasOwn(window, "adsConfig")) return;

  Object.defineProperty(window, "adsConfig", {
    configurable: true,
    set(ads) {
      Object.defineProperty(window, "adsConfig", {
        value: ads, writable: true, configurable: true, enumerable: true
      });

      const player = window.playerData;
      if (typeof player?.config?.video !== "string" || !player.config.video ||
          typeof player.config.duration !== "number" || player.playlist?.current == null ||
          ads?.rolls?.startroll == null || ads.rolls.midroll == null ||
          ads.rolls.pauseroll == null || ads.film == null) return;

      const config = window.dConf || (window.dConf = {});
      const disabled = { get: () => false, set() {}, enumerable: true };
      Object.defineProperty(config, "showRadish", disabled);
      Object.defineProperty(window, "adallow", disabled);
    }
  });
})();
