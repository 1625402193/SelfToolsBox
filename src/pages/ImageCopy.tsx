import { useEffect, useRef, useState } from 'react'
import {
  Card, Button, Input, Switch, Table, Tag, Space, message, Modal, Alert,
  InputNumber, Radio, Tooltip, Empty, Select, Divider,
} from 'antd'
import {
  FolderOpenOutlined, PlusOutlined, MinusCircleOutlined, ReloadOutlined,
  ScanOutlined, PlayCircleOutlined, DeleteOutlined, FolderOutlined,
  DatabaseOutlined, ExportOutlined,
} from '@ant-design/icons'
import type {
  ImageIndexData, ImageScanData, ImageCopyPlan, ImageConflict, ImageCopyLogEntry, ImagePlanGroup,
} from '../types'

const api = window.electronAPI

const DEFAULT_ODD_FOLDER = '尺寸异常'
const DEFAULT_UNMATCHED_FOLDER = '未匹配'
const CONFIG_KEY = 'imageCopy'

// 多目录选择的复合键：目标路径 + 分类键，与主进程 choiceKey 保持一致
const choiceKey = (root: string, key: string) => `${root}||${key}`

const levelColor: Record<string, string> = {
  success: '#52c41a', warn: '#faad14', error: '#ff4d4f', info: '#8c8c8c',
}

function fmtTime(iso?: string) {
  if (!iso) return ''
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function fmtSize(bytes: number) {
  if (!bytes) return '0 B'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

/** 多路径编辑器：支持任意数量的源/目标路径 */
function PathList({ label, paths, onChange }: {
  label: string
  paths: string[]
  onChange: (next: string[]) => void
}) {
  const browse = async (idx: number) => {
    const dir = await api.openDirectory()
    if (!dir) return
    const next = [...paths]
    next[idx] = dir
    onChange(next)
  }
  return (
    <div>
      {paths.map((p, idx) => (
        <div key={idx} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
          <span style={{ width: 78, color: '#666', fontSize: 13 }}>
            {label} {idx + 1}{idx === 0 ? ' *' : ''}
          </span>
          <Input
            value={p}
            placeholder={idx === 0 ? `选择${label}（首个${label}用于存放尺寸异常/未匹配图片）` : `选择${label}`}
            onChange={e => {
              const next = [...paths]
              next[idx] = e.target.value
              onChange(next)
            }}
            style={{ flex: 1 }}
          />
          <Button icon={<FolderOpenOutlined />} onClick={() => browse(idx)}>浏览</Button>
          <Button
            icon={<MinusCircleOutlined />}
            danger
            disabled={paths.length <= 1}
            onClick={() => onChange(paths.filter((_, i) => i !== idx))}
          />
        </div>
      ))}
      <Button type="dashed" icon={<PlusOutlined />} onClick={() => onChange([...paths, ''])} style={{ width: 200 }}>
        添加{label}
      </Button>
    </div>
  )
}

export default function ImageCopy() {
  // 路径
  const [sourcePaths, setSourcePaths] = useState<string[]>([''])
  const [targetPaths, setTargetPaths] = useState<string[]>([''])

  // 选项
  const [keySegments, setKeySegments] = useState(1)
  const [recursive, setRecursive] = useState(true)
  const [autoRebuildIndex, setAutoRebuildIndex] = useState(true)
  const [askOverwrite, setAskOverwrite] = useState(true)
  const [oddSizeFolderName, setOddSizeFolderName] = useState(DEFAULT_ODD_FOLDER)
  const [unmatchedFolderName, setUnmatchedFolderName] = useState(DEFAULT_UNMATCHED_FOLDER)

  // 数据
  const [indexData, setIndexData] = useState<ImageIndexData | null>(null)
  const [scanData, setScanData] = useState<ImageScanData | null>(null)
  const [plan, setPlan] = useState<ImageCopyPlan | null>(null)
  const [logs, setLogs] = useState<ImageCopyLogEntry[]>([])
  const [logFilter, setLogFilter] = useState<string>('all')
  const [createdFolders, setCreatedFolders] = useState<{ label: string; path: string }[]>([])

  // 加载态
  const [indexing, setIndexing] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [running, setRunning] = useState(false)

  // 交互弹窗（choiceModal.groups 携带所属目标路径，各目标路径分别选择）
  const [choiceModal, setChoiceModal] = useState<{ open: boolean; groups: (ImagePlanGroup & { root: string })[] }>({ open: false, groups: [] })
  const [choiceValues, setChoiceValues] = useState<Record<string, string>>({})
  const choiceResolver = useRef<((v: Record<string, string> | null) => void) | null>(null)

  const [conflictModal, setConflictModal] = useState<{ open: boolean; conflicts: ImageConflict[] }>({ open: false, conflicts: [] })
  const [conflictDecisions, setConflictDecisions] = useState<Record<string, boolean>>({})
  const conflictResolver = useRef<((v: Record<string, boolean> | null) => void) | null>(null)

  const options = () => ({
    keySegments, recursive, oddSizeFolderName, unmatchedFolderName,
  })

  // ---------- 日志 ----------
  const pushLogs = (entries: ImageCopyLogEntry[] | ImageCopyLogEntry) => {
    const list = (Array.isArray(entries) ? entries : [entries]).map(e => ({
      ...e, time: e.time || new Date().toISOString(),
    }))
    setLogs(prev => [...list.slice().reverse(), ...prev].slice(0, 2000))
  }

  // 界面侧发起的操作同样写入本地日志文件，保证操作全程留痕
  const logAction = (entry: ImageCopyLogEntry) => {
    pushLogs(entry)
    api.imageCopyAppendLog?.(entry)
  }

  // ---------- 初始化：恢复配置 + 读取已有索引和历史日志 ----------
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let savedTargets: string[] = []
      try {
        const cfg = await api.configRead?.()
        const saved = cfg?.data?.[CONFIG_KEY]
        if (!cancelled && saved) {
          if (Array.isArray(saved.sourcePaths) && saved.sourcePaths.length) setSourcePaths(saved.sourcePaths)
          if (Array.isArray(saved.targetPaths) && saved.targetPaths.length) {
            setTargetPaths(saved.targetPaths)
            savedTargets = saved.targetPaths
          }
          if (typeof saved.keySegments === 'number') setKeySegments(saved.keySegments)
          if (typeof saved.recursive === 'boolean') setRecursive(saved.recursive)
          if (typeof saved.autoRebuildIndex === 'boolean') setAutoRebuildIndex(saved.autoRebuildIndex)
          if (typeof saved.askOverwrite === 'boolean') setAskOverwrite(saved.askOverwrite)
          if (saved.oddSizeFolderName) setOddSizeFolderName(saved.oddSizeFolderName)
          if (saved.unmatchedFolderName) setUnmatchedFolderName(saved.unmatchedFolderName)
        }
      } catch {}

      // 只加载当前配置的目标路径对应的索引（每个目标路径一份，互相独立）
      const idx = await api.imageCopyLoadIndex?.(savedTargets.map(p => String(p).trim()).filter(Boolean))
      if (!cancelled && idx?.success && idx.data?.exists) setIndexData(idx.data)

      const lg = await api.imageCopyReadLog?.(300)
      if (!cancelled && lg?.success && lg.data) setLogs(lg.data.entries)
    })()
    return () => { cancelled = true }
  }, [])

  // 配置持久化（先读取全量再合并写回，避免覆盖其他页面的配置）
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const cfg = await api.configRead?.()
        const all = cfg?.data || {}
        await api.configWrite?.({
          ...all,
          [CONFIG_KEY]: {
            sourcePaths, targetPaths, keySegments, recursive,
            autoRebuildIndex, askOverwrite, oddSizeFolderName, unmatchedFolderName,
          },
        })
      } catch {}
    }, 600)
    return () => clearTimeout(timer)
  }, [sourcePaths, targetPaths, keySegments, recursive, autoRebuildIndex, askOverwrite, oddSizeFolderName, unmatchedFolderName])

  // ---------- 记录工具创建的文件夹，供界面快捷打开 ----------
  const addCreatedFolder = (label: string, folderPath?: string | null) => {
    if (!folderPath) return
    setCreatedFolders(prev => (prev.some(f => f.path === folderPath) ? prev : [...prev, { label, path: folderPath }]))
  }

  // ---------- 步骤 1：重建目标索引（每个目标路径分别建立，互相独立） ----------
  const buildIndex = async (silent = false): Promise<ImageIndexData | null> => {
    const valid = targetPaths.map(p => p.trim()).filter(Boolean)
    if (valid.length === 0) {
      message.warning('请至少选择一个目标路径')
      return null
    }
    setIndexing(true)
    logAction({ action: 'buildIndex', level: 'info', message: `开始重建目标索引（${valid.length} 个目标路径，各自独立建立）` })
    const res = await api.imageCopyBuildIndex(valid, options())
    setIndexing(false)

    if (!res.success || !res.data) {
      logAction({ action: 'buildIndex', level: 'error', message: `重建索引失败：${res.error || '未知错误'}` })
      message.error(res.error || '重建索引失败')
      return null
    }
    setIndexData(res.data)
    setPlan(null)
    for (const r of res.data.roots) {
      pushLogs({
        action: 'buildIndex', level: 'success',
        message: `索引已更新：${r.root} → ${r.stats.imageCount} 张图 / ${r.stats.keyCount} 个键（${r.stats.multiDirKeyCount} 个键在该路径内分布于多个目录）`,
      })
    }
    if (res.data.missing?.length) {
      pushLogs({ action: 'buildIndex', level: 'warn', message: `以下目标路径不存在，已跳过：${res.data.missing.join('、')}` })
    }
    if (!silent) message.success(`索引重建完成，共 ${res.data.roots.length} 个目标路径`)
    return res.data
  }

  // ---------- 步骤 2：扫描源路径 ----------
  const scanSources = async (silent = false): Promise<ImageScanData | null> => {
    const valid = sourcePaths.map(p => p.trim()).filter(Boolean)
    if (valid.length === 0) {
      message.warning('请至少选择一个源路径')
      return null
    }
    setScanning(true)
    logAction({ action: 'scanSources', level: 'info', message: `开始扫描源路径（${valid.length} 个源路径）` })
    const res = await api.imageCopyScanSources(valid, options())
    setScanning(false)

    if (!res.success || !res.data) {
      logAction({ action: 'scanSources', level: 'error', message: `扫描失败：${res.error || '未知错误'}` })
      message.error(res.error || '扫描失败')
      return null
    }
    setScanData(res.data)
    setPlan(null)
    pushLogs(res.data.logs || [])
    if (res.data.missing?.length) {
      pushLogs({ action: 'scanSources', level: 'warn', message: `以下源路径不存在，已跳过：${res.data.missing.join('、')}` })
    }

    if (res.data.oddSizeFolder) {
      addCreatedFolder('尺寸异常图片', res.data.oddSizeFolder)
      Modal.warning({
        title: '存在尺寸不是 2 的倍数的图片',
        content: (
          <div>
            <p>共 {res.data.oddSized.length} 张图片尺寸不是 2 的倍数，这些图片不会复制到目标路径。</p>
            <p>已复制到：<br /><code style={{ fontSize: 12 }}>{res.data.oddSizeFolder}</code></p>
          </div>
        ),
        okText: '打开该文件夹',
        cancelText: '知道了',
        okCancel: true,
        onOk: () => api.openPath(res.data!.oddSizeFolder!),
      })
    }
    if (!silent) message.success(`扫描完成，待处理 ${res.data.pending} 张图`)
    return res.data
  }

  // ---------- 步骤 3：生成匹配计划（每个目标路径一份） ----------
  const makePlan = async (): Promise<ImageCopyPlan | null> => {
    const res = await api.imageCopyMakePlan()
    if (!res.success || !res.data) {
      logAction({ action: 'makePlan', level: 'error', message: `匹配失败：${res.error || '未知错误'}` })
      message.error(res.error || '匹配失败')
      return null
    }
    setPlan(res.data)
    for (const rp of res.data.roots) {
      pushLogs({
        action: 'makePlan', level: 'info',
        message: `匹配结果（${rp.root}）：直接命中 ${rp.direct.length} 个分类，需人工选择 ${rp.ambiguous.length} 个，未命中 ${rp.unmatched.length} 个`,
      })
    }
    return res.data
  }

  // ---------- 用户交互：多目录选择 / 覆盖确认 ----------
  // groups 携带所属目标路径，选择结果以「目标路径||分类键」为键，各目标路径互不影响
  const askChoices = (groups: (ImagePlanGroup & { root: string })[]) =>
    new Promise<Record<string, string> | null>(resolve => {
      const defaults: Record<string, string> = {}
      groups.forEach(g => {
        if (g.candidates?.length) defaults[choiceKey(g.root, g.key)] = g.candidates[0].dir
      })
      setChoiceValues(defaults)
      setChoiceModal({ open: true, groups })
      choiceResolver.current = resolve
    })

  const askConflicts = (conflicts: ImageConflict[]) =>
    new Promise<Record<string, boolean> | null>(resolve => {
      const defaults: Record<string, boolean> = {}
      conflicts.forEach(c => { defaults[c.destPath] = true })
      setConflictDecisions(defaults)
      setConflictModal({ open: true, conflicts })
      conflictResolver.current = resolve
    })

  const closeChoiceModal = (value: Record<string, string> | null) => {
    setChoiceModal({ open: false, groups: [] })
    choiceResolver.current?.(value)
    choiceResolver.current = null
  }

  const closeConflictModal = (value: Record<string, boolean> | null) => {
    setConflictModal({ open: false, conflicts: [] })
    conflictResolver.current?.(value)
    conflictResolver.current = null
  }

  // ---------- 完整流程 ----------
  const runFullFlow = async () => {
    if (sourcePaths.map(p => p.trim()).filter(Boolean).length === 0) return message.warning('请至少选择一个源路径')
    setRunning(true)
    try {
      logAction({ action: 'flow', level: 'info', message: '===== 开始执行批量复制流程 =====' })

      // 1. 目标索引（可选自动重建；未重建时要求已有索引）
      if (autoRebuildIndex) {
        const idx = await buildIndex(true)
        if (!idx) return
      } else if (!indexData) {
        message.warning('尚无目标索引，请先执行「重建目标索引」，或开启「执行前自动重建索引」')
        logAction({ action: 'flow', level: 'error', message: '流程中止：尚无目标索引' })
        return
      } else {
        const latest = indexData.roots.reduce((acc, r) => (r.updatedAt > acc ? r.updatedAt : acc), '')
        pushLogs({
          action: 'flow', level: 'info',
          message: `跳过索引重建，沿用已有索引（${indexData.roots.length} 个目标路径，最近更新 ${fmtTime(latest)}）`,
        })
      }

      // 2. 扫描源路径
      const scan = await scanSources(true)
      if (!scan) return
      if (scan.pending === 0) {
        message.warning('没有可复制的图片')
        logAction({ action: 'flow', level: 'warn', message: '流程结束：没有可复制的图片' })
        return
      }

      // 3. 匹配（每个目标路径各自一份计划）
      const p = await makePlan()
      if (!p) return

      // 4. 多目录键需要用户选择（按目标路径分别询问）
      let choices: Record<string, string> = {}
      const ambiguousAll = p.roots.flatMap(rp => rp.ambiguous.map(g => ({ ...g, root: rp.root })))
      if (ambiguousAll.length > 0) {
        const picked = await askChoices(ambiguousAll)
        if (!picked) {
          message.info('已取消')
          logAction({ action: 'flow', level: 'warn', message: '用户取消了目录选择，流程中止' })
          return
        }
        choices = picked
        ambiguousAll.forEach(g => {
          const dir = picked[choiceKey(g.root, g.key)]
          if (dir) {
            pushLogs({
              action: 'choice', level: 'info',
              message: `目标路径 ${g.root} 中，分类 ${g.display} 选择目录：${dir}`,
            })
          }
        })
      }

      // 5. 冲突确认（用户可在界面关闭询问，关闭时默认覆盖）
      let overwriteMode: 'overwrite' | 'decide' = 'overwrite'
      let decisions: Record<string, boolean> = {}
      if (askOverwrite) {
        const conflictRes = await api.imageCopyCheckConflicts({ choices, unmatchedFolderName })
        if (conflictRes.success && conflictRes.data && conflictRes.data.conflicts.length > 0) {
          const decided = await askConflicts(conflictRes.data.conflicts)
          if (!decided) {
            message.info('已取消')
            logAction({ action: 'flow', level: 'warn', message: '用户取消了覆盖确认，流程中止' })
            return
          }
          overwriteMode = 'decide'
          decisions = decided
        }
      } else {
        pushLogs({ action: 'flow', level: 'info', message: '覆盖询问已关闭，同名文件将直接覆盖' })
      }

      // 6. 执行
      const res = await api.imageCopyExecute({ choices, overwriteMode, decisions, unmatchedFolderName })
      if (!res.success || !res.data) {
        logAction({ action: 'execute', level: 'error', message: `执行失败：${res.error || '未知错误'}` })
        message.error(res.error || '执行失败')
        return
      }
      pushLogs(res.data.logs || [])

      // 每个目标路径可能各有一个未匹配文件夹，都提供打开入口
      const unmatchedDirs = Object.entries(res.data.unmatchedDirs || {})
      unmatchedDirs.forEach(([root, dir], i) => {
        const label = unmatchedDirs.length > 1 ? `未匹配图片(${root.split(/[\\/]/).pop() || i + 1})` : '未匹配图片'
        addCreatedFolder(label, dir)
      })

      const { copied, overwritten, skipped, failed } = res.data
      message.success(`复制完成：新增 ${copied}，覆盖 ${overwritten}，跳过 ${skipped}，失败 ${failed}`)

      if (unmatchedDirs.length > 0) {
        Modal.warning({
          title: '存在未匹配任何分类的图片',
          content: (
            <div>
              <p>以下图片在对应目标路径的索引中找不到匹配的键，已按目标路径分别复制到：</p>
              {unmatchedDirs.map(([root, dir]) => (
                <div key={root} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 12, color: '#999' }}>目标路径：{root}</div>
                  <code style={{ fontSize: 12 }}>{dir}</code>
                </div>
              ))}
            </div>
          ),
          okText: '打开首个文件夹',
          cancelText: '知道了',
          okCancel: true,
          onOk: () => api.openPath(unmatchedDirs[0][1]),
        })
      }
    } finally {
      setRunning(false)
    }
  }

  // ---------- 日志操作 ----------
  const clearLogs = async () => {
    await api.imageCopyClearLog?.()
    setLogs([])
    message.success('日志已清空')
  }

  const exportLogs = async () => {
    const content = logs.slice().reverse()
      .map(l => `[${l.time ? new Date(l.time).toLocaleString('zh-CN') : ''}] [${l.level}] ${l.message}`)
      .join('\r\n')
    const res = await api.exportJson({ defaultFileName: `批量复制图片日志_${Date.now()}.txt`, content })
    if (res.success && !res.canceled) message.success('日志已导出')
  }

  const visibleLogs = logFilter === 'all' ? logs : logs.filter(l => l.level === logFilter)

  // ---------- 表格列 ----------
  const indexColumns = [
    { title: '分类键', dataIndex: 'display', key: 'display', width: 220, render: (v: string) => <Tag color="blue">{v}</Tag> },
    { title: '图片数', dataIndex: 'fileCount', key: 'fileCount', width: 80 },
    {
      title: '所在目录', dataIndex: 'dirs', key: 'dirs',
      render: (dirs: string[]) => (
        <div>
          {dirs.map(d => (
            <div key={d} style={{ fontSize: 12, color: dirs.length > 1 ? '#fa8c16' : '#999' }}>
              {dirs.length > 1 && <Tag color="orange" style={{ marginRight: 4 }}>多</Tag>}{d}
            </div>
          ))}
        </div>
      ),
    },
  ]

  const scanColumns = [
    { title: '分类键', dataIndex: 'display', key: 'display', width: 220, render: (v: string) => <Tag color="green">{v}</Tag> },
    { title: '图片数', dataIndex: 'fileCount', key: 'fileCount', width: 80 },
    {
      title: '图片', dataIndex: 'files', key: 'files',
      render: (files: ImageScanData['groups'][0]['files']) => (
        <div style={{ fontSize: 12, color: '#666' }}>
          {files.map(f => (
            <span key={f.path} style={{ marginRight: 12 }}>
              {f.name}
              <span style={{ color: '#bbb' }}>
                {f.sizeUnknown ? '（尺寸未知）' : ` (${f.width}×${f.height})`}
              </span>
            </span>
          ))}
        </div>
      ),
    },
  ]

  return (
    <div>
      <div className="page-title">批量复制图片</div>

      <Card size="small" className="section-card" title="源路径（待复制的图片来源）">
        <PathList label="源路径" paths={sourcePaths} onChange={setSourcePaths} />
      </Card>

      <Card size="small" className="section-card" title="目标路径（建立分类索引的位置）">
        <PathList label="目标路径" paths={targetPaths} onChange={setTargetPaths} />
      </Card>

      <Card size="small" className="section-card" title="选项">
        <Space size="large" wrap>
          <Space>
            <Tooltip title="从文件名中取几个业务段作为分类键。取 1 段时 Icon_ShareTalk_01 与 Icon_ShareTalk_hero_02 同属 Icon_ShareTalk_ 分类；数值越大分类越精细">
              <span>分类粒度：</span>
            </Tooltip>
            <InputNumber min={1} max={4} value={keySegments} onChange={v => setKeySegments(Number(v) || 1)} style={{ width: 70 }} />
            <span style={{ color: '#999', fontSize: 12 }}>段</span>
          </Space>
          <Space>包含子文件夹：<Switch checked={recursive} onChange={setRecursive} /></Space>
          <Space>
            <Tooltip title="开启后，点击「开始执行」会先自动重建目标索引，再进行后续流程">
              <span>执行前自动重建索引：</span>
            </Tooltip>
            <Switch checked={autoRebuildIndex} onChange={setAutoRebuildIndex} />
          </Space>
          <Space>
            <Tooltip title="关闭后遇到目标目录已存在的同名文件将直接覆盖，不再弹窗询问">
              <span>覆盖前询问：</span>
            </Tooltip>
            <Switch checked={askOverwrite} onChange={setAskOverwrite} />
          </Space>
        </Space>
        <Divider style={{ margin: '12px 0' }} />
        <Space size="large" wrap>
          <Space>
            <span>尺寸异常文件夹名：</span>
            <Input value={oddSizeFolderName} onChange={e => setOddSizeFolderName(e.target.value)} style={{ width: 160 }} />
          </Space>
          <Space>
            <span>未匹配文件夹名：</span>
            <Input value={unmatchedFolderName} onChange={e => setUnmatchedFolderName(e.target.value)} style={{ width: 160 }} />
          </Space>
          <span style={{ color: '#999', fontSize: 12 }}>两个文件夹都创建在「源路径 1」下，且仅在确有对应图片时才创建</span>
        </Space>
      </Card>

      <div className="action-bar">
        <Space wrap>
          <Button icon={<DatabaseOutlined />} loading={indexing} onClick={() => buildIndex()}>
            重建目标索引
          </Button>
          <Button icon={<ScanOutlined />} loading={scanning} onClick={() => scanSources()}>
            扫描源路径
          </Button>
          <Button type="primary" icon={<PlayCircleOutlined />} loading={running} onClick={runFullFlow}>
            开始执行
          </Button>
          {createdFolders.map(f => (
            <Button key={f.path} icon={<FolderOutlined />} onClick={() => api.openPath(f.path)}>
              打开{f.label}文件夹
            </Button>
          ))}
        </Space>
      </div>

      {indexData && indexData.roots.length > 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={<span>目标索引（{indexData.roots.length} 个目标路径，各自独立）</span>}
          description={
            <div>
              {indexData.roots.map(r => (
                <div key={r.root} style={{ fontSize: 12, marginBottom: 4 }}>
                  <Tag color="blue">{r.root}</Tag>
                  {r.stats.keyCount} 个键 / {r.stats.imageCount} 张图
                  {r.stats.multiDirKeyCount > 0 &&
                    <span style={{ color: '#fa8c16' }}>，{r.stats.multiDirKeyCount} 个键在该路径内分布于多个目录（执行时需选择）</span>}
                  <span style={{ color: '#999', marginLeft: 8 }}>
                    更新于 {r.updatedAt ? new Date(r.updatedAt).toLocaleString('zh-CN') : '-'}
                  </span>
                </div>
              ))}
            </div>
          }
        />
      )}

      {scanData && (
        <Alert
          type={scanData.oddSized.length > 0 ? 'warning' : 'success'}
          showIcon
          style={{ marginBottom: 16 }}
          message={
            <Space wrap>
              <span>扫描结果：待处理 {scanData.pending} 张</span>
              <span>合并重名 {scanData.duplicates.length} 张</span>
              <span style={{ color: scanData.oddSized.length ? '#fa8c16' : undefined }}>尺寸异常 {scanData.oddSized.length} 张</span>
              {scanData.unknownSize.length > 0 && <span style={{ color: '#fa8c16' }}>尺寸未知 {scanData.unknownSize.length} 张</span>}
            </Space>
          }
        />
      )}

      {plan && (
        <Card size="small" className="section-card" title="匹配结果（按目标路径分别统计）">
          {plan.roots.map(rp => (
            <div key={rp.root} style={{ marginBottom: 12 }}>
              <div style={{ marginBottom: 6 }}><Tag color="blue">{rp.root}</Tag></div>
              <Space size="large" wrap>
                <span>直接命中：<Tag color="green">{rp.direct.length}</Tag> 个分类</span>
                <span>需人工选择：<Tag color="orange">{rp.ambiguous.length}</Tag> 个分类</span>
                <span>未命中：<Tag color="red">{rp.unmatched.length}</Tag> 个分类</span>
              </Space>
              {rp.unmatched.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 12, color: '#999' }}>
                  未命中分类：{rp.unmatched.map(g => g.display).join('、')}
                </div>
              )}
            </div>
          ))}
        </Card>
      )}

      <Card
        size="small"
        className="section-card"
        title="源路径分类结果"
        extra={scanData ? <span style={{ fontSize: 12, color: '#999' }}>{scanData.groups.length} 个分类</span> : null}
      >
        {scanData
          ? <Table
              columns={scanColumns}
              dataSource={scanData.groups}
              rowKey="key"
              size="small"
              pagination={{ pageSize: 10, showSizeChanger: true, showTotal: t => `共 ${t} 个分类` }}
            />
          : <Empty description="尚未扫描源路径" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
      </Card>

      <Card
        size="small"
        className="section-card"
        title="目标索引明细"
        extra={indexData?.roots?.length
          ? <span style={{ fontSize: 12, color: '#999' }}>{indexData.roots.length} 个目标路径</span>
          : null}
      >
        {indexData?.roots?.length
          ? indexData.roots.map(r => (
              <div key={r.root} style={{ marginBottom: 16 }}>
                <div style={{ marginBottom: 6 }}>
                  <Tag color="blue">{r.root}</Tag>
                  <span style={{ fontSize: 12, color: '#999' }}>{r.entries.length} 个键</span>
                </div>
                <Table
                  columns={indexColumns}
                  dataSource={r.entries}
                  rowKey="key"
                  size="small"
                  pagination={{ pageSize: 10, showSizeChanger: true, showTotal: t => `共 ${t} 个键` }}
                />
              </div>
            ))
          : <Empty description="尚未建立目标索引" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
      </Card>

      <Card
        size="small"
        className="section-card"
        title="操作记录"
        extra={
          <Space>
            <Radio.Group size="small" value={logFilter} onChange={e => setLogFilter(e.target.value)}>
              <Radio.Button value="all">全部</Radio.Button>
              <Radio.Button value="success">成功</Radio.Button>
              <Radio.Button value="warn">警告</Radio.Button>
              <Radio.Button value="error">错误</Radio.Button>
            </Radio.Group>
            <Button size="small" icon={<ExportOutlined />} onClick={exportLogs} disabled={logs.length === 0}>导出</Button>
            <Button size="small" icon={<DeleteOutlined />} danger onClick={clearLogs} disabled={logs.length === 0}>清空</Button>
          </Space>
        }
      >
        <div className="log-box" style={{ height: 260, color: '#ddd' }}>
          {visibleLogs.length === 0
            ? <div style={{ color: '#666' }}>暂无操作记录</div>
            : visibleLogs.map((l, i) => (
                <div key={i} style={{ color: levelColor[l.level] || '#ddd' }}>
                  [{fmtTime(l.time)}] {l.message}
                </div>
              ))}
        </div>
      </Card>

      {/* 多目录选择 */}
      <Modal
        title="选择目标目录"
        open={choiceModal.open}
        width={760}
        okText="确认并继续"
        cancelText="取消流程"
        onOk={() => closeChoiceModal(choiceValues)}
        onCancel={() => closeChoiceModal(null)}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="以下分类在对应目标路径内命中了多个目录，请分别选择本次要复制到哪个目录"
        />
        {/* 按目标路径分组展示，各目标路径的选择互不影响 */}
        {[...new Set(choiceModal.groups.map(g => g.root))].map(root => (
          <div key={root} style={{ marginBottom: 18 }}>
            <div style={{ marginBottom: 8 }}>
              <Tag color="blue">目标路径：{root}</Tag>
            </div>
            {choiceModal.groups.filter(g => g.root === root).map(g => (
              <div key={choiceKey(g.root, g.key)} style={{ marginBottom: 14, paddingLeft: 12 }}>
                <div style={{ marginBottom: 6 }}>
                  <Tag color="orange">{g.display}</Tag>
                  <span style={{ color: '#999', fontSize: 12 }}>{g.fileCount} 张图：{g.fileNames.join('、')}</span>
                </div>
                <Select
                  style={{ width: '100%' }}
                  value={choiceValues[choiceKey(g.root, g.key)]}
                  onChange={v => setChoiceValues(prev => ({ ...prev, [choiceKey(g.root, g.key)]: v }))}
                  options={(g.candidates || []).map(c => ({
                    value: c.dir,
                    label: `${c.dir}（已有 ${c.sampleCount} 张同类图）`,
                  }))}
                />
              </div>
            ))}
          </div>
        ))}
      </Modal>

      {/* 覆盖确认 */}
      <Modal
        title="目标目录已存在同名文件"
        open={conflictModal.open}
        width={860}
        okText="按选择执行"
        cancelText="取消流程"
        onOk={() => closeConflictModal(conflictDecisions)}
        onCancel={() => closeConflictModal(null)}
      >
        <Space style={{ marginBottom: 12 }}>
          <Button size="small" onClick={() => {
            const next: Record<string, boolean> = {}
            conflictModal.conflicts.forEach(c => { next[c.destPath] = true })
            setConflictDecisions(next)
          }}>全部覆盖</Button>
          <Button size="small" onClick={() => {
            const next: Record<string, boolean> = {}
            conflictModal.conflicts.forEach(c => { next[c.destPath] = false })
            setConflictDecisions(next)
          }}>全部跳过</Button>
          <span style={{ color: '#999', fontSize: 12 }}>可在「选项 → 覆盖前询问」中关闭本弹窗</span>
        </Space>
        <Table
          size="small"
          rowKey="destPath"
          dataSource={conflictModal.conflicts}
          pagination={{ pageSize: 8, showTotal: t => `共 ${t} 个冲突` }}
          columns={[
            { title: '文件名', dataIndex: 'name', key: 'name', width: 180 },
            {
              title: '目标路径', dataIndex: 'root', key: 'root', width: 150, ellipsis: true,
              render: (v: string) => <Tooltip title={v}><Tag color="blue">{v.split(/[\\/]/).pop() || v}</Tag></Tooltip>,
            },
            { title: '分类', dataIndex: 'display', key: 'display', width: 150, render: (v: string) => <Tag>{v}</Tag> },
            {
              title: '已存在文件', dataIndex: 'destPath', key: 'destPath', ellipsis: true,
              render: (v: string, r: ImageConflict) => (
                <Tooltip title={v}>
                  <span style={{ fontSize: 12, color: '#999' }}>
                    {v}（{fmtSize(r.existSize)}，{r.existTime ? new Date(r.existTime).toLocaleString('zh-CN') : '-'}）
                  </span>
                </Tooltip>
              ),
            },
            {
              title: '操作', key: 'action', width: 150,
              render: (_: unknown, r: ImageConflict) => (
                <Radio.Group
                  size="small"
                  value={conflictDecisions[r.destPath] ? 'overwrite' : 'skip'}
                  onChange={e => setConflictDecisions(prev => ({ ...prev, [r.destPath]: e.target.value === 'overwrite' }))}
                >
                  <Radio.Button value="overwrite">覆盖</Radio.Button>
                  <Radio.Button value="skip">跳过</Radio.Button>
                </Radio.Group>
              ),
            },
          ]}
        />
      </Modal>
    </div>
  )
}
