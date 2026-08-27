import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Card, Button, Input, Switch, Space, message, Rate, Radio, Checkbox, Tag, Empty,
  Modal, Tooltip, Progress, Divider, Popconfirm,
} from 'antd'
import {
  FolderOpenOutlined, ScanOutlined, LeftOutlined, RightOutlined,
  CopyOutlined, ScissorOutlined, DeleteOutlined, ReloadOutlined,
  PictureOutlined, VideoCameraOutlined,
} from '@ant-design/icons'
import type { MediaItem } from '../types'

const api = window.electronAPI

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

const RATING_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'unrated', label: '未评分' },
  { value: '1', label: '1星' },
  { value: '2', label: '2星' },
  { value: '3', label: '3星' },
  { value: '4', label: '4星' },
  { value: '5', label: '5星' },
]

export default function MediaRating() {
  const [sourcePath, setSourcePath] = useState('')
  const [targetPath, setTargetPath] = useState('')
  const [includeSubfolders, setIncludeSubfolders] = useState(false)
  const [files, setFiles] = useState<MediaItem[]>([])
  const [ratings, setRatings] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(false)

  const [filter, setFilter] = useState<string>('all')
  const [currentIdx, setCurrentIdx] = useState(0)

  // 导出配置
  const [exportRatings, setExportRatings] = useState<string[]>(['5'])
  const [isCopyMode, setIsCopyMode] = useState(true)
  const [groupByRating, setGroupByRating] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState(0)

  const saveTimerRef = useRef<number | null>(null)
  const previewWrapRef = useRef<HTMLDivElement>(null)

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

  const scanFiles = async () => {
    if (!sourcePath) return message.warning('请选择源文件夹')
    setLoading(true)
    const [scanRes, ratingRes] = await Promise.all([
      api.mediaScan(sourcePath, { includeSubfolders }),
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
      message.success(`扫描完成，共 ${scanRes.data.length} 个媒体文件`)
    } else {
      message.error(scanRes.error || '扫描失败')
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

  // 评分统计
  const ratingStats = useMemo(() => {
    const stats: Record<string, number> = { unrated: 0, '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }
    for (const f of files) {
      const r = ratings[f.relativePath]
      if (!r) stats.unrated++
      else stats[String(r)]++
    }
    return stats
  }, [files, ratings])

  // 执行导出
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

    Modal.confirm({
      title: `${isCopyMode ? '复制' : '移动'} ${toExport.length} 个文件到目标文件夹？`,
      content: `${groupByRating ? '将按"X星/未评分"分文件夹' : '所有文件直接放到目标文件夹'}${isCopyMode ? '' : '，移动操作会从源目录删除原文件'}`,
      okText: '确定执行',
      cancelText: '取消',
      onOk: async () => {
        setExporting(true)
        setExportProgress(20)
        const result = await api.mediaExportByRating(
          toExport.map(f => ({ path: f.path, name: f.name, relativePath: f.relativePath })),
          targetPath,
          isCopyMode,
          groupByRating,
          ratings,
        )
        setExportProgress(100)
        setTimeout(() => { setExporting(false); setExportProgress(0) }, 400)
        if (result.success && result.data) {
          message.success(`完成：成功 ${result.data.successCount}，失败 ${result.data.failCount}`)
          if (result.data.errors.length > 0) {
            console.warn('导出错误：', result.data.errors)
          }
          // 移动模式：从列表中剔除已移走的文件
          if (!isCopyMode && result.data.successCount > 0) {
            const movedSet = new Set(toExport.map(f => f.relativePath))
            setFiles(prev => prev.filter(f => !movedSet.has(f.relativePath)))
            // 同步删除评分
            setRatings(prev => {
              const next = { ...prev }
              for (const k of movedSet) delete next[k]
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

  // 删除当前文件
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
          <Button type="primary" icon={<ScanOutlined />} loading={loading} onClick={scanFiles}>扫描</Button>
          {files.length > 0 && (
            <span style={{ color: '#666' }}>
              共 <b>{files.length}</b> 个 · 已评 <b>{files.length - ratingStats.unrated}</b> · 未评 <b>{ratingStats.unrated}</b>
            </span>
          )}
        </Space>

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
          <Empty description="尚未扫描，请先选择文件夹并点击扫描" />
        ) : (
          <div style={{ display: 'flex', gap: 12, height: 'calc(100vh - 360px)', minHeight: 480 }}>
            {/* 左侧文件列表 */}
            <div style={{
              width: 280, flexShrink: 0, border: '1px solid #f0f0f0', borderRadius: 6,
              overflowY: 'auto', background: '#fafafa',
            }}>
              {filteredFiles.length === 0 ? (
                <Empty style={{ marginTop: 60 }} description="此筛选下无文件" />
              ) : (
                filteredFiles.map((f, idx) => {
                  const isActive = idx === currentIdx
                  const r = ratings[f.relativePath] || 0
                  return (
                    <div
                      key={f.path}
                      onClick={() => setCurrentIdx(idx)}
                      style={{
                        padding: '8px 10px',
                        cursor: 'pointer',
                        borderBottom: '1px solid #f0f0f0',
                        background: isActive ? '#e6f4ff' : 'transparent',
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                      }}
                    >
                      {/* 缩略图 */}
                      <div style={{
                        width: 48, height: 48, flexShrink: 0,
                        background: '#fff', border: '1px solid #eee', borderRadius: 4,
                        overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        {f.type === 'image' ? (
                          <img src={toMediaUrl(f.path)} alt="" style={{ maxWidth: '100%', maxHeight: '100%' }} />
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
                })
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
                          <Button size="small" onClick={() => api.openPath?.(currentFile.path.replace(/[\\/][^\\/]+$/, ''))}>定位</Button>
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
                </div>
              </Space>
            </Card>
          </>
        )}
      </Card>
    </div>
  )
}
