# 更新日志

> 本文件记录工具箱每次更新修复/优化的内容。新版本写在最上方。
>
> **版本号规则**：`major.minor.patch`，每次递增只 `patch`（第三位）+1；`patch` 到 `99` 后进位（`patch` 归 0，`minor` +1）；`minor` 到 `99` 后同理进位到 `major`。不使用 SemVer 语义，不跳号。
>
> **递增时机**：每天第一次改动后打包时自动 patch +1；当天后续打包需先确认是否递增，选择不递增则保持当前版本号打包。详见 `DEVELOPMENT.md`。

---

## v1.1.1 — 2026-08-28

### 修复
- **修复首次打开软件后应用预设，起止时间不是预设中保存的值**：需要再切换一次预设才正确。
  - **根因**：存在一个「切换到时间段模式时自动填入当前时间」的 `useEffect`（依赖 `isDurationMode`）。软件启动时 `isDurationMode` 默认为 `true`，应用一个时间段模式的预设时该值变为 `false`，effect 被触发，把刚写入的预设时间覆盖成了当前时间 ± 30 分钟。第二次应用同一预设时 `isDurationMode` 已经是 `false`，effect 不再触发，所以时间才正确。
  - **修复**：新增 `applyingPresetRef` 标记，应用预设导致模式变化时置位，effect 检测到该标记则跳过本次自动填充并复位。用户手动切换运行模式时行为不变，仍会自动填入当前时间。

---

## v1.1.0 — 2026-08-27

### 变更
- **重新制定版本号规则并重置版本号**：历史版本号递增混乱（1.2.9 → 1.3.0 → 1.4.0），现统一为「每次只递增第三位，满 99 进位」的规则，当前版本重置为 `1.1.0`。规则已记录到 `DEVELOPMENT.md` 与本文件顶部。

### 新增
- **自动点击支持预设方案**：可保存多个具名预设，一键应用，免去每次打开软件重复设置。
  - 支持任意多个预设、自定义名称（30 字内）、同名覆盖更新、下拉选择即应用、带确认的删除。
  - 保存内容：运行模式（持续时间/时间段）、时长、起止时间、随机间隔开关与范围、点击动画开关、点击区域坐标、区域预览缩略图。
  - 持久化到 `app-config.json` 的 `autoclickPresets` 字段。
- **自动点击预设支持导入 / 导出（分享）**：导出为 JSON 文件可发给他人，对方「导入」即可使用。
  - 导出支持「全部预设」或「仅当前选中」两种方式。
  - 导入兼容标准导出包、纯预设数组、单个预设对象三种格式；逐字段校验并回落默认值，非法数据不会污染现有预设。
  - 同名冲突时弹窗选择「覆盖同名」或「保留两者」（导入项自动重命名为 `原名 (2)`），完成后汇总提示新增/覆盖数量。
- **窗口置顶开关**：侧边栏底部新增「窗口置顶」开关，菜单栏「窗口 → 窗口置顶」也可勾选切换，两处状态实时同步。
  - 设置持久化到 `app-config.json` 的 `windowAlwaysOnTop` 字段，重启后保持上次选择（默认开启）。
  - 关闭后窗口不再置顶；开启时仍保留「失焦临时让位」行为，避免遮挡第三方截图工具选区。
- **文档页移入顶部菜单栏**：「配置说明」「更新日志」从侧边栏移至原生菜单栏顶级菜单项，侧边栏更聚焦于功能页。同时把默认英文菜单（File/Edit/View/Window/Help）替换为中文菜单，并按版本控制文档项可见性。

### 修复
- **更新任务的工程路径改为单路径**：每个更新任务只保留一个工程目录，选择新目录时弹窗确认替换，UI 调整为「工程目录 / 选择目录 / 更换 / 清除」，标题标签改为「已配置 / 未配置」。（`SvnBatchUpdate.tsx`、`ScheduledTasks.tsx`）
- **修复第三方截图工具选区框被主窗口遮挡**：主窗口置顶层级由 `screen-saver`（Windows 最高层）降为 `floating`，并移除失焦后每秒强制置顶的定时器，改为失焦时主动取消置顶、重获焦点时恢复。
- **修复任务编号重复**：删除中间任务后再添加会出现两个同名任务（如两个「更新任务 4」）。新任务编号改用「现有最大编号 +1」，删除时对默认命名的任务自动重排编号，用户自定义名称不受影响。
- **修复应用预设后区域预览消失**：保存预设时一并存入降采样后的预览缩略图（最宽 480px、JPEG 0.7），应用预设时自动恢复；旧预设无缩略图则实时截取该区域补上。另新增「刷新预览」按钮，无预览图时以等比占位框保证点击位置标记仍能正常显示。

---

## v1.2.8 — 2026-06-06

### 修复
- 定时任务**执行日志时间加上日期**（`MM-DD HH:mm:ss` 格式），方便跨天查看。
- 修复定时任务 SVN Update **有冲突时窗口被自动关闭**的问题：`/closeonend` 从 `1` 改为 `2`，有冲突/错误时保留 TortoiseSVN 窗口让用户查看详情。

---

## v1.2.7 — 2026-06-02

### 修复
- 修复**区域录制时视频时长远短于实际录制时长**的 Bug。
  - **现象**：UI 显示录制 54 秒，但生成的 webm 视频实际时长只有约 16-24 秒；点击停止后 UI 不立即响应，时间继续跳动（从 20 秒跳到 51 秒后才真正停止）。
  - **根因**：录制遮罩窗口（recording overlay）覆盖工具箱主窗口 → Chromium 将渲染进程标记为 "background" → 对 `setInterval`/`requestAnimationFrame` 实施 **intensive throttling**（最低 1 分钟间隔或大幅降频）。canvas 绘制频率远低于预期 → captureStream 按实际时间戳写帧 → 视频时长 ≠ 录制时长。点停止时遮罩关闭 → 窗口回到前台 → 被积压的 setInterval 回调"追赶"触发 → 时间突然跳变。
  - **修复**：
    1. 主窗口 `BrowserWindow` 的 webPreferences 增加 **`backgroundThrottling: false`**，从根本上禁止 Chromium 对渲染进程的后台节流。
    2. canvas 绘制驱动从 `requestAnimationFrame` 改为 `setInterval(drawFrame, 1000/fps)`，配合 backgroundThrottling=false 确保稳定帧率。
    3. `stopRecording()` 重排执行顺序：**先**立即清计时器 + 更新 UI 状态 + 关遮罩，**再**异步停 MediaRecorder，避免节流追赶导致 UI 延迟响应。

---

## v1.2.6 — 2026-06-02

### 修复
- 修复**副屏录制时数据为空**的 Bug（接 v1.2.5 的修复，副屏场景仍报"录制失败：数据为空"）。
  - **现象**：在左侧/上侧副屏选择区域（X/Y 为负数，例如 `(-1942, 55) 1916x1231`），点击开始录制 6 秒后停止，提示"录制数据为空，未生成文件"。
  - **根因 1**：`capture:getScreenSourceId` 写死返回 `sources[0]`，永远是主屏的 capture 源。副屏的内容根本不在视频流里。
  - **根因 2**：渲染端 `drawImage(video, region.x * scaleX, region.y * scaleY, ...)` 直接用绝对坐标。副屏 region.x = -1942，源矩形完全落在视频外 → canvas 没有任何绘制 → `canvas.captureStream()` 因内容无变化不发帧 → MediaRecorder 编码出空数据。
- **修复**：
  1. `capture:getScreenSourceId` 接受可选 `region` 参数。主进程根据 region 中心点定位到所属显示器（`screen.getAllDisplays()`），用 `desktopCapturer.getSources` 的 `display_id` 字段把 source 与 Electron display 对齐，返回**正确显示器**的 sourceId 以及 `display.bounds / scaleFactor`。
  2. 渲染端用返回的 `display.bounds` 做坐标变换：相对坐标 = `region.x - display.bounds.x`，`region.y - display.bounds.y`；scale 用该屏宽高，不再用主屏宽高。
  3. drawImage 源矩形 clamp 到源视频尺寸内，避免越界。
  4. canvas 创建后先填一次黑色底色，确保 captureStream 立即有内容可发帧；videoWidth/videoHeight 为 0 时延迟到下一帧再算 scale。

### 变更
- `electron/main.js` `capture:getScreenSourceId` 改为带 region 参数，返回 sourceId + display 信息。
- `electron/preload.js`、`src/types/index.ts` 同步更新 `getScreenSourceId` 签名。
- `src/pages/ScreenCapture.tsx` 重写区域录制时的源选择与 drawImage 坐标计算逻辑。

---

## v1.2.5 — 2026-06-02

### 修复
- 修复"录屏保存出来 0 字节"的严重 Bug。
  - 根因：原实现把视频 Blob 转成 base64 字符串再走 IPC 写盘，几十 MB 视频时 `String.fromCharCode` 逐字节字符串拼接是 O(n²)，加上 IPC 大字符串容易丢/截断，最终落盘是空文件。
  - 修复：新增 `fs:saveBuffer` IPC，渲染进程直接把 `Uint8Array` 通过 IPC 结构化克隆传给主进程，主进程一次 `fs.writeFileSync` 写入。
- 录制结束后做空数据校验（blob.size === 0 时直接报错并提示"请检查屏幕源/帧率设置"），不再生成空文件。
- 保存成功后日志带文件大小（MB），方便确认。

### 新增
- 录制时显示**高亮遮罩**：选定区域外的屏幕区域统一变暗（50% 黑色蒙版），区域边缘有红色脉动边框 + 闪烁的"● 录制中 W×H" 标签。
  - 遮罩窗口鼠标穿透（`setIgnoreMouseEvents(true)`），不影响用户继续操作其他程序。
  - 遮罩的红框/标签紧贴区域**外侧**绘制，且 canvas 裁剪只取区域内像素，因此遮罩**不会进入录像**。
  - 仅在"区域录制"模式下显示；全屏录制时不显示（避免影响整屏录像）。
- 异常退出（启动失败 / 用户停止）时兜底关闭遮罩窗口，避免残留。

### 变更
- `electron/preload.js` 新增 `saveBuffer / showRecordingOverlay / hideRecordingOverlay`。
- `electron/main.js` 新增 `fs:saveBuffer / recording:showOverlay / recording:hideOverlay` IPC 与 `recordingOverlayWindow` 单例管理。
- 新增 `electron/recording-overlay.html` 静态遮罩页面（透明、frame-less、always-on-top、focusable=false、click-through）。
- `src/pages/ScreenCapture.tsx` 移除 `arrayBufferToBase64` 工具函数。
- `src/types/index.ts` 同步声明新 API 类型。

---

## v1.2.4 — 2026-06-02

### 修复
- 修复 SVN 批量更新中"SVN 还没开始执行，后置 BAT 就已经跑了"的严重时序问题。
  - 根因：`svn:update` 通过检测 `.svn/wc.db-lock` 锁文件判断完成，但锁文件在"还没开始"和"已完成"两个时刻都不存在，被代码当成同一事件处理，导致约 6 秒后假装成功 resolve。
  - 触发场景：① wmic 在新版 Win11 上被禁用 / 输出格式异常；② TortoiseProc.exe 启动慢（杀软扫描、UAC、磁盘忙）；③ TortoiseSVN 未安装或不在 PATH。
- 修复 `TortoiseProc.exe` 启动失败时 `spawn 'error'` 事件未监听，导致悄无声息走到回退分支假阳性 resolve。

### 优化
- SVN Update 检测策略改为「快照 + 差集」：spawn 前先 `tasklist` 拍快照，spawn 后扫描排除已存在 PID，精确定位本次新启动的 TortoiseProc 进程。
- 彻底删除不可靠的"锁文件回退分支"。
- 60 秒内找不到 TortoiseProc 进程时返回明确错误，不再假装成功。
- SVN 硬性失败（路径无效 / TortoiseProc 未启动）时跳过后置 BAT，避免误执行。
- cleanup 分支同步加固，逻辑与 update 保持一致。

---

## v1.2.3 及之前

### 修复
- 修复更新任务组并行执行时进度条不更新的问题。
  - 原因：`svn:update` 通过 `tasklist` 按进程名全局检测 `TortoiseProc.exe` 是否退出。并行时多个 TortoiseProc 同时存在，一个完成后另一个还在，所有检测都卡住。
  - 修复：通过 `wmic` 按命令行参数（包含 `dirPath`）精确匹配特定任务的 TortoiseProc PID，按 PID 轮询检测。

### 优化
- 选区截图改为覆盖所有显示器（计算所有 display 总边界创建窗口）。
- 截图区域根据区域中心点定位对应屏幕源，支持多显示器。
- 文件分类去掉预设 `typeMap`，改为直接按扩展名分类。
- 自动点击的点击动画改为三层波纹扩散 + 发光效果，更醒目。
- 添加全局异常捕获（`uncaughtException` / `unhandledRejection`）。
- 渲染进程崩溃自动恢复（`render-process-gone` 监听）。
- 页面无响应自动重载（`unresponsive` 监听）。
- 页面切换改为 `display` 显隐模式，避免自动点击等组件状态丢失。

### 打包
- 三版本打包：全能版 / 工作专用版 / 普通版，对应命令 `electron:build:full` / `electron:build:work` / `electron:build:normal` / `electron:build:all`。
- 打包脚本内置重试逻辑（最多 3 次，每次间隔 10 秒），可应对临时文件锁问题。
- 跳过 `rcedit`（`signAndEditExecutable: false`），规避 Windows Defender 扫描导致的"Unable to commit changes"。
- `productName` 用英文 `ToolBox`，中文名通过 `portable.artifactName` 注入，避免 rcedit 处理中文名出错。

---

> 更早期版本未单独记录。
