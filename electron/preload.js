const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 对话框
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),

  // 文件系统
  readDir: (dirPath, options) => ipcRenderer.invoke('fs:readDir', dirPath, options),
  classifyFiles: (dirPath, options) => ipcRenderer.invoke('fs:classifyFiles', dirPath, options),
  executeClassify: (targetPath, groups, isCopyMode) =>
    ipcRenderer.invoke('fs:executeClassify', targetPath, groups, isCopyMode),
  batchMove: (targetPath, files, isCopyMode, flatten) =>
    ipcRenderer.invoke('fs:batchMove', targetPath, files, isCopyMode, flatten),
  saveFile: (filePath, data) => ipcRenderer.invoke('fs:saveFile', filePath, data),
  saveBuffer: (filePath, data) => ipcRenderer.invoke('fs:saveBuffer', filePath, data),
  saveScreenshot: (saveDir, dataUrl) => ipcRenderer.invoke('fs:saveScreenshot', saveDir, dataUrl),
  exportJson: (options) => ipcRenderer.invoke('fs:exportJson', options),
  importJson: () => ipcRenderer.invoke('fs:importJson'),

  // 截屏录屏
  getCaptureSources: () => ipcRenderer.invoke('capture:getSources'),
  getScreenSourceId: (region) => ipcRenderer.invoke('capture:getScreenSourceId', region),
  selectRegion: () => ipcRenderer.invoke('capture:selectRegion'),
  screenshotRegion: (region) => ipcRenderer.invoke('capture:screenshotRegion', region),
  showRecordingOverlay: (region) => ipcRenderer.invoke('recording:showOverlay', region),
  hideRecordingOverlay: () => ipcRenderer.invoke('recording:hideOverlay'),

  // 屏幕
  getScreenBounds: () => ipcRenderer.invoke('screen:getBounds'),

  // 配置持久化
  configRead: () => ipcRenderer.invoke('config:read'),
  configWrite: (data) => ipcRenderer.invoke('config:write', data),

  // Shell
  openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),

  // 自动点击
  autoClick: (x, y) => ipcRenderer.invoke('autoclick:click', x, y),
  showClickIndicator: (x, y) => ipcRenderer.invoke('autoclick:showClickIndicator', x, y),
  getMousePos: () => ipcRenderer.invoke('autoclick:getMousePos'),
  selectPosition: () => ipcRenderer.invoke('autoclick:selectPosition'),
  preventSleep: () => ipcRenderer.invoke('autoclick:preventSleep'),
  allowSleep: () => ipcRenderer.invoke('autoclick:allowSleep'),

  // 剪贴板
  copyImageToClipboard: (dataUrl) => ipcRenderer.invoke('clipboard:copyImage', dataUrl),

  // 日报周报
  reportRead: (fileName) => ipcRenderer.invoke('report:read', fileName),
  reportWrite: (fileName, content) => ipcRenderer.invoke('report:write', fileName, content),

  // SVN 批量更新
  selectFile: (options) => ipcRenderer.invoke('dialog:openFile', options),
  svnUpdate: (dirPath) => ipcRenderer.invoke('svn:update', dirPath),
  runBat: (batPath) => ipcRenderer.invoke('svn:runBat', batPath),

  // 电源管理（防止系统休眠，用于定时任务）
  powerPreventSleep: () => ipcRenderer.invoke('power:preventSleep'),
  powerAllowSleep: () => ipcRenderer.invoke('power:allowSleep'),

  // 软件管理
  appLaunch: (exePath, silent) => ipcRenderer.invoke('app:launch', exePath, silent),
  appKill: (processName, force) => ipcRenderer.invoke('app:kill', processName, force),
  appIsRunning: (processName) => ipcRenderer.invoke('app:isRunning', processName),

  // 窗口置顶
  getAlwaysOnTop: () => ipcRenderer.invoke('window:getAlwaysOnTop'),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke('window:setAlwaysOnTop', enabled),
  onAlwaysOnTopChanged: (callback) => {
    const handler = (_event, enabled) => callback(enabled);
    ipcRenderer.on('window:alwaysOnTopChanged', handler);
    return () => ipcRenderer.removeListener('window:alwaysOnTopChanged', handler);
  },

  // 应用菜单
  menuSetup: (items) => ipcRenderer.invoke('menu:setup', items),
  onMenuNavigate: (callback) => {
    const handler = (_event, route) => callback(route);
    ipcRenderer.on('menu:navigate', handler);
    return () => ipcRenderer.removeListener('menu:navigate', handler);
  },

  // 媒体评分
  mediaScan: (dirPath, options) => ipcRenderer.invoke('media:scan', dirPath, options),
  mediaLoadRatings: (dirPath) => ipcRenderer.invoke('media:loadRatings', dirPath),
  mediaSaveRatings: (dirPath, ratings) => ipcRenderer.invoke('media:saveRatings', dirPath, ratings),
  mediaExportByRating: (files, targetPath, isCopyMode, groupByRating, ratingMap) =>
    ipcRenderer.invoke('media:exportByRating', files, targetPath, isCopyMode, groupByRating, ratingMap),
  mediaDeleteFile: (filePath, toTrash) => ipcRenderer.invoke('media:deleteFile', filePath, toTrash),
});
