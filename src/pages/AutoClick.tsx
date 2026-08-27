import { useState, useRef, useCallback, useEffect } from 'react'
import { Card, Button, InputNumber, Switch, Space, message, Tag, Row, Col, Statistic, Select, Modal, Input, Popconfirm, Dropdown } from 'antd'
import { PlayCircleOutlined, PauseCircleOutlined, AimOutlined, DeleteOutlined, ReloadOutlined, SaveOutlined, CameraOutlined, ExportOutlined, ImportOutlined } from '@ant-design/icons'

const api = window.electronAPI

// 点击位置记录
interface ClickPoint {
  x: number
  y: number
  index: number
}

// 自动点击预设方案
interface AutoClickPreset {
  name: string
  isDurationMode: boolean
  durationMinutes: number
  startHour: number
  startMinute: number
  endHour: number
  endMinute: number
  isRandomInterval: boolean
  intervalMin: number
  intervalMax: number
  showAnimation: boolean
  regionX: number
  regionY: number
  regionW: number
  regionH: number
  regionText: string
  // 区域预览缩略图（降采样后的 JPEG dataURL，用于应用预设后仍能显示点击预览）
  regionPreview?: string
}

// 预设存储在 app-config.json 中的 key
const PRESETS_CONFIG_KEY = 'autoclickPresets'

// 将预览图降采样为小尺寸 JPEG，避免 base64 撑爆配置文件
const shrinkPreview = (dataUrl: string, maxWidth = 480): Promise<string> =>
  new Promise(resolve => {
    try {
      const img = new Image()
      img.onload = () => {
        try {
          const scale = img.width > maxWidth ? maxWidth / img.width : 1
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.round(img.width * scale))
          canvas.height = Math.max(1, Math.round(img.height * scale))
          const ctx = canvas.getContext('2d')
          if (!ctx) return resolve('')
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
          resolve(canvas.toDataURL('image/jpeg', 0.7))
        } catch {
          resolve('')
        }
      }
      img.onerror = () => resolve('')
      img.src = dataUrl
    } catch {
      resolve('')
    }
  })

export default function AutoClick() {
  const [isDurationMode, setIsDurationMode] = useState(true)
  const [durationMinutes, setDurationMinutes] = useState(30)

  // 时间段模式：初始化为当前时间和当前+30分钟
  const now = new Date()
  const [startHour, setStartHour] = useState(now.getHours())
  const [startMinute, setStartMinute] = useState(now.getMinutes())
  const [endHour, setEndHour] = useState(new Date(now.getTime() + 30 * 60 * 1000).getHours())
  const [endMinute, setEndMinute] = useState(new Date(now.getTime() + 30 * 60 * 1000).getMinutes())

  const [isRandomInterval, setIsRandomInterval] = useState(false)
  const [intervalMin, setIntervalMin] = useState(3)
  const [intervalMax, setIntervalMax] = useState(8)
  const [showAnimation, setShowAnimation] = useState(true)
  const [regionX, setRegionX] = useState(0)
  const [regionY, setRegionY] = useState(0)
  const [regionW, setRegionW] = useState(0)
  const [regionH, setRegionH] = useState(0)
  const [regionText, setRegionText] = useState('未选择区域')
  const [regionPreview, setRegionPreview] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [clickCount, setClickCount] = useState(0)
  const [logs, setLogs] = useState<string[]>([])
  const [statusText, setStatusText] = useState('就绪')
  const [selectingPos, setSelectingPos] = useState(false)
  // 点击位置历史记录（用于在预览图上显示）
  const [clickPoints, setClickPoints] = useState<ClickPoint[]>([])
  // 预设方案相关
  const [presets, setPresets] = useState<AutoClickPreset[]>([])
  const [selectedPresetName, setSelectedPresetName] = useState<string | undefined>(undefined)
  const [saveModalOpen, setSaveModalOpen] = useState(false)
  const [presetNameInput, setPresetNameInput] = useState('')

  const timerRef = useRef<number>(0)
  const stopTimeRef = useRef<number>(0)
  const logsEndRef = useRef<HTMLDivElement>(null)
  const runningRef = useRef(false)

  // 切换到时间段模式时，自动更新为当前时间
  useEffect(() => {
    if (!isDurationMode) {
      const n = new Date()
      const end = new Date(n.getTime() + 30 * 60 * 1000)
      setStartHour(n.getHours())
      setStartMinute(n.getMinutes())
      setEndHour(end.getHours())
      setEndMinute(end.getMinutes())
    }
  }, [isDurationMode])

  const addLog = (text: string) => {
    const time = new Date().toLocaleTimeString('zh-CN')
    setLogs(prev => {
      const newLogs = [...prev, `[${time}] ${text}`]
      return newLogs.length > 100 ? newLogs.slice(-100) : newLogs
    })
    setTimeout(() => logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
  }

  // 更新区域文本显示
  const updateRegionText = (x: number, y: number, w: number, h: number) => {
    setRegionText(`区域 (${x},${y}) ${w}x${h}`)
  }

  const selectRegion = async () => {
    setSelectingPos(true)
    const region = await api.selectRegion()
    setSelectingPos(false)
    if (region) {
      setRegionX(region.x)
      setRegionY(region.y)
      setRegionW(region.width)
      setRegionH(region.height)
      updateRegionText(region.x, region.y, region.width, region.height)
      addLog(`已选择区域: (${region.x}, ${region.y}) ${region.width}x${region.height}，将随机点击区域内位置`)
      message.success(`已选择区域，将随机点击区域内位置`)
      // 重新选择区域时清除之前的点击位置记录
      setClickPoints([])

      if (region.previewDataUrl) {
        setRegionPreview(region.previewDataUrl)
      } else {
        setRegionPreview(null)
      }
    } else {
      message.info('已取消选择')
    }
  }

  // 手动调整区域坐标
  const handleRegionXChange = (v: number | null) => {
    const val = v || 0
    setRegionX(val)
    updateRegionText(val, regionY, regionW, regionH)
  }
  const handleRegionYChange = (v: number | null) => {
    const val = v || 0
    setRegionY(val)
    updateRegionText(regionX, val, regionW, regionH)
  }
  const handleRegionWChange = (v: number | null) => {
    const val = v || 0
    setRegionW(val)
    updateRegionText(regionX, regionY, val, regionH)
  }
  const handleRegionHChange = (v: number | null) => {
    const val = v || 0
    setRegionH(val)
    updateRegionText(regionX, regionY, regionW, val)
  }

  // 在区域内生成随机点击位置
  const getRandomClickPos = () => {
    if (regionW > 0 && regionH > 0) {
      const rx = regionX + Math.floor(Math.random() * regionW)
      const ry = regionY + Math.floor(Math.random() * regionH)
      return { x: rx, y: ry }
    }
    return { x: regionX, y: regionY }
  }

  // 获取下一次点击的延迟（毫秒）
  const getNextDelay = () => {
    if (isRandomInterval) {
      const min = Math.min(intervalMin, intervalMax)
      const max = Math.max(intervalMin, intervalMax)
      return (min + Math.random() * (max - min)) * 1000
    }
    return intervalMin * 1000
  }

  // 调度下一次点击（用 setTimeout 实现随机间隔）
  const scheduleNext = (doClick: () => Promise<void>) => {
    if (!runningRef.current) return
    const delay = getNextDelay()
    timerRef.current = window.setTimeout(async () => {
      if (!runningRef.current) return
      if (Date.now() >= stopTimeRef.current) {
        stopAutoClick()
        return
      }
      await doClick()
      scheduleNext(doClick)
    }, delay)
  }

  const startAutoClick = useCallback(async () => {
    if (regionX === 0 && regionY === 0 && regionText === '未选择区域') {
      return message.warning('请先选择点击位置')
    }

    runningRef.current = true
    setIsRunning(true)
    setClickCount(0)
    setStatusText('运行中...')

    // 防止屏幕熄屏
    await api.preventSleep()

    if (isDurationMode) {
      stopTimeRef.current = Date.now() + durationMinutes * 60 * 1000
      addLog(`开始自动点击，持续时间 ${durationMinutes} 分钟`)
    } else {
      const n = new Date()
      const end = new Date(n)
      end.setHours(endHour, endMinute, 0, 0)
      if (end <= n) end.setDate(end.getDate() + 1)
      stopTimeRef.current = end.getTime()
      addLog(`开始自动点击，时间段 ${startHour}:${String(startMinute).padStart(2, '0')} - ${endHour}:${String(endMinute).padStart(2, '0')}`)
    }

    const intervalDesc = isRandomInterval
      ? `间隔 ${Math.min(intervalMin, intervalMax)}~${Math.max(intervalMin, intervalMax)} 秒（随机）`
      : `间隔 ${intervalMin} 秒`
    addLog(intervalDesc)

    let count = 0
    const doClick = async () => {
      if (!runningRef.current) return

      const pos = getRandomClickPos()
      if (showAnimation) {
        api.showClickIndicator(pos.x, pos.y)
      }
      const result = await api.autoClick(pos.x, pos.y)
      if (result.success) {
        count++
        setClickCount(count)
        addLog(`点击 (${pos.x}, ${pos.y}) - 第 ${count} 次`)
        // 记录点击位置，最多保留最近50个
        setClickPoints(prev => {
          const newPoints = [...prev, { x: pos.x, y: pos.y, index: count }]
          return newPoints.length > 50 ? newPoints.slice(-50) : newPoints
        })
      } else {
        addLog(`点击失败: ${result.error}`)
      }
    }

    await doClick()
    scheduleNext(doClick)
  }, [isDurationMode, durationMinutes, regionX, regionY, regionW, regionH, isRandomInterval, intervalMin, intervalMax, startHour, startMinute, endHour, endMinute, showAnimation])

  const stopAutoClick = useCallback(() => {
    runningRef.current = false
    clearTimeout(timerRef.current)
    timerRef.current = 0
    setIsRunning(false)
    setStatusText('已停止')
    addLog('自动点击已停止')
    // 恢复屏幕熄屏
    api.allowSleep()
  }, [])

  const clearLogs = () => {
    setLogs([])
    setClickCount(0)
    setClickPoints([])
  }

  // =============== 预设方案 ===============

  // 启动时加载预设
  useEffect(() => {
    const loadPresets = async () => {
      try {
        const result = await api.configRead()
        if (result?.success && result.data && Array.isArray(result.data[PRESETS_CONFIG_KEY])) {
          setPresets(result.data[PRESETS_CONFIG_KEY])
        }
      } catch {
        // 读取失败则忽略，保持空列表
      }
    }
    loadPresets()
  }, [])

  // 持久化预设到磁盘
  const persistPresets = async (next: AutoClickPreset[]) => {
    setPresets(next)
    try {
      const result = await api.configRead()
      const existing = (result?.success && result.data) || {}
      await api.configWrite({ ...existing, [PRESETS_CONFIG_KEY]: next })
    } catch {
      message.error('预设保存失败')
    }
  }

  // 收集当前所有设置参数
  const getCurrentSettings = (): Omit<AutoClickPreset, 'name'> => ({
    isDurationMode,
    durationMinutes,
    startHour,
    startMinute,
    endHour,
    endMinute,
    isRandomInterval,
    intervalMin,
    intervalMax,
    showAnimation,
    regionX,
    regionY,
    regionW,
    regionH,
    regionText,
  })

  // 打开保存预设弹窗
  const openSaveModal = () => {
    setPresetNameInput('')
    setSaveModalOpen(true)
  }

  // 确认保存预设（同名则覆盖更新）
  const confirmSavePreset = async () => {
    const name = presetNameInput.trim()
    if (!name) {
      message.warning('请输入预设名称')
      return
    }
    // 一并保存降采样后的区域预览图，应用预设后可直接显示点击预览
    const thumb = regionPreview ? await shrinkPreview(regionPreview) : ''
    const preset: AutoClickPreset = { name, ...getCurrentSettings() }
    if (thumb) preset.regionPreview = thumb
    const next = [...presets.filter(p => p.name !== name), preset]
    await persistPresets(next)
    setSelectedPresetName(name)
    setSaveModalOpen(false)
    message.success(`已保存预设「${name}」`)
    addLog(`已保存预设「${name}」`)
  }

  // 重新截取当前区域作为预览图
  const refreshPreview = async () => {
    if (regionW <= 0 || regionH <= 0) {
      message.warning('请先选择点击区域')
      return
    }
    const res = await api.screenshotRegion({ x: regionX, y: regionY, width: regionW, height: regionH })
    if (res?.success && res.dataUrl) {
      setRegionPreview(res.dataUrl)
      message.success('预览已刷新')
    } else {
      message.error(`预览刷新失败：${res?.error || '未知错误'}`)
    }
  }

  // 应用预设
  const applyPreset = (name: string) => {
    const preset = presets.find(p => p.name === name)
    if (!preset) return
    setIsDurationMode(preset.isDurationMode)
    setDurationMinutes(preset.durationMinutes)
    setStartHour(preset.startHour)
    setStartMinute(preset.startMinute)
    setEndHour(preset.endHour)
    setEndMinute(preset.endMinute)
    setIsRandomInterval(preset.isRandomInterval)
    setIntervalMin(preset.intervalMin)
    setIntervalMax(preset.intervalMax)
    setShowAnimation(preset.showAnimation)
    setRegionX(preset.regionX)
    setRegionY(preset.regionY)
    setRegionW(preset.regionW)
    setRegionH(preset.regionH)
    setRegionText(preset.regionText)
    // 优先恢复预设内保存的预览图；旧预设没有则实时截取一次该区域
    if (preset.regionPreview) {
      setRegionPreview(preset.regionPreview)
    } else if (preset.regionW > 0 && preset.regionH > 0) {
      setRegionPreview(null)
      api.screenshotRegion({ x: preset.regionX, y: preset.regionY, width: preset.regionW, height: preset.regionH })
        .then(res => { if (res?.success && res.dataUrl) setRegionPreview(res.dataUrl) })
        .catch(() => {})
    } else {
      setRegionPreview(null)
    }
    setClickPoints([])
    setSelectedPresetName(name)
    message.success(`已应用预设「${name}」`)
    addLog(`已应用预设「${name}」`)
  }

  // 删除预设
  const deletePreset = async (name: string) => {
    const next = presets.filter(p => p.name !== name)
    await persistPresets(next)
    if (selectedPresetName === name) setSelectedPresetName(undefined)
    message.success(`已删除预设「${name}」`)
  }

  // =============== 预设导入 / 导出（分享） ===============

  // 校验并规范化外部导入的预设对象
  const normalizePreset = (raw: any): AutoClickPreset | null => {
    if (!raw || typeof raw !== 'object') return null
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!name) return null
    const num = (v: any, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
    const bool = (v: any, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
    const regionX = num(raw.regionX, 0)
    const regionY = num(raw.regionY, 0)
    const regionW = num(raw.regionW, 0)
    const regionH = num(raw.regionH, 0)
    return {
      name,
      isDurationMode: bool(raw.isDurationMode, true),
      durationMinutes: num(raw.durationMinutes, 30),
      startHour: num(raw.startHour, 9),
      startMinute: num(raw.startMinute, 0),
      endHour: num(raw.endHour, 18),
      endMinute: num(raw.endMinute, 0),
      isRandomInterval: bool(raw.isRandomInterval, false),
      intervalMin: num(raw.intervalMin, 3),
      intervalMax: num(raw.intervalMax, 8),
      showAnimation: bool(raw.showAnimation, true),
      regionX,
      regionY,
      regionW,
      regionH,
      regionText: typeof raw.regionText === 'string' && raw.regionText
        ? raw.regionText
        : (regionW > 0 ? `区域 (${regionX},${regionY}) ${regionW}x${regionH}` : '未选择区域'),
      ...(typeof raw.regionPreview === 'string' && raw.regionPreview.startsWith('data:image')
        ? { regionPreview: raw.regionPreview }
        : {}),
    }
  }

  // 导出预设：全部或仅当前选中
  const exportPresets = async (onlySelected: boolean) => {
    const list = onlySelected
      ? presets.filter(p => p.name === selectedPresetName)
      : presets
    if (list.length === 0) {
      message.warning(onlySelected ? '请先选择要导出的预设' : '暂无预设可导出')
      return
    }
    const payload = {
      type: 'toolbox-autoclick-presets',
      version: 1,
      exportedAt: new Date().toISOString(),
      presets: list,
    }
    const defaultFileName = onlySelected
      ? `自动点击预设-${list[0].name}.json`
      : `自动点击预设-${list.length}项.json`
    const res = await api.exportJson({ defaultFileName, content: JSON.stringify(payload, null, 2) })
    if (res?.success) {
      message.success(`已导出 ${list.length} 个预设`)
      addLog(`已导出 ${list.length} 个预设到 ${res.filePath}`)
    } else if (!res?.canceled) {
      message.error(`导出失败：${res?.error || '未知错误'}`)
    }
  }

  // 导入预设：解析文件后进入冲突确认流程
  const importPresets = async () => {
    const res = await api.importJson()
    if (!res?.success) {
      if (!res?.canceled) message.error(`导入失败：${res?.error || '未知错误'}`)
      return
    }
    let parsed: any
    try {
      parsed = JSON.parse(res.content || '')
    } catch {
      message.error('导入失败：文件不是合法的 JSON')
      return
    }
    // 兼容三种格式：标准导出包 / 预设数组 / 单个预设对象
    const rawList = Array.isArray(parsed?.presets)
      ? parsed.presets
      : Array.isArray(parsed)
        ? parsed
        : [parsed]
    const incoming: AutoClickPreset[] = rawList
      .map(normalizePreset)
      .filter((p: AutoClickPreset | null): p is AutoClickPreset => p !== null)
    if (incoming.length === 0) {
      message.error('导入失败：文件中没有有效的预设数据')
      return
    }

    const conflicts = incoming.filter(p => presets.some(e => e.name === p.name))

    // 合并逻辑：overwrite=true 覆盖同名，false 则给导入项加后缀保留双方
    const merge = async (overwrite: boolean) => {
      let next = [...presets]
      let added = 0
      let updated = 0
      for (const p of incoming) {
        const idx = next.findIndex(e => e.name === p.name)
        if (idx === -1) {
          next.push(p)
          added++
        } else if (overwrite) {
          next[idx] = p
          updated++
        } else {
          // 生成不冲突的新名称：原名 (2)、原名 (3) ...
          let suffix = 2
          let newName = `${p.name} (${suffix})`
          while (next.some(e => e.name === newName)) {
            suffix++
            newName = `${p.name} (${suffix})`
          }
          next.push({ ...p, name: newName })
          added++
        }
      }
      await persistPresets(next)
      const summary = `导入完成：新增 ${added} 个${updated > 0 ? `，覆盖 ${updated} 个` : ''}`
      message.success(summary)
      addLog(`${summary}（来源：${res.filePath}）`)
    }

    if (conflicts.length === 0) {
      await merge(false)
      return
    }

    Modal.confirm({
      title: '存在同名预设',
      width: 480,
      content: (
        <div>
          <div style={{ marginBottom: 8 }}>
            共导入 {incoming.length} 个预设，其中 {conflicts.length} 个与现有预设同名：
          </div>
          <div style={{ maxHeight: 120, overflow: 'auto', fontSize: 12, color: '#666' }}>
            {conflicts.map(p => <div key={p.name}>· {p.name}</div>)}
          </div>
          <div style={{ marginTop: 12, fontSize: 12, color: '#888' }}>
            选择「覆盖」将用导入的内容替换同名预设；选择「保留两者」会把导入项重命名为「原名 (2)」。
          </div>
        </div>
      ),
      okText: '覆盖同名',
      cancelText: '保留两者',
      onOk: () => merge(true),
      onCancel: () => merge(false),
    })
  }

  const intervalDisplay = isRandomInterval
    ? `${Math.min(intervalMin, intervalMax)}~${Math.max(intervalMin, intervalMax)}秒`
    : `${intervalMin}秒`

  return (
    <div>
      <div className="page-title">自动点击</div>

      <Card size="small" className="section-card" title="预设方案" style={{ marginBottom: 16 }}>
        <Space style={{ width: '100%', flexWrap: 'wrap' }}>
          <Select
            style={{ minWidth: 180 }}
            placeholder={presets.length === 0 ? '暂无预设，点击「保存当前为预设」创建' : '选择预设方案（选择即应用）'}
            value={selectedPresetName}
            onChange={applyPreset}
            disabled={isRunning || presets.length === 0}
            options={presets.map(p => ({ label: p.name, value: p.name }))}
            showSearch
            optionFilterProp="label"
            notFoundContent="暂无预设"
          />
          <Button icon={<SaveOutlined />} onClick={openSaveModal} disabled={isRunning}>
            保存当前为预设
          </Button>
          <Popconfirm title="确认删除此预设？" onConfirm={() => selectedPresetName && deletePreset(selectedPresetName)} disabled={!selectedPresetName}>
            <Button icon={<DeleteOutlined />} danger disabled={isRunning || !selectedPresetName}>
              删除
            </Button>
          </Popconfirm>
          <Dropdown
            disabled={isRunning || presets.length === 0}
            menu={{
              items: [
                { key: 'all', label: `导出全部预设（${presets.length} 个）` },
                { key: 'one', label: selectedPresetName ? `仅导出「${selectedPresetName}」` : '仅导出当前选中（未选中）', disabled: !selectedPresetName },
              ],
              onClick: ({ key }) => exportPresets(key === 'one'),
            }}
          >
            <Button icon={<ExportOutlined />} disabled={isRunning || presets.length === 0}>
              导出
            </Button>
          </Dropdown>
          <Button icon={<ImportOutlined />} onClick={importPresets} disabled={isRunning}>
            导入
          </Button>
        </Space>
        <div style={{ fontSize: 12, color: '#888', marginTop: 8 }}>
          将当前所有参数（运行模式、时间、点击间隔、点击区域等）保存为预设方案，下次打开软件可直接一键应用，无需重复设置。
          导出的 JSON 文件可分享给他人，对方通过「导入」即可使用。
        </div>
      </Card>

      <Row gutter={16}>
        <Col span={14}>
          <Card size="small" className="section-card" title="点击设置">
            <Space direction="vertical" style={{ width: '100%' }}>
              <div>
                <Space>
                  <span>运行模式：</span>
                  <Switch
                    checkedChildren="持续时间"
                    unCheckedChildren="时间段"
                    checked={isDurationMode}
                    onChange={setIsDurationMode}
                    disabled={isRunning}
                  />
                </Space>
              </div>

              {isDurationMode ? (
                <div>
                  <span>持续时间 (分钟)：</span>
                  <InputNumber min={1} max={1440} value={durationMinutes} onChange={v => setDurationMinutes(v || 1)} disabled={isRunning} />
                </div>
              ) : (
                <div>
                  <Space>
                    <span>开始时间：</span>
                    <InputNumber min={0} max={23} value={startHour} onChange={v => setStartHour(v || 0)} disabled={isRunning} style={{ width: 60 }} />
                    <span>:</span>
                    <InputNumber min={0} max={59} value={startMinute} onChange={v => setStartMinute(v || 0)} disabled={isRunning} style={{ width: 60 }} />
                    <span style={{ marginLeft: 16 }}>结束时间：</span>
                    <InputNumber min={0} max={23} value={endHour} onChange={v => setEndHour(v || 0)} disabled={isRunning} style={{ width: 60 }} />
                    <span>:</span>
                    <InputNumber min={0} max={59} value={endMinute} onChange={v => setEndMinute(v || 0)} disabled={isRunning} style={{ width: 60 }} />
                  </Space>
                </div>
              )}

              <div>
                <Space style={{ flexWrap: 'wrap' }}>
                  <span>点击间隔：</span>
                  <Switch
                    checkedChildren="随机"
                    unCheckedChildren="固定"
                    checked={isRandomInterval}
                    onChange={setIsRandomInterval}
                    disabled={isRunning}
                  />
                  {isRandomInterval ? (
                    <>
                      <InputNumber min={1} max={3600} value={intervalMin} onChange={v => setIntervalMin(v || 1)} disabled={isRunning} style={{ width: 60 }} />
                      <span style={{ fontSize: 12, color: '#888' }}>秒 ~</span>
                      <InputNumber min={1} max={3600} value={intervalMax} onChange={v => setIntervalMax(v || 1)} disabled={isRunning} style={{ width: 60 }} />
                      <span style={{ fontSize: 12, color: '#888' }}>秒</span>
                    </>
                  ) : (
                    <>
                      <InputNumber min={1} max={3600} value={intervalMin} onChange={v => setIntervalMin(v || 1)} disabled={isRunning} style={{ width: 70 }} />
                      <span style={{ fontSize: 12, color: '#888' }}>秒</span>
                    </>
                  )}
                </Space>
              </div>

              <div>
                <Space align="center">
                  <span>点击位置：</span>
                  <Tag color={regionText === '未选择区域' ? 'default' : 'blue'}>{regionText}</Tag>
                  <Button size="small" icon={<AimOutlined />} onClick={selectRegion} disabled={isRunning || selectingPos} loading={selectingPos}>
                    选择区域
                  </Button>
                  {regionW > 0 && (
                    <>
                      <Button size="small" icon={<ReloadOutlined />} onClick={selectRegion} disabled={isRunning || selectingPos}>
                        重新选择
                      </Button>
                      <Button size="small" icon={<CameraOutlined />} onClick={refreshPreview} disabled={isRunning || selectingPos}>
                        刷新预览
                      </Button>
                    </>
                  )}
                </Space>
              </div>
              {regionW > 0 && (
                <div style={{ paddingLeft: 70 }}>
                  <Space style={{ flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, color: '#666' }}>微调：</span>
                    <span style={{ fontSize: 12, color: '#999' }}>X:</span>
                    <InputNumber size="small" min={0} value={regionX} onChange={handleRegionXChange} style={{ width: 70 }} disabled={isRunning} />
                    <span style={{ fontSize: 12, color: '#999' }}>Y:</span>
                    <InputNumber size="small" min={0} value={regionY} onChange={handleRegionYChange} style={{ width: 70 }} disabled={isRunning} />
                    <span style={{ fontSize: 12, color: '#999' }}>宽:</span>
                    <InputNumber size="small" min={1} value={regionW} onChange={handleRegionWChange} style={{ width: 70 }} disabled={isRunning} />
                    <span style={{ fontSize: 12, color: '#999' }}>高:</span>
                    <InputNumber size="small" min={1} value={regionH} onChange={handleRegionHChange} style={{ width: 70 }} disabled={isRunning} />
                  </Space>
                </div>
              )}

              <div>
                <Space>
                  <span>动画显示：</span>
                  <Switch
                    checkedChildren="开"
                    unCheckedChildren="关"
                    checked={showAnimation}
                    onChange={setShowAnimation}
                  />
                  <span style={{ fontSize: 12, color: '#888' }}>点击时屏幕上的波纹动画指示器</span>
                </Space>
              </div>
            </Space>
          </Card>

          <div className="action-bar">
            <Space>
              {!isRunning ? (
                <Button type="primary" icon={<PlayCircleOutlined />} onClick={startAutoClick} size="large">
                  开始
                </Button>
              ) : (
                <Button danger icon={<PauseCircleOutlined />} onClick={stopAutoClick} size="large">
                  停止
                </Button>
              )}
              <Tag color={isRunning ? 'red' : 'default'} style={{ fontSize: 14, padding: '4px 12px' }}>
                {statusText}
              </Tag>
            </Space>
          </div>
        </Col>

        <Col span={10}>
          <Card size="small" className="section-card" title="运行状态" extra={
            <Button size="small" icon={<DeleteOutlined />} onClick={clearLogs}>清空</Button>
          }>
            <Row gutter={16} style={{ marginBottom: 12 }}>
              <Col span={12}><Statistic title="点击次数" value={clickCount} /></Col>
              <Col span={12}><Statistic title="点击间隔" value={intervalDisplay} /></Col>
            </Row>

            {/* 区域预览 + 点击位置标记 */}
            {(regionPreview || regionW > 0) && (
              <div style={{ marginBottom: 12, textAlign: 'center' }}>
                <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>
                  选中区域预览 {clickPoints.length > 0 && <span style={{ color: '#1677ff' }}>（已标记 {clickPoints.length} 个点击位置）</span>}
                </div>
                <div style={{ position: 'relative', display: 'inline-block' }}>
                  {regionPreview ? (
                    <img
                      src={regionPreview}
                      alt="区域预览"
                      style={{
                        maxWidth: '100%',
                        maxHeight: 160,
                        border: '1px solid #d9d9d9',
                        borderRadius: 4,
                        objectFit: 'contain',
                        display: 'block',
                      }}
                      id="region-preview-img"
                    />
                  ) : (
                    // 无预览图时用等比空白占位，保证点击标记仍能按区域比例显示
                    <div
                      style={{
                        width: Math.min(280, Math.round(160 * (regionW / Math.max(1, regionH)))),
                        height: 160,
                        border: '1px dashed #d9d9d9',
                        borderRadius: 4,
                        background: '#fafafa',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 12,
                        color: '#bbb',
                      }}
                    >
                      无预览图（可点「刷新预览」）
                    </div>
                  )}
                  {/* 点击位置标记叠加层 */}
                  {clickPoints.length > 0 && (
                    <svg
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                        pointerEvents: 'none',
                      }}
                      viewBox={`0 0 ${regionW} ${regionH}`}
                      preserveAspectRatio="xMidYMid meet"
                    >
                      {clickPoints.map((pt, i) => {
                        // 将绝对坐标转为相对于区域的坐标
                        const relX = pt.x - regionX
                        const relY = pt.y - regionY
                        const isLatest = i === clickPoints.length - 1
                        return (
                          <g key={i}>
                            <circle
                              cx={relX}
                              cy={relY}
                              r={isLatest ? 5 : 3}
                              fill={isLatest ? '#ff4d4f' : 'rgba(22, 119, 255, 0.7)'}
                              stroke={isLatest ? '#fff' : 'none'}
                              strokeWidth={isLatest ? 1.5 : 0}
                            />
                            {isLatest && (
                              <circle
                                cx={relX}
                                cy={relY}
                                r={10}
                                fill="none"
                                stroke="#ff4d4f"
                                strokeWidth={1.5}
                                opacity={0.6}
                              />
                            )}
                          </g>
                        )
                      })}
                    </svg>
                  )}
                </div>
                <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>{regionText}</div>
              </div>
            )}

            <div className="log-box">
              {logs.map((log, i) => (
                <div key={i}>{log}</div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </Card>
        </Col>
      </Row>

      {/* 保存预设弹窗 */}
      <Modal
        title="保存为预设方案"
        open={saveModalOpen}
        onOk={confirmSavePreset}
        onCancel={() => setSaveModalOpen(false)}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <div style={{ marginBottom: 8 }}>预设名称：</div>
        <Input
          placeholder="例如：日常挂机、周常任务"
          value={presetNameInput}
          onChange={e => setPresetNameInput(e.target.value)}
          onPressEnter={confirmSavePreset}
          maxLength={30}
          autoFocus
        />
        <div style={{ fontSize: 12, color: '#888', marginTop: 8 }}>
          同名预设将被覆盖更新。保存内容包含：运行模式、时长/时间段、点击间隔、动画开关、点击区域坐标。
        </div>
      </Modal>
    </div>
  )
}
