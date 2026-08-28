# 开发文档

多功能工具箱项目的技术文档，面向开发者参考。

---

## 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 前端框架 | React | ^18.2.0 |
| UI 组件库 | Ant Design | ^5.12.0 |
| 路由 | React Router DOM | ^6.20.0 |
| 日期处理 | Day.js | ^1.11.10 |
| 语言 | TypeScript | ^5.3.3 |
| 构建工具 | Vite | ^5.0.8 |
| 桌面框架 | Electron | ^28.0.0 |
| 打包工具 | electron-builder | ^26.8.1 |

---

## 项目结构

```
d:/Tool/tools/
├── electron/                       # Electron 主进程
│   ├── main.js                    # 主进程入口（窗口管理 + IPC Handler）
│   ├── preload.js                 # 预加载脚本（暴露 API 到渲染进程）
│   ├── region-preload.js          # 区域选择窗口预加载
│   ├── region-selector.html       # 框选区域 UI（透明覆盖窗口）
│   ├── click-indicator.html       # 点击波纹动画窗口
│   └── data/                      # 运行时数据目录（打包时作为 extraResources）
│       ├── 日报.txt
│       ├── 周报.txt
│       └── 月报.txt
├── src/                            # 前端源码（React + TypeScript）
│   ├── App.tsx                    # 根组件 + 路由定义
│   ├── main.tsx                   # 入口文件
│   ├── index.css                  # 全局样式
│   ├── components/
│   │   └── Sider.tsx              # 侧边栏导航组件
│   ├── pages/                     # 功能页面
│   │   ├── FileClassify.tsx       # 文件分类
│   │   ├── BatchMove.tsx          # 批量移动
│   │   ├── MediaRating.tsx        # 媒体评分
│   │   ├── DailyReport.tsx        # 日报周报月报
│   │   ├── ScreenCapture.tsx      # 截图录屏
│   │   ├── AutoClick.tsx          # 自动点击（含预设方案）
│   │   ├── ScheduledTasks.tsx     # 定时任务（含 SVN 批量更新）
│   │   ├── ConfigDoc.tsx          # 配置说明文档页
│   │   └── Changelog.tsx          # 更新日志页
│   └── types/
│       └── index.ts               # 全局类型声明（ElectronAPI 等）
├── scripts/
│   └── build.js                   # 多版本打包脚本
├── package.json                    # 项目配置
├── vite.config.ts                  # Vite 构建配置
├── tsconfig.json                   # TypeScript 配置
├── tsconfig.electron.json          # Electron 主进程 TS 配置
├── tsconfig.node.json              # Node 脚本 TS 配置
├── electron-builder-full.json      # 全能版打包配置
├── electron-builder-work.json      # 工作版打包配置
├── index.html                      # HTML 模板
└── README.md                       # 用户文档
```

---

## 环境搭建

### 前置条件

- Node.js >= 18
- npm
- Windows 10/11 x64（开发和运行环境）

### 安装依赖

```bash
cd d:/Tool/tools
npm install
```

### 启动开发环境

```bash
npm run electron:dev
```

该命令会同时启动 Vite 开发服务器（端口 5173）和 Electron 主进程，支持热更新。

---

## 可用脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | 仅启动 Vite 开发服务器（无 Electron） |
| `npm run build` | 仅构建前端到 `dist/` |
| `npm run electron:dev` | 启动完整开发环境（Vite + Electron） |
| `npm run electron:build` | 构建并打包（默认配置） |
| `npm run electron:build:full` | 打包全能版 |
| `npm run electron:build:work` | 打包工作版 |
| `npm run electron:build:all` | 同时打包两个版本 |
| `node scripts/build.js` | 打包脚本（支持参数 `full` / `work` / `all`，默认 `all`） |

---

## 版本管理（VITE_EDITION）

项目通过环境变量 `VITE_EDITION` 区分两个版本：

| 值 | 版本 | 包含功能 |
|----|------|----------|
| `full` | 全能版 | 所有功能 |
| `work` | 工作版 | 隐藏"文件分类"和"批量移动" |

### 工作原理

1. **构建时注入**：`vite.config.ts` 通过 `define` 将 `VITE_EDITION` 注入前端代码
2. **导航过滤**：`src/components/Sider.tsx` 根据版本过滤侧边栏菜单项
3. **路由守卫**：`src/App.tsx` 根据版本设置默认路由（全能版 → `/classify`，工作版 → `/report`）

---

## 架构设计

### 进程通信模型

```
┌─────────────────────────────────┐
│         渲染进程 (React)         │
│  通过 window.electronAPI 调用    │
└──────────────┬──────────────────┘
               │ IPC (contextBridge)
┌──────────────┴──────────────────┐
│       预加载脚本 (preload.js)    │
│  contextBridge.exposeInMainWorld │
└──────────────┬──────────────────┘
               │ ipcRenderer.invoke
┌──────────────┴──────────────────┐
│       主进程 (main.js)           │
│  ipcMain.handle 处理所有业务逻辑  │
└─────────────────────────────────┘
```

- **安全策略**：启用 `contextIsolation`，禁用 `nodeIntegration`
- **通信方式**：全部使用 `invoke/handle` 模式（Promise 化）
- **错误恢复**：渲染进程崩溃时自动重载

### 数据持久化

| 数据类型 | 存储位置 | 格式 |
|----------|----------|------|
| 全局配置 | `{userData}/config.json` | JSON |
| 日报数据 | `{resources}/data/日报.txt` | 自定义文本格式 |
| 周报数据 | `{resources}/data/周报.txt` | 自定义文本格式 |
| 月报数据 | `{resources}/data/月报.txt` | 自定义文本格式 |

> `{userData}` = `app.getPath('userData')`，通常为 `%APPDATA%/ToolBox/`
> `{resources}` = `process.resourcesPath`，开发环境为项目根目录

---

## IPC API 参考

### 对话框

| 通道 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `dialog:openDirectory` | 无 | `string \| null` | 打开文件夹选择对话框 |
| `dialog:openFile` | `{ filters }` | `string \| null` | 打开文件选择对话框 |

### 文件系统

| 通道 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `fs:readDir` | `{ path, recursive }` | `FileInfo[]` | 读取目录文件列表 |
| `fs:classifyFiles` | `{ source, dateType }` | `ClassifyResult` | 分析文件分类 |
| `fs:executeClassify` | `{ plan, target, mode }` | `Result` | 执行文件分类操作 |
| `fs:batchMove` | `{ files, target, mode }` | `Result` | 批量移动/复制文件 |
| `fs:saveFile` | `{ path, data }` | `Result` | 保存文件（base64） |
| `fs:saveScreenshot` | `{ dir, data }` | `{ path }` | 保存截图 PNG |

### 截图录屏

| 通道 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `capture:getSources` | 无 | `Source[]` | 获取屏幕源列表 |
| `capture:getScreenSourceId` | 无 | `string` | 获取屏幕源 ID |
| `capture:selectRegion` | 无 | `Region \| null` | 框选屏幕区域 |
| `capture:screenshotRegion` | `Region` | `string (base64)` | 截取指定区域 |

### 屏幕与剪贴板

| 通道 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `screen:getBounds` | 无 | `Bounds` | 获取所有显示器边界 |
| `shell:openPath` | `string` | 无 | 在资源管理器中打开路径 |
| `clipboard:copyImage` | `string (base64)` | 无 | 复制图片到剪贴板 |

### 自动点击

| 通道 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `autoclick:click` | `{ x, y }` | `Result` | 执行鼠标点击（调用 user32.dll） |
| `autoclick:showClickIndicator` | `{ x, y }` | 无 | 显示点击波纹动画 |
| `autoclick:selectPosition` | 无 | `{ x, y }` | 最小化后取鼠标坐标 |
| `autoclick:getMousePos` | 无 | `{ x, y }` | 即时获取鼠标位置 |
| `autoclick:preventSleep` | 无 | 无 | 防止屏幕休眠 |
| `autoclick:allowSleep` | 无 | 无 | 允许屏幕休眠 |

### 定时任务相关

| 通道 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `app:launch` | `{ path, silent }` | `Result` | 启动软件（detached） |
| `app:kill` | `{ processName, mode }` | `Result` | 关闭软件（taskkill） |
| `app:isRunning` | `{ processName }` | `boolean` | 检测进程是否运行 |
| `power:preventSleep` | 无 | 无 | 防止系统休眠（定时任务） |
| `power:allowSleep` | 无 | 无 | 允许系统休眠 |

### SVN 操作

| 通道 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `svn:update` | `{ path }` | `Result` | 执行 SVN Update（TortoiseSVN） |
| `svn:runBat` | `{ path }` | `Result` | 执行 BAT 脚本（detached） |

### 配置与报告

| 通道 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `config:read` | 无 | `ConfigData` | 读取全局配置 |
| `config:write` | `ConfigData` | `Result` | 写入全局配置 |
| `report:read` | `{ type }` | `string` | 读取报告文件内容 |
| `report:write` | `{ type, content }` | `Result` | 写入报告文件 |

---

## 打包流程

### 打包脚本逻辑（scripts/build.js）

```
1. 解析命令行参数（full / work / all）
2. 对每个版本:
   a. 设置环境变量 VITE_EDITION
   b. 执行 npx vite build（构建前端）
   c. 等待 5 秒（避免 Windows Defender 文件锁）
   d. 清理输出目录 release/{edition}/
   e. 调用 electron-builder --config=electron-builder-{edition}.json
   f. 失败自动重试（最多 3 次，间隔 10 秒）
3. 输出所有生成的 exe 文件路径
```

### 输出目录

打包产物输出到项目内 `release/` 目录（已在 `.gitignore` 中排除，不纳入版本管理）：

| 版本 | 输出位置 |
|------|----------|
| 全能版 | `release/full/多功能工具箱-全能版 {version}.exe` |
| 工作版 | `release/work/多功能工具箱-工作版 {version}.exe` |
| 普通版 | `release/normal/多功能工具箱-普通版 {version}.exe` |

分发方式：上传到 GitHub Releases 作为附件（文件名改为英文，避免中文 URL 编码问题），并在 `README.md` 中更新下载链接。

### 打包配置差异

| 配置 | 全能版 | 工作版 |
|------|--------|--------|
| appId | `com.tools.file-classifier` | `com.tools.file-classifier-work` |
| productName | 多功能工具箱 | 多功能工具箱-工作版 |
| 可执行文件名 | ToolBox | ToolBox-Work |
| 打包格式 | portable (exe) | portable (exe) |
| 目标架构 | x64 | x64 |
| signAndEditExecutable | false | false |

> ⚠️ `signAndEditExecutable: false` 是为了避免 Windows Defender 锁定 exe 导致 rcedit 失败。

### 常见打包问题

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| rcedit "Unable to commit changes" | Windows Defender 扫描新 exe | 已设置 `signAndEditExecutable: false` |
| EBUSY 文件被占用 | Defender 锁定 extraResources | 等待 15 秒再重试 |
| release 目录删不掉 | 进程或 Defender 锁定 | `Start-Sleep -Seconds 15` 后再删 |
| 打包卡住 | 残留 electron/node 进程 | 打包前 `taskkill /F /IM electron.exe` |

---

## 功能模块开发指南

### 添加新页面

1. 在 `src/pages/` 创建新的 `.tsx` 文件
2. 在 `src/App.tsx` 中添加路由：
   ```tsx
   <Route path="/new-page" element={<NewPage />} />
   ```
3. 在 `src/components/Sider.tsx` 中添加侧边栏菜单项：
   ```tsx
   { key: '/new-page', icon: <IconOutlined />, label: '新功能', edition: 'all' }
   ```
   - `edition` 可选值：`'all'`（两版均有）、`'full'`（仅全能版）

### 添加新 IPC 通道

1. 在 `electron/main.js` 中添加 handler：
   ```javascript
   ipcMain.handle('channel:name', async (event, args) => {
     // 业务逻辑
     return { success: true, data: result }
   })
   ```
2. 在 `electron/preload.js` 中暴露 API：
   ```javascript
   channelName: (args) => ipcRenderer.invoke('channel:name', args),
   ```
3. 在渲染进程中使用：
   ```typescript
   const api = (window as any).electronAPI
   const result = await api.channelName(args)
   ```

### 数据存储约定

- **配置数据**：使用 `config:read` / `config:write`，所有配置统一存储在 `config.json` 中
- **文件数据**：如需独立文件存储，使用 `report:read` / `report:write` 模式
- **配置键名**：各模块用自己的命名空间，如 `scheduleConfig`、`autoclickConfig`

---

## 关键设计决策

### 为什么使用 PowerShell 调用 user32.dll 实现点击？

Electron 的 `robot.js` 等原生模块在打包时容易出兼容问题。使用 PowerShell 调用 Windows API 的方式：
- 无需编译原生模块
- 不依赖 node-gyp
- 打包后体积不增加
- 兼容所有 Windows 10/11 系统

### 为什么使用 TortoiseSVN 而非命令行 SVN？

- TortoiseSVN 提供图形界面，用户可直观看到冲突文件
- 支持交互式解决冲突
- 大多数使用 SVN 的团队已安装 TortoiseSVN

### 为什么是 portable 格式而非安装包？

- 免安装，双击即用
- 不写注册表，不污染系统
- 方便携带和分发
- 适合工作环境（可能无管理员权限）

---

## 调试技巧

### 开发者工具

- 运行时按 `F12` 或 `Ctrl+Shift+I` 打开 DevTools
- 主进程日志输出在启动终端中
- 渲染进程日志在 DevTools Console 中

### 常见开发问题

**Q: 修改 main.js 后不生效？**
A: 主进程代码不支持热更新，需要重启 `npm run electron:dev`。

**Q: IPC 调用返回 undefined？**
A: 检查 preload.js 是否暴露了该 API，以及通道名是否一致。

**Q: 打包后路径错误？**
A: 确保使用 `process.resourcesPath` 获取资源路径，开发环境使用 `__dirname` 作为备选。

**Q: 多显示器截图坐标偏移？**
A: `screen:getBounds` 返回所有显示器的合并边界，坐标计算需考虑负数（副屏在主屏左侧时）。

---

## 版本号规则（重要）

本项目使用**自定义三段式版本号**：`major.minor.patch`

### 递增规则

- **每次发布只递增 `patch`（第三位）**，步进为 1
- `patch` 的取值范围是 `0` ~ `99`
- 当 `patch` 达到 `99` 后，下一版进位：`patch` 归 `0`，`minor`（第二位）+1
- 当 `minor` 达到 `99` 后，下一版进位：`minor` 归 `0`，`major`（第一位）+1

### 递增示例

```
1.1.0  ->  1.1.1  ->  1.1.2  ->  ...  ->  1.1.98  ->  1.1.99
1.1.99 ->  1.2.0  ->  1.2.1  ->  ...  ->  1.2.99
1.2.99 ->  1.3.0
...
1.99.99 -> 2.0.0
```

### 递增时机规则（重要）

版本号**不是每次打包都递增**，而是按"天"划分：

| 场景 | 行为 |
|------|------|
| **当天第一次改动后打包** | **自动**将 patch +1，无需询问 |
| **当天后续再次打包** | **必须先询问用户**是否递增版本号 |
| 用户回答「更新」 | patch +1 后再打包 |
| 用户回答「不更新」 | 保持当前版本号，直接打包（覆盖同名 exe） |

判定"当天第一次"的依据：`CHANGELOG.md` 顶部最新版本条目的日期。
- 若最新条目日期 **≠ 今天** → 视为当天第一次，自动 patch +1 并新建 CHANGELOG 条目
- 若最新条目日期 **= 今天** → 视为当天后续打包，需询问用户

### 注意事项

- **不使用语义化版本（SemVer）语义**：即使是新功能或破坏性变更，也只递增 `patch`，不因变更类型跳版本
- **不跳号**：禁止出现 `1.1.5` 直接跳到 `1.2.0` 的情况（除非 `patch` 已到 99）
- 版本号在 `package.json` 的 `version` 字段中维护，打包时会自动写入 exe 文件名
- 同一天内多次打包若选择不递增版本号，新产物会直接覆盖旧的同名 exe

---

## 版本发布流程

1. **确定版本号**：
   - 查看 `CHANGELOG.md` 顶部条目日期
   - 日期 ≠ 今天 → 直接 patch +1
   - 日期 = 今天 → 询问用户是否递增；不递增则跳过第 2 步的新建条目（追加到今天的条目中即可）
2. 更新 `package.json` 中的 `version` 字段，并在 `CHANGELOG.md` 顶部追加/补充本次变更记录
3. 运行 `node scripts/build.js all` 打包全部版本
4. 输出的 exe 在项目内 `release/` 下（full / normal / work 三个子目录）
5. 创建 GitHub Release（tag 为 `v{version}`），上传三个 exe 作为附件（改英文名）
6. 更新 `README.md` 顶部的下载链接指向新版本

---

## 贡献规范

### 代码风格

- 使用 TypeScript 严格模式
- React 组件使用函数式组件 + Hooks
- 文件命名：PascalCase（组件/页面）、camelCase（工具函数）
- 缩进：2 空格
- 字符串：单引号

### 提交信息格式

```
feat: 新增XX功能
fix: 修复XX问题
refactor: 重构XX模块
docs: 更新文档
chore: 构建/配置变更
```
