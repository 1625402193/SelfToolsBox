import { useMemo } from 'react'
import { Card, Tag, Typography, Empty } from 'antd'
import { TagOutlined } from '@ant-design/icons'
import changelogRaw from '../../CHANGELOG.md?raw'

const { Title, Paragraph, Text } = Typography

interface VersionBlock {
  version: string // 如 "v1.2.4 — 2026-06-02" 或 "v1.2.3 及之前"
  sections: { title: string; items: string[] }[]
  notes: string[] // 顶部 blockquote (>) 或纯段落
}

// 简易 markdown 解析：仅处理 ## 版本 / ### 分组 / - 列表 / > 引用 / 普通段落
function parseChangelog(md: string): { intro: string[]; versions: VersionBlock[] } {
  const lines = md.split(/\r?\n/)
  const intro: string[] = []
  const versions: VersionBlock[] = []
  let curVer: VersionBlock | null = null
  let curSec: { title: string; items: string[] } | null = null

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) continue
    if (line.startsWith('# ')) continue // 文档主标题忽略
    if (line.startsWith('---')) continue

    if (line.startsWith('## ')) {
      curVer = { version: line.slice(3).trim(), sections: [], notes: [] }
      versions.push(curVer)
      curSec = null
      continue
    }

    if (line.startsWith('### ')) {
      if (!curVer) continue
      curSec = { title: line.slice(4).trim(), items: [] }
      curVer.sections.push(curSec)
      continue
    }

    // 列表项
    const itemMatch = line.match(/^\s*-\s+(.*)$/)
    if (itemMatch) {
      const text = itemMatch[1]
      if (curSec) {
        curSec.items.push(text)
      } else if (curVer) {
        curVer.notes.push(text)
      } else {
        intro.push(text)
      }
      continue
    }

    // 引用块 / 普通段落
    const txt = line.replace(/^>\s*/, '').trim()
    if (!txt) continue
    if (curVer && !curSec) {
      curVer.notes.push(txt)
    } else if (curSec) {
      // 上一项的延续行
      if (curSec.items.length > 0) {
        curSec.items[curSec.items.length - 1] += ' ' + txt
      } else {
        curSec.items.push(txt)
      }
    } else {
      intro.push(txt)
    }
  }

  return { intro, versions }
}

const sectionColorMap: Record<string, string> = {
  修复: 'red',
  优化: 'blue',
  新增: 'green',
  变更: 'orange',
  打包: 'purple',
  其他: 'default',
}

export default function Changelog() {
  const { intro, versions } = useMemo(() => parseChangelog(changelogRaw), [])
  const currentVersion = (import.meta.env.VITE_APP_VERSION as string) || ''

  if (versions.length === 0) {
    return <Empty description="暂无更新记录" />
  }

  return (
    <div style={{ maxWidth: 920, margin: '0 auto' }}>
      <Title level={3} style={{ marginTop: 0 }}>
        <TagOutlined style={{ marginRight: 8 }} />
        更新日志
        {currentVersion && (
          <Tag color="blue" style={{ marginLeft: 12, fontSize: 12 }}>
            当前 {currentVersion}
          </Tag>
        )}
      </Title>

      {intro.length > 0 && (
        <Paragraph type="secondary" style={{ marginBottom: 24 }}>
          {intro.join(' ')}
        </Paragraph>
      )}

      {versions.map((v, idx) => {
        // 拆分版本号和日期
        const m = v.version.match(/^(v[\d.]+)\s*(?:—|-|–)\s*(.+)$/)
        const versionTag = m ? m[1] : v.version
        const dateText = m ? m[2] : ''
        const isLatest = idx === 0

        return (
          <Card
            key={v.version}
            size="small"
            style={{ marginBottom: 16, borderColor: isLatest ? '#1677ff' : undefined }}
            title={
              <span>
                <Tag color={isLatest ? 'blue' : 'default'} style={{ fontSize: 13, fontWeight: 600 }}>
                  {versionTag}
                </Tag>
                {dateText && <Text type="secondary" style={{ fontSize: 13 }}>{dateText}</Text>}
                {isLatest && <Tag color="green" style={{ marginLeft: 8 }}>最新</Tag>}
              </span>
            }
          >
            {v.notes.length > 0 && (
              <Paragraph type="secondary" style={{ marginBottom: 12 }}>
                {v.notes.join(' ')}
              </Paragraph>
            )}

            {v.sections.map(sec => (
              <div key={sec.title} style={{ marginBottom: 12 }}>
                <div style={{ marginBottom: 6 }}>
                  <Tag color={sectionColorMap[sec.title] || 'default'}>{sec.title}</Tag>
                </div>
                <ul style={{ margin: 0, paddingLeft: 22, lineHeight: 1.9 }}>
                  {sec.items.map((it, i) => (
                    <li key={i} style={{ marginBottom: 2 }}>
                      <span dangerouslySetInnerHTML={{ __html: renderInline(it) }} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </Card>
        )
      })}
    </div>
  )
}

// 将行内 markdown 简单转 html：`code` 与 **bold**
function renderInline(s: string): string {
  // 先转义 HTML
  let out = s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  // `code`
  out = out.replace(/`([^`]+)`/g, '<code style="background:#f5f5f5;padding:1px 4px;border-radius:3px;font-size:0.92em;color:#c41d7f">$1</code>')
  // **bold**
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  return out
}
