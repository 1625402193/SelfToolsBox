const { app, BrowserWindow, ipcMain, dialog, desktopCapturer, screen, powerSaveBlocker, protocol, net, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { exec } = require('child_process');

// 懒加载 exifr（仅在预览 RAW 时才需要）
let _exifr = null;
function getExifr() {
  if (_exifr === null) {
    try { _exifr = require('exifr'); } catch (e) { _exifr = false; }
  }
  return _exifr || null;
}

// RAW 格式扩展名（佳能/索尼/尼康/富士/松下/奥林巴斯/宾得/通用 DNG）
const RAW_EXTS = new Set([
  '.cr2', '.cr3', '.crw',           // 佳能
  '.arw', '.sr2', '.srf',           // 索尼
  '.nef', '.nrw',                   // 尼康
  '.raf',                            // 富士
  '.rw2',                            // 松下
  '.orf',                            // 奥林巴斯
  '.pef',                            // 宾得
  '.dng',                            // 通用
]);

// RAW 预览缓存目录（提取出来的内嵌 JPEG）
const RAW_CACHE_DIR = path.join(os.tmpdir(), 'tools-raw-preview');
function ensureRawCacheDir() {
  try { fs.mkdirSync(RAW_CACHE_DIR, { recursive: true }); } catch (e) {}
}
function cleanupOldRawCache() {
  try {
    if (!fs.existsSync(RAW_CACHE_DIR)) return;
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7天
    for (const name of fs.readdirSync(RAW_CACHE_DIR)) {
      try {
        const fp = path.join(RAW_CACHE_DIR, name);
        const st = fs.statSync(fp);
        if (now - st.mtimeMs > maxAge) fs.unlinkSync(fp);
      } catch (e) {}
    }
  } catch (e) {}
}

// 提取 RAW 内嵌 JPEG，返回缓存文件路径
async function extractRawPreview(absPath) {
  const exifr = getExifr();
  if (!exifr) throw new Error('exifr 未安装');
  ensureRawCacheDir();

  // 用 路径 + mtime 做缓存 key，文件改动会自动失效
  let stat;
  try { stat = fs.statSync(absPath); } catch (e) { throw new Error('源文件不存在'); }
  const key = crypto.createHash('md5').update(absPath + '|' + stat.mtimeMs + '|' + stat.size).digest('hex');
  const cacheFile = path.join(RAW_CACHE_DIR, key + '.jpg');
  if (fs.existsSync(cacheFile)) {
    try { fs.utimesSync(cacheFile, new Date(), new Date()); } catch (e) {}
    return cacheFile;
  }

  // 优先取大尺寸 preview，没有再退到 thumbnail
  let buf = null;
  try {
    // exifr.thumbnail() 返回 Uint8Array（小预览）
    // 优先尝试 parse 拿全尺寸 preview
    const out = await exifr.parse(absPath, {
      tiff: true, ifd0: true, ifd1: true,
      mergeOutput: false,
      translateValues: false,
      reviveValues: false,
      makerNote: false,
      userComment: false,
    }).catch(() => null);
    // ifd1 / SubIFDs 中可能包含 JPEGInterchangeFormat / StripOffsets 指向大预览
    // exifr 已经在某些 RAW 上自动暴露 preview / jpeg buffer，但 API 不稳定
    // 这里先直接用 thumbnail 作为兜底，多数相机的 thumbnail 已 1024+ 宽够用
    void out;
  } catch (e) {}

  if (!buf) {
    try {
      const t = await exifr.thumbnail(absPath);
      if (t && t.byteLength > 0) buf = Buffer.from(t);
    } catch (e) {}
  }

  if (!buf || buf.length === 0) throw new Error('未提取到内嵌预览图');
  fs.writeFileSync(cacheFile, buf);
  return cacheFile;
}

// 注册自定义协议（用于本地图片/视频预览）— 必须在 app ready 之前
protocol.registerSchemesAsPrivileged([
  { scheme: 'local-media', privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true } },
]);

let mainWindow;
// 标记是否是本工具自己主动隐藏/最小化窗口（区分外部操作）
let selfHiding = false;
// 窗口是否保持置顶（用户可在界面开关，持久化到 app-config.json）
let alwaysOnTopEnabled = true;

// 置顶配置的存储 key
const ALWAYS_ON_TOP_KEY = 'windowAlwaysOnTop';

// 同步读取配置文件（启动时需要，早于 IPC 可用）
function readConfigSync() {
  try {
    const configPath = path.join(app.getPath('userData'), 'app-config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8')) || {};
    }
  } catch (e) {}
  return {};
}

// 统一的置顶应用入口：所有恢复置顶的地方都走这里，尊重用户开关
function applyAlwaysOnTop() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (alwaysOnTopEnabled) {
      // floating 级别而非 screen-saver，避免遮盖第三方截图工具的选区框
      mainWindow.setAlwaysOnTop(true, 'floating');
    } else {
      mainWindow.setAlwaysOnTop(false);
    }
  } catch (e) {}
}

// 全局异常捕获，防止应用崩溃退出
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

function createWindow() {
  // 启动时读取用户的置顶偏好（默认开启）
  const savedConfig = readConfigSync();
  if (typeof savedConfig[ALWAYS_ON_TOP_KEY] === 'boolean') {
    alwaysOnTopEnabled = savedConfig[ALWAYS_ON_TOP_KEY];
  }

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    alwaysOnTop: alwaysOnTopEnabled,
    title: '多功能工具箱',
    icon: path.join(__dirname, '../public/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // 禁止后台节流：录屏时遮罩覆盖主窗口，Chromium 会把渲染进程当 background 节流 setInterval/RAF
    },
  });

  // 授权媒体权限（录屏 getDisplayMedia 需要）
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
    } else {
      callback(true);
    }
  });

  // 渲染进程崩溃时自动恢复
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Render process gone:', details.reason);
    if (details.reason !== 'clean-exit') {
      // 重新加载页面而不是退出应用
      setTimeout(() => {
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.reload();
          }
        } catch(e) {}
      }, 1000);
    }
  });

  // 页面无响应时的处理
  mainWindow.webContents.on('unresponsive', () => {
    console.error('Window became unresponsive, reloading...');
    setTimeout(() => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.reload();
        }
      } catch(e) {}
    }, 2000);
  });

  mainWindow.webContents.on('responsive', () => {
    console.log('Window became responsive again');
  });

  // 应用启动时的置顶状态（尊重用户在界面上的开关设置）
  applyAlwaysOnTop();

  // 监听窗口失焦：只在失焦时短暂停止置顶，让其他截图软件的选区能正常显示
  // 不再做定时强制置顶，否则会覆盖第三方截图工具的选区框
  mainWindow.on('blur', () => {
    // 失焦时主动取消置顶，让其他软件（如截图工具）能在本工具界面之上显示选区
    if (!selfHiding && mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.setAlwaysOnTop(false); } catch(e) {}
    }
  });

  mainWindow.on('focus', () => {
    // 重新获得焦点时按用户设置恢复置顶
    if (!selfHiding) applyAlwaysOnTop();
  });

  mainWindow.on('restore', () => {
    if (!selfHiding) applyAlwaysOnTop();
  });

  // 开发模式加载 Vite dev server
  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
    // 按 F12 或 Ctrl+Shift+I 手动打开开发者工具
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

// ===================== 应用菜单 =====================

// 文档类页面菜单项（由渲染进程根据版本上报，默认全部显示）
let docMenuItems = [
  { label: '配置说明', route: '/config' },
  { label: '更新日志', route: '/changelog' },
];

function navigateTo(route) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu:navigate', route);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

function buildAppMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        {
          label: '窗口置顶',
          type: 'checkbox',
          checked: alwaysOnTopEnabled,
          click: (menuItem) => {
            alwaysOnTopEnabled = menuItem.checked;
            applyAlwaysOnTop();
            try {
              const configPath = path.join(app.getPath('userData'), 'app-config.json');
              const existing = readConfigSync();
              existing[ALWAYS_ON_TOP_KEY] = alwaysOnTopEnabled;
              fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf-8');
            } catch (e) {}
            // 通知渲染进程同步开关 UI
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('window:alwaysOnTopChanged', alwaysOnTopEnabled);
            }
          },
        },
        { type: 'separator' },
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' },
      ],
    },
  ];

  // 文档类页面：作为顶级菜单项直接点击跳转
  for (const item of docMenuItems) {
    template.push({ label: item.label, click: () => navigateTo(item.route) });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // 启动时清理过期 RAW 预览缓存
  cleanupOldRawCache();

  // 注册 local-media 协议处理器
  // URL 形如 local-media://m/<encoded-absolute-path>
  // 例：local-media://m/F%3A%2Ftmp%2F%E4%B8%AD%E6%96%87%2Fa.png
  try {
    protocol.handle('local-media', async (request) => {
      try {
        const url = new URL(request.url);
        // 去掉首个斜杠：'/F%3A%2Ftmp%2F...'
        let p = decodeURIComponent(url.pathname || '');
        if (p.startsWith('/')) p = p.slice(1);
        // 兼容 windows 路径
        let absPath = path.normalize(p);

        // RAW 文件：提取内嵌 JPEG 预览
        const ext = path.extname(absPath).toLowerCase();
        if (RAW_EXTS.has(ext)) {
          try {
            absPath = await extractRawPreview(absPath);
          } catch (e) {
            return new Response('raw preview failed: ' + (e && e.message), { status: 500 });
          }
        }
        return net.fetch(pathToFileURL(absPath).href);
      } catch (e) {
        return new Response('not found', { status: 404 });
      }
    });
  } catch (e) {
    // 旧版本 Electron 兜底（不支持 RAW 转换）
    protocol.registerFileProtocol('local-media', (request, callback) => {
      try {
        const url = new URL(request.url);
        let p = decodeURIComponent(url.pathname || '');
        if (p.startsWith('/')) p = p.slice(1);
        callback({ path: path.normalize(p) });
      } catch (err) {
        callback({ error: -2 });
      }
    });
  }
  createWindow();
  buildAppMenu();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ===================== IPC Handlers =====================

// 读取窗口置顶状态
// 注：必须返回 mainWindow.isAlwaysOnTop() 而非 alwaysOnTopEnabled 变量。
// 启动后页面加载过程中窗口可能短暂失焦，blur 监听器会主动调用 setAlwaysOnTop(false)
// 给截图工具让位（不影响配置意图），但此时 alwaysOnTopEnabled 仍是 true。
// 如果返回变量，会导致渲染端 UI 显示「勾选」而实际窗口未置顶，需要用户取消再勾选才生效。
ipcMain.handle('window:getAlwaysOnTop', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { success: true, enabled: false };
  }
  return { success: true, enabled: mainWindow.isAlwaysOnTop() };
});

// 设置窗口置顶状态（并持久化）
ipcMain.handle('window:setAlwaysOnTop', (_event, enabled) => {
  try {
    alwaysOnTopEnabled = !!enabled;
    applyAlwaysOnTop();
    // 持久化到配置文件
    try {
      const configPath = path.join(app.getPath('userData'), 'app-config.json');
      const existing = readConfigSync();
      existing[ALWAYS_ON_TOP_KEY] = alwaysOnTopEnabled;
      fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf-8');
    } catch (e) {}
    buildAppMenu(); // 同步菜单栏勾选状态
    return { success: true, enabled: alwaysOnTopEnabled };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 渲染进程上报当前版本可访问的文档类页面，据此重建菜单
ipcMain.handle('menu:setup', (_event, items) => {
  try {
    if (Array.isArray(items)) {
      docMenuItems = items.filter(i => i && i.label && i.route);
      buildAppMenu();
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 选择文件夹对话框
ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// 读取目录文件列表
ipcMain.handle('fs:readDir', async (_event, dirPath, options) => {
  const { recursive = false, includeFiles = true, includeDirs = true } = options || {};
  const results = [];

  function walk(dir, depth = 0) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (includeDirs) {
          results.push({
            name: entry.name,
            path: fullPath,
            isDirectory: true,
          });
        }
        if (recursive && depth < 10) walk(fullPath, depth + 1);
      } else if (entry.isFile() && includeFiles) {
        const stat = fs.statSync(fullPath);
        results.push({
          name: entry.name,
          path: fullPath,
          isDirectory: false,
          size: stat.size,
          extension: path.extname(entry.name).toLowerCase(),
          createTime: stat.birthtime.toISOString(),
          modifyTime: stat.mtime.toISOString(),
        });
      }
    }
  }

  try {
    walk(dirPath);
    return { success: true, data: results };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 分析文件并按日期+类型分类
ipcMain.handle('fs:classifyFiles', async (_event, dirPath, options) => {
  const { useCreationTime = true, includeSubfolders = false } = options || {};
  const files = [];

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (includeSubfolders) walk(fullPath);
      } else if (entry.isFile()) {
        const stat = fs.statSync(fullPath);
        const timeStr = useCreationTime ? stat.birthtime : stat.mtime;
        files.push({
          name: entry.name,
          path: fullPath,
          size: stat.size,
          extension: path.extname(entry.name).toLowerCase(),
          date: timeStr.toISOString().slice(0, 10),
          createTime: stat.birthtime.toISOString(),
          modifyTime: stat.mtime.toISOString(),
        });
      }
    }
  }

  try {
    walk(dirPath);
    // 按日期+扩展名分组
    const groups = {};

    for (const file of files) {
      // 直接使用文件扩展名作为类型（去掉前面的点，无扩展名归为"无扩展名"）
      const type = file.extension ? file.extension.slice(1) : '无扩展名';
      const key = `${file.date}_${type}`;
      if (!groups[key]) {
        groups[key] = { date: file.date, type, files: [] };
      }
      groups[key].files.push(file);
    }

    const groupList = Object.values(groups).sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      return a.type.localeCompare(b.type);
    });

    return { success: true, data: { totalFiles: files.length, groups: groupList } };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 执行文件分类（复制/移动）
ipcMain.handle('fs:executeClassify', async (_event, targetPath, groups, isCopyMode) => {
  let successCount = 0;
  let failCount = 0;
  const errors = [];

  for (const group of groups) {
    const destDir = path.join(targetPath, group.date, group.type);
    try {
      fs.mkdirSync(destDir, { recursive: true });
    } catch (err) {
      errors.push(`创建目录失败 ${destDir}: ${err.message}`);
      continue;
    }

    for (const file of group.files) {
      const destFile = path.join(destDir, file.name);
      try {
        if (isCopyMode) {
          fs.copyFileSync(file.path, destFile);
        } else {
          // 避免跨盘移动问题，先复制再删除
          fs.copyFileSync(file.path, destFile);
          fs.unlinkSync(file.path);
        }
        successCount++;
      } catch (err) {
        failCount++;
        errors.push(`${file.name}: ${err.message}`);
      }
    }
  }

  return { success: true, data: { successCount, failCount, errors } };
});

// 批量移动/复制文件
ipcMain.handle('fs:batchMove', async (_event, targetPath, files, isCopyMode, flatten) => {
  let successCount = 0;
  let failCount = 0;
  const errors = [];

  for (const file of files) {
    let destFile;
    if (flatten) {
      destFile = path.join(targetPath, file.name);
    } else {
      const relDir = file.relativeDir || '';
      const destDir = path.join(targetPath, relDir);
      fs.mkdirSync(destDir, { recursive: true });
      destFile = path.join(destDir, file.name);
    }
    try {
      if (isCopyMode) {
        fs.copyFileSync(file.path, destFile);
      } else {
        fs.copyFileSync(file.path, destFile);
        fs.unlinkSync(file.path);
      }
      successCount++;
    } catch (err) {
      failCount++;
      errors.push(`${file.name}: ${err.message}`);
    }
  }

  return { success: true, data: { successCount, failCount, errors } };
});

// 获取屏幕源列表（用于截图/录屏）- 使用较大缩略图尺寸
ipcMain.handle('capture:getSources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 1920, height: 1080 },
    fetchWindowIcons: false,
  });
  return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
});

// 获取屏幕源 ID（用于录屏 getUserMedia）
// 可选参数 region: { x, y, width, height } —— 当 region 落在副屏时，自动定位到对应显示器
ipcMain.handle('capture:getScreenSourceId', async (_event, region) => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    if (!sources || sources.length === 0) {
      return { success: false, error: '未找到屏幕源' };
    }

    const displays = screen.getAllDisplays();
    let target = screen.getPrimaryDisplay();

    if (region && typeof region.x === 'number' && typeof region.y === 'number') {
      // 取区域中心点判断落在哪个显示器，避免跨屏
      const cx = region.x + (region.width || 0) / 2;
      const cy = region.y + (region.height || 0) / 2;
      const found = displays.find((d) => {
        const b = d.bounds;
        return cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height;
      });
      if (found) target = found;
    }

    // 把 Electron display.id 与 desktopCapturer source 对齐：
    // sources[i].display_id 是字符串形式的显示器 ID
    let matched = sources.find((s) => String(s.display_id) === String(target.id));
    if (!matched) {
      // 兜底：按 displays 顺序与 sources 顺序对齐（多屏环境一般一一对应）
      const idx = displays.findIndex((d) => d.id === target.id);
      if (idx >= 0 && idx < sources.length) matched = sources[idx];
    }
    if (!matched) matched = sources[0];

    return {
      success: true,
      sourceId: matched.id,
      display: {
        id: target.id,
        bounds: target.bounds,
        scaleFactor: target.scaleFactor,
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 保存文件
ipcMain.handle('fs:saveFile', async (_event, filePath, data) => {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    // data 是 base64 data URL
    const base64 = data.replace(/^data:.+;base64,/, '');
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 导出 JSON 文本到用户选择的文件（用于预设分享）
ipcMain.handle('fs:exportJson', async (_event, options) => {
  try {
    const { defaultFileName, content } = options || {};
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出预设',
      defaultPath: defaultFileName || 'presets.json',
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    fs.writeFileSync(result.filePath, content, 'utf-8');
    return { success: true, filePath: result.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 从用户选择的文件导入 JSON 文本（用于预设分享）
ipcMain.handle('fs:importJson', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入预设',
      properties: ['openFile'],
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { success: false, canceled: true };
    const filePath = result.filePaths[0];
    const content = fs.readFileSync(filePath, 'utf-8');
    return { success: true, filePath, content };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 保存二进制 Buffer / Uint8Array（用于大文件，避免 base64 IPC 失败导致 0 字节）
ipcMain.handle('fs:saveBuffer', async (_event, filePath, data) => {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    let buf;
    if (Buffer.isBuffer(data)) {
      buf = data;
    } else if (data instanceof Uint8Array) {
      buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    } else if (data && data.byteLength !== undefined) {
      buf = Buffer.from(data);
    } else {
      return { success: false, error: '无效的数据类型' };
    }
    if (buf.length === 0) return { success: false, error: '数据为空（0 字节），不写入' };
    fs.writeFileSync(filePath, buf);
    return { success: true, size: buf.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 保存截图到指定目录
ipcMain.handle('fs:saveScreenshot', async (_event, saveDir, dataUrl) => {
  try {
    fs.mkdirSync(saveDir, { recursive: true });
    const fileName = `screenshot_${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    const filePath = path.join(saveDir, fileName);
    const base64 = dataUrl.replace(/^data:.+;base64,/, '');
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    return { success: true, filePath, fileName };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 打开文件夹
ipcMain.handle('shell:openPath', async (_event, filePath) => {
  const { shell } = require('electron');
  await shell.openPath(filePath);
});

// 复制图片到剪贴板
ipcMain.handle('clipboard:copyImage', async (_event, dataUrl) => {
  try {
    const { clipboard, nativeImage } = require('electron');
    const base64 = dataUrl.replace(/^data:.+;base64,/, '');
    const img = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
    clipboard.writeImage(img);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 自动点击 - 使用 PowerShell 执行
ipcMain.handle('autoclick:click', async (_event, x, y) => {
  return new Promise((resolve) => {
    const ps = `
      Add-Type -TypeDefinition @"
      using System;
      using System.Runtime.InteropServices;
      public class Mouse {
        [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
      }
"@
      [Mouse]::SetCursorPos(${x}, ${y})
      [Mouse]::mouse_event(0x0002, 0, 0, 0, 0)
      [Mouse]::mouse_event(0x0004, 0, 0, 0, 0)
    `;
    exec(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, (err) => {
      resolve({ success: !err, error: err?.message });
    });
  });
});

// 自动点击 - 防止屏幕熄屏
let sleepBlockerId = null;
ipcMain.handle('autoclick:preventSleep', async () => {
  if (sleepBlockerId === null) {
    sleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  }
  return { success: true };
});
ipcMain.handle('autoclick:allowSleep', async () => {
  if (sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
  return { success: true };
});

// 防止系统休眠（用于定时任务，确保电脑熄屏后定时器仍可触发）
let systemSleepBlockerId = null;
ipcMain.handle('power:preventSleep', async () => {
  if (systemSleepBlockerId === null) {
    systemSleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  }
  return { success: true, blocking: true };
});
ipcMain.handle('power:allowSleep', async () => {
  if (systemSleepBlockerId !== null) {
    powerSaveBlocker.stop(systemSleepBlockerId);
    systemSleepBlockerId = null;
  }
  return { success: true, blocking: false };
});

// 软件管理 - 启动软件
ipcMain.handle('app:launch', async (_event, exePath, silent) => {
  try {
    const { spawn } = require('child_process');
    const args = [];
    const options = { detached: true, stdio: 'ignore' };
    if (silent) {
      // 静默启动（最小化窗口）
      options.windowsHide = true;
    }
    const child = spawn(exePath, args, options);
    child.unref();
    return { success: true, pid: child.pid };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 软件管理 - 关闭软件（通过进程名杀进程）
ipcMain.handle('app:kill', async (_event, processName, force) => {
  return new Promise((resolve) => {
    const cmd = force
      ? `chcp 65001 >nul && taskkill /F /IM "${processName}"`
      : `chcp 65001 >nul && taskkill /IM "${processName}"`;
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        resolve({ success: false, error: stderr || err.message, output: stdout });
      } else {
        resolve({ success: true, output: stdout });
      }
    });
  });
});

// 软件管理 - 检查进程是否运行
ipcMain.handle('app:isRunning', async (_event, processName) => {
  return new Promise((resolve) => {
    exec(`chcp 65001 >nul && tasklist /FI "IMAGENAME eq ${processName}" /NH`, (err, stdout) => {
      if (err) {
        resolve({ running: false });
        return;
      }
      resolve({ running: stdout.toLowerCase().includes(processName.toLowerCase()) });
    });
  });
});

// 自动点击 - 显示点击视觉反馈（多层波纹扩散）
ipcMain.handle('autoclick:showClickIndicator', async (_event, x, y) => {
  const indicator = new BrowserWindow({
    width: 140,
    height: 140,
    x: x - 70,
    y: y - 70,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  indicator.setIgnoreMouseEvents(true);
  indicator.loadFile(path.join(__dirname, 'click-indicator.html'));
  indicator.on('closed', () => {});
  // 900ms 后自动关闭
  setTimeout(() => { try { indicator.close(); } catch(e) {} }, 900);
  return { success: true };
});

// 自动点击 - 选择点击位置（最小化窗口后延时捕获）
ipcMain.handle('autoclick:selectPosition', async () => {
  return new Promise((resolve) => {
    // 先取消置顶并最小化，让用户能操作其他窗口
    selfHiding = true;
    mainWindow.setAlwaysOnTop(false);
    mainWindow.minimize();

    // 延时 3 秒后捕获鼠标位置
    setTimeout(() => {
      const ps = `
        Add-Type -TypeDefinition @"
        using System;
        using System.Runtime.InteropServices;
        public class CursorPos {
          [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
          [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
        }
"@
        $p = New-Object CursorPos+POINT
        [CursorPos]::GetCursorPos([ref]$p) | Out-Null
        Write-Output "$($p.X),$($p.Y)"
      `;
      exec(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, (err, stdout) => {
        // 恢复窗口
        mainWindow.restore();
        applyAlwaysOnTop();
        selfHiding = false;
        if (err) {
          resolve({ success: false, error: err.message });
        } else {
          const [x, y] = stdout.trim().split(',').map(Number);
          resolve({ success: true, x, y });
        }
      });
    }, 3000);
  });
});

// 自动点击 - 获取鼠标位置（即时获取）
ipcMain.handle('autoclick:getMousePos', async () => {
  return new Promise((resolve) => {
    const ps = `
      Add-Type -TypeDefinition @"
      using System;
      using System.Runtime.InteropServices;
      public class CursorPos {
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
      }
"@
      $p = New-Object CursorPos+POINT
      [CursorPos]::GetCursorPos([ref]$p) | Out-Null
      Write-Output "$($p.X),$($p.Y)"
    `;
    exec(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, (err, stdout) => {
      if (err) {
        resolve({ success: false, error: err.message });
      } else {
        const [x, y] = stdout.trim().split(',').map(Number);
        resolve({ success: true, x, y });
      }
    });
  });
});

// 获取屏幕尺寸（包含所有显示器）
ipcMain.handle('screen:getBounds', async () => {
  const primaryDisplay = screen.getPrimaryDisplay();
  const displays = screen.getAllDisplays();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const display of displays) {
    const { x, y, width, height } = display.bounds;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + width > maxX) maxX = x + width;
    if (y + height > maxY) maxY = y + height;
  }
  return {
    width: primaryDisplay.bounds.width,
    height: primaryDisplay.bounds.height,
    scaleFactor: primaryDisplay.scaleFactor,
    totalWidth: maxX - minX,
    totalHeight: maxY - minY,
    offsetX: minX,
    offsetY: minY,
    displays: displays.map(d => ({
      id: d.id,
      bounds: d.bounds,
      scaleFactor: d.scaleFactor,
    })),
  };
});

// ===================== 配置持久化 =====================

function getConfigPath() {
  return path.join(app.getPath('userData'), 'app-config.json');
}

ipcMain.handle('config:read', async () => {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return { success: true, data };
    }
    return { success: true, data: {} };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('config:write', async (_event, data) => {
  try {
    const configPath = getConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ===================== 日报周报 IPC Handlers =====================

// 获取报告数据文件路径
function getReportDataDir() {
  // 开发环境用 electron/data，打包后用 resources/data
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'data');
  }
  return path.join(__dirname, 'data');
}

function ensureReportFile(fileName) {
  const dir = getReportDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '', 'utf-8');
  }
  return filePath;
}

// 读取报告文件内容
ipcMain.handle('report:read', async (_event, fileName) => {
  try {
    const filePath = ensureReportFile(fileName);
    const content = fs.readFileSync(filePath, 'utf-8');
    return { success: true, data: content };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 写入报告文件内容
ipcMain.handle('report:write', async (_event, fileName, content) => {
  try {
    const filePath = ensureReportFile(fileName);
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 屏幕区域选择（鼠标拖拽框选）- 覆盖所有显示器
ipcMain.handle('capture:selectRegion', async () => {
  const { BrowserWindow } = require('electron');

  // 计算所有显示器的总边界
  const displays = screen.getAllDisplays();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const display of displays) {
    const { x, y, width, height } = display.bounds;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + width > maxX) maxX = x + width;
    if (y + height > maxY) maxY = y + height;
  }
  const totalWidth = maxX - minX;
  const totalHeight = maxY - minY;

  // 隐藏主窗口，让用户能看到桌面
  selfHiding = true;
  mainWindow.hide();

  const selector = new BrowserWindow({
    x: minX,
    y: minY,
    width: totalWidth,
    height: totalHeight,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    hasShadow: false,
    focusable: true,
    resizable: false,
    movable: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'region-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 确保窗口覆盖全部显示器区域（避免被系统限制大小）
  selector.setBounds({ x: minX, y: minY, width: totalWidth, height: totalHeight });

  return new Promise((resolve) => {
    let resolved = false;

    const safeShowMainWindow = () => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          applyAlwaysOnTop();
          mainWindow.focus();
        }
        selfHiding = false;
      } catch(e) {}
    };

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        try { selector.close(); } catch(e) {}
        ipcMain.removeListener('region:finish', onFinish);
        ipcMain.removeListener('region:cancel', onCancel);
        safeShowMainWindow();
        resolve(null);
      }
    };

    const onFinish = async (_event, region) => {
      if (!resolved) {
        resolved = true;
        try { selector.close(); } catch(e) {}
        ipcMain.removeListener('region:finish', onFinish);
        ipcMain.removeListener('region:cancel', onCancel);

        // region 的坐标是相对于选区窗口的，需要转换为屏幕绝对坐标
        const absRegion = {
          x: region.x + minX,
          y: region.y + minY,
          width: region.width,
          height: region.height,
        };

        // 等待框选窗口关闭后桌面重绘，再截图（此时主窗口仍隐藏）
        await new Promise(r => setTimeout(r, 300));
        let previewDataUrl = null;
        try {
          // 确定该区域属于哪个显示器
          const centerX = absRegion.x + absRegion.width / 2;
          const centerY = absRegion.y + absRegion.height / 2;
          let targetDisplay = screen.getPrimaryDisplay();
          for (const d of displays) {
            const b = d.bounds;
            if (centerX >= b.x && centerX < b.x + b.width && centerY >= b.y && centerY < b.y + b.height) {
              targetDisplay = d;
              break;
            }
          }

          const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: targetDisplay.bounds.width, height: targetDisplay.bounds.height },
          });

          // 找到对应的屏幕源
          let source = sources[0];
          for (const s of sources) {
            if (s.display_id === String(targetDisplay.id)) {
              source = s;
              break;
            }
          }

          if (source && !source.thumbnail.isEmpty()) {
            const thumb = source.thumbnail;
            const sz = thumb.getSize();
            const db = targetDisplay.bounds;
            // 将绝对坐标转为相对于该显示器的坐标
            const relX = absRegion.x - db.x;
            const relY = absRegion.y - db.y;
            const cropX = Math.round(relX * sz.width / db.width);
            const cropY = Math.round(relY * sz.height / db.height);
            const cropW = Math.round(absRegion.width * sz.width / db.width);
            const cropH = Math.round(absRegion.height * sz.height / db.height);
            // 确保裁剪区域不越界
            const safeCropX = Math.max(0, Math.min(cropX, sz.width - 1));
            const safeCropY = Math.max(0, Math.min(cropY, sz.height - 1));
            const safeCropW = Math.max(1, Math.min(cropW, sz.width - safeCropX));
            const safeCropH = Math.max(1, Math.min(cropH, sz.height - safeCropY));
            previewDataUrl = thumb.crop({ x: safeCropX, y: safeCropY, width: safeCropW, height: safeCropH }).toDataURL();
          }
        } catch(e) {}

        safeShowMainWindow();
        resolve({ ...absRegion, previewDataUrl });
      }
    };

    const onCancel = () => cleanup();

    ipcMain.on('region:finish', onFinish);
    ipcMain.on('region:cancel', onCancel);

    selector.loadFile(path.join(__dirname, 'region-selector.html'));

    // 确保窗口加载后获得焦点
    selector.once('ready-to-show', () => {
      selector.focus();
    });

    selector.on('closed', () => {
      if (!resolved) {
        resolved = true;
        ipcMain.removeListener('region:finish', onFinish);
        ipcMain.removeListener('region:cancel', onCancel);
        safeShowMainWindow();
        resolve(null);
      }
    });
  });
});

// 录屏高亮遮罩窗口（区域录制时使用：四周变暗，区域内保持清晰 + 红框提示）
let recordingOverlayWindow = null;
ipcMain.handle('recording:showOverlay', async (_event, region) => {
  try {
    const { BrowserWindow } = require('electron');
    if (recordingOverlayWindow && !recordingOverlayWindow.isDestroyed()) {
      try { recordingOverlayWindow.close(); } catch (e) {}
    }
    recordingOverlayWindow = null;

    const displays = screen.getAllDisplays();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const d of displays) {
      const b = d.bounds;
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.x + b.width > maxX) maxX = b.x + b.width;
      if (b.y + b.height > maxY) maxY = b.y + b.height;
    }
    const totalWidth = maxX - minX;
    const totalHeight = maxY - minY;

    recordingOverlayWindow = new BrowserWindow({
      x: minX,
      y: minY,
      width: totalWidth,
      height: totalHeight,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      resizable: false,
      movable: false,
      enableLargerThanScreen: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // 鼠标事件穿透到下层窗口，保证用户能继续操作其他程序
    recordingOverlayWindow.setIgnoreMouseEvents(true, { forward: false });
    recordingOverlayWindow.setAlwaysOnTop(true, 'screen-saver');
    recordingOverlayWindow.setBounds({ x: minX, y: minY, width: totalWidth, height: totalHeight });

    // 把绝对坐标换算为相对于遮罩窗口左上角的坐标
    const relX = region.x - minX;
    const relY = region.y - minY;
    const url = `file://${path.join(__dirname, 'recording-overlay.html').replace(/\\/g, '/')}?x=${relX}&y=${relY}&w=${region.width}&h=${region.height}`;
    recordingOverlayWindow.loadURL(url);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('recording:hideOverlay', async () => {
  try {
    if (recordingOverlayWindow && !recordingOverlayWindow.isDestroyed()) {
      try { recordingOverlayWindow.close(); } catch (e) {}
    }
    recordingOverlayWindow = null;
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 截取屏幕区域（支持多显示器）
ipcMain.handle('capture:screenshotRegion', async (_event, region) => {
  try {
    const displays = screen.getAllDisplays();

    // 确定该区域属于哪个显示器（以区域中心点判断）
    const centerX = region.x + region.width / 2;
    const centerY = region.y + region.height / 2;
    let targetDisplay = screen.getPrimaryDisplay();
    for (const d of displays) {
      const b = d.bounds;
      if (centerX >= b.x && centerX < b.x + b.width && centerY >= b.y && centerY < b.y + b.height) {
        targetDisplay = d;
        break;
      }
    }

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: targetDisplay.bounds.width, height: targetDisplay.bounds.height },
    });
    if (sources.length === 0) return { success: false, error: '未找到屏幕源' };

    // 找到对应的屏幕源
    let source = sources[0];
    for (const s of sources) {
      if (s.display_id === String(targetDisplay.id)) {
        source = s;
        break;
      }
    }

    const thumbnail = source.thumbnail;
    if (thumbnail.isEmpty()) return { success: false, error: '截图为空' };

    const size = thumbnail.getSize();
    const db = targetDisplay.bounds;

    // 将绝对坐标转为相对于该显示器的坐标
    const relX = region.x - db.x;
    const relY = region.y - db.y;
    const cropX = Math.round(relX * size.width / db.width);
    const cropY = Math.round(relY * size.height / db.height);
    const cropW = Math.round(region.width * size.width / db.width);
    const cropH = Math.round(region.height * size.height / db.height);

    // 安全边界检查
    const safeCropX = Math.max(0, Math.min(cropX, size.width - 1));
    const safeCropY = Math.max(0, Math.min(cropY, size.height - 1));
    const safeCropW = Math.max(1, Math.min(cropW, size.width - safeCropX));
    const safeCropH = Math.max(1, Math.min(cropH, size.height - safeCropY));

    const cropped = thumbnail.crop({ x: safeCropX, y: safeCropY, width: safeCropW, height: safeCropH });
    return { success: true, dataUrl: cropped.toDataURL() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ===================== SVN 批量更新 IPC Handlers =====================

// 选择文件对话框
ipcMain.handle('dialog:openFile', async (_event, options) => {
  const { filters } = options || {};
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters || [{ name: 'All Files', extensions: ['*'] }],
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// 规范化工作副本路径：
// 1. 去掉末尾的 \ 或 /，避免传给 TortoiseProc 时反斜杠转义双引号导致 E155007
// 2. 去掉首尾空白
function normalizeWcPath(p) {
  if (typeof p !== 'string') return p;
  let s = p.trim();
  // 反复剥离末尾的 \ /，但保留盘符根（如 D:\ 保留为 D:\）
  while (s.length > 3 && (s.endsWith('\\') || s.endsWith('/'))) {
    s = s.slice(0, -1);
  }
  return s;
}

// 执行 SVN Update（使用 TortoiseSVN 窗口程序）
// TortoiseProc.exe 是 GUI 程序，启动后会立即返回，需要通过轮询 wmic 检测其窗口进程是否结束
ipcMain.handle('svn:update', async (_event, rawDirPath) => {
  // 规范化路径（去除末尾斜杠等）
  const dirPath = normalizeWcPath(rawDirPath);

  // 校验：参数为空或不是字符串
  if (!dirPath || typeof dirPath !== 'string') {
    return { success: false, error: `路径无效: ${rawDirPath}` };
  }

  // 检查路径是否存在
  if (!fs.existsSync(dirPath)) {
    return { success: false, error: `路径不存在: ${dirPath}` };
  }

  // 校验是否是 SVN 工作副本（避免 TortoiseProc 报 E155007 黑盒错误）
  const svnMetaDir = path.join(dirPath, '.svn');
  if (!fs.existsSync(svnMetaDir)) {
    return {
      success: false,
      error: `不是 SVN 工作副本（缺少 .svn 目录）: ${dirPath}\n请确认该目录是通过 SVN Checkout 检出的，或重新 Checkout。`,
    };
  }

  // 先尝试 svn status 检测是否需要 cleanup
  const checkResult = await new Promise((resolve) => {
    exec(`svn status "${dirPath}" --show-updates`, { cwd: dirPath, timeout: 30000 }, (err, stdout, stderr) => {
      if (err && (err.message.includes('locked') || (stderr && stderr.includes('locked')))) {
        resolve({ needsCleanup: true });
      } else {
        resolve({ needsCleanup: false });
      }
    });
  });

  // 如果需要 cleanup，先用 TortoiseSVN 执行 cleanup
  if (checkResult.needsCleanup) {
    await new Promise((resolve) => {
      const { spawn } = require('child_process');
      // 1) 先快照已存在的 TortoiseProc.exe PID，spawn 后通过差集找到本次新启动的那个
      //    这样可以彻底避免"wmic 查询失败"导致的假阳性 resolve
      exec('tasklist /FI "IMAGENAME eq TortoiseProc.exe" /FO CSV /NH', (snapErr, snapOut) => {
        const existingPids = new Set();
        if (!snapErr && snapOut) {
          snapOut.split('\n').forEach(line => {
            const m = line.match(/"[^"]+","(\d+)"/);
            if (m) existingPids.add(parseInt(m[1]));
          });
        }

        // 2) 直接 spawn TortoiseProc.exe，避免 cmd.exe 引号/反斜杠转义陷阱
        const cleanupChild = spawn(
          'TortoiseProc.exe',
          ['/command:cleanup', `/path:${dirPath}`, '/closeonend:3'],
          { shell: false, detached: true, stdio: 'ignore', windowsHide: false }
        );
        let spawnErr = null;
        cleanupChild.on('error', (e) => { spawnErr = e; });
        cleanupChild.unref();

        // 3) 反复扫描，找到本次新启动的、命令行匹配 dirPath 的 TortoiseProc PID
        let cleanupPid = null;
        const startTime = Date.now();
        const findInterval = setInterval(() => {
          if (spawnErr) {
            clearInterval(findInterval);
            return resolve(); // cleanup 启动失败直接放过，让 update 自己再校验
          }
          const wqlPath = dirPath.replace(/\\/g, '\\\\');
          const findCmd = `wmic process where "name='TortoiseProc.exe' and commandline like '%cleanup%' and commandline like '%${wqlPath}%'" get ProcessId /format:csv`;
          exec(findCmd, { timeout: 10000 }, (err, stdout) => {
            if (!err && stdout) {
              const lines = stdout.trim().split('\n').filter(l => l.trim() && !l.toLowerCase().includes('processid'));
              for (const line of lines) {
                const parts = line.trim().split(',');
                const pid = parseInt(parts[parts.length - 1]);
                if (!isNaN(pid) && pid > 0 && !existingPids.has(pid)) {
                  cleanupPid = pid;
                  break;
                }
              }
            }

            if (cleanupPid) {
              clearInterval(findInterval);
              // 4) 监视该 PID 直到退出
              const waitCleanup = setInterval(() => {
                exec(`tasklist /FI "PID eq ${cleanupPid}" /FO CSV /NH`, (e, out) => {
                  if (!out || !out.includes('TortoiseProc')) {
                    clearInterval(waitCleanup);
                    resolve();
                  }
                });
              }, 2000);
              setTimeout(() => { clearInterval(waitCleanup); resolve(); }, 300000); // 最长 5 分钟
            } else if (Date.now() - startTime > 30000) {
              // 30 秒还找不到对应的 cleanup 进程，放过让 update 流程继续
              clearInterval(findInterval);
              resolve();
            }
          });
        }, 1500);
      });
    });
    // cleanup 后等 2 秒让锁释放
    await new Promise(r => setTimeout(r, 2000));
  }

  // 使用 TortoiseProc.exe 执行 update
  // /closeonend:2 表示无错误且无冲突时自动关闭窗口；有冲突/错误时保留窗口让用户查看
  return new Promise((resolve) => {
    const { spawn } = require('child_process');

    // 1) 先快照所有已存在的 TortoiseProc.exe PID
    //    spawn 后通过差集找到本次新启动的那一个，避免：
    //      a) wmic 不可用/查询失败导致的"假阳性 resolve"
    //      b) 多个并行 update 互相干扰
    exec('tasklist /FI "IMAGENAME eq TortoiseProc.exe" /FO CSV /NH', (snapErr, snapOut) => {
      const existingPids = new Set();
      if (!snapErr && snapOut) {
        snapOut.split('\n').forEach(line => {
          const m = line.match(/"[^"]+","(\d+)"/);
          if (m) existingPids.add(parseInt(m[1]));
        });
      }

      // 2) 启动 TortoiseProc.exe（直接 spawn，避免 cmd.exe 引号/反斜杠转义陷阱）
      //    （路径以 \ 结尾时 "D:\foo\" 会被 cmd 解析成 D:\foo"，引发 E155007）
      const child = spawn(
        'TortoiseProc.exe',
        ['/command:update', `/path:${dirPath}`, '/closeonend:2'],
        { shell: false, detached: true, stdio: 'ignore', windowsHide: false }
      );
      // 监听 spawn 错误（如 TortoiseProc.exe 不在 PATH 中）—— 否则会悄无声息失败
      let spawnErr = null;
      child.on('error', (e) => { spawnErr = e; });
      child.unref();

      let targetPid = null;
      const startTime = Date.now();

      // 3) 反复扫描，找到本次新启动的、命令行匹配 dirPath 的 TortoiseProc PID
      //    在找到 PID 之前绝不 resolve，从根本上杜绝"更新还没开始后置 BAT 就跑了"
      const findInterval = setInterval(() => {
        if (spawnErr) {
          clearInterval(findInterval);
          return resolve({
            success: false,
            error: `启动 TortoiseProc.exe 失败：${spawnErr.message}\n请确认已安装 TortoiseSVN，且安装时勾选了「command line client tools」（让 TortoiseProc.exe 加入 PATH）。`,
          });
        }

        const wqlPath = dirPath.replace(/\\/g, '\\\\');
        const findPidCmd = `wmic process where "name='TortoiseProc.exe' and commandline like '%${wqlPath}%'" get ProcessId /format:csv`;

        exec(findPidCmd, { timeout: 10000 }, (err, stdout) => {
          if (!err && stdout) {
            const lines = stdout.trim().split('\n').filter(l => l.trim() && !l.toLowerCase().includes('processid'));
            for (const line of lines) {
              const parts = line.trim().split(',');
              const pid = parseInt(parts[parts.length - 1]);
              // 排除快照中已存在的（属于其他并行任务），找新启动的
              if (!isNaN(pid) && pid > 0 && !existingPids.has(pid)) {
                targetPid = pid;
                break;
              }
            }
          }

          if (targetPid) {
            // 找到 PID 了，进入"等待该进程退出"阶段
            clearInterval(findInterval);
            startWatch(targetPid);
          } else if (Date.now() - startTime > 60000) {
            // 60 秒还找不到对应的 TortoiseProc，认为启动失败 / wmic 不可用
            clearInterval(findInterval);
            resolve({
              success: false,
              error: `未检测到 TortoiseProc.exe 进程（路径：${dirPath}）。\n可能原因：\n  1. TortoiseSVN 未安装或不在 PATH；\n  2. wmic 命令不可用（Win11 部分版本已默认禁用）；\n  3. 进程被安全软件拦截。\n请手动在该目录右键执行 SVN Update 验证。`,
            });
          }
          // 否则继续下一轮 scan
        });
      }, 2000);

      // 等待目标 PID 退出后再 resolve
      function startWatch(pid) {
        const watchInterval = setInterval(() => {
          exec(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, (e, out) => {
            if (!out || !out.includes('TortoiseProc')) {
              clearInterval(watchInterval);
              // TortoiseProc 退出后再用 svn status 检测冲突
              exec(`svn status "${dirPath}"`, { cwd: dirPath, timeout: 30000 }, (statusErr, statusOut) => {
                if (statusOut && statusOut.includes('C ')) {
                  resolve({ success: true, output: 'SVN Update 完成（存在冲突，请稍后手动处理）', hasConflict: true });
                } else {
                  resolve({ success: true, output: 'SVN Update 完成' });
                }
              });
            }
          });
        }, 2000);
        // 单个 update 最长等 30 分钟
        setTimeout(() => {
          clearInterval(watchInterval);
          resolve({ success: true, output: 'SVN Update 超时（TortoiseSVN 窗口可能仍在运行）' });
        }, 1800000);
      }
    });
  });
});

// 执行 BAT 文件（等待 BAT 执行完毕后再返回）
ipcMain.handle('svn:runBat', async (_event, batPath) => {
  // 检查文件是否存在
  if (!fs.existsSync(batPath)) {
    return { success: false, error: `文件不存在: ${batPath}` };
  }

  const batDir = path.dirname(batPath);
  
  return new Promise((resolve) => {
    // 使用 exec 执行 BAT，等待其完全退出后再 resolve
    exec(`"${batPath}"`, { cwd: batDir, timeout: 300000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        // 如果是超时错误
        if (err.killed) {
          resolve({ success: false, error: `BAT 执行超时（5分钟）: ${batPath}` });
        } else {
          // BAT 执行出错但不一定是失败（有些 BAT taskkill 返回非0退出码是正常的）
          resolve({ success: true, output: stdout || stderr || `BAT 执行完毕（退出码: ${err.code}）` });
        }
      } else {
        resolve({ success: true, output: stdout || 'BAT 执行完毕' });
      }
    });
  });
});

// ===================== 媒体评分 IPC Handlers =====================

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.avif', '.ico']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.avi', '.mkv', '.flv', '.wmv']);
const RATING_FILE_NAME = '.media-ratings.json';

function getMediaType(ext) {
  const e = (ext || '').toLowerCase();
  if (IMAGE_EXTS.has(e)) return 'image';
  if (RAW_EXTS.has(e)) return 'image'; // RAW 也归为图片，预览时会透明转换为内嵌 JPEG
  if (VIDEO_EXTS.has(e)) return 'video';
  return null;
}

// 扫描文件夹下的图片/视频文件
ipcMain.handle('media:scan', async (_event, dirPath, options) => {
  const { includeSubfolders = false } = options || {};
  const results = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (includeSubfolders) walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        const type = getMediaType(ext);
        if (!type) continue;
        try {
          const stat = fs.statSync(fullPath);
          results.push({
            name: entry.name,
            path: fullPath,
            relativePath: path.relative(dirPath, fullPath),
            size: stat.size,
            extension: ext,
            type,
            modifyTime: stat.mtime.toISOString(),
          });
        } catch (e) {}
      }
    }
  }

  try {
    if (!fs.existsSync(dirPath)) return { success: false, error: '路径不存在' };
    walk(dirPath);
    // 按文件名自然排序
    results.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN', { numeric: true }));
    return { success: true, data: results };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 读取评分数据（保存在源文件夹下的 .media-ratings.json）
ipcMain.handle('media:loadRatings', async (_event, dirPath) => {
  try {
    const filePath = path.join(dirPath, RATING_FILE_NAME);
    if (!fs.existsSync(filePath)) return { success: true, data: {} };
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return { success: true, data: data && typeof data === 'object' ? data : {} };
  } catch (err) {
    return { success: false, error: err.message, data: {} };
  }
});

// 保存评分数据
ipcMain.handle('media:saveRatings', async (_event, dirPath, ratings) => {
  try {
    const filePath = path.join(dirPath, RATING_FILE_NAME);
    fs.writeFileSync(filePath, JSON.stringify(ratings || {}, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 按评分导出（复制或移动）到目标文件夹
// files: [{ path, name, relativePath }]
// groupByRating: 是否按"评分_X星"建子目录
ipcMain.handle('media:exportByRating', async (_event, files, targetPath, isCopyMode, groupByRating, ratingMap) => {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return { success: false, error: '目标路径不存在' };
  }
  let successCount = 0;
  let failCount = 0;
  const errors = [];

  for (const file of files) {
    try {
      let destDir = targetPath;
      if (groupByRating) {
        const r = ratingMap && ratingMap[file.relativePath || file.name];
        const folderName = r ? `${r}星` : '未评分';
        destDir = path.join(targetPath, folderName);
      }
      fs.mkdirSync(destDir, { recursive: true });

      // 处理重名：a.jpg -> a (1).jpg
      let destFile = path.join(destDir, file.name);
      if (fs.existsSync(destFile)) {
        const ext = path.extname(file.name);
        const base = path.basename(file.name, ext);
        let i = 1;
        while (fs.existsSync(path.join(destDir, `${base} (${i})${ext}`))) i++;
        destFile = path.join(destDir, `${base} (${i})${ext}`);
      }

      if (isCopyMode) {
        fs.copyFileSync(file.path, destFile);
      } else {
        fs.copyFileSync(file.path, destFile);
        fs.unlinkSync(file.path);
      }
      successCount++;
    } catch (err) {
      failCount++;
      errors.push(`${file.name}: ${err.message}`);
    }
  }
  return { success: true, data: { successCount, failCount, errors } };
});

// 删除文件（支持移到回收站）
ipcMain.handle('media:deleteFile', async (_event, filePath, toTrash) => {
  try {
    if (toTrash) {
      const { shell } = require('electron');
      await shell.trashItem(filePath);
    } else {
      fs.unlinkSync(filePath);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

