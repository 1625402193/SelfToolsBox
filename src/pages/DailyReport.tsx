import { useState, useCallback } from 'react'
import { Tabs, DatePicker, Button, Input, message, Space, Typography } from 'antd'
import { SaveOutlined, DownloadOutlined, ClearOutlined, SyncOutlined, CopyOutlined, EyeOutlined } from '@ant-design/icons'
import dayjs, { Dayjs } from 'dayjs'

const { TextArea } = Input
const { Text } = Typography

const api = window.electronAPI

// ==================== 日期解析工具 ====================

function tryParseDate(line: string): Dayjs | null {
  const s = line.trim()
  if (!s) return null
  // yyMMdd
  let d = dayjs(s, 'YYMMDD', true)
  if (d.isValid()) return d
  // yy.MM.dd
  d = dayjs(s, 'YY.MM.DD', true)
  if (d.isValid()) return d
  // yy.M.d
  d = dayjs(s, 'YY.M.D', true)
  if (d.isValid()) return d
  // yy.M.dd
  d = dayjs(s, 'YY.M.DD', true)
  if (d.isValid()) return d
  // yy.MM.d
  d = dayjs(s, 'YY.MM.D', true)
  if (d.isValid()) return d
  return null
}

// ==================== 排序函数 ====================

function sortDailyReports(content: string): string {
  if (!content.trim()) return ''
  const lines = content.split(/\r?\n/).filter(l => l.trim())
  const reports: { date: Dayjs; dateStr: string; items: string[] }[] = []
  let currentDate: Dayjs | null = null
  let currentDateStr = ''
  let currentItems: string[] = []

  for (const line of lines) {
    const d = tryParseDate(line)
    if (d) {
      if (currentDate && currentItems.length > 0) {
        reports.push({ date: currentDate, dateStr: currentDateStr, items: [...currentItems] })
      }
      currentDate = d
      currentDateStr = line.trim()
      currentItems = []
    } else if (currentDate) {
      currentItems.push(line.trim())
    }
  }
  if (currentDate && currentItems.length > 0) {
    reports.push({ date: currentDate, dateStr: currentDateStr, items: currentItems })
  }

  reports.sort((a, b) => a.date.valueOf() - b.date.valueOf())

  return reports.map(r => `${r.dateStr}\n${r.items.join('\n')}`).join('\n\n')
}

function sortByDateRangeReports(content: string): string {
  if (!content.trim()) return ''
  const lines = content.split(/\r?\n/).filter(l => l.trim())
  const reports: { startDate: Dayjs; lines: string[] }[] = []
  let currentStartDate: Dayjs | null = null
  let currentLines: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.includes('-') && trimmed.length >= 13) {
      const parts = trimmed.split('-')
      if (parts.length === 2) {
        const d = tryParseDate(parts[0].trim())
        if (d) {
          if (currentStartDate && currentLines.length > 0) {
            reports.push({ startDate: currentStartDate, lines: [...currentLines] })
          }
          currentStartDate = d
          currentLines = [trimmed]
          continue
        }
      }
    }
    if (currentStartDate) {
      currentLines.push(trimmed)
    }
  }
  if (currentStartDate && currentLines.length > 0) {
    reports.push({ startDate: currentStartDate, lines: currentLines })
  }

  reports.sort((a, b) => a.startDate.valueOf() - b.startDate.valueOf())
  return reports.map(r => r.lines.join('\n')).join('\n\n')
}

// ==================== 提取函数 ====================

function extractItems(dailyContent: string, startDate: Dayjs, endDate: Dayjs): string[] {
  const items: string[] = []
  const uniqueItems = new Set<string>()
  const lines = dailyContent.split(/\r?\n/).filter(l => l.trim())
  let currentDate: Dayjs | null = null

  for (const line of lines) {
    const d = tryParseDate(line)
    if (d) {
      currentDate = d
      continue
    }
    if (currentDate && currentDate.valueOf() >= startDate.valueOf() && currentDate.valueOf() <= endDate.valueOf()) {
      if (uniqueItems.add(line.trim())) {
        items.push(line.trim())
      }
    }
  }

  return items.map((item, i) => `${i + 1}、${item}`)
}

// ==================== 主组件 ====================

export default function DailyReport() {
  // 日报录入
  const [dailyDate, setDailyDate] = useState<Dayjs>(dayjs())
  const [dailyContent, setDailyContent] = useState('')

  // 周报
  const [weekStart, setWeekStart] = useState<Dayjs>(() => {
    const today = dayjs()
    const dow = today.day() // 0=Sunday
    const monday = today.subtract(dow === 0 ? 6 : dow - 1, 'day')
    return monday
  })
  const [weekEnd, setWeekEnd] = useState<Dayjs>(() => {
    const today = dayjs()
    const dow = today.day()
    const monday = today.subtract(dow === 0 ? 6 : dow - 1, 'day')
    return monday.add(4, 'day')
  })
  const [weekTitle, setWeekTitle] = useState('三组周报')
  const [weekPreview, setWeekPreview] = useState('')

  // 月报
  const [monthStart, setMonthStart] = useState<Dayjs>(() => dayjs().startOf('month'))
  const [monthEnd, setMonthEnd] = useState<Dayjs>(() => dayjs().endOf('month'))
  const [monthTitle, setMonthTitle] = useState('三组月报')
  const [monthPreview, setMonthPreview] = useState('')

  // 历史
  const [historyContent, setHistoryContent] = useState('')

  // ===== 日报操作 =====
  const saveDaily = useCallback(async () => {
    if (!dailyContent.trim()) {
      message.warning('请输入工作内容！')
      return
    }
    try {
      const dateStr = dailyDate.format('YYMMDD')
      const res = await api.reportRead('日报.txt')
      if (!res.success) { message.error('读取日报失败：' + res.error); return }

      const existing = res.data || ''
      const lines = existing.split(/\r?\n/).filter(l => l.trim())

      // 查找是否已有该日期
      let dateIndex = -1
      let nextDateIndex = -1
      for (let i = 0; i < lines.length; i++) {
        const d = tryParseDate(lines[i])
        if (d && d.format('YYYY-MM-DD') === dailyDate.format('YYYY-MM-DD')) {
          dateIndex = i
        } else if (dateIndex >= 0 && d && d.isAfter(dailyDate, 'day')) {
          nextDateIndex = i
          break
        }
      }

      const newContentLines = dailyContent.split('\n').map(l => l.trim()).filter(l => l)

      if (dateIndex >= 0) {
        // 已存在：覆盖（与WPF行为一致，简化为覆盖模式）
        const deleteEnd = nextDateIndex >= 0 ? nextDateIndex : lines.length
        lines.splice(dateIndex + 1, deleteEnd - dateIndex - 1, ...newContentLines)
      } else {
        lines.push(dateStr, ...newContentLines)
      }

      const sorted = sortDailyReports(lines.join('\n'))
      const writeRes = await api.reportWrite('日报.txt', sorted)
      if (writeRes.success) {
        message.success(`日报已保存！日期：${dateStr}`)
        setDailyContent('')
      } else {
        message.error('保存失败：' + writeRes.error)
      }
    } catch (err: any) {
      message.error('保存失败：' + err.message)
    }
  }, [dailyDate, dailyContent])

  const loadDaily = useCallback(async () => {
    try {
      const res = await api.reportRead('日报.txt')
      if (!res.success) { message.error('读取失败'); return }
      const lines = (res.data || '').split(/\r?\n/).filter(l => l.trim())
      let found = false
      const dailyItems: string[] = []
      for (const line of lines) {
        const d = tryParseDate(line)
        if (d) {
          if (found) break
          if (d.format('YYYY-MM-DD') === dailyDate.format('YYYY-MM-DD')) {
            found = true
          }
          continue
        }
        if (found) dailyItems.push(line.trim())
      }
      if (dailyItems.length > 0) {
        setDailyContent(dailyItems.join('\n'))
        message.success(`已加载 ${dailyDate.format('YYYY-MM-DD')} 的日报`)
      } else {
        message.info(`未找到 ${dailyDate.format('YYYY-MM-DD')} 的日报记录`)
      }
    } catch (err: any) {
      message.error('加载失败：' + err.message)
    }
  }, [dailyDate])

  // ===== 周报操作 =====
  const setThisWeek = () => {
    const today = dayjs()
    const dow = today.day()
    const monday = today.subtract(dow === 0 ? 6 : dow - 1, 'day')
    setWeekStart(monday)
    setWeekEnd(monday.add(4, 'day'))
  }

  const generateWeekly = useCallback(async () => {
    if (weekStart.isAfter(weekEnd, 'day')) {
      message.warning('开始日期不能晚于结束日期！')
      return
    }
    try {
      const res = await api.reportRead('日报.txt')
      if (!res.success) { message.error('读取日报失败'); return }
      const items = extractItems(res.data || '', weekStart, weekEnd)
      if (items.length === 0) {
        message.warning('所选日期范围内没有日报记录！')
        return
      }
      const report = `${weekStart.format('YYMMDD')}-${weekEnd.format('YYMMDD')}\n${weekTitle || '三组周报'}\n${items.join('\n')}`
      setWeekPreview(report)
      message.success('周报已生成！')
    } catch (err: any) {
      message.error('生成失败：' + err.message)
    }
  }, [weekStart, weekEnd, weekTitle])

  const saveWeekly = useCallback(async () => {
    if (!weekPreview.trim()) { message.warning('请先生成周报！'); return }
    try {
      const res = await api.reportRead('周报.txt')
      const existing = (res.data || '').trim()
      const combined = existing ? existing + '\n\n' + weekPreview : weekPreview
      const sorted = sortByDateRangeReports(combined)
      const writeRes = await api.reportWrite('周报.txt', sorted + '\n')
      if (writeRes.success) {
        message.success('周报已保存到文件！')
      } else {
        message.error('保存失败：' + writeRes.error)
      }
    } catch (err: any) {
      message.error('保存失败：' + err.message)
    }
  }, [weekPreview])

  const copyWeekly = () => {
    if (!weekPreview.trim()) { message.warning('请先生成周报！'); return }
    navigator.clipboard.writeText(weekPreview)
    message.success('周报已复制到剪贴板！')
  }

  // ===== 月报操作 =====
  const setThisMonth = () => {
    setMonthStart(dayjs().startOf('month'))
    setMonthEnd(dayjs().endOf('month'))
  }

  const generateMonthly = useCallback(async () => {
    if (monthStart.isAfter(monthEnd, 'day')) {
      message.warning('开始日期不能晚于结束日期！')
      return
    }
    try {
      const res = await api.reportRead('日报.txt')
      if (!res.success) { message.error('读取日报失败'); return }
      const items = extractItems(res.data || '', monthStart, monthEnd)
      if (items.length === 0) {
        message.warning('所选日期范围内没有日报记录！')
        return
      }
      const report = `${monthStart.format('YYMMDD')}-${monthEnd.format('YYMMDD')}\n${monthTitle || '三组月报'}\n${items.join('\n')}`
      setMonthPreview(report)
      message.success('月报已生成！')
    } catch (err: any) {
      message.error('生成失败：' + err.message)
    }
  }, [monthStart, monthEnd, monthTitle])

  const saveMonthly = useCallback(async () => {
    if (!monthPreview.trim()) { message.warning('请先生成月报！'); return }
    try {
      const res = await api.reportRead('月报.txt')
      const existing = (res.data || '').trim()
      const combined = existing ? existing + '\n\n' + monthPreview : monthPreview
      const sorted = sortByDateRangeReports(combined)
      const writeRes = await api.reportWrite('月报.txt', sorted + '\n')
      if (writeRes.success) {
        message.success('月报已保存到文件！')
      } else {
        message.error('保存失败：' + writeRes.error)
      }
    } catch (err: any) {
      message.error('保存失败：' + err.message)
    }
  }, [monthPreview])

  const copyMonthly = () => {
    if (!monthPreview.trim()) { message.warning('请先生成月报！'); return }
    navigator.clipboard.writeText(monthPreview)
    message.success('月报已复制到剪贴板！')
  }

  // ===== 历史查看 =====
  const viewDaily = useCallback(async () => {
    const res = await api.reportRead('日报.txt')
    if (!res.success) { message.error('读取失败'); return }
    setHistoryContent(res.data?.trim() ? sortDailyReports(res.data) : '日报文件为空！')
  }, [])

  const viewWeekly = useCallback(async () => {
    const res = await api.reportRead('周报.txt')
    if (!res.success) { message.error('读取失败'); return }
    setHistoryContent(res.data?.trim() ? sortByDateRangeReports(res.data) : '周报文件为空！')
  }, [])

  const viewMonthly = useCallback(async () => {
    const res = await api.reportRead('月报.txt')
    if (!res.success) { message.error('读取失败'); return }
    setHistoryContent(res.data?.trim() ? sortByDateRangeReports(res.data) : '月报文件为空！')
  }, [])

  const tabItems = [
    {
      key: 'daily',
      label: '📅 日报录入',
      children: (
        <div style={{ maxWidth: 700 }}>
          <Space style={{ marginBottom: 12 }}>
            <Text strong>日期：</Text>
            <DatePicker value={dailyDate} onChange={(d) => d && setDailyDate(d)} format="YYYY-MM-DD" />
            <Button type="primary" style={{ background: '#27AE60' }} onClick={() => setDailyDate(dayjs())}>📅 今天</Button>
            <Text type="secondary">({dailyDate.format('YYYY年MM月DD日')})</Text>
          </Space>
          <div style={{ marginBottom: 4 }}>
            <Text type="secondary">工作内容（每行一项）：</Text>
          </div>
          <TextArea
            rows={8}
            value={dailyContent}
            onChange={(e) => setDailyContent(e.target.value)}
            placeholder="请输入工作内容，每行一项"
            style={{ fontFamily: 'Consolas, monospace', marginBottom: 12 }}
          />
          <Space>
            <Button type="primary" icon={<SaveOutlined />} onClick={saveDaily}>保存日报</Button>
            <Button style={{ background: '#27AE60', color: '#fff' }} icon={<DownloadOutlined />} onClick={loadDaily}>加载日报</Button>
            <Button icon={<ClearOutlined />} onClick={() => setDailyContent('')}>清空</Button>
          </Space>
        </div>
      ),
    },
    {
      key: 'weekly',
      label: '📊 周报生成',
      children: (
        <div style={{ maxWidth: 700 }}>
          <div style={{ marginBottom: 12 }}>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>周报周期：</Text>
            <Space>
              <Text>开始：</Text>
              <DatePicker value={weekStart} onChange={(d) => d && setWeekStart(d)} format="YYYY-MM-DD" />
              <Text>结束：</Text>
              <DatePicker value={weekEnd} onChange={(d) => d && setWeekEnd(d)} format="YYYY-MM-DD" />
              <Button type="primary" style={{ background: '#27AE60' }} onClick={setThisWeek}>📅 本周</Button>
            </Space>
          </div>
          <div style={{ marginBottom: 12 }}>
            <Text type="secondary">周报标题：</Text>
            <Input value={weekTitle} onChange={(e) => setWeekTitle(e.target.value)} style={{ maxWidth: 300 }} />
          </div>
          <div style={{ marginBottom: 4 }}>
            <Text type="secondary">周报预览：</Text>
          </div>
          <TextArea
            rows={10}
            value={weekPreview}
            readOnly
            style={{ fontFamily: 'Consolas, monospace', background: '#fafafa', marginBottom: 12 }}
          />
          <Space>
            <Button type="primary" icon={<SyncOutlined />} onClick={generateWeekly}>生成周报</Button>
            <Button style={{ background: '#27AE60', color: '#fff' }} icon={<SaveOutlined />} onClick={saveWeekly}>保存周报</Button>
            <Button style={{ background: '#E67E22', color: '#fff' }} icon={<CopyOutlined />} onClick={copyWeekly}>复制周报</Button>
          </Space>
        </div>
      ),
    },
    {
      key: 'monthly',
      label: '📅 月报生成',
      children: (
        <div style={{ maxWidth: 700 }}>
          <div style={{ marginBottom: 12 }}>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>月报周期：</Text>
            <Space>
              <Text>开始：</Text>
              <DatePicker value={monthStart} onChange={(d) => d && setMonthStart(d)} format="YYYY-MM-DD" />
              <Text>结束：</Text>
              <DatePicker value={monthEnd} onChange={(d) => d && setMonthEnd(d)} format="YYYY-MM-DD" />
              <Button type="primary" style={{ background: '#27AE60' }} onClick={setThisMonth}>📅 本月</Button>
            </Space>
          </div>
          <div style={{ marginBottom: 12 }}>
            <Text type="secondary">月报标题：</Text>
            <Input value={monthTitle} onChange={(e) => setMonthTitle(e.target.value)} style={{ maxWidth: 300 }} />
          </div>
          <div style={{ marginBottom: 4 }}>
            <Text type="secondary">月报预览：</Text>
          </div>
          <TextArea
            rows={10}
            value={monthPreview}
            readOnly
            style={{ fontFamily: 'Consolas, monospace', background: '#fafafa', marginBottom: 12 }}
          />
          <Space>
            <Button type="primary" icon={<SyncOutlined />} onClick={generateMonthly}>生成月报</Button>
            <Button style={{ background: '#27AE60', color: '#fff' }} icon={<SaveOutlined />} onClick={saveMonthly}>保存月报</Button>
            <Button style={{ background: '#E67E22', color: '#fff' }} icon={<CopyOutlined />} onClick={copyMonthly}>复制月报</Button>
          </Space>
        </div>
      ),
    },
    {
      key: 'history',
      label: '📚 查看历史',
      children: (
        <div style={{ maxWidth: 700 }}>
          <Space style={{ marginBottom: 12 }}>
            <Button type="primary" icon={<EyeOutlined />} onClick={viewDaily}>查看日报</Button>
            <Button style={{ background: '#27AE60', color: '#fff' }} icon={<EyeOutlined />} onClick={viewWeekly}>查看周报</Button>
            <Button style={{ background: '#9B59B6', color: '#fff' }} icon={<EyeOutlined />} onClick={viewMonthly}>查看月报</Button>
            <Button icon={<ClearOutlined />} onClick={() => setHistoryContent('')}>刷新</Button>
          </Space>
          <div style={{ marginBottom: 4 }}>
            <Text type="secondary">历史记录：</Text>
          </div>
          <TextArea
            rows={16}
            value={historyContent}
            readOnly
            style={{ fontFamily: 'Consolas, monospace', background: '#fafafa' }}
          />
        </div>
      ),
    },
  ]

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>📝 日报周报管理</h2>
      <Tabs items={tabItems} />
    </div>
  )
}
