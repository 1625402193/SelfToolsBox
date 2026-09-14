import { useEffect, useRef, useState } from 'react'
import {
  Card, Button, Input, Switch, Table, Tag, Space, message, Modal, Alert,
  InputNumber, Radio, Tooltip, Empty, Select, Divider, Checkbox,
} from 'antd'
import {
  FolderOpenOutlined, PlusOutlined, MinusCircleOutlined, ReloadOutlined,
  ScanOutlined, PlayCircleOutlined, DeleteOutlined, FolderOutlined,
  DatabaseOutlined, ExportOutlined, LockOutlined, WarningOutlined,
} from '@ant-design/icons'
import type {
  ImageIndexData, ImageScanData, ImageScanFile, ImageDirStat,
  ImageCopyPlan, ImageConflict, ImageCopyLogEntry, ImagePlanGroup,
} from '../types'

const api = window.electronAPI

const DEFAULT_ODD_FOLDER = '尺寸异常'
const DEFAULT_UNMATCHED_FOLDER = '未匹配'
const CONFIG_KEY = 'imageCopy'

// 多目录选择的复合键：目标路径 + 匹配键，与主进程 choiceKey 保持一致
const choiceKey = (root: string, key: string) => `${root}||${key}`

// 匹配方式的中文标签与配色，与主进程 VIA_LABEL 保持一致
const VIA_LABEL: Record<string, string> = {
  exact: '同名匹配', suffix: '后缀词匹配', prefix: '前缀匹配', size: '尺寸匹配', none: '未匹配',
}
const VIA_COLOR: Record<string, string> = {
  exact: 'green', suffix: 'geekblue', prefix: 'blue', size: 'purple', none: 'red',
}

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
  const [recursive, setRecursive] = useState(true)
  const [autoRebuildIndex, setAutoRebuildIndex] = useState(true)
  const [askOverwrite, setAskOverwrite] = useState(true)
  // 多级匹配开关（优先级：同名 → 后缀词 → 前缀回退 → 尺寸）
  const [enableExactName, setEnableExactName] = useState(true)
  const [enableSuffixMatch, setEnableSuffixMatch] = useState(true)
  const [enablePrefixMatch, setEnablePrefixMatch] = useState(true)
  const [enableSizeFallback, setEnableSizeFallback] = useState(true)
  // 分辨率消歧后仍有多个候选时，是否自动取命中数量最多的目录
  const [preferMostFiles, setPreferMostFiles] = useState(true)
  // 后缀分类词与前缀回退的最短分段数
  const [suffixWordsText, setSuffixWordsText] = useState('Fang,Yuan')
  const [minSegments, setMinSegments] = useState(1)
  // 同名且内容一致（大小 + MD5）时自动跳过，不询问
  const [skipSameContent, setSkipSameContent] = useState(true)
  // 尺寸非 2 的倍数时的处理方式：ask 逐张询问 / include 全部复制 / exclude 全部不复制
  const [oddSizePolicy, setOddSizePolicy] = useState<'ask' | 'include' | 'exclude'>('ask')
  // 是否把尺寸异常图额外复制一份到「尺寸异常」文件夹备查
  const [copyOddSizeToFolder, setCopyOddSizeToFolder] = useState(true)
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

  // 尺寸异常图的逐张选择弹窗：勾选表示复制，取消勾选表示不复制。
  // viewOnly 为 true 时是「查看」模式（不参与流程，关闭即可，不影响后续执行）
  const [oddSizeModal, setOddSizeModal] = useState<{ open: boolean; items: ImageScanData['oddSized']; viewOnly: boolean }>(
    { open: false, items: [], viewOnly: false }
  )
  const [oddSizeChecked, setOddSizeChecked] = useState<Record<string, boolean>>({})
  const oddSizeResolver = useRef<((v: string[] | null) => void) | null>(null)

  // 后缀词文本 → 数组（逗号分隔，去空）
  const suffixWords = suffixWordsText.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)

  // 建索引与扫描共用的选项
  const options = () => ({
    recursive, oddSizeFolderName, unmatchedFolderName, copyOddSizeToFolder,
    suffixWords, minSegments,
  })

  // 匹配阶段的选项
  const matchOptions = () => ({
    enableExactName, enableSuffixMatch, enablePrefixMatch, enableSizeFallback,
    preferMostFiles, suffixWords, minSegments,
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
          if (typeof saved.recursive === 'boolean') setRecursive(saved.recursive)
          if (typeof saved.autoRebuildIndex === 'boolean') setAutoRebuildIndex(saved.autoRebuildIndex)
          if (typeof saved.askOverwrite === 'boolean') setAskOverwrite(saved.askOverwrite)
          if (typeof saved.enableExactName === 'boolean') setEnableExactName(saved.enableExactName)
          if (typeof saved.enableSuffixMatch === 'boolean') setEnableSuffixMatch(saved.enableSuffixMatch)
          if (typeof saved.enablePrefixMatch === 'boolean') setEnablePrefixMatch(saved.enablePrefixMatch)
          if (typeof saved.enableSizeFallback === 'boolean') setEnableSizeFallback(saved.enableSizeFallback)
          if (typeof saved.preferMostFiles === 'boolean') setPreferMostFiles(saved.preferMostFiles)
          if (typeof saved.skipSameContent === 'boolean') setSkipSameContent(saved.skipSameContent)
          if (typeof saved.suffixWordsText === 'string') setSuffixWordsText(saved.suffixWordsText)
          if (typeof saved.minSegments === 'number') setMinSegments(saved.minSegments)
          if (saved.oddSizePolicy === 'ask' || saved.oddSizePolicy === 'include' || saved.oddSizePolicy === 'exclude') {
            setOddSizePolicy(saved.oddSizePolicy)
          }
          if (typeof saved.copyOddSizeToFolder === 'boolean') setCopyOddSizeToFolder(saved.copyOddSizeToFolder)
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
            sourcePaths, targetPaths, recursive,
            autoRebuildIndex, askOverwrite,
            enableExactName, enableSuffixMatch, enablePrefixMatch, enableSizeFallback,
            preferMostFiles, skipSameContent, suffixWordsText, minSegments,
            oddSizePolicy, copyOddSizeToFolder,
            oddSizeFolderName, unmatchedFolderName,
          },
        })
      } catch {}
    }, 600)
    return () => clearTimeout(timer)
  }, [sourcePaths, targetPaths, recursive, autoRebuildIndex, askOverwrite,
      enableExactName, enableSuffixMatch, enablePrefixMatch, enableSizeFallback,
      preferMostFiles, skipSameContent, suffixWordsText, minSegments,
      oddSizePolicy, copyOddSizeToFolder, oddSizeFolderName, unmatchedFolderName])

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
        message: `索引已更新：${r.root} → ${r.stats.imageCount} 张图，分布在 ${r.stats.dirCount} 个目录`
          + `；查询表：同名 ${r.stats.nameKeyCount ?? 0} / 前缀 ${r.stats.prefixKeyCount ?? 0}`
          + ` / 后缀词 ${r.stats.suffixKeyCount ?? 0} / 尺寸 ${r.stats.sizeKeyCount ?? 0}`,
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

    // 尺寸异常图已另存备查时，提供打开入口（不再意味着这些图被排除）
    if (res.data.oddSizeFolder) {
      addCreatedFolder('尺寸异常图片', res.data.oddSizeFolder)
      pushLogs({
        action: 'oddSize', level: 'warn',
        message: `${res.data.oddSized.length} 张尺寸非 2 的倍数的图片已另存一份到：${res.data.oddSizeFolder}（是否复制到目标路径仍由你决定）`,
      })
    }
    if (!silent) message.success(`扫描完成，待处理 ${res.data.pending} 张图`)
    return res.data
  }

  // ---------- 尺寸异常图：让用户逐张选择是否复制 ----------
  const askOddSize = (items: ImageScanData['oddSized']) =>
    new Promise<string[] | null>(resolve => {
      const defaults: Record<string, boolean> = {}
      items.forEach(it => { defaults[it.path] = false }) // 默认不复制，需要时由用户勾选
      setOddSizeChecked(defaults)
      setOddSizeModal({ open: true, items, viewOnly: false })
      oddSizeResolver.current = resolve
    })

  // 仅查看尺寸异常图清单，不参与流程
  const viewOddSize = (items: ImageScanData['oddSized']) => {
    const defaults: Record<string, boolean> = {}
    items.forEach(it => { defaults[it.path] = false })
    setOddSizeChecked(defaults)
    setOddSizeModal({ open: true, items, viewOnly: true })
  }

  // 返回值是「排除的路径列表」
  const closeOddSizeModal = (excluded: string[] | null) => {
    setOddSizeModal({ open: false, items: [], viewOnly: false })
    oddSizeResolver.current?.(excluded)
    oddSizeResolver.current = null
  }

  // ---------- 步骤 4：生成匹配计划（逐张多级匹配：同名 → 后缀词 → 前缀回退 → 尺寸） ----------
  const makePlan = async (excludePaths: string[] = []): Promise<ImageCopyPlan | null> => {
    const res = await api.imageCopyMakePlan({ excludePaths, ...matchOptions() })
    if (!res.success || !res.data) {
      logAction({ action: 'makePlan', level: 'error', message: `匹配失败：${res.error || '未知错误'}` })
      message.error(res.error || '匹配失败')
      return null
    }
    setPlan(res.data)
    for (const rp of res.data.roots) {
      const viaParts = Object.entries(rp.viaCount || {})
        .filter(([, n]) => (n ?? 0) > 0)
        .map(([v, n]) => `${VIA_LABEL[v] || v} ${n} 张`)
      pushLogs({
        action: 'makePlan', level: 'info',
        message: `匹配结果（${rp.root}）：已确定 ${rp.direct.reduce((s, g) => s + g.fileCount, 0)} 张，`
          + `需人工选择 ${rp.ambiguous.reduce((s, g) => s + g.fileCount, 0)} 张，`
          + `未匹配 ${rp.unmatched.reduce((s, g) => s + g.fileCount, 0)} 张`
          + (viaParts.length ? `；${viaParts.join('、')}` : '')
          + ((rp.autoResolvedCount ?? 0) > 0 ? `；${rp.autoResolvedCount} 张由分辨率自动消歧` : ''),
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

      // 3. 尺寸非 2 的倍数的图片：按策略决定是否复制（不再强制剔除）
      let excludePaths: string[] = []
      if (scan.oddSized.length > 0) {
        if (oddSizePolicy === 'include') {
          pushLogs({
            action: 'oddSize', level: 'warn',
            message: `${scan.oddSized.length} 张尺寸非 2 的倍数的图片按设置全部复制`,
          })
        } else if (oddSizePolicy === 'exclude') {
          excludePaths = scan.oddSized.map(f => f.path)
          pushLogs({
            action: 'oddSize', level: 'warn',
            message: `${scan.oddSized.length} 张尺寸非 2 的倍数的图片按设置全部不复制`,
          })
        } else {
          const excluded = await askOddSize(scan.oddSized)
          if (!excluded) {
            message.info('已取消')
            logAction({ action: 'flow', level: 'warn', message: '用户取消了尺寸异常图片的选择，流程中止' })
            return
          }
          excludePaths = excluded
          const keep = scan.oddSized.length - excluded.length
          logAction({
            action: 'oddSize', level: 'warn',
            message: `尺寸异常图片用户选择：复制 ${keep} 张，不复制 ${excluded.length} 张`,
          })
        }
      }

      // 4. 匹配（每个目标路径各自一份计划）
      const p = await makePlan(excludePaths)
      if (!p) return

      // 5. 多目录键需要用户选择（按目标路径分别询问）
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
              message: `目标路径 ${g.root} 中，${g.display} 选择目录：${dir}`,
            })
          }
        })
      }

      // 6. 冲突确认（内容相同的会自动跳过，不计入冲突）
      let overwriteMode: 'overwrite' | 'decide' = 'overwrite'
      let decisions: Record<string, boolean> = {}
      if (askOverwrite) {
        const conflictRes = await api.imageCopyCheckConflicts({ choices, unmatchedFolderName, skipSameContent })
        if (conflictRes.success && conflictRes.data) {
          if ((conflictRes.data.sameContentCount ?? 0) > 0) {
            pushLogs({
              action: 'checkConflicts', level: 'info',
              message: `${conflictRes.data.sameContentCount} 张图与目标内容完全一致，将自动跳过（不再询问）`,
            })
          }
          if (conflictRes.data.conflicts.length > 0) {
            const decided = await askConflicts(conflictRes.data.conflicts)
            if (!decided) {
              message.info('已取消')
              logAction({ action: 'flow', level: 'warn', message: '用户取消了覆盖确认，流程中止' })
              return
            }
            overwriteMode = 'decide'
            decisions = decided
          }
        }
      } else {
        pushLogs({ action: 'flow', level: 'info', message: '覆盖询问已关闭，同名文件将直接覆盖' })
      }

      // 7. 执行
      const res = await api.imageCopyExecute({ choices, overwriteMode, decisions, unmatchedFolderName, skipSameContent })
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

      const { copied, overwritten, skipped, failed, sameContent } = res.data
      message.success(
        `复制完成：新增 ${copied}，替换 ${overwritten}`
        + ((sameContent ?? 0) > 0 ? `，内容相同跳过 ${sameContent}` : '')
        + `，跳过 ${skipped}，失败 ${failed}`
      )

      if (unmatchedDirs.length > 0) {
        Modal.warning({
          title: '存在未匹配任何分类的图片',
          content: (
            <div>
              <p>
                以下图片{enableSizeFallback ? '按名称和尺寸都没能匹配上' : '按名称没能匹配上'}，
                已按目标路径分别复制到：
              </p>
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

  // 导出日志前提示：日志正文含完整的本地/项目路径，属于个人信息，不应随意外发
  const exportLogs = () => {
    Modal.confirm({
      title: '导出的日志包含完整文件路径',
      content: (
        <div>
          <p>日志中会记录源路径、目标路径等完整的本地磁盘路径与项目目录结构。</p>
          <p style={{ color: '#fa8c16', marginBottom: 0 }}>
            这些信息仅供本机排查使用，请勿上传到公开仓库或分享给他人。
          </p>
        </div>
      ),
      okText: '我知道了，继续导出',
      cancelText: '取消',
      onOk: async () => {
        const content = logs.slice().reverse()
          .map(l => `[${l.time ? new Date(l.time).toLocaleString('zh-CN') : ''}] [${l.level}] ${l.message}`)
          .join('\r\n')
        const res = await api.exportJson({ defaultFileName: `批量复制图片日志_${Date.now()}.txt`, content })
        if (res.success && !res.canceled) message.success('日志已导出')
      },
    })
  }

  const visibleLogs = logFilter === 'all' ? logs : logs.filter(l => l.level === logFilter)

  // ---------- 表格列 ----------
  // 目标索引：按目录维度展示（每个目录多少图、都是什么分辨率）
  const dirStatColumns = [
    {
      title: '子目录', dataIndex: 'relativeDir', key: 'relativeDir', width: 280, ellipsis: true,
      render: (v: string, r: ImageDirStat) => (
        <Tooltip title={r.dir}>
          <a onClick={() => api.openPath(r.dir)}>{v}</a>
        </Tooltip>
      ),
    },
    {
      title: '图片数', dataIndex: 'fileCount', key: 'fileCount', width: 90,
      sorter: (a: ImageDirStat, b: ImageDirStat) => a.fileCount - b.fileCount,
    },
    {
      title: '分辨率分布', dataIndex: 'resolutions', key: 'resolutions',
      render: (list: ImageDirStat['resolutions']) => (
        <Space wrap size={4}>
          {list.length === 0
            ? <span style={{ color: '#bbb', fontSize: 12 }}>-</span>
            : list.map(r => <Tag key={r.res} color="purple">{r.res} × {r.count}</Tag>)}
        </Space>
      ),
    },
  ]

  // 源路径扫描结果：平铺展示每张待处理图片
  const scanColumns = [
    { title: '文件名', dataIndex: 'name', key: 'name', width: 300, ellipsis: true },
    {
      title: '尺寸', key: 'size', width: 140,
      render: (_: unknown, f: ImageScanFile) => (
        f.sizeUnknown
          ? <span style={{ color: '#fa8c16', fontSize: 12 }}>尺寸未知</span>
          : (
            <span style={{ color: f.oddSized ? '#fa8c16' : '#666', fontSize: 12 }}>
              {f.width}×{f.height}{f.oddSized && ' 非2倍数'}
            </span>
          )
      ),
    },
    {
      title: '来源路径', dataIndex: 'path', key: 'path', ellipsis: true,
      render: (v: string) => <Tooltip title={v}><span style={{ fontSize: 12, color: '#999' }}>{v}</span></Tooltip>,
    },
  ]

  return (
    <div>
      <div className="page-title">批量复制图片</div>

      <Card size="small" className="section-card" title="源路径（待复制的图片来源）">
        <PathList label="源路径" paths={sourcePaths} onChange={setSourcePaths} />
      </Card>

      <Card size="small" className="section-card" title="目标路径（建立索引的位置）">
        <PathList label="目标路径" paths={targetPaths} onChange={setTargetPaths} />
      </Card>

      <Card size="small" className="section-card" title="选项">
        <Space size="large" wrap>
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
          <Space>
            <Tooltip title="目标已有同名文件且内容完全一致（大小 + MD5 相同）时直接跳过，不复制也不询问">
              <span>内容相同自动跳过：</span>
            </Tooltip>
            <Switch checked={skipSameContent} onChange={setSkipSameContent} />
          </Space>
        </Space>
      </Card>

      <Card
        size="small"
        className="section-card"
        title="匹配规则（按优先级逐级回退，命中即停）"
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Space size="large" wrap>
            <Space>
              <Tag color="green">1</Tag>
              <Tooltip title="目标路径中已存在同名文件时，直接定位到该文件所在目录（替换场景）">
                <span>同名精确匹配：</span>
              </Tooltip>
              <Switch checked={enableExactName} onChange={setEnableExactName} />
            </Space>
            <Space>
              <Tag color="geekblue">2</Tag>
              <Tooltip title="文件名以后缀词结尾时（如 _Fang / _Yuan），优先定位到「同前缀且同后缀」的资源所在目录，避免 Fang 与 Yuan 混淆">
                <span>后缀词匹配：</span>
              </Tooltip>
              <Switch checked={enableSuffixMatch} onChange={setEnableSuffixMatch} />
            </Space>
            <Space>
              <Tag color="blue">3</Tag>
              <Tooltip title="按 _ 分段，从最长前缀逐级缩短，命中第一个存在已有资源的前缀（最精确的那一级）">
                <span>前缀逐级回退：</span>
              </Tooltip>
              <Switch checked={enablePrefixMatch} onChange={setEnablePrefixMatch} />
            </Space>
            <Space>
              <Tag color="purple">4</Tag>
              <Tooltip title="以上都没命中时，用「尺寸 → 目录」索引兜底。读不出尺寸的图片不参与">
                <span>尺寸兜底匹配：</span>
              </Tooltip>
              <Switch checked={enableSizeFallback} onChange={setEnableSizeFallback} />
            </Space>
          </Space>
          <Space size="large" wrap>
            <Space>
              <Tooltip title="命中多个候选目录时，先用源图分辨率消歧（只保留含同分辨率资源的目录）。仍无法唯一确定时，开启本项会自动取命中数量最多的目录，关闭则弹窗让你选择">
                <span>多目录时按数量自动决定：</span>
              </Tooltip>
              <Switch checked={preferMostFiles} onChange={setPreferMostFiles} />
            </Space>
            <Space>
              <Tooltip title="后缀分类词，逗号分隔，大小写不敏感。清空可禁用后缀词匹配">
                <span>后缀词：</span>
              </Tooltip>
              <Input
                value={suffixWordsText}
                onChange={e => setSuffixWordsText(e.target.value)}
                placeholder="Fang,Yuan"
                style={{ width: 160 }}
              />
            </Space>
            <Space>
              <Tooltip title="前缀逐级回退时允许的最短分段数。设为 1 表示允许退到单段前缀（如 Icon）">
                <span>最短前缀分段：</span>
              </Tooltip>
              <InputNumber min={1} max={6} value={minSegments} onChange={v => setMinSegments(Number(v) || 1)} style={{ width: 70 }} />
              <span style={{ color: '#999', fontSize: 12 }}>段</span>
            </Space>
          </Space>
          <div style={{ fontSize: 12, color: '#999' }}>
            命中多个候选目录时一律先用源图分辨率消歧，无法确定才询问你；全部规则都没命中的图片才放进「未匹配」文件夹。
          </div>
        </Space>
      </Card>

      <Card size="small" className="section-card" title="尺寸校验">
        <Space size="large" wrap>
          <Space>
            <Tooltip title="宽高非 2 的倍数的图片不会被强制剔除，由你决定是否复制到目标路径">
              <span>尺寸非 2 的倍数时：</span>
            </Tooltip>
            <Radio.Group
              size="small"
              value={oddSizePolicy}
              onChange={e => setOddSizePolicy(e.target.value)}
              optionType="button"
              buttonStyle="solid"
            >
              <Radio.Button value="ask">逐张询问</Radio.Button>
              <Radio.Button value="include">全部复制</Radio.Button>
              <Radio.Button value="exclude">全部不复制</Radio.Button>
            </Radio.Group>
          </Space>
          <Space>
            <Tooltip title="开启后，尺寸非 2 的倍数的图片会额外复制一份到「尺寸异常」文件夹，便于集中查看或修图。与是否复制到目标路径互不影响">
              <span>尺寸异常图另存备查：</span>
            </Tooltip>
            <Switch checked={copyOddSizeToFolder} onChange={setCopyOddSizeToFolder} />
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
          {scanData && scanData.oddSized.length > 0 && (
            <Button icon={<WarningOutlined />} onClick={() => viewOddSize(scanData.oddSized)}>
              查看尺寸异常图（{scanData.oddSized.length}）
            </Button>
          )}
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
          message={<span>目标索引（{indexData.roots.length} 个目标路径，各自独立）</span>}          description={
            <div>
              {indexData.roots.map(r => (
                <div key={r.root} style={{ fontSize: 12, marginBottom: 4 }}>
                  <Tag color="blue">{r.root}</Tag>
                  {r.stats.imageCount} 张图
                  <span style={{ color: '#666', marginLeft: 6 }}>
                    查询表：同名 {r.stats.nameKeyCount ?? 0} / 前缀 {r.stats.prefixKeyCount ?? 0}
                    {' / '}后缀词 {r.stats.suffixKeyCount ?? 0} / 尺寸 {r.stats.sizeKeyCount ?? 0}
                  </span>
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
              <span style={{ color: scanData.oddSized.length ? '#fa8c16' : undefined }}>
                尺寸非 2 的倍数 {scanData.oddSized.length} 张
                {scanData.oddSized.length > 0 && (
                  <span style={{ color: '#999' }}>
                    （{oddSizePolicy === 'ask' ? '执行时逐张询问' : oddSizePolicy === 'include' ? '按设置全部复制' : '按设置全部不复制'}）
                  </span>
                )}
              </span>
              {scanData.unknownSize.length > 0 && <span style={{ color: '#fa8c16' }}>尺寸未知 {scanData.unknownSize.length} 张</span>}
            </Space>
          }
        />
      )}

      {plan && (plan.excludedCount ?? 0) > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`已按你的选择排除 ${plan.excludedCount} 张图片，不复制到任何目标路径`}
        />
      )}

      {plan && (
        <Card size="small" className="section-card" title="匹配结果（按目标路径分别统计）">
          {plan.roots.map(rp => {
            const directFiles = rp.direct.reduce((s, g) => s + g.fileCount, 0)
            const ambiguousFiles = rp.ambiguous.reduce((s, g) => s + g.fileCount, 0)
            const unmatchedFiles = rp.unmatched.reduce((s, g) => s + g.fileCount, 0)
            return (
              <div key={rp.root} style={{ marginBottom: 16 }}>
                <div style={{ marginBottom: 6 }}><Tag color="blue">{rp.root}</Tag></div>
                <Space size="large" wrap>
                  <span>已确定：<Tag color="green">{directFiles}</Tag> 张</span>
                  <span>需人工选择：<Tag color="orange">{ambiguousFiles}</Tag> 张</span>
                  <span>未匹配：<Tag color="red">{unmatchedFiles}</Tag> 张</span>
                  {(rp.autoResolvedCount ?? 0) > 0 && (
                    <span style={{ color: '#999', fontSize: 12 }}>
                      （{rp.autoResolvedCount} 张由分辨率自动消歧）
                    </span>
                  )}
                </Space>
                {/* 各规则命中分布，直观看出主要靠哪一级规则 */}
                <div style={{ marginTop: 8 }}>
                  <Space wrap size={6}>
                    {(['exact', 'suffix', 'prefix', 'size'] as const).map(v =>
                      (rp.viaCount?.[v] ?? 0) > 0 ? (
                        <Tag key={v} color={VIA_COLOR[v]}>{VIA_LABEL[v]} {rp.viaCount![v]} 张</Tag>
                      ) : null
                    )}
                  </Space>
                </div>
                {unmatchedFiles > 0 && (
                  <div style={{ marginTop: 6, fontSize: 12, color: '#999' }}>
                    未匹配图片：{rp.unmatched.flatMap(g => g.fileNames).slice(0, 8).join('、')}
                    {unmatchedFiles > 8 && ` 等 ${unmatchedFiles} 张`}
                  </div>
                )}
              </div>
            )
          })}
        </Card>
      )}

      <Card
        size="small"
        className="section-card"
        title="源路径待处理图片"
        extra={scanData ? <span style={{ fontSize: 12, color: '#999' }}>{scanData.files.length} 张</span> : null}
      >
        {scanData
          ? <Table
              columns={scanColumns}
              dataSource={scanData.files}
              rowKey="path"
              size="small"
              pagination={{ pageSize: 10, showSizeChanger: true, showTotal: t => `共 ${t} 张图` }}
            />
          : <Empty description="尚未扫描源路径" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
      </Card>

      <Card
        size="small"
        className="section-card"
        title="目标路径目录分布"
        extra={indexData?.roots?.length
          ? <span style={{ fontSize: 12, color: '#999' }}>{indexData.roots.length} 个目标路径</span>
          : null}
      >
        {indexData?.roots?.length
          ? indexData.roots.map(r => (
              <div key={r.root} style={{ marginBottom: 20 }}>
                <div style={{ marginBottom: 6 }}>
                  <Tag color="blue">{r.root}</Tag>
                  <span style={{ fontSize: 12, color: '#999' }}>
                    {r.stats.imageCount} 张图分布在 {r.dirStats.length} 个目录
                  </span>
                </div>
                <Table
                  columns={dirStatColumns}
                  dataSource={r.dirStats}
                  rowKey="dir"
                  size="small"
                  pagination={{ pageSize: 10, showSizeChanger: true, showTotal: t => `共 ${t} 个目录` }}
                />
              </div>
            ))
          : <Empty description="尚未建立目标索引" image={Empty.PRESENTED_IMAGE_SIMPLE} />}

        {/* 明示数据落地位置，便于确认这些路径信息不会随项目外泄 */}
        {indexData?.indexDir && (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #f0f0f0', fontSize: 12, color: '#999' }}>
            <LockOutlined style={{ marginRight: 4 }} />
            索引与操作日志仅保存在本机用户目录，不随项目上传：
            <Tooltip title="点击打开该目录">
              <a onClick={() => api.openPath(indexData.indexDir)} style={{ marginLeft: 4 }}>
                {indexData.indexDir}
              </a>
            </Tooltip>
          </div>
        )}
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

      {/* 尺寸非 2 的倍数的图片：逐张选择是否复制（viewOnly 时仅查看清单） */}
      <Modal
        title={oddSizeModal.viewOnly ? '尺寸不是 2 的倍数的图片' : '有图片尺寸不是 2 的倍数'}
        open={oddSizeModal.open}
        width={780}
        okText={oddSizeModal.viewOnly ? '关闭' : '按选择继续'}
        cancelText="取消流程"
        cancelButtonProps={{ style: oddSizeModal.viewOnly ? { display: 'none' } : undefined }}
        onOk={() => oddSizeModal.viewOnly
          ? setOddSizeModal({ open: false, items: [], viewOnly: false })
          : closeOddSizeModal(oddSizeModal.items.filter(it => !oddSizeChecked[it.path]).map(it => it.path))}
        onCancel={() => oddSizeModal.viewOnly
          ? setOddSizeModal({ open: false, items: [], viewOnly: false })
          : closeOddSizeModal(null)}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={oddSizeModal.viewOnly
            ? '这些图片宽高不是 2 的倍数，不会被自动剔除；是否复制到目标路径将在执行时按你的设置决定。'
            : '勾选表示该图仍复制到目标路径，不勾选则跳过。默认全部不勾选。'}
          description={
            <span style={{ fontSize: 12 }}>
              可在「选项 → 尺寸非 2 的倍数时」切换为「逐张询问」「全部复制」或「全部不复制」。
            </span>
          }
        />
        {!oddSizeModal.viewOnly && (
          <Space style={{ marginBottom: 12 }}>
            <Button size="small" onClick={() => {
              const next: Record<string, boolean> = {}
              oddSizeModal.items.forEach(it => { next[it.path] = true })
              setOddSizeChecked(next)
            }}>全选（都复制）</Button>
            <Button size="small" onClick={() => {
              const next: Record<string, boolean> = {}
              oddSizeModal.items.forEach(it => { next[it.path] = false })
              setOddSizeChecked(next)
            }}>全不选（都跳过）</Button>
            <span style={{ color: '#999', fontSize: 12 }}>
              已选 {oddSizeModal.items.filter(it => oddSizeChecked[it.path]).length} / {oddSizeModal.items.length} 张
            </span>
          </Space>
        )}
        <Table
          size="small"
          rowKey="path"
          dataSource={oddSizeModal.items}
          pagination={{ pageSize: 8, showTotal: t => `共 ${t} 张` }}
          columns={[
            // 查看模式下不显示勾选列
            ...(oddSizeModal.viewOnly ? [] : [{
              title: '复制', key: 'check', width: 60,
              render: (_: unknown, r: ImageScanData['oddSized'][0]) => (
                <Checkbox
                  checked={!!oddSizeChecked[r.path]}
                  onChange={e => setOddSizeChecked(prev => ({ ...prev, [r.path]: e.target.checked }))}
                />
              ),
            }]),
            { title: '文件名', dataIndex: 'name', key: 'name', width: 220 },
            {
              title: '尺寸', key: 'size', width: 120,
              render: (_: unknown, r) => (
                <span style={{ color: '#fa8c16' }}>{r.width}×{r.height}</span>
              ),
            },
            {
              title: '分类', dataIndex: 'display', key: 'display', width: 150,
              render: (v?: string) => v ? <Tag>{v}</Tag> : '-',
            },
            {
              title: '源路径', dataIndex: 'path', key: 'path', ellipsis: true,
              render: (v: string) => <Tooltip title={v}><span style={{ fontSize: 12, color: '#999' }}>{v}</span></Tooltip>,
            },
          ]}
        />
      </Modal>

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
          message="以下条目命中了多个候选目录，且用源图分辨率也无法唯一确定，请分别选择"
          description={
            <span style={{ fontSize: 12 }}>
              选项中标注了各候选目录已有资源的分辨率，可据此判断该放哪个目录（如头像类常按分辨率区分 TouXiang / TouXiangLOD2）。
            </span>
          }
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
                  <Tag color={VIA_COLOR[g.via || 'none']}>{VIA_LABEL[g.via || 'none']}</Tag>
                  <span style={{ fontSize: 12, color: '#666', marginRight: 8 }}>{g.display}</span>
                  <span style={{ color: '#999', fontSize: 12 }}>{g.fileCount} 张图：{g.fileNames.slice(0, 6).join('、')}{g.fileCount > 6 ? ' …' : ''}</span>
                </div>
                <Select
                  style={{ width: '100%' }}
                  value={choiceValues[choiceKey(g.root, g.key)]}
                  onChange={v => setChoiceValues(prev => ({ ...prev, [choiceKey(g.root, g.key)]: v }))}
                  options={(g.candidates || []).map(c => ({
                    value: c.dir,
                    label: `${c.dir}（已有 ${c.sampleCount} 张${c.resolutions?.length ? `，分辨率 ${c.resolutions.join(' / ')}` : ''}）`,
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
          <span style={{ color: '#999', fontSize: 12 }}>
            {skipSameContent ? '内容完全相同的已自动跳过，此处仅列出内容不同的。' : ''}
            可在「选项 → 覆盖前询问」中关闭本弹窗
          </span>
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
            {
              title: '匹配方式', dataIndex: 'via', key: 'via', width: 110,
              render: (v?: string) => <Tag color={VIA_COLOR[v || 'none']}>{VIA_LABEL[v || 'none']}</Tag>,
            },
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
