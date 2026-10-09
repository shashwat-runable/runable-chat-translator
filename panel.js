"use strict";

const sourceSelect = document.querySelector("#source");
const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const status = document.querySelector("#status");

let tabId = null;
let translator = null;
let active = false;
let processing = false;
let completed = 0;
const queue = new Map();
const translated = new Map();

function setStatus(message) {
  status.textContent = message;
}

function isRunableChat(tab) {
  try {
    const url = new URL(tab.url);
    return url.origin === "https://runable.com" && url.pathname.startsWith("/chat/");
  } catch {
    return false;
  }
}

async function currentChatTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && isRunableChat(tab) ? tab : null;
}

async function attachToChat() {
  try {
    return await chrome.tabs.sendMessage(tabId, { kind: "RUNABLE_START" });
  } catch {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return chrome.tabs.sendMessage(tabId, { kind: "RUNABLE_START" });
  }
}

function enqueue(items) {
  if (!active || !Array.isArray(items)) return;
  for (const item of items) {
    if (!Number.isInteger(item.id) || typeof item.text !== "string") continue;
    if (translated.get(item.id) === item.text) continue;
    queue.set(item.id, item);
  }
  void processQueue();
}

function chunksOf(text, maxLength = 1200) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let split = remaining.lastIndexOf(" ", maxLength);
    if (split < maxLength / 2) split = maxLength;
    chunks.push(remaining.slice(0, split));
    remaining = remaining.slice(split).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function translateText(text) {
  const parts = chunksOf(text);
  const output = [];
  for (const part of parts) output.push(await translator.translate(part));
  return output.join(" ").trim();
}

async function processQueue() {
  if (processing || !active || !translator) return;
  processing = true;
  try {
    while (active && queue.size) {
      const [id, item] = queue.entries().next().value;
      queue.delete(id);
      try {
        const english = await translateText(item.text);
        if (!active) break;
        const result = await chrome.tabs.sendMessage(tabId, {
          kind: "RUNABLE_APPLY",
          id,
          source: item.text,
          english
        });
        if (result?.applied) {
          translated.set(id, item.text);
          completed++;
          setStatus(`Translated ${completed} text ${completed === 1 ? "block" : "blocks"}. New chat text will appear in English automatically.`);
        }
      } catch (error) {
        setStatus(`Translation stopped: ${error.message || String(error)}`);
        active = false;
      }
    }
  } finally {
    processing = false;
  }
}

async function startContent() {
  const tab = await currentChatTab();
  if (!tab) {
    setStatus("Select the Runable chat tab, then try again.");
    return;
  }
  tabId = tab.id;
  const response = await attachToChat();
  active = true;
  startButton.hidden = true;
  stopButton.hidden = false;
  sourceSelect.disabled = true;
  setStatus("Finding chat text…");
  enqueue(response?.items || []);
  if (!response?.items?.length) setStatus("No chat text found yet. New messages will be checked as they appear.");
}

startButton.addEventListener("click", () => {
  if (typeof Translator !== "function") {
    setStatus("This Chrome version does not support on-device translation.");
    return;
  }
  // Keep create() directly inside the click handler: a first-time model download needs user activation.
  let creation;
  try {
    creation = Translator.create({
      sourceLanguage: sourceSelect.value,
      targetLanguage: "en",
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          setStatus(`Downloading the local language pack: ${Math.round(event.loaded * 100)}%.`);
        });
      }
    });
  } catch (error) {
    setStatus(`Could not start translation: ${error.message || String(error)}`);
    return;
  }

  startButton.disabled = true;
  setStatus("Preparing Chrome's on-device translator…");
  creation.then(async (created) => {
    translator = created;
    await startContent();
  }).catch((error) => {
    setStatus(`Could not start translation: ${error.message || String(error)}. Check that Chrome allows on-device language packs, then try again.`);
  }).finally(() => {
    startButton.disabled = false;
  });
});

async function stopTranslation(message) {
  active = false;
  queue.clear();
  translated.clear();
  completed = 0;
  try {
    if (tabId !== null) await chrome.tabs.sendMessage(tabId, { kind: "RUNABLE_STOP" });
  } catch { /* The tab may have closed. */ }
  translator?.destroy?.();
  translator = null;
  stopButton.hidden = true;
  startButton.hidden = false;
  sourceSelect.disabled = false;
  setStatus(message);
}

stopButton.addEventListener("click", () => {
  void stopTranslation("Translations removed. Select Translate this chat to start again.");
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.kind === "RUNABLE_BLOCKS" && sender.tab?.id === tabId) enqueue(message.items);
});

chrome.tabs.onUpdated.addListener((updatedTabId, info, tab) => {
  if (updatedTabId === tabId && info.status === "complete" && active && isRunableChat(tab)) {
    attachToChat().then((response) => enqueue(response?.items || [])).catch((error) => {
      setStatus(`Reloaded chat could not be read: ${error.message || String(error)}`);
    });
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId: activatedTabId }) => {
  if (activatedTabId === tabId) return;
  if (active) await stopTranslation("The active tab changed. Open a Runable chat and select Translate this chat again.");
  const tab = await currentChatTab();
  tabId = tab?.id ?? null;
  if (!active && tab) setStatus("Ready to translate the open Runable chat into English.");
});

currentChatTab().then((tab) => {
  tabId = tab?.id ?? null;
  if (tabId === null) setStatus("Open the Runable chat tab, then reopen this panel.");
  else setStatus("Ready to translate the open Runable chat into English.");
}).catch((error) => setStatus(`Could not inspect the current tab: ${error.message || String(error)}`));
