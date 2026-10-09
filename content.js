(() => {
  "use strict";
  if (globalThis.__runableTranslatorInjected) return;
  globalThis.__runableTranslatorInjected = true;

  const MARKER = "data-runable-english";
  const BLOCKS = "p, li, blockquote, h1, h2, h3, h4, h5, h6, td, th";
  const IGNORE = "nav, aside, header, footer, button, input, textarea, select, option, pre, script, style, [contenteditable], [role='navigation'], [role='complementary'], [aria-hidden='true'], [data-runable-english]";
  const records = new WeakMap();
  const byId = new Map();
  let nextId = 1;
  let active = false;
  let scanTimer = null;

  function rootElements() {
    const messageBodies = [...document.querySelectorAll('div[class*="space-y-4"][class*="whitespace-normal"]')]
      .filter((element) => !element.parentElement?.closest('div[class*="space-y-4"][class*="whitespace-normal"]'));
    if (messageBodies.length) return messageBodies;
    const roots = [...document.querySelectorAll("main, [role='main']")];
    if (!roots.length) return [document.body];
    return [roots.sort((a, b) => b.textContent.length - a.textContent.length)[0]];
  }

  function blockFor(textNode, root) {
    const parent = textNode.parentElement;
    if (!parent || parent.closest(IGNORE)) return null;
    const semantic = parent.closest(BLOCKS);
    if (semantic && root.contains(semantic)) return semantic;
    const generic = parent.closest("div, section, article");
    return generic && root.contains(generic) ? generic : null;
  }

  function eligible(block, root, text) {
    if (!block.isConnected || block.closest(IGNORE) || !text) return false;
    if (text.length > 12000) return false;
    if (root === document.body && !block.matches(BLOCKS) && text.length < 18) return false;
    if (block.matches(BLOCKS) && text.length < 2) return false;
    const rect = block.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    if (innerWidth >= 900) {
      const center = rect.left + rect.width / 2;
      if (center < innerWidth * .17 || center > innerWidth * .79) return false;
    }
    return true;
  }

  function collect(force = false) {
    if (!location.pathname.startsWith("/chat/")) return [];
    for (const [id, entry] of byId) {
      if (!entry.block.isConnected) byId.delete(id);
    }
    const grouped = new Map();
    for (const root of rootElements()) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = node.nodeValue.trim();
        if (!value) continue;
        const block = blockFor(node, root);
        if (!block) continue;
        const group = grouped.get(block) || { root, parts: [] };
        group.parts.push(value);
        grouped.set(block, group);
      }
    }

    const items = [];
    for (const [block, { root, parts }] of grouped) {
      const text = parts.join(" ").replace(/\s+/g, " ").trim();
      if (!eligible(block, root, text)) continue;
      let record = records.get(block);
      if (!record) {
        record = { id: nextId++, text: "", translation: null, requested: false };
        records.set(block, record);
        byId.set(record.id, { block, record });
      }
      if (record.text !== text) {
        record.text = text;
        record.requested = false;
        if (record.translation) {
          record.translation.remove();
          record.translation = null;
        }
      } else if (record.translation && !record.translation.isConnected) {
        record.translation = null;
        record.requested = false;
      }
      if (!force && record.requested) {
        continue;
      }
      record.requested = true;
      const rect = block.getBoundingClientRect();
      const visible = rect.bottom >= 0 && rect.top <= innerHeight;
      items.push({ id: record.id, text, visible, distance: Math.abs((rect.top + rect.bottom) / 2 - innerHeight / 2) });
    }
    items.sort((a, b) => Number(b.visible) - Number(a.visible) || a.distance - b.distance);
    return items.map(({ id, text }) => ({ id, text }));
  }

  function publish() {
    scanTimer = null;
    if (!active) return;
    const items = collect();
    if (items.length) chrome.runtime.sendMessage({ kind: "RUNABLE_BLOCKS", items }).catch(() => {});
  }

  function schedule() {
    if (!active || scanTimer) return;
    scanTimer = setTimeout(publish, 250);
  }

  function apply({ id, source, english }) {
    const entry = byId.get(id);
    if (!entry || !entry.block.isConnected || entry.record.text !== source || !english.trim()) return false;
    const { block, record } = entry;
    if (!record.translation || !record.translation.isConnected) {
      const translation = document.createElement("div");
      translation.setAttribute(MARKER, "true");
      translation.setAttribute("lang", "en");
      if (["LI", "TD", "TH"].includes(block.tagName)) block.append(translation);
      else block.insertAdjacentElement("afterend", translation);
      record.translation = translation;
    }
    record.translation.textContent = english;
    return true;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.kind === "RUNABLE_START") {
      active = true;
      sendResponse({ items: collect(true) });
      return;
    }
    if (message?.kind === "RUNABLE_APPLY") {
      sendResponse({ applied: active ? apply(message) : false });
      return;
    }
    if (message?.kind === "RUNABLE_STOP") {
      active = false;
      clearTimeout(scanTimer);
      scanTimer = null;
      for (const translation of document.querySelectorAll(`[${MARKER}]`)) translation.remove();
      for (const { record } of byId.values()) {
        record.translation = null;
        record.requested = false;
      }
      sendResponse({ ok: true });
    }
  });

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    characterData: true,
    subtree: true
  });
  addEventListener("scroll", schedule, { passive: true, capture: true });
})();
