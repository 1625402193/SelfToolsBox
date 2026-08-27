# 项目备忘

## 基本信息
- 项目名：多功能工具箱（Electron + React + Ant Design）
- 启动命令：`npm run electron:dev`
- 打包命令：`npm run electron:build`
- 打包输出：`publish/` 目录（portable 模式，单个 exe）
- 调试：已配置 `.vscode/launch.json`，按 F5 一键启动

## 功能模块
- 文件分类：按日期 + 文件扩展名自动分类（复制/移动）
- 批量移动：批量复制或移动文件，支持扁平化/保持结构
- 媒体评分：图片/视频预览 + 1-5星评分 + 按评分复制/移动到目标文件夹
- 截图录屏：全屏截图、区域截图（支持多显示器）、录屏
- 自动点击：定时自动鼠标点击，支持持续时间/时间段模式
- 日报周报：报告编写与管理
- 定时任务：软件开关任务、SVN 更新任务、触发时间设置
- 更新日志：项目根 `CHANGELOG.md` 通过 `?raw` 内联到前端，所有版本可见

## 已完成的改动记录
- 选区功能改为覆盖所有显示器（计算所有 display 总边界创建窗口）
- 截图区域支持多显示器（根据区域中心点定位对应屏幕源）
- 文件分类改为直接按扩展名分类（去掉预设的 typeMap 映射）
- 点击动画改为三层波纹扩散 + 发光效果（更醒目）
- 添加全局异常捕获（uncaughtException / unhandledRejection）
- 渲染进程崩溃自动恢复（render-process-gone 监听）
- 页面无响应自动重载（unresponsive 监听）
- 页面切换改为 display 显隐模式（避免自动点击等组件状态丢失）

## 注意事项
- 主窗口默认 `alwaysOnTop: true`
- 录屏格式为 WebM
- 自动点击使用 PowerShell 调用 Windows user32.dll API
- `.codebuddy/` 文件夹为项目数据目录，不要删除

## 开发规则
- **每次修改代码后不要直接启动项目**，询问用户是否需要运行
- 如果有正在运行的进程，先关掉再重新运行
- 运行命令：`npm run electron:dev`
- **只有功能变动时才询问是否需要打包**，没有功能变动不主动提及

## 打包规则
- 打包生成的 exe 文件名需要带版本号（如 `多功能工具箱-全能版 1.2.1.exe`）
- **每次打包时版本号最后一位（patch）自动递增**（如 1.2.0 → 1.2.1 → 1.2.2）
- 更新 `package.json` 中的 `version` 字段后再执行打包
- 有三个打包版本：
  - **全能版 full**：所有功能
  - **工作专用版 work**：屏蔽"文件分类"、"批量移动"、"配置说明"、"媒体评分"
  - **普通版 normal**：屏蔽"日报周报"、"定时任务"
- 每次打包需询问用户选择"全能版"、"工作专用版"、"普通版"还是"都打包"
- 命令：`electron:build:full` / `electron:build:work` / `electron:build:normal` / `electron:build:all`
- 版本通过 `VITE_EDITION` 环境变量控制
  - 菜单：`src/components/Sider.tsx` 用 `editions` 数组控制
  - 路由：`src/App.tsx` 用 `routePermissions` 控制
- productName 用英文（ToolBox），中文名放在 portable.artifactName 中

## 打包常见问题
- **rcedit 错误**：设置 `signAndEditExecutable: false` 跳过
- **EBUSY 文件占用**：打包前删除目标目录中的 resources/data，或等15秒让 Defender 释放
- **release 目录删不掉**：`Start-Sleep -Seconds 15` 后再删除
- **残留进程**：打包前先 `taskkill /F /IM electron.exe` 和 `taskkill /F /IM node.exe`
- **打包脚本已内置重试逻辑**（最多3次，每次间隔10秒）

## 已修复 Bug

### 区域录制视频时长不对 + 停止后 UI 不响应（v1.2.7 已修复）
- **现象**：UI 显示录了 54 秒但视频只有 16-24 秒；点停止后遮罩框消失了但 UI 仍显示录制中（时间从 20 秒跳到 51 秒才停）
- **根因**：录制遮罩窗口（alwaysOnTop screen-saver 级别）覆盖主窗口 → Chromium 将渲染进程标记为 background → intensive throttling 对 setInterval/RAF 降频（最慢 1 分钟一次）→ canvas 绘制帧率远低于预期 → captureStream 按实际时间戳写帧 → 视频时长短。停止时遮罩关闭 → 窗口回前台 → 积压的 setInterval 回调"追赶"触发 → 时间突然跳变
- **修复**：
  1. 主窗口 webPreferences 增加 `backgroundThrottling: false`，禁止 Chromium 后台节流
  2. canvas 绘制用 `setInterval(drawFrame, 1000/fps)` 替代 RAF（配合 backgroundThrottling=false）
  3. `stopRecording()` 重排：先立即清计时器+更新 UI+关遮罩，再异步停 MediaRecorder

### 副屏录制时数据为空（v1.2.6 已修复，接 v1.2.5）
- **现象**：在副屏（X 为负数，例如 -1942）选择区域开始录制，6 秒后提示"录制失败：数据为空"，文件未生成
- **根因 1**：`capture:getScreenSourceId` 写死取 `sources[0]`，副屏场景拿到的视频流是**主屏内容**
- **根因 2**：渲染端 `drawImage(video, region.x * scaleX, ...)` 用绝对坐标，副屏 region.x = -1942 → 源矩形完全落在视频外 → canvas 无内容 → `canvas.captureStream()` 不发帧 → MediaRecorder 输出空数据
- **修复**：
  1. main.js `capture:getScreenSourceId` 接受 region 参数。主进程根据区域中心点找到所属 `screen.getAllDisplays()` 中的显示器，用 `source.display_id` 字段（或 displays/sources 顺序对齐做兜底）匹配到正确 capture 源，返回 `sourceId + display.bounds + scaleFactor`
  2. 渲染端用返回的 `display.bounds`：相对坐标 = `region.x - display.bounds.x`；scale = `videoWidth / display.bounds.width`
  3. drawImage 源矩形 clamp 到 [0, videoWidth-1] / [0, videoHeight-1]，避免越界
  4. canvas 先 `fillRect` 一次黑色底色，video.videoWidth=0 时 RAF 等到下一帧再算（避免首帧空白导致 captureStream 不发帧）

### 录屏保存 0 字节（v1.2.5 已修复）
- **现象**：录屏停止后磁盘上只有 0 字节的 .webm 文件
- **根因**：原代码 `arrayBufferToBase64` 用 `binary += String.fromCharCode(bytes[i])` 逐字节拼接，几十 MB 视频时 O(n²) 字符串拼接超慢/卡死；再走 IPC 传 base64 大字符串容易被截断/丢包，结果落盘是空
- **修复**：
  1. 主进程新增 `fs:saveBuffer` IPC，参数是 `Uint8Array`，由 Electron 结构化克隆传输，避开 base64 编码与字符串 IPC
  2. 渲染端 `blob.arrayBuffer()` → `new Uint8Array()` → `api.saveBuffer(path, u8)`
  3. blob.size === 0 时直接报错，不再写文件
  4. 保存成功提示带 MB

### 录屏区域可视化遮罩（v1.2.5 新增）
- 区域录制时在所有屏幕上方贴一个透明遮罩窗：区域外 50% 黑色蒙版，区域边缘红色脉动边框 + "● 录制中 W×H" 标签
- 窗口属性：`transparent / frame:false / alwaysOnTop("screen-saver") / skipTaskbar / focusable:false`
- `setIgnoreMouseEvents(true, { forward:false })` 鼠标穿透
- 红框紧贴区域**外侧 2px** 绘制，canvas 裁剪只取区域内像素，遮罩不进入录像
- 仅在 region 存在时显示，全屏录制不显示
- 异常退出兜底 `hideRecordingOverlay`

### 更新任务组并行执行时进度条不更新（已修复）
- **现象**：两个任务并行执行 SVN Update，实际都已完成，但进度条卡住不动
- **原因**：`svn:update` 通过 `tasklist` 按进程名全局检测 `TortoiseProc.exe` 是否退出。并行时多个 TortoiseProc 同时存在，一个完成后另一个还在，导致所有检测都卡住
- **修复方案**：通过 `wmic` 按命令行参数（包含 dirPath）精确匹配找到特定任务的 TortoiseProc PID，然后按 PID 轮询检测。回退方案：检测 `.svn/wc.db-lock` 和 `.svn/lock` 文件是否存在

### SVN 更新还没开始后置 BAT 就执行（v1.2.4 已修复）
- **现象**：SVN Update 大约 6 秒后假装"完成"返回 success，前端紧接着执行后置 BAT，但此时 TortoiseProc 窗口可能还没显示出来
- **根因**：`svn:update` 中的回退检测分支光看 `.svn/wc.db-lock` 锁文件——锁文件在"还没开始"和"已完成"两个时刻都不存在，被代码当成同一事件处理
- **触发**：① wmic 在新版 Win11 上被禁用；② TortoiseProc 启动慢；③ TortoiseSVN 未装 / 不在 PATH（spawn 'error' 未监听）
- **修复方案**：
  1. spawn 前 `tasklist` 拍 PID 快照，spawn 后扫描排除已存在 PID，精确定位本次新启动的 TortoiseProc
  2. 删除不可靠的"锁文件回退分支"
  3. 监听 `child.on('error')` 捕获启动失败
  4. 60s 找不到对应 PID 返回明确错误，不再假阳性 resolve
  5. 前端 SVN 硬失败时跳过后置 BAT
  6. cleanup 分支同步加固

## 更新日志
- **位置**：项目根 `CHANGELOG.md`
- **展示**：`src/pages/Changelog.tsx`，通过 `import changelogRaw from '../../CHANGELOG.md?raw'` 在打包时内联到 JS bundle
- **菜单**：`/changelog`，三个版本（full/work/normal）都可见
- **类型支持**：`src/vite-env.d.ts` 声明 `*.md?raw` 模块
- **版本号注入**：`vite.config.ts` 的 `define` 注入 `import.meta.env.VITE_APP_VERSION = pkg.version`
- **格式约定**：`## vX.Y.Z — YYYY-MM-DD` 作为版本头，`### 修复/优化/新增/变更/打包` 作为分组，每次发版前在最上方追加新版本块

## AI 记忆备份
以下是通过 AI 记忆系统保存的所有规则，与上文内容对应：
- [ID: 43521061] 打包 exe 文件名带版本号，每次打包 patch 自动递增
- [ID: 56027899] 打包常见问题及解决方案
- [ID: 72060795] 三个打包版本（全能版/工作专用版/普通版），打包时询问用户选择
- [ID: 80284690] 只有功能变动时才询问是否打包
- [ID: 89242923] 修改代码后不直接启动，询问用户是否需要运行
- [ID: 56925924] 更新日志维护规则（CHANGELOG.md + Changelog.tsx）
