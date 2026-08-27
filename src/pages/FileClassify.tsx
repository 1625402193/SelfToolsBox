import { useState } from 'react'
import { Card, Button, Input, Switch, Table, Tag, Space, message, Progress, Statistic, Row, Col, Alert } from 'antd'
import { FolderOpenOutlined, SearchOutlined, CopyOutlined, ScissorOutlined } from '@ant-design/icons'
import type { ClassifyGroup, FileItem } from '../types'

const api = window.electronAPI
const tagColors = ['pink', 'purple', 'blue', 'green', 'orange', 'cyan', 'red', 'magenta', 'geekblue', 'volcano', 'gold', 'lime']
function getTypeColor(type: string) {
  // 根据扩展名字符串生成稳定的颜色索引
  let hash = 0
  for (let i = 0; i < type.length; i++) {
    hash = ((hash << 5) - hash) + type.charCodeAt(i)
    hash |= 0
  }
  return tagColors[Math.abs(hash) % tagColors.length]
}

function formatSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
}

export default function FileClassify() {
  const [sourcePath, setSourcePath] = useState('')
  const [targetPath, setTargetPath] = useState('')
  const [isCopyMode, setIsCopyMode] = useState(true)
  const [useCreationTime, setUseCreationTime] = useState(true)
  const [includeSubfolders, setIncludeSubfolders] = useState(false)
  const [groups, setGroups] = useState<ClassifyGroup[]>([])
  const [totalFiles, setTotalFiles] = useState(0)
  const [loading, setLoading] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState(0)

  const browseFolder = async (type: 'source' | 'target') => {
    const dir = await api.openDirectory()
    if (dir) {
      if (type === 'source') setSourcePath(dir)
      else setTargetPath(dir)
    }
  }

  const analyze = async () => {
    if (!sourcePath) return message.warning('请选择源文件夹')
    setLoading(true)
    setGroups([])
    const result = await api.classifyFiles(sourcePath, { useCreationTime, includeSubfolders })
    setLoading(false)
    if (result.success && result.data) {
      setGroups(result.data.groups)
      setTotalFiles(result.data.totalFiles)
      message.success(`分析完成，共 ${result.data.totalFiles} 个文件，${result.data.groups.length} 个分组`)
    } else {
      message.error(result.error || '分析失败')
    }
  }

  const executeClassify = async () => {
    if (!targetPath) return message.warning('请选择目标文件夹')
    if (groups.length === 0) return message.warning('请先分析文件')
    setProcessing(true)
    setProgress(0)
    const result = await api.executeClassify(targetPath, groups, isCopyMode)
    setProgress(100)
    setProcessing(false)
    if (result.success && result.data) {
      const { successCount, failCount } = result.data
      message.success(`${isCopyMode ? '复制' : '移动'}完成：成功 ${successCount}，失败 ${failCount}`)
    } else {
      message.error(result.error || '操作失败')
    }
  }

  const columns = [
    {
      title: '日期', dataIndex: 'date', key: 'date', width: 120,
      render: (v: string) => <Tag color="blue">{v}</Tag>,
    },
    {
      title: '类型', dataIndex: 'type', key: 'type', width: 100,
      render: (v: string) => <Tag color={getTypeColor(v)}>.{v}</Tag>,
    },
    {
      title: '文件数', key: 'count', width: 80,
      render: (_: any, r: ClassifyGroup) => r.files.length,
    },
    {
      title: '总大小', key: 'size', width: 100,
      render: (_: any, r: ClassifyGroup) => formatSize(r.files.reduce((s, f) => s + (f.size || 0), 0)),
    },
    {
      title: '文件列表', key: 'files',
      render: (_: any, r: ClassifyGroup) => (
        <div style={{ maxHeight: 120, overflow: 'auto' }}>
          {r.files.map((f, i) => (
            <div key={i} style={{ fontSize: 12, color: '#666' }}>{f.name} ({formatSize(f.size || 0)})</div>
          ))}
        </div>
      ),
    },
  ]

  return (
    <div>
      <div className="page-title">文件分类</div>

      <Card size="small" className="section-card" title="路径设置">
        <div className="option-row">
          <Space>
            <span>源文件夹：</span>
            <Input value={sourcePath} onChange={e => setSourcePath(e.target.value)} style={{ width: 400 }} placeholder="选择或输入源文件夹路径" />
            <Button icon={<FolderOpenOutlined />} onClick={() => browseFolder('source')}>浏览</Button>
          </Space>
        </div>
        <div className="option-row">
          <Space>
            <span>目标文件夹：</span>
            <Input value={targetPath} onChange={e => setTargetPath(e.target.value)} style={{ width: 400 }} placeholder="选择或输入目标文件夹路径" />
            <Button icon={<FolderOpenOutlined />} onClick={() => browseFolder('target')}>浏览</Button>
          </Space>
        </div>
      </Card>

      <Card size="small" className="section-card" title="选项">
        <Row gutter={24}>
          <Col><Space>操作模式：<Switch checkedChildren="复制" unCheckedChildren="移动" checked={isCopyMode} onChange={setIsCopyMode} /></Space></Col>
          <Col><Space>时间依据：<Switch checkedChildren="创建时间" unCheckedChildren="修改时间" checked={useCreationTime} onChange={setUseCreationTime} /></Space></Col>
          <Col><Space>包含子文件夹：<Switch checked={includeSubfolders} onChange={setIncludeSubfolders} /></Space></Col>
        </Row>
      </Card>

      <div className="action-bar">
        <Space>
          <Button type="primary" icon={<SearchOutlined />} loading={loading} onClick={analyze}>分析文件</Button>
          <Button type="primary" danger icon={isCopyMode ? <CopyOutlined /> : <ScissorOutlined />} loading={processing} disabled={groups.length === 0} onClick={executeClassify}>
            {isCopyMode ? '执行复制' : '执行移动'}
          </Button>
        </Space>
      </div>

      {totalFiles > 0 && (
        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col><Statistic title="总文件数" value={totalFiles} /></Col>
          <Col><Statistic title="分组数" value={groups.length} /></Col>
          <Col><Statistic title="总大小" value={formatSize(groups.reduce((s, g) => s + g.files.reduce((ss, f) => ss + (f.size || 0), 0), 0))} /></Col>
        </Row>
      )}

      {processing && <Progress percent={progress} status="active" style={{ marginBottom: 16 }} />}

      <Table
        columns={columns}
        dataSource={groups}
        rowKey={(r) => `${r.date}_${r.type}`}
        size="small"
        pagination={false}
        loading={loading}
        expandable={{
          expandedRowRender: (record) => (
            <ul style={{ margin: 0 }}>
              {record.files.map((f, i) => (
                <li key={i} style={{ fontSize: 12 }}>{f.name} — {formatSize(f.size || 0)} — {f.path}</li>
              ))}
            </ul>
          ),
        }}
      />
    </div>
  )
}
