// Service worker. Loads the shared store and the MCP bridge, opens the manager
// on first install, and keeps the bridge connection alive across SW restarts.

importScripts("lib/bookmarks.js", "bridge.js");

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("manager.html") });
  }
  bridgeConnect();
});

chrome.runtime.onStartup.addListener(() => bridgeConnect());

// The service worker can be torn down when idle; this alarm wakes it roughly
// once a minute so it re-establishes the bridge connection if it dropped.
chrome.alarms.create("bridge-keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "bridge-keepalive") bridgeConnect();
});

// Attempt a connection as soon as the worker spins up.
bridgeConnect();
