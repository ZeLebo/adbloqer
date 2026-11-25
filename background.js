"use strict";

// shortcut: inspect at most the first 64 KiB / 1 s; increase only for a real player fixture.
const MAX_PREFIX_BYTES = 64 * 1024;
const MAX_WAIT_MS = 1000;

function prepareResponse(details) {
  if (details.statusCode !== 200 || details.method !== "GET") return;
  const headers = details.responseHeaders || [];
  const contentType = headers.find(header => header.name.toLowerCase() === "content-type")?.value || "";
  if (!/^text\/html(?:\s*;|\s*$)/i.test(contentType)) return;
  const charset = contentType.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1];
  if (charset && !/^(utf-8|utf8|us-ascii)$/i.test(charset)) return;
  if (headers.some(header => header.name.toLowerCase() === "content-security-policy" &&
    /'sha(?:256|384|512)-/i.test(header.value || ""))) return;

  let filter;
  try {
    filter = browser.webRequest.filterResponseData(details.requestId);
  } catch (error) {
    console.warn("[Adbloqer] Cannot inspect response:", error.message);
    return;
  }

  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const chunks = [];
  let prefix = "";
  let size = 0;
  let timer;
  let finished = false;

  function finish(rewritten) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try {
      if (rewritten !== undefined) {
        const encoder = new TextEncoder();
        filter.write(encoder.encode(rewritten));
        // A streaming decoder may still hold the first bytes of a UTF-8 character.
        let consumed = encoder.encode(prefix).byteLength;
        for (const chunk of chunks) {
          const bytes = new Uint8Array(chunk);
          if (consumed < bytes.byteLength) filter.write(bytes.subarray(consumed));
          consumed = Math.max(0, consumed - bytes.byteLength);
        }
      } else {
        for (const chunk of chunks) filter.write(chunk);
      }
    } finally {
      chunks.length = 0;
      filter.disconnect();
    }
  }

  function inspect() {
    const rewritten = AdbloqerPlayer.rewrite(prefix);
    if (rewritten === prefix) return false;
    finish(rewritten);
    console.info("[Adbloqer] Player HTML prepared:", new URL(details.url).hostname);
    return true;
  }

  filter.ondata = event => {
    if (finished) return;
    timer ??= setTimeout(() => finish(), MAX_WAIT_MS);
    chunks.push(event.data);
    const remaining = MAX_PREFIX_BYTES - size;
    size += event.data.byteLength;
    try {
      const bytes = new Uint8Array(event.data);
      prefix += decoder.decode(bytes.subarray(0, remaining), { stream: true });
      if (size > MAX_PREFIX_BYTES) {
        // Avoid dropping bytes beyond the inspected prefix when the chunk is large.
        finish();
      } else if (!inspect() && size === MAX_PREFIX_BYTES) {
        finish();
      }
    } catch (error) {
      console.warn("[Adbloqer] Response passed through:", error.message);
      finish();
    }
  };

  filter.onstop = () => {
    if (finished) return;
    try {
      prefix += decoder.decode();
      if (!inspect()) finish();
    } catch (error) {
      console.warn("[Adbloqer] Response passed through:", error.message);
      finish();
    }
  };

  filter.onerror = () => {
    clearTimeout(timer);
    finished = true;
    chunks.length = 0;
    console.warn("[Adbloqer] Response stream error:", filter.error);
  };
}

browser.webRequest.onHeadersReceived.addListener(
  prepareResponse,
  { urls: ["https://*/*"], types: ["main_frame", "sub_frame"] },
  ["blocking", "responseHeaders"]
);
