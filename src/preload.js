const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getData: () => ipcRenderer.invoke("get-data"),
  getAudio: (text) => ipcRenderer.invoke("get-audio", text),
  recordResult: (id, grade) => ipcRenderer.send("record-result", id, grade),
  finishSession: (durationMs, count) => ipcRenderer.invoke("finish-session", durationMs, count),
  sessionDone: () => ipcRenderer.send("session-done"),
  closeWindow: () => ipcRenderer.send("close-window"),
  onStartSession: (cb) => ipcRenderer.on("start-session", () => cb()),
});
