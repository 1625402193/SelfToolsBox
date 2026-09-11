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

// ===================== 批量复制图片 IPC Handlers =====================

const IMAGE_COPY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp', '.tga', '.tif', '.tiff', '.psd',
]);

// 通用前缀段：这些段在所有资源名中都相同（如 Icon_ / UI_），不具备区分度，
// 提取分类键时跳过它们，改用后面的业务段（Icon_ShareTalk_xxx → 业务段 ShareTalk）
const DEFAULT_GENERIC_PREFIXES = ['icon', 'img', 'image', 'ui', 'tex', 'texture', 'pic', 'sprite', 'spr', 'bg'];

// 索引 / 日志文件均存放在 userData（系统用户目录，如 %APPDATA%/file-classifier-tools/），
// 位于项目仓库之外，git 无法触及，因此不会随项目上传。
//
// 【隐私】这些文件含有用户的完整本地磁盘路径与项目目录结构（属于个人/公司内部信息），
// 必须只保留在本机。新增相关文件时一律写在 userData 下，禁止写入项目目录。
//
// 每个目标路径拥有独立的索引文件（以路径 hash 命名），互不干扰：
// 多个目标路径是彼此独立的处理单元，检索、匹配、复制都各做各的，不做合并。
function getImageCopyIndexDir() {
  return path.join(app.getPath('userData'), 'image-copy-index');
}
function getImageCopyIndexFile(root) {
  const hash = crypto.createHash('md5').update(path.resolve(root).toLowerCase()).digest('hex');
  return path.join(getImageCopyIndexDir(), `${hash}.json`);
}
function getImageCopyLogPath() {
  return path.join(app.getPath('userData'), 'image-copy-log.jsonl');
}

// 主进程侧缓存：索引与扫描结果数据量较大，避免在 IPC 中反复往返传输
// index 形如 { roots: [{ root, updatedAt, stats, entries }] }
// excludePaths 记录用户选择不复制的源图片（如尺寸异常图），仅用于日志回溯
let imageCopyState = { index: null, scan: null, plan: null, excludePaths: [] };

/**
 * 从文件头解析图片尺寸（不引入第三方依赖）。
 * 支持 PNG / GIF / BMP / WEBP / JPEG，解析失败返回 null 由调用方降级处理。
 */
function parseImageSizeFromBuffer(buf) {
  if (!buf || buf.length < 16) return null;

  // PNG：IHDR 固定为首个 chunk
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    if (buf.toString('ascii', 12, 16) === 'IHDR') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
  }

  // GIF
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // BMP（高度可能为负，表示自上而下存储）
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
  }

  // WEBP
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fourCC = buf.toString('ascii', 12, 16);
    if (fourCC === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (fourCC === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (fourCC === 'VP8X') {
      return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    }
  }

  // JPEG：遍历 segment 找 SOFn
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) { offset++; continue; }
      const marker = buf[offset + 1];
      // 填充字节 / SOI / RSTn：无长度字段
      if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { offset += 2; continue; }
      // EOI / SOS：之后是熵编码数据，不再有尺寸信息
      if (marker === 0xd9 || marker === 0xda) break;
      const segLen = buf.readUInt16BE(offset + 2);
      if (segLen < 2) break;
      // SOF0~SOF15，排除 DHT(C4) / JPG(C8) / DAC(CC)
      const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF && offset + 9 < buf.length) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      offset += 2 + segLen;
    }
  }

  // PSD
  if (buf.length >= 26 && buf.toString('ascii', 0, 4) === '8BPS') {
    return { width: buf.readUInt32BE(18), height: buf.readUInt32BE(14) };
  }

  return null;
}

// 读取图片尺寸：优先文件头解析，失败时降级到 nativeImage（覆盖 tiff 等格式）
function readImageSize(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    // JPEG 的 SOF 段可能不在最前面，读取 256KB 足以覆盖绝大多数情况
    const len = Math.min(stat.size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    fd = null;

    // TGA 无 magic number，只能按扩展名解析固定头
    if (ext === '.tga' && buf.length >= 18) {
      const w = buf.readUInt16LE(12);
      const h = buf.readUInt16LE(14);
      if (w > 0 && h > 0) return { width: w, height: h };
    }
    const size = parseImageSizeFromBuffer(buf);
    if (size && size.width > 0 && size.height > 0) return size;
  } catch (e) {
    // 忽略，走降级分支
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} }
  }

  try {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromPath(filePath);
    if (!img.isEmpty()) {
      const s = img.getSize();
      if (s.width > 0 && s.height > 0) return s;
    }
  } catch (e) {}
  return null;
}

// 按 _ - 空格 . 拆分文件名为语义段
function splitNameSegments(baseName) {
  return String(baseName).split(/[_\-\s.]+/).filter(Boolean);
}

/**
 * 提取分类键。
 * 规则：跳过开头的通用前缀段（Icon_ 等），取其后 keySegments 个业务段作为唯一键。
 * 例：keySegments=1 时
 *   Icon_ShareTalk_ChangE_RiYue_Btn.png → key=sharetalk, display=Icon_ShareTalk_
 *   Icon_ShareTalk_01.png               → key=sharetalk, display=Icon_ShareTalk_
 *   Icon_ShareTalk_hero_02.png          → key=sharetalk, display=Icon_ShareTalk_
 * 这样同一业务模块的图片会归入同一分类，即需求中要求的"模糊性"。
 */
function extractGroupKey(fileName, options) {
  const opts = options || {};
  const keySegments = Math.max(1, Number(opts.keySegments) || 1);
  const prefixList = Array.isArray(opts.genericPrefixes) && opts.genericPrefixes.length
    ? opts.genericPrefixes
    : DEFAULT_GENERIC_PREFIXES;
  const generic = new Set(prefixList.map(s => String(s).toLowerCase()));

  const base = path.basename(fileName, path.extname(fileName));
  const segs = splitNameSegments(base);
  if (segs.length === 0) {
    return { key: base.toLowerCase(), display: base };
  }

  // 跳过开头的通用前缀段，但至少保留最后一段，避免整名被吃空
  const leading = [];
  let i = 0;
  while (i < segs.length - 1 && generic.has(segs[i].toLowerCase())) {
    leading.push(segs[i]);
    i++;
  }

  const picked = segs.slice(i, i + keySegments);
  if (picked.length === 0) {
    return { key: base.toLowerCase(), display: base };
  }

  return {
    key: picked.join('_').toLowerCase(),
    // 展示名带尾部下划线，与需求中的 Icon_ShareTalk_ 写法保持一致
    display: [...leading, ...picked].join('_') + '_',
  };
}

// 遍历目录下的图片文件，skipDirs 用于跳过工具自己创建的输出文件夹
function walkImageFiles(root, recursive, skipDirs, onFile) {
  const skip = new Set((skipDirs || []).filter(Boolean).map(s => String(s).toLowerCase()));
  function walk(dir, depth) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!recursive || depth >= 12) continue;
        if (skip.has(entry.name.toLowerCase())) continue;
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!IMAGE_COPY_EXTS.has(ext)) continue;
        try {
          onFile(fullPath, fs.statSync(fullPath));
        } catch (e) {}
      }
    }
  }
  walk(root, 0);
}

// 追加操作日志到本地文件（jsonl，逐行追加避免读写整个文件）
function appendImageCopyLog(entries) {
  const list = Array.isArray(entries) ? entries : [entries];
  if (list.length === 0) return;
  try {
    const lines = list.map(e => JSON.stringify({ time: new Date().toISOString(), ...e })).join('\n') + '\n';
    fs.appendFileSync(getImageCopyLogPath(), lines, 'utf-8');
  } catch (e) {}
}

// ---------- 目标索引 ----------

// 把单个目标路径下的图片聚合成「键 → 目录列表」
function buildRootIndex(root, recursive, skipDirs, opts) {
  const entries = {};
  let imageCount = 0;
  walkImageFiles(root, recursive, skipDirs, (filePath, stat) => {
    imageCount++;
    const name = path.basename(filePath);
    const { key, display } = extractGroupKey(name, opts);
    const dir = path.dirname(filePath);
    if (!entries[key]) entries[key] = { key, display, dirs: [] };
    let bucket = entries[key].dirs.find(d => d.dir === dir);
    if (!bucket) {
      bucket = { dir, files: [] };
      entries[key].dirs.push(bucket);
    }
    bucket.files.push({ name, path: filePath, size: stat.size, modifyTime: stat.mtime.toISOString() });
  });

  const keyList = Object.keys(entries);
  return {
    root,
    version: 2,
    updatedAt: new Date().toISOString(),
    options: { keySegments: opts.keySegments || 1, recursive },
    stats: {
      keyCount: keyList.length,
      dirCount: keyList.reduce((sum, k) => sum + entries[k].dirs.length, 0),
      imageCount,
      // 同一目标路径内部，一个键落在多个子目录时仍需用户选择
      multiDirKeyCount: keyList.filter(k => entries[k].dirs.length > 1).length,
    },
    entries,
  };
}

// 索引明细体积较大，只回传摘要给渲染进程
function summarizeRootIndex(rootIndex) {
  const entries = rootIndex.entries || {};
  return {
    root: rootIndex.root,
    updatedAt: rootIndex.updatedAt,
    indexFile: getImageCopyIndexFile(rootIndex.root),
    stats: rootIndex.stats || {},
    entries: Object.keys(entries)
      .map(k => ({
        key: k,
        display: entries[k].display,
        dirCount: (entries[k].dirs || []).length,
        fileCount: (entries[k].dirs || []).reduce((s, d) => s + (d.files || []).length, 0),
        dirs: (entries[k].dirs || []).map(d => d.dir),
      }))
      .sort((a, b) => a.display.localeCompare(b.display, 'zh-CN', { numeric: true })),
  };
}

/**
 * 为每个目标路径分别建立索引。
 * 多个目标路径彼此独立：各自检索、各自落盘（一个路径一个索引文件），不做任何跨路径合并。
 */
ipcMain.handle('imageCopy:buildIndex', async (_event, targetPaths, options) => {
  const opts = options || {};
  const recursive = opts.recursive !== false;
  const skipDirs = [opts.oddSizeFolderName, opts.unmatchedFolderName];

  try {
    const valid = [];
    const missing = [];
    for (const p of targetPaths || []) {
      if (!p) continue;
      if (fs.existsSync(p)) valid.push(p);
      else missing.push(p);
    }
    if (valid.length === 0) {
      return { success: false, error: '没有有效的目标路径' };
    }

    fs.mkdirSync(getImageCopyIndexDir(), { recursive: true });

    const roots = [];
    const logs = [];
    for (const root of valid) {
      const rootIndex = buildRootIndex(root, recursive, skipDirs, opts);
      fs.writeFileSync(getImageCopyIndexFile(root), JSON.stringify(rootIndex, null, 2), 'utf-8');
      roots.push(rootIndex);
      const s = rootIndex.stats;
      logs.push({
        action: 'buildIndex',
        level: 'success',
        message: `目标路径索引完成：${root} → ${s.imageCount} 张图 / ${s.keyCount} 个键（${s.multiDirKeyCount} 个键在该路径内分布于多个目录）`,
        detail: { root, indexFile: getImageCopyIndexFile(root) },
      });
    }
    if (missing.length) {
      logs.push({ action: 'buildIndex', level: 'warn', message: `以下目标路径不存在，已跳过：${missing.join('、')}` });
    }
    appendImageCopyLog(logs);

    imageCopyState.index = { roots };
    imageCopyState.plan = null;

    return {
      success: true,
      data: {
        exists: true,
        indexDir: getImageCopyIndexDir(),
        missing,
        roots: roots.map(summarizeRootIndex),
      },
    };
  } catch (err) {
    appendImageCopyLog({ action: 'buildIndex', level: 'error', message: `重建索引失败：${err.message}` });
    return { success: false, error: err.message };
  }
});

/**
 * 读取已落盘的索引。
 * 传入 targetPaths 时只加载这些路径对应的索引文件（各自独立），
 * 未传时加载索引目录下的全部索引。
 */
ipcMain.handle('imageCopy:loadIndex', async (_event, targetPaths) => {
  try {
    const dir = getImageCopyIndexDir();
    if (!fs.existsSync(dir)) {
      return { success: true, data: { exists: false, indexDir: dir, roots: [] } };
    }

    const roots = [];
    const wanted = (targetPaths || []).map(p => String(p || '').trim()).filter(Boolean);

    const readIndexFile = file => {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return data && data.root ? data : null;
      } catch (e) {
        return null;
      }
    };

    if (wanted.length > 0) {
      for (const root of wanted) {
        const file = getImageCopyIndexFile(root);
        if (!fs.existsSync(file)) continue;
        const data = readIndexFile(file);
        if (data) roots.push(data);
      }
    } else {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        const data = readIndexFile(path.join(dir, name));
        if (data) roots.push(data);
      }
    }

    imageCopyState.index = roots.length > 0 ? { roots } : null;
    return {
      success: true,
      data: {
        exists: roots.length > 0,
        indexDir: dir,
        roots: roots.map(summarizeRootIndex),
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ---------- 源路径扫描 ----------

/**
 * 检索源路径下的图片，完成三件事：
 * 1. 分类：按与索引一致的规则提取分类键
 * 2. 合并：跨源路径同名文件只保留创建/修改时间最新的一张
 * 3. 尺寸校验：宽高是否均为 2 的倍数。
 *    注：尺寸异常的图片**不会**被强制剔除，只做标记（oddSized）并照常进入分类结果，
 *    最终是否复制到目标路径由用户在界面上逐项选择（见 makePlan 的 excludePaths）。
 *    可选地把这些图片额外复制一份到「首个源路径 / 尺寸异常」文件夹备查。
 */
ipcMain.handle('imageCopy:scanSources', async (_event, sourcePaths, options) => {
  const opts = options || {};
  const recursive = opts.recursive !== false;
  const oddSizeFolderName = opts.oddSizeFolderName || '尺寸异常';
  const copyOddSizeToFolder = opts.copyOddSizeToFolder !== false;
  const skipDirs = [oddSizeFolderName, opts.unmatchedFolderName];

  try {
    const valid = [];
    const missing = [];
    for (const p of sourcePaths || []) {
      if (!p) continue;
      if (fs.existsSync(p)) valid.push(p);
      else missing.push(p);
    }
    if (valid.length === 0) {
      return { success: false, error: '没有有效的源路径' };
    }

    // 收集所有图片
    const collected = [];
    for (const root of valid) {
      walkImageFiles(root, recursive, skipDirs, (filePath, stat) => {
        collected.push({
          name: path.basename(filePath),
          path: filePath,
          root,
          size: stat.size,
          // 创建时间与修改时间取较新者，作为「最新」的判定依据
          latestTime: Math.max(stat.mtimeMs || 0, stat.birthtimeMs || 0),
          modifyTime: stat.mtime.toISOString(),
        });
      });
    }

    // 合并同名文件：只保留最新的一张
    const byName = new Map();
    const duplicates = [];
    for (const item of collected) {
      const nameKey = item.name.toLowerCase();
      const exist = byName.get(nameKey);
      if (!exist) {
        byName.set(nameKey, item);
        continue;
      }
      const [keep, drop] = item.latestTime > exist.latestTime ? [item, exist] : [exist, item];
      byName.set(nameKey, keep);
      duplicates.push({ name: drop.name, dropped: drop.path, kept: keep.path });
    }

    // 尺寸校验 + 分类：所有图片都进入 files，尺寸异常的只做标记
    const files = [];
    const oddSized = [];
    const unknownSize = [];
    for (const item of byName.values()) {
      const { key, display } = extractGroupKey(item.name, opts);
      const size = readImageSize(item.path);
      const record = {
        ...item,
        key,
        display,
        width: size ? size.width : null,
        height: size ? size.height : null,
      };
      if (!size) {
        // 尺寸读不出来时仅记录警告，不影响复制
        record.sizeUnknown = true;
        unknownSize.push(record);
      } else if (size.width % 2 !== 0 || size.height % 2 !== 0) {
        record.oddSized = true;
        oddSized.push(record);
      }
      files.push(record);
    }

    // 可选：把尺寸异常的图片额外复制一份到首个源路径下的尺寸文件夹，方便集中查看/修图
    let oddSizeFolder = null;
    const logs = [];
    if (oddSized.length > 0 && copyOddSizeToFolder) {
      oddSizeFolder = path.join(valid[0], oddSizeFolderName);
      try {
        fs.mkdirSync(oddSizeFolder, { recursive: true });
        logs.push({ action: 'mkdir', level: 'warn', message: `创建尺寸异常文件夹：${oddSizeFolder}` });
        for (const item of oddSized) {
          try {
            fs.copyFileSync(item.path, path.join(oddSizeFolder, item.name));
            logs.push({
              action: 'oddSize',
              level: 'warn',
              message: `尺寸非 2 的倍数（${item.width}×${item.height}），已另存一份到尺寸异常文件夹备查：${item.name}`,
              detail: { from: item.path },
            });
          } catch (e) {
            logs.push({ action: 'oddSize', level: 'error', message: `复制到尺寸异常文件夹失败：${item.name} - ${e.message}` });
          }
        }
      } catch (e) {
        oddSizeFolder = null;
        logs.push({ action: 'mkdir', level: 'error', message: `创建尺寸异常文件夹失败：${e.message}` });
      }
    } else if (oddSized.length > 0) {
      logs.push({
        action: 'oddSize', level: 'warn',
        message: `发现 ${oddSized.length} 张尺寸非 2 的倍数的图片（未另存到尺寸异常文件夹，可在选项中开启）`,
      });
    }

    // 按分类键聚合（含尺寸异常的图片）
    const groupMap = new Map();
    for (const f of files) {
      if (!groupMap.has(f.key)) groupMap.set(f.key, { key: f.key, display: f.display, files: [] });
      groupMap.get(f.key).files.push(f);
    }
    const groups = [...groupMap.values()].sort((a, b) =>
      a.display.localeCompare(b.display, 'zh-CN', { numeric: true }));

    const scan = {
      sourcePaths: valid,
      scannedAt: new Date().toISOString(),
      groups,
      files,
      oddSized,
      unknownSize,
      duplicates,
      oddSizeFolder,
    };
    imageCopyState.scan = scan;
    imageCopyState.plan = null;

    logs.unshift({
      action: 'scanSources',
      level: 'success',
      message: `扫描源路径完成：共 ${collected.length} 张图，合并重名 ${duplicates.length} 张，待处理 ${files.length} 张（其中尺寸非 2 的倍数 ${oddSized.length} 张，是否复制由用户选择），归为 ${groups.length} 个分类`,
      detail: { sourcePaths: valid, missing },
    });
    appendImageCopyLog(logs);

    return {
      success: true,
      data: {
        scannedAt: scan.scannedAt,
        missing,
        total: collected.length,
        pending: files.length,
        oddSizeFolder,
        groups: groups.map(g => ({
          key: g.key,
          display: g.display,
          fileCount: g.files.length,
          files: g.files.map(f => ({
            name: f.name, path: f.path, width: f.width, height: f.height,
            sizeUnknown: !!f.sizeUnknown, oddSized: !!f.oddSized,
          })),
        })),
        oddSized: oddSized.map(f => ({
          name: f.name, path: f.path, width: f.width, height: f.height, display: f.display,
        })),
        unknownSize: unknownSize.map(f => ({ name: f.name, path: f.path })),
        duplicates,
        logs,
      },
    };
  } catch (err) {
    appendImageCopyLog({ action: 'scanSources', level: 'error', message: `扫描源路径失败：${err.message}` });
    return { success: false, error: err.message };
  }
});

// ---------- 匹配与复制 ----------

/**
 * 为每个目标路径生成短标签，用于「未匹配」文件夹下按目标路径分子目录。
 * 以目录名为主，重名时追加序号保证唯一。
 */
function makeRootLabels(roots) {
  const labels = {};
  const used = new Set();
  for (const root of roots) {
    let base = path.basename(root) || root.replace(/[\\/:]/g, '_');
    let label = base;
    let i = 2;
    while (used.has(label.toLowerCase())) {
      label = `${base}_${i}`;
      i++;
    }
    used.add(label.toLowerCase());
    labels[root] = label;
  }
  return labels;
}

// 多目录选择的复合键：目标路径与分类键共同决定一次选择，避免不同目标路径互相串味
function choiceKey(root, key) {
  return `${root}||${key}`;
}

/**
 * 将扫描结果分别与每个目标路径的索引匹配，为每个目标路径生成一份独立的复制计划。
 * 每个目标路径内部：
 * - direct：键在该路径内唯一命中一个目录，可直接复制
 * - ambiguous：键在该路径内命中多个目录，需要用户选择
 * - unmatched：该路径的索引中没有这个键
 * 同一张图会分别复制到每个目标路径下各自对应的目录，互不影响。
 *
 * excludePaths: 用户勾掉的源图片绝对路径数组（主要用于尺寸异常图），这些图不进入计划。
 */
ipcMain.handle('imageCopy:makePlan', async (_event, options) => {
  const opts = options || {};
  try {
    const { index, scan } = imageCopyState;
    if (!index || !index.roots || index.roots.length === 0) {
      return { success: false, error: '尚未建立目标索引，请先执行「重建目标索引」' };
    }
    if (!scan) return { success: false, error: '尚未扫描源路径，请先执行「扫描源路径」' };

    const excluded = new Set((opts.excludePaths || []).map(p => String(p).toLowerCase()));
    imageCopyState.excludePaths = [...excluded];

    const rootPlans = [];
    const logs = [];
    let excludedCount = 0;

    for (const rootIndex of index.roots) {
      const entries = rootIndex.entries || {};
      const direct = [];
      const ambiguous = [];
      const unmatched = [];

      for (const group of scan.groups) {
        // 过滤掉用户选择不复制的图片；整组都被排除时跳过该分类
        const files = excluded.size > 0
          ? group.files.filter(f => !excluded.has(String(f.path).toLowerCase()))
          : group.files;
        if (files.length === 0) continue;

        const entry = entries[group.key];
        const dirs = entry ? (entry.dirs || []) : [];
        if (dirs.length === 1) {
          direct.push({ key: group.key, display: group.display, targetDir: dirs[0].dir, files });
        } else if (dirs.length > 1) {
          ambiguous.push({
            key: group.key,
            display: group.display,
            candidates: dirs.map(d => ({ dir: d.dir, sampleCount: (d.files || []).length })),
            files,
          });
        } else {
          unmatched.push({ key: group.key, display: group.display, files });
        }
      }

      rootPlans.push({ root: rootIndex.root, direct, ambiguous, unmatched });
      logs.push({
        action: 'makePlan',
        level: 'info',
        message: `目标路径匹配结果：${rootIndex.root} → 直接命中 ${direct.length} 个分类，需人工选择 ${ambiguous.length} 个，未命中 ${unmatched.length} 个`,
        detail: { root: rootIndex.root },
      });
    }

    if (excluded.size > 0) {
      excludedCount = scan.files.filter(f => excluded.has(String(f.path).toLowerCase())).length;
      logs.unshift({
        action: 'makePlan', level: 'warn',
        message: `按用户选择排除 ${excludedCount} 张图片，不复制到任何目标路径`,
      });
    }

    const plan = { roots: rootPlans, excludedCount, createdAt: new Date().toISOString() };
    imageCopyState.plan = plan;
    appendImageCopyLog(logs);

    const brief = g => ({
      key: g.key,
      display: g.display,
      fileCount: g.files.length,
      fileNames: g.files.map(f => f.name),
    });

    return {
      success: true,
      data: {
        excludedCount,
        roots: rootPlans.map(rp => ({
          root: rp.root,
          direct: rp.direct.map(g => ({ ...brief(g), targetDir: g.targetDir })),
          ambiguous: rp.ambiguous.map(g => ({ ...brief(g), candidates: g.candidates })),
          unmatched: rp.unmatched.map(brief),
        })),
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * 展开成最终的文件级复制任务。
 * 每个目标路径各自展开一遍，因此同一张源图会为每个目标路径生成一个独立任务。
 * unmatchedDirs: { root: dir }，为空表示该目标路径不需要未匹配文件夹。
 */
function buildCopyTasks(plan, choices, unmatchedDirs) {
  const tasks = [];
  for (const rp of plan.roots) {
    for (const group of rp.direct) {
      for (const f of group.files) {
        tasks.push({
          root: rp.root, key: group.key, display: group.display,
          name: f.name, src: f.path, destDir: group.targetDir, kind: 'matched',
        });
      }
    }
    for (const group of rp.ambiguous) {
      const chosen = choices && choices[choiceKey(rp.root, group.key)];
      if (!chosen) continue; // 用户未对该目标路径下的这个分类做选择，本轮跳过
      for (const f of group.files) {
        tasks.push({
          root: rp.root, key: group.key, display: group.display,
          name: f.name, src: f.path, destDir: chosen, kind: 'matched',
        });
      }
    }
    const unmatchedDir = unmatchedDirs && unmatchedDirs[rp.root];
    if (unmatchedDir) {
      for (const group of rp.unmatched) {
        for (const f of group.files) {
          tasks.push({
            root: rp.root, key: group.key, display: group.display,
            name: f.name, src: f.path, destDir: unmatchedDir, kind: 'unmatched',
          });
        }
      }
    }
  }
  return tasks;
}

/**
 * 计算每个目标路径对应的「未匹配」文件夹。
 * 文件夹统一建在首个源路径下；存在多个目标路径时再按目标路径分子目录，
 * 这样各目标路径的未匹配结果同样是分离的。
 */
function resolveUnmatchedDirs(plan, scan, folderName) {
  const result = {};
  if (!scan || !scan.sourcePaths || scan.sourcePaths.length === 0) return result;
  const base = path.join(scan.sourcePaths[0], folderName || '未匹配');
  const multiRoot = plan.roots.length > 1;
  const labels = multiRoot ? makeRootLabels(plan.roots.map(rp => rp.root)) : null;
  for (const rp of plan.roots) {
    if (rp.unmatched.length === 0) continue;
    result[rp.root] = multiRoot ? path.join(base, labels[rp.root]) : base;
  }
  return result;
}

// 预检冲突：返回目标目录下已存在的同名文件，供界面询问是否覆盖
ipcMain.handle('imageCopy:checkConflicts', async (_event, options) => {
  const opts = options || {};
  try {
    const { plan, scan } = imageCopyState;
    if (!plan) return { success: false, error: '尚未生成复制计划' };

    const unmatchedDirs = resolveUnmatchedDirs(plan, scan, opts.unmatchedFolderName);
    const tasks = buildCopyTasks(plan, opts.choices, unmatchedDirs);
    const conflicts = [];
    for (const t of tasks) {
      const destPath = path.join(t.destDir, t.name);
      if (t.kind === 'matched' && fs.existsSync(destPath)) {
        let existSize = 0;
        let existTime = '';
        try {
          const st = fs.statSync(destPath);
          existSize = st.size;
          existTime = st.mtime.toISOString();
        } catch (e) {}
        conflicts.push({
          root: t.root, key: t.key, display: t.display, name: t.name,
          src: t.src, destPath, existSize, existTime,
        });
      }
    }
    return { success: true, data: { total: tasks.length, conflicts, unmatchedDirs } };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * 执行复制。每个目标路径独立处理，同一张源图会分别复制到各目标路径下对应的目录。
 * options:
 *   choices          多目录键的用户选择 { "目标路径||分类键": 目录 }
 *   overwriteMode    'overwrite' 全部覆盖 | 'skip' 全部跳过 | 'decide' 按 decisions 逐项决定
 *   decisions        { destPath: true(覆盖) | false(跳过) }
 *   unmatchedFolderName 未匹配图片的落地文件夹名
 */
ipcMain.handle('imageCopy:execute', async (_event, options) => {
  const opts = options || {};
  const overwriteMode = opts.overwriteMode || 'decide';
  const decisions = opts.decisions || {};

  try {
    const { plan, scan } = imageCopyState;
    if (!plan) return { success: false, error: '尚未生成复制计划' };

    const logs = [];
    // 仅为确实存在未匹配图片的目标路径创建文件夹
    const planned = resolveUnmatchedDirs(plan, scan, opts.unmatchedFolderName);
    const unmatchedDirs = {};
    for (const [root, dir] of Object.entries(planned)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        unmatchedDirs[root] = dir;
        logs.push({ action: 'mkdir', level: 'warn', message: `创建未匹配文件夹（对应目标路径 ${root}）：${dir}` });
      } catch (e) {
        logs.push({ action: 'mkdir', level: 'error', message: `创建未匹配文件夹失败：${dir} - ${e.message}` });
      }
    }

    const tasks = buildCopyTasks(plan, opts.choices, unmatchedDirs);
    let copied = 0;
    let overwritten = 0;
    let skipped = 0;
    let failed = 0;
    // 按目标路径分别统计，便于界面区分每个目标路径各自的结果
    const perRoot = {};
    const bump = (root, field) => {
      if (!perRoot[root]) perRoot[root] = { root, copied: 0, overwritten: 0, skipped: 0, failed: 0 };
      perRoot[root][field]++;
    };

    for (const t of tasks) {
      const destPath = path.join(t.destDir, t.name);
      try {
        const exists = fs.existsSync(destPath);
        if (exists) {
          let allow;
          if (overwriteMode === 'overwrite') allow = true;
          else if (overwriteMode === 'skip') allow = false;
          else allow = decisions[destPath] === true;

          if (!allow) {
            skipped++;
            bump(t.root, 'skipped');
            logs.push({ action: 'skip', level: 'info', message: `跳过已存在文件：${t.name} → ${t.destDir}`, detail: { root: t.root, src: t.src, destPath } });
            continue;
          }
        }
        fs.mkdirSync(t.destDir, { recursive: true });
        fs.copyFileSync(t.src, destPath);
        if (exists) {
          overwritten++;
          bump(t.root, 'overwritten');
          logs.push({ action: 'overwrite', level: 'warn', message: `覆盖同名文件：${t.name} → ${t.destDir}`, detail: { root: t.root, src: t.src, destPath, key: t.display } });
        } else {
          copied++;
          bump(t.root, 'copied');
          logs.push({
            action: t.kind === 'unmatched' ? 'copyUnmatched' : 'copy',
            level: 'success',
            message: t.kind === 'unmatched'
              ? `未命中任何键（目标路径 ${t.root}），复制到未匹配文件夹：${t.name}`
              : `复制成功：${t.name} → ${t.destDir}（分类 ${t.display}）`,
            detail: { root: t.root, src: t.src, destPath, key: t.display },
          });
        }
      } catch (e) {
        failed++;
        bump(t.root, 'failed');
        logs.push({ action: 'copy', level: 'error', message: `复制失败：${t.name} - ${e.message}`, detail: { root: t.root, src: t.src, destPath } });
      }
    }

    for (const r of Object.values(perRoot)) {
      logs.push({
        action: 'execute',
        level: r.failed > 0 ? 'warn' : 'success',
        message: `目标路径完成：${r.root} → 新增 ${r.copied}，覆盖 ${r.overwritten}，跳过 ${r.skipped}，失败 ${r.failed}`,
        detail: { root: r.root },
      });
    }
    logs.push({
      action: 'execute',
      level: failed > 0 ? 'warn' : 'success',
      message: `全部完成（${plan.roots.length} 个目标路径）：新增 ${copied}，覆盖 ${overwritten}，跳过 ${skipped}，失败 ${failed}`,
    });
    appendImageCopyLog(logs);

    return {
      success: true,
      data: {
        total: tasks.length, copied, overwritten, skipped, failed,
        unmatchedDirs, perRoot: Object.values(perRoot), logs,
      },
    };
  } catch (err) {
    appendImageCopyLog({ action: 'execute', level: 'error', message: `执行复制失败：${err.message}` });
    return { success: false, error: err.message };
  }
});

// ---------- 操作日志 ----------

// 读取历史操作日志（倒序返回最近 limit 条）
ipcMain.handle('imageCopy:readLog', async (_event, limit) => {
  try {
    const logPath = getImageCopyLogPath();
    if (!fs.existsSync(logPath)) return { success: true, data: { logPath, entries: [] } };
    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
    const max = Number(limit) > 0 ? Number(limit) : 500;
    const entries = lines.slice(-max).map(line => {
      try { return JSON.parse(line); } catch (e) { return null; }
    }).filter(Boolean).reverse();
    return { success: true, data: { logPath, entries, total: lines.length } };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 由渲染进程写入日志（界面上的操作同样需要留痕）
ipcMain.handle('imageCopy:appendLog', async (_event, entry) => {
  appendImageCopyLog(entry);
  return { success: true };
});

// 清空操作日志
ipcMain.handle('imageCopy:clearLog', async () => {
  try {
    const logPath = getImageCopyLogPath();
    if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

