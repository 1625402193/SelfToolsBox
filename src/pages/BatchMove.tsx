import { useState } from 'react'
import { Card, Button, Input, Switch, Table, Tag, Space, message, Progress, Checkbox, Alert } from 'antd'
import { FolderOpenOutlined, ScanOutlined, CopyOutlined, ScissorOutlined } from '@ant-design/icons'
import type { FileItem } from '../types'

const api = window.electronAPI
const typeColors: Record<string, string> = {
  '.jpg': 'pink', '.png': 'pink', '.gif': 'pink', '.mp4': 'purple', '.avi': 'purple',
  '.mp3': 'blue', '.wav': 'blue', '.pdf': 'green', '.doc': 'green', '.txt': 'orange',
  '.zip': 'cyan', '.exe': 'red',
}

function formatSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
}

export default function BatchMove() {
  const [sourcePath, setSourcePath] = useState('')
  const [targetPath, setTargetPath] = useState('')
  const [isCopyMode, setIsCopyMode] = useState(false)
  const [includeSubfolders, setIncludeSubfolders] = useState(true)
  const [flattenStructure, setFlattenStructure] = useState(true)
  const [files, setFiles] = useState<FileItem[]>([])
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([])
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

  const scanFiles = async () => {
    if (!sourcePath) return message.warning('请选择源文件夹')
    setLoading(true)
    const result = await api.readDir(sourcePath, { recursive: includeSubfolders, includeFiles: true, includeDirs: false })
    setLoading(false)
    if (result.success && result.data) {
      setFiles(result.data)
      setSelectedRowKeys(result.data.map(f => f.path))
      message.success(`扫描完成，共 ${result.data.length} 个文件`)
    } else {
      message.error(result.error || '扫描失败')
    }
  }

  const executeBatchMove = async () => {
    if (!targetPath) return message.warning('请选择目标文件夹')
    if (selectedRowKeys.length === 0) return message.warning('请选择要操作的文件')
    setProcessing(true)
    setProgress(30)
    const selectedFiles = files.filter(f => selectedRowKeys.includes(f.path))
    const result = await api.batchMove(targetPath, selectedFiles, isCopyMode, flattenStructure)
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
      title: '文件名', dataIndex: 'name', key: 'name',
      render: (v: string) => <span style={{ fontWeight: 500 }}>{v}</span>,
    },
    {
      title: '扩展名', dataIndex: 'extension', key: 'extension', width: 80,
      render: (v: string) => <Tag color={typeColors[v] || 'default'}>{v || '无'}</Tag>,
    },
    { title: '大小', dataIndex: 'size', key: 'size', width: 100, render: (v: number) => formatSize(v || 0) },
    {
      title: '修改时间', dataIndex: 'modifyTime', key: 'modifyTime', width: 180,
      render: (v: string) => v ? new Date(v).toLocaleString('zh-CN') : '-',
    },
    {
      title: '路径', dataIndex: 'path', key: 'path', ellipsis: true,
      render: (v: string) => <span style={{ fontSize: 12, color: '#999' }}>{v}</span>,
    },
  ]

  return (
    <div>
      <div className="page-title">批量移动</div>

      <Card size="small" className="section-card" title="路径设置">
        <div className="option-row">
          <Space>
            <span>源文件夹：</span>
            <Input value={sourcePath} onChange={e => setSourcePath(e.target.value)} style={{ width: 400 }} placeholder="选择源文件夹" />
            <Button icon={<FolderOpenOutlined />} onClick={() => browseFolder('source')}>浏览</Button>
          </Space>
        </div>
        <div className="option-row">
          <Space>
            <span>目标文件夹：</span>
            <Input value={targetPath} onChange={e => setTargetPath(e.target.value)} style={{ width: 400 }} placeholder="选择目标文件夹" />
            <Button icon={<FolderOpenOutlined />} onClick={() => browseFolder('target')}>浏览</Button>
          </Space>
        </div>
      </Card>

      <Card size="small" className="section-card" title="选项">
        <Space size="large">
          <Space>操作模式：<Switch checkedChildren="复制" unCheckedChildren="移动" checked={isCopyMode} onChange={setIsCopyMode} /></Space>
          <Space>包含子文件夹：<Switch checked={includeSubfolders} onChange={setIncludeSubfolders} /></Space>
          <Space>扁平化结构：<Switch checked={flattenStructure} onChange={setFlattenStructure} /></Space>
        </Space>
      </Card>

      <div className="action-bar">
        <Space>
          <Button type="primary" icon={<ScanOutlined />} loading={loading} onClick={scanFiles}>扫描文件</Button>
          <Button type="primary" danger icon={isCopyMode ? <CopyOutlined /> : <ScissorOutlined />} loading={processing} disabled={selectedRowKeys.length === 0} onClick={executeBatchMove}>
            {isCopyMode ? '批量复制' : '批量移动'} ({selectedRowKeys.length})
          </Button>
        </Space>
      </div>

      {processing && <Progress percent={progress} status="active" style={{ marginBottom: 16 }} />}

      <Table
        columns={columns}
        dataSource={files}
        rowKey="path"
        size="small"
        loading={loading}
        rowSelection={{
          selectedRowKeys,
          onChange: (keys) => setSelectedRowKeys(keys as string[]),
        }}
        pagination={{ pageSize: 50, showSizeChanger: true, showTotal: (t) => `共 ${t} 个文件` }}
      />
    </div>
  )
}
