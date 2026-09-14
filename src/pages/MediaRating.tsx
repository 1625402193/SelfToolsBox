import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Card, Button, Input, Switch, Space, message, Rate, Radio, Checkbox, Tag, Empty,
  Modal, Tooltip, Progress, Divider, Popconfirm,
} from 'antd'
import {
  FolderOpenOutlined, ScanOutlined, LeftOutlined, RightOutlined,
  CopyOutlined, ScissorOutlined, DeleteOutlined, ReloadOutlined,
  PictureOutlined, VideoCameraOutlined, PlayCircleOutlined, WarningOutlined,
} from '@ant-design/icons'
import type { MediaItem, MediaSiblingFile } from '../types'

const api = window.electronAPI

// 左侧缩略图列表采用固定行高做虚拟滚动，避免大文件夹（几千张图）时一次性挂载
// 成千上万个 <img>，导致内存暴涨甚至应用崩溃。只渲染视口附近的行。
const ROW_HEIGHT = 66
const OVERSCAN = 8

function formatSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
}

// 把绝对路径转换为 local-media:// URL
// 用 host=m + 路径整体作 encodeURIComponent，避免中文/空格/盘符冒号被错误解析
function toMediaUrl(absPath: string) {
  const norm = absPath.replace(/\\/g, '/')
  return 'local-media://m/' + encodeURIComponent(norm)
}

// 取文件所在目录（不依赖 node path，纯字符串处理，与"定位"按钮的写法保持一致）
function dirOf(absPath: string) {
  return absPath.replace(/[\\/][^\\/]+$/, '')
}

// 取文件的基础名（去掉扩展名）
function baseNameOf(name: string, extension: string) {
  return extension && name.toLowerCase().endsWith(extension.toLowerCase())
    ? name.slice(0, name.length - extension.length)
    : name
}

function siblingKey(dir: string, baseName: string) {
  return `${dir}||${baseName.toLowerCase()}`
}

function ratingLabelOf(ratings: Record<string, number>, relativePath: string) {
  const r = ratings[relativePath]
  return r ? `${r}星` : '未评分'
}

const RATING_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'unrated', label: '未评分' },
  { value: '1', label: '1星' },
  { value: '2', label: '2星' },
  { value: '3', label: '3星' },
  { value: '4', label: '4星' },
  { value: '5', label: '5星' },
]

const RATING_OPTIONS = [
  { value: '5', label: '5星' },
  { value: '4', label: '4星' },
  { value: '3', label: '3星' },
  { value: '2', label: '2星' },
  { value: '1', label: '1星' },
  { value: 'unrated', label: '未评分' },
]

type SiblingChoice = 'both' | 'previewOnly' | null

interface SiblingModalState {
  open: boolean
  mode: 'export' | 'delete'
  baseCount: number
  extras: MediaSiblingFile[]
}

export default function MediaRating() {
  const [sourcePath, setSourcePath] = useState('')
  const [targetPath, setTargetPath] = useState('')
  const [includeSubfolders, setIncludeSubfolders] = useState(false)
  const [files, setFiles] = useState<MediaItem[]>([])
  const [ratings, setRatings] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(false)

  // 预览类型筛选：先探测各扩展名的文件数量，用户确认要预览哪些类型后才真正扫描加载，
  // 未选中的类型完全不会进入预览（不 stat、不渲染、不生成缩略图）
  const [availableExts, setAvailableExts] = useState<{ ext: string; count: number }[]>([])
  const [selectedExts, setSelectedExts] = useState<string[]>([])
  const [probing, setProbing] = useState(false)

  const [filter, setFilter] = useState<string>('all')
  const [currentIdx, setCurrentIdx] = useState(0)

  // 导出配置
  const [exportRatings, setExportRatings] = useState<string[]>(['5'])
  const [isCopyMode, setIsCopyMode] = useState(true)
  const [groupByRating, setGroupByRating] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState(0)

  // 按评分删除配置
  const [deleteRatings, setDeleteRatings] = useState<string[]>([])
  const [deleting, setDeleting] = useState(false)

  // 同名不同类型文件的确认弹窗（导出/删除共用）
  const [siblingModal, setSiblingModal] = useState<SiblingModalState | null>(null)
  const siblingResolver = useRef<((choice: SiblingChoice) => void) | null>(null)

  const saveTimerRef = useRef<number | null>(null)
  const previewWrapRef = useRef<HTMLDivElement>(null)

  // 虚拟滚动状态
  const listRef = useRef<HTMLDivElement>(null)
  const [listViewport, setListViewport] = useState({ scrollTop: 0, height: 480 })

  // 配置持久化（来源/目标路径）
  useEffect(() => {
    api.configRead?.().then(res => {
      if (res?.success && res.data?.mediaRating) {
        const cfg = res.data.mediaRating
        if (cfg.sourcePath) setSourcePath(cfg.sourcePath)
        if (cfg.targetPath) setTargetPath(cfg.targetPath)
        if (typeof cfg.includeSubfolders === 'boolean') setIncludeSubfolders(cfg.includeSubfolders)
        if (typeof cfg.isCopyMode === 'boolean') setIsCopyMode(cfg.isCopyMode)
        if (typeof cfg.groupByRating === 'boolean') setGroupByRating(cfg.groupByRating)
      }
    })
  }, [])

  // 保存配置（防抖）
  useEffect(() => {
    const t = window.setTimeout(() => {
      api.configRead?.().then(res => {
        const data = res?.data || {}
        api.configWrite?.({
          ...data,
          mediaRating: { sourcePath, targetPath, includeSubfolders, isCopyMode, groupByRating },
        })
      })
    }, 500)
    return () => clearTimeout(t)
  }, [sourcePath, targetPath, includeSubfolders, isCopyMode, groupByRating])

  const browseFolder = async (type: 'source' | 'target') => {
    const dir = await api.openDirectory()
    if (dir) {
      if (type === 'source') setSourcePath(dir)
      else setTargetPath(dir)
    }
  }

  // 第一步：快速探测文件夹下有哪些类型、各多少个文件（不加载预览）
  const probeExtensions = async () => {
    if (!sourcePath) return message.warning('请选择源文件夹')
    setProbing(true)
    const res = await api.mediaScanExtensions(sourcePath, { includeSubfolders })
    setProbing(false)
    if (!res.success || !res.data) {
      message.error(res.error || '扫描失败')
      return
    }
    const list = Object.entries(res.data)
      .map(([ext, count]) => ({ ext, count }))
      .sort((a, b) => b.count - a.count)
    setAvailableExts(list)
    setSelectedExts(list.map(x => x.ext)) // 默认全选
    // 重置上一次的预览结果，等用户确认类型后再加载
    setFiles([])
    setRatings({})
    setCurrentIdx(0)
    setFilter('all')
    if (list.length === 0) {
      message.warning('该文件夹下没有可识别的图片/视频文件')
    } else {
      const total = list.reduce((s, x) => s + x.count, 0)
      message.success(`发现 ${total} 个媒体文件，共 ${list.length} 种类型，请选择要预览的类型`)
    }
  }

  // 第二步：按选中的类型真正加载预览
  const loadPreview = async () => {
    if (!sourcePath) return
    if (selectedExts.length === 0) return message.warning('请至少选择一种文件类型')
    setLoading(true)
    const [scanRes, ratingRes] = await Promise.all([
      api.mediaScan(sourcePath, { includeSubfolders, extensions: selectedExts }),
      api.mediaLoadRatings(sourcePath),
    ])
    setLoading(false)
    if (scanRes.success && scanRes.data) {
      setFiles(scanRes.data)
      setRatings(ratingRes.data || {})
      setCurrentIdx(0)
      setFilter('all')
      // 若用户尚未指定目标文件夹，默认使用源文件夹（在它下面建 5星/4星... 子目录）
      if (!targetPath) setTargetPath(sourcePath)
      message.success(`已加载 ${scanRes.data.length} 个媒体文件用于预览`)
    } else {
      message.error(scanRes.error || '加载失败')
    }
  }

  // 过滤后的文件列表
  const filteredFiles = useMemo(() => {
    if (filter === 'all') return files
    if (filter === 'unrated') return files.filter(f => !ratings[f.relativePath])
    const num = Number(filter)
    return files.filter(f => ratings[f.relativePath] === num)
  }, [files, ratings, filter])

  // 限制 currentIdx 在 filteredFiles 范围内
  useEffect(() => {
    if (currentIdx >= filteredFiles.length) {
      setCurrentIdx(filteredFiles.length === 0 ? 0 : filteredFiles.length - 1)
    }
  }, [filteredFiles, currentIdx])

  const currentFile = filteredFiles[currentIdx]
  const currentRating = currentFile ? (ratings[currentFile.relativePath] || 0) : 0

  // 修改评分（自动保存到 .media-ratings.json）
  const setRating = (file: MediaItem | undefined, value: number) => {
    if (!file) return
    setRatings(prev => {
      const next = { ...prev }
      if (value && value > 0) {
        next[file.relativePath] = value
      } else {
        delete next[file.relativePath]
      }
      // 防抖保存
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = window.setTimeout(() => {
        api.mediaSaveRatings(sourcePath, next)
      }, 400)
      return next
    })
  }

  // 上一个/下一个
  const goPrev = () => {
    if (filteredFiles.length === 0) return
    setCurrentIdx(i => (i - 1 + filteredFiles.length) % filteredFiles.length)
  }
  const goNext = () => {
    if (filteredFiles.length === 0) return
    setCurrentIdx(i => (i + 1) % filteredFiles.length)
  }

  // 键盘快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 输入框中不响应
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.ctrlKey || e.altKey || e.metaKey) return
      if (filteredFiles.length === 0) return

      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev() }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goNext() }
      else if (e.key >= '1' && e.key <= '5') { e.preventDefault(); setRating(currentFile, Number(e.key)) }
      else if (e.key === '0' || e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault(); setRating(currentFile, 0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [currentFile, filteredFiles, sourcePath])

  // 评分统计（基于当前已加载预览的文件，未预览的类型不计入）
  const ratingStats = useMemo(() => {
    const stats: Record<string, number> = { unrated: 0, '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }
    for (const f of files) {
      const r = ratings[f.relativePath]
      if (!r) stats.unrated++
      else stats[String(r)]++
    }
    return stats
  }, [files, ratings])

  // ---------- 虚拟滚动 ----------
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const update = () => setListViewport(v => ({ ...v, height: el.clientHeight }))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // currentIdx 变化时，确保对应行在可视区域内（键盘切换/点击筛选后跳转等场景）
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const itemTop = currentIdx * ROW_HEIGHT
    const itemBottom = itemTop + ROW_HEIGHT
    if (itemTop < el.scrollTop) el.scrollTop = itemTop
    else if (itemBottom > el.scrollTop + el.clientHeight) el.scrollTop = itemBottom - el.clientHeight
  }, [currentIdx])

  const totalListHeight = filteredFiles.length * ROW_HEIGHT
  const startIndex = Math.max(0, Math.floor(listViewport.scrollTop / ROW_HEIGHT) - OVERSCAN)
  const visibleRowCount = Math.ceil(listViewport.height / ROW_HEIGHT) + OVERSCAN * 2
  const endIndex = Math.min(filteredFiles.length, startIndex + visibleRowCount)
  const visibleRows = filteredFiles.slice(startIndex, endIndex)

  // ---------- 同名不同类型文件检测（导出/删除共用） ----------
  // 在已加载的 files 之外，去磁盘查找同目录、同基础名但扩展名不同的媒体文件。
  // 这些文件可能因为在"预览类型"步骤被排除而完全不在 files 中。
  const findExtraSiblings = async (baseItems: MediaItem[]): Promise<(MediaSiblingFile & { repRatingLabel: string })[]> => {
    if (baseItems.length === 0 || !sourcePath) return []
    const keyMap = new Map<string, { dir: string; baseName: string }>()
    for (const f of baseItems) {
      const dir = dirOf(f.path)
      const baseName = baseNameOf(f.name, f.extension)
      keyMap.set(siblingKey(dir, baseName), { dir, baseName })
    }
    const res = await api.mediaFindSiblings(sourcePath, [...keyMap.values()])
    if (!res.success || !res.data) return []

    const basePathSet = new Set(baseItems.map(f => f.path))
    const seen = new Set<string>()
    const extras: (MediaSiblingFile & { repRatingLabel: string })[] = []
    for (const f of baseItems) {
      const key = siblingKey(dirOf(f.path), baseNameOf(f.name, f.extension))
      const list = res.data[key] || []
      const repRatingLabel = ratingLabelOf(ratings, f.relativePath)
      for (const s of list) {
        if (basePathSet.has(s.path) || seen.has(s.path)) continue
        seen.add(s.path)
        extras.push({ ...s, repRatingLabel })
      }
    }
    return extras
  }

  const askSiblingChoice = (mode: 'export' | 'delete', baseCount: number, extras: MediaSiblingFile[]) =>
    new Promise<SiblingChoice>(resolve => {
      setSiblingModal({ open: true, mode, baseCount, extras })
      siblingResolver.current = resolve
    })

  const closeSiblingModal = (choice: SiblingChoice) => {
    setSiblingModal(null)
    siblingResolver.current?.(choice)
    siblingResolver.current = null
  }

  // ---------- 执行导出 ----------
  const doExport = async () => {
    if (!targetPath) return message.warning('请选择目标文件夹')
    if (exportRatings.length === 0) return message.warning('请至少选择一种评分')

    const wantedSet = new Set(exportRatings)
    const toExport = files.filter(f => {
      const r = ratings[f.relativePath]
      const key = r ? String(r) : 'unrated'
      return wantedSet.has(key)
    })

    if (toExport.length === 0) return message.warning('没有匹配的文件')

    let finalItems = toExport.map(f => ({
      path: f.path, name: f.name, relativePath: f.relativePath,
      ratingLabel: ratingLabelOf(ratings, f.relativePath),
    }))
    let separateByType = false

    const extras = await findExtraSiblings(toExport)
    if (extras.length > 0) {
      const choice = await askSiblingChoice('export', toExport.length, extras)
      if (choice === null) return
      if (choice === 'both') {
        finalItems = finalItems.concat(extras.map(s => ({
          path: s.path, name: s.name, relativePath: s.relativePath, ratingLabel: s.repRatingLabel,
        })))
        separateByType = true
      }
    }

    Modal.confirm({
      title: `${isCopyMode ? '复制' : '移动'} ${finalItems.length} 个文件到目标文件夹？`,
      content: `${groupByRating ? '将按"X星/未评分"分文件夹' : '所有文件直接放到目标文件夹'}`
        + `${separateByType ? '，并按文件类型（如 JPG / ARW）再分子文件夹' : ''}`
        + `${isCopyMode ? '' : '，移动操作会从源目录删除原文件'}`,
      okText: '确定执行',
      cancelText: '取消',
      onOk: async () => {
        setExporting(true)
        setExportProgress(20)
        const result = await api.mediaExportByRating(finalItems, targetPath, isCopyMode, groupByRating, separateByType)
        setExportProgress(100)
        setTimeout(() => { setExporting(false); setExportProgress(0) }, 400)
        if (result.success && result.data) {
          message.success(`完成：成功 ${result.data.successCount}，失败 ${result.data.failCount}`)
          if (result.data.errors.length > 0) {
            console.warn('导出错误：', result.data.errors)
          }
          // 移动模式：从列表中剔除已移走的文件
          if (!isCopyMode && result.data.successCount > 0) {
            const movedPathSet = new Set(finalItems.map(f => f.path))
            setFiles(prev => prev.filter(f => !movedPathSet.has(f.path)))
            // 同步删除评分
            setRatings(prev => {
              const next = { ...prev }
              for (const f of finalItems) {
                if (f.relativePath) delete next[f.relativePath]
              }
              api.mediaSaveRatings(sourcePath, next)
              return next
            })
          }
        } else {
          message.error(result.error || '导出失败')
        }
      },
    })
  }

  // ---------- 按评分删除 ----------
  const doDelete = async () => {
    if (deleteRatings.length === 0) return message.warning('请至少选择一种评分')

    const wantedSet = new Set(deleteRatings)
    const matched = files.filter(f => {
      const r = ratings[f.relativePath]
      const key = r ? String(r) : 'unrated'
      return wantedSet.has(key)
    })
    if (matched.length === 0) return message.warning('没有匹配的文件')

    let finalPaths = matched.map(f => f.path)
    let finalRelPaths = matched.map(f => f.relativePath)

    const extras = await findExtraSiblings(matched)
    if (extras.length > 0) {
      const choice = await askSiblingChoice('delete', matched.length, extras)
      if (choice === null) return
      if (choice === 'both') {
        finalPaths = finalPaths.concat(extras.map(s => s.path))
        finalRelPaths = finalRelPaths.concat(extras.map(s => s.relativePath).filter(Boolean))
      }
    }

    Modal.confirm({
      title: `确定删除这 ${finalPaths.length} 个文件？`,
      content: '文件将移到回收站，可在回收站中恢复。',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setDeleting(true)
        const res = await api.mediaDeleteFiles(finalPaths, true)
        setDeleting(false)
        if (res.success && res.data) {
          message.success(`删除完成：成功 ${res.data.successCount}，失败 ${res.data.failCount}`)
          if (res.data.errors.length > 0) console.warn('删除错误：', res.data.errors)
          const deletedSet = new Set(finalPaths)
          setFiles(prev => prev.filter(f => !deletedSet.has(f.path)))
          setRatings(prev => {
            const next = { ...prev }
            for (const rp of finalRelPaths) delete next[rp]
            api.mediaSaveRatings(sourcePath, next)
            return next
          })
        } else {
          message.error(res.error || '删除失败')
        }
      },
    })
  }

  // 删除当前文件（单个，预览面板里的删除按钮）
  const deleteCurrent = async () => {
    if (!currentFile) return
    const res = await api.mediaDeleteFile(currentFile.path, true)
    if (res.success) {
      message.success('已移到回收站')
      const removedRel = currentFile.relativePath
      setFiles(prev => prev.filter(f => f.relativePath !== removedRel))
      setRatings(prev => {
        const next = { ...prev }
        delete next[removedRel]
        api.mediaSaveRatings(sourcePath, next)
        return next
      })
    } else {
      message.error(res.error || '删除失败')
    }
  }

  return (
    <div>
      <Card title="媒体评分与分类">
        {/* 顶部操作栏 */}
        <Space wrap style={{ marginBottom: 12 }}>
          <Input
            style={{ width: 380 }}
            placeholder="选择包含图片/视频的文件夹"
            value={sourcePath}
            onChange={e => setSourcePath(e.target.value)}
          />
          <Button icon={<FolderOpenOutlined />} onClick={() => browseFolder('source')}>浏览</Button>
          <Switch checked={includeSubfolders} onChange={setIncludeSubfolders} checkedChildren="含子目录" unCheckedChildren="仅当前目录" />
          <Button type="primary" icon={<ScanOutlined />} loading={probing} onClick={probeExtensions}>扫描</Button>
          {files.length > 0 && (
            <span style={{ color: '#666' }}>
              共 <b>{files.length}</b> 个 · 已评 <b>{files.length - ratingStats.unrated}</b> · 未评 <b>{ratingStats.unrated}</b>
            </span>
          )}
        </Space>

        {/* 预览类型筛选：探测到类型后展示，未选中的类型不会进入下方预览 */}
        {availableExts.length > 0 && (
          <Space wrap style={{ marginBottom: 12 }}>
            <span style={{ color: '#666' }}>预览类型：</span>
            <Checkbox.Group
              value={selectedExts}
              onChange={vals => setSelectedExts(vals as string[])}
              options={availableExts.map(e => ({ label: `${e.ext} (${e.count})`, value: e.ext }))}
            />
            <Button
              type="primary"
              ghost
              icon={<PlayCircleOutlined />}
              loading={loading}
              onClick={loadPreview}
            >
              {files.length > 0 ? '按所选类型重新加载' : '开始预览'}
            </Button>
          </Space>
        )}

        {/* 评分筛选 + 统计 */}
        {files.length > 0 && (
          <Space wrap style={{ marginBottom: 12 }}>
            <span style={{ color: '#666' }}>筛选：</span>
            <Radio.Group value={filter} onChange={e => { setFilter(e.target.value); setCurrentIdx(0) }} optionType="button" buttonStyle="solid">
              {RATING_FILTERS.map(o => {
                const cnt = o.value === 'all' ? files.length : ratingStats[o.value] || 0
                return (
                  <Radio.Button key={o.value} value={o.value}>
                    {o.label}（{cnt}）
                  </Radio.Button>
                )
              })}
            </Radio.Group>
          </Space>
        )}

        {files.length === 0 ? (
          <Empty description={
            availableExts.length > 0
              ? '请选择要预览的类型，然后点击"开始预览"'
              : '尚未扫描，请先选择文件夹并点击扫描'
          } />
        ) : (
          <div style={{ display: 'flex', gap: 12, height: 'calc(100vh - 360px)', minHeight: 480 }}>
            {/* 左侧文件列表（虚拟滚动，只挂载可视区域附近的行） */}
            <div
              ref={listRef}
              onScroll={e => setListViewport(v => ({ ...v, scrollTop: (e.target as HTMLDivElement).scrollTop }))}
              style={{
                width: 280, flexShrink: 0, border: '1px solid #f0f0f0', borderRadius: 6,
                overflowY: 'auto', background: '#fafafa',
              }}
            >
              {filteredFiles.length === 0 ? (
                <Empty style={{ marginTop: 60 }} description="此筛选下无文件" />
              ) : (
                <div style={{ position: 'relative', height: totalListHeight }}>
                  {visibleRows.map((f, i) => {
                    const idx = startIndex + i
                    const isActive = idx === currentIdx
                    const r = ratings[f.relativePath] || 0
                    return (
                      <div
                        key={f.path}
                        onClick={() => setCurrentIdx(idx)}
                        style={{
                          position: 'absolute',
                          top: idx * ROW_HEIGHT,
                          left: 0,
                          right: 0,
                          height: ROW_HEIGHT,
                          boxSizing: 'border-box',
                          padding: '8px 10px',
                          cursor: 'pointer',
                          borderBottom: '1px solid #f0f0f0',
                          background: isActive ? '#e6f4ff' : 'transparent',
                          display: 'flex',
                          gap: 8,
                          alignItems: 'center',
                        }}
                      >
                        {/* 缩略图：只有滚动到视口附近才会挂载，避免一次性发起成千上万个解码请求 */}
                        <div style={{
                          width: 48, height: 48, flexShrink: 0,
                          background: '#fff', border: '1px solid #eee', borderRadius: 4,
                          overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          {f.type === 'image' ? (
                            <img src={toMediaUrl(f.path)} alt="" style={{ maxWidth: '100%', maxHeight: '100%' }} loading="lazy" />
                          ) : (
                            <VideoCameraOutlined style={{ fontSize: 20, color: '#1677ff' }} />
                          )}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: isActive ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {f.name}
                          </div>
                          <div style={{ fontSize: 11, color: '#999' }}>
                            {r > 0 ? <Tag color="gold" style={{ fontSize: 11, marginRight: 4 }}>{'★'.repeat(r)}</Tag> : <Tag style={{ fontSize: 11, marginRight: 4 }}>未评分</Tag>}
                            {formatSize(f.size)}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* 右侧预览 */}
            <div style={{
              flex: 1, display: 'flex', flexDirection: 'column',
              border: '1px solid #f0f0f0', borderRadius: 6, background: '#fff', minWidth: 0,
            }}>
              {currentFile ? (
                <>
                  <div ref={previewWrapRef} style={{
                    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: '#1f1f1f', overflow: 'hidden', position: 'relative',
                  }}>
                    {currentFile.type === 'image' ? (
                      <img
                        key={currentFile.path}
                        src={toMediaUrl(currentFile.path)}
                        alt=""
                        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                      />
                    ) : (
                      <video
                        key={currentFile.path}
                        src={toMediaUrl(currentFile.path)}
                        controls
                        autoPlay={false}
                        style={{ maxWidth: '100%', maxHeight: '100%' }}
                      />
                    )}
                    {/* 上一个/下一个 浮动按钮 */}
                    <Button
                      shape="circle"
                      icon={<LeftOutlined />}
                      onClick={goPrev}
                      style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', opacity: 0.85 }}
                    />
                    <Button
                      shape="circle"
                      icon={<RightOutlined />}
                      onClick={goNext}
                      style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', opacity: 0.85 }}
                    />
                  </div>
                  {/* 底部信息+评分 */}
                  <div style={{ padding: 12, borderTop: '1px solid #f0f0f0' }}>
                    <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
                      <Space>
                        {currentFile.type === 'image' ? <PictureOutlined /> : <VideoCameraOutlined />}
                        <span style={{ fontWeight: 600 }}>{currentFile.name}</span>
                        <Tag>{currentFile.extension}</Tag>
                        <span style={{ color: '#999', fontSize: 12 }}>{formatSize(currentFile.size)}</span>
                        <span style={{ color: '#999', fontSize: 12 }}>{currentIdx + 1} / {filteredFiles.length}</span>
                      </Space>
                      <Space>
                        <Tooltip title="在资源管理器中打开所在文件夹">
                          <Button size="small" onClick={() => api.openPath?.(dirOf(currentFile.path))}>定位</Button>
                        </Tooltip>
                        <Popconfirm title="将此文件移到回收站？" onConfirm={deleteCurrent} okText="删除" cancelText="取消">
                          <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                        </Popconfirm>
                      </Space>
                    </Space>
                    <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 16 }}>
                      <span style={{ color: '#666' }}>评分：</span>
                      <Rate
                        value={currentRating}
                        onChange={v => setRating(currentFile, v)}
                      />
                      {currentRating > 0 && (
                        <Button size="small" type="link" onClick={() => setRating(currentFile, 0)}>清除评分</Button>
                      )}
                      <span style={{ color: '#bbb', fontSize: 12, marginLeft: 'auto' }}>
                        快捷键：← / → 切换 · 1-5 评分 · 0 / Delete 清除
                      </span>
                    </div>
                  </div>
                </>
              ) : (
                <Empty style={{ marginTop: 80 }} description="无文件" />
              )}
            </div>
          </div>
        )}

        {/* 导出区 */}
        {files.length > 0 && (
          <>
            <Divider style={{ margin: '16px 0 12px' }} />
            <Card type="inner" title="按评分导出/分类" size="small">
              <Space direction="vertical" style={{ width: '100%' }}>
                <Space wrap>
                  <span style={{ color: '#666' }}>选择要导出的评分：</span>
                  <Checkbox.Group
                    value={exportRatings}
                    onChange={vals => setExportRatings(vals as string[])}
                    options={[
                      { label: `5星 (${ratingStats['5']})`, value: '5' },
                      { label: `4星 (${ratingStats['4']})`, value: '4' },
                      { label: `3星 (${ratingStats['3']})`, value: '3' },
                      { label: `2星 (${ratingStats['2']})`, value: '2' },
                      { label: `1星 (${ratingStats['1']})`, value: '1' },
                      { label: `未评分 (${ratingStats.unrated})`, value: 'unrated' },
                    ]}
                  />
                </Space>
                <Space wrap>
                  <Input
                    style={{ width: 380 }}
                    placeholder="目标文件夹（默认=源文件夹）"
                    value={targetPath}
                    onChange={e => setTargetPath(e.target.value)}
                  />
                  <Button icon={<FolderOpenOutlined />} onClick={() => browseFolder('target')}>浏览</Button>
                  <Tooltip title="将目标文件夹设为当前源文件夹（在源目录下生成 5星/4星 子目录）">
                    <Button onClick={() => setTargetPath(sourcePath)} disabled={!sourcePath}>用源路径</Button>
                  </Tooltip>
                  <Switch checked={isCopyMode} onChange={setIsCopyMode} checkedChildren="复制" unCheckedChildren="移动" />
                  <Switch checked={groupByRating} onChange={setGroupByRating} checkedChildren="分文件夹" unCheckedChildren="不分组" />
                  <Button
                    type="primary"
                    icon={isCopyMode ? <CopyOutlined /> : <ScissorOutlined />}
                    loading={exporting}
                    onClick={doExport}
                  >
                    执行{isCopyMode ? '复制' : '移动'}
                  </Button>
                  <Tooltip title="重新加载评分文件">
                    <Button icon={<ReloadOutlined />} onClick={async () => {
                      const r = await api.mediaLoadRatings(sourcePath)
                      if (r.success) { setRatings(r.data || {}); message.success('已重新加载评分') }
                    }}>重载</Button>
                  </Tooltip>
                </Space>
                {exporting && <Progress percent={exportProgress} />}
                <div style={{ color: '#999', fontSize: 12 }}>
                  评分数据保存在源文件夹下的 <code>.media-ratings.json</code>。
                  分文件夹模式会在目标目录下生成 <code>5星 / 4星 / ... / 未评分</code> 子文件夹。
                  若存在同名不同类型的文件（如 5099.jpg 与 5099.arw），执行时会询问是否一并导出。
                </div>
              </Space>
            </Card>

            <Divider style={{ margin: '16px 0 12px' }} />
            <Card type="inner" title="按评分删除" size="small">
              <Space direction="vertical" style={{ width: '100%' }}>
                <Space wrap>
                  <span style={{ color: '#666' }}>选择要删除的评分：</span>
                  <Checkbox.Group
                    value={deleteRatings}
                    onChange={vals => setDeleteRatings(vals as string[])}
                    options={RATING_OPTIONS.map(o => ({ label: `${o.label} (${ratingStats[o.value] || 0})`, value: o.value }))}
                  />
                  <Button danger icon={<DeleteOutlined />} loading={deleting} onClick={doDelete}>
                    删除所选评分的文件
                  </Button>
                </Space>
                <div style={{ color: '#999', fontSize: 12 }}>
                  仅删除当前预览的文件（含子目录时按扫描范围），文件会移到回收站，可恢复。
                  若存在同名不同类型的文件，会询问是否一并删除。
                </div>
              </Space>
            </Card>
          </>
        )}
      </Card>

      {/* 同名不同类型文件确认弹窗（导出/删除共用） */}
      <Modal
        title={<><WarningOutlined style={{ color: '#faad14', marginRight: 8 }} />检测到同名不同类型的文件</>}
        open={!!siblingModal?.open}
        onCancel={() => closeSiblingModal(null)}
        footer={[
          <Button key="cancel" onClick={() => closeSiblingModal(null)}>取消</Button>,
          <Button key="previewOnly" onClick={() => closeSiblingModal('previewOnly')}>
            仅{siblingModal?.mode === 'delete' ? '删除' : '导出'}预览类型（{siblingModal?.baseCount ?? 0}）
          </Button>,
          <Button key="both" type="primary" onClick={() => closeSiblingModal('both')}>
            两种类型都{siblingModal?.mode === 'delete' ? '删除' : '导出'}（{(siblingModal?.baseCount ?? 0) + (siblingModal?.extras.length ?? 0)}）
          </Button>,
        ]}
      >
        <p>
          发现 <b>{siblingModal?.extras.length ?? 0}</b> 个文件与已选中的文件同名但类型不同
          （如 <code>5099.jpg</code> 对应的 <code>5099.arw</code>），是否一并
          {siblingModal?.mode === 'delete' ? '删除' : '导出'}？
        </p>
        <div style={{ maxHeight: 160, overflowY: 'auto', background: '#fafafa', padding: 8, borderRadius: 4 }}>
          {siblingModal?.extras.slice(0, 30).map(s => (
            <div key={s.path} style={{ fontSize: 12, color: '#666' }}>{s.relativePath || s.name}</div>
          ))}
          {(siblingModal?.extras.length ?? 0) > 30 && (
            <div style={{ fontSize: 12, color: '#999' }}>… 共 {siblingModal!.extras.length} 个</div>
          )}
        </div>
        {siblingModal?.mode === 'export' && (
          <p style={{ marginTop: 8, color: '#999', fontSize: 12 }}>
            选择"两种类型都导出"将在目标文件夹下按文件类型（如 JPG / ARW）分别创建子文件夹存放。
          </p>
        )}
      </Modal>
    </div>
  )
}
