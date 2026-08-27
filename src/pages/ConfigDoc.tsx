import { Card, Typography, Tag } from 'antd'

const { Title, Paragraph, Text } = Typography

export default function ConfigDoc() {
  return (
    <div>
      <div className="page-title">配置说明</div>

      <Typography>
        <Card size="small" className="section-card" title="文件分类规则">
          <Paragraph>
            文件分类功能会将源文件夹中的文件按照 <Text strong>日期 + 文件扩展名</Text> 的方式分组，然后复制或移动到目标文件夹下的对应子目录中。
          </Paragraph>
          <Paragraph>
            分类依据为文件的扩展名（如 <Tag>jpg</Tag><Tag>pdf</Tag><Tag>mp4</Tag> 等），无需预先配置，系统会自动识别所有扩展名类型。
          </Paragraph>
          <Paragraph>
            目录结构示例：
            <pre style={{ background: '#f5f5f5', padding: 12, borderRadius: 4, fontSize: 13 }}>
{`目标文件夹/
├── 2024-01-15/
│   ├── jpg/
│   │   ├── photo1.jpg
│   │   └── photo2.jpg
│   ├── png/
│   │   └── screenshot.png
│   ├── pdf/
│   │   └── report.pdf
│   └── 无扩展名/
│       └── Makefile
├── 2024-01-16/
│   └── mp4/
│       └── clip.mp4`}
            </pre>
          </Paragraph>
          <Paragraph>
            <Text strong>选项说明：</Text>
            <ul>
              <li><Text code>复制模式</Text> — 保留源文件，将副本放入目标目录</li>
              <li><Text code>移动模式</Text> — 将源文件移走，源目录中的文件会消失</li>
              <li><Text code>创建时间</Text> — 使用文件的创建时间作为分类依据</li>
              <li><Text code>修改时间</Text> — 使用文件的最后修改时间作为分类依据</li>
              <li><Text code>包含子文件夹</Text> — 是否递归扫描源文件夹下的子目录</li>
            </ul>
          </Paragraph>
        </Card>

        <Card size="small" className="section-card" title="批量移动说明">
          <Paragraph>
            批量移动功能允许你将源文件夹中的文件批量复制或移动到目标文件夹。
          </Paragraph>
          <ul>
            <li><Text strong>扁平化结构</Text> — 忽略源文件夹的目录层级，所有文件直接放入目标文件夹（同名文件会被覆盖）</li>
            <li><Text strong>保持结构</Text> — 在目标文件夹中重建源文件夹的目录结构</li>
            <li>支持勾选部分文件进行操作</li>
          </ul>
        </Card>

        <Card size="small" className="section-card" title="截图录屏说明">
          <Paragraph>
            截图录屏功能基于浏览器 Screen Capture API 实现：
          </Paragraph>
          <ul>
            <li><Text strong>全屏截图</Text> — 捕获整个屏幕画面</li>
            <li><Text strong>区域截图</Text> — 捕获指定矩形区域的画面</li>
            <li><Text strong>录屏</Text> — 录制屏幕画面，保存为 WebM 格式视频</li>
            <li>截图可保存为 PNG 或复制到剪贴板</li>
          </ul>
          <Paragraph type="warning">
            注意：录屏时需要授权屏幕捕获权限。录屏格式为 WebM，如需 MP4 格式可使用 FFmpeg 转码。
          </Paragraph>
        </Card>

        <Card size="small" className="section-card" title="自动点击说明">
          <Paragraph>
            自动点击功能会按设定的时间间隔，在指定坐标位置模拟鼠标点击。
          </Paragraph>
          <ul>
            <li><Text strong>持续时间模式</Text> — 运行指定分钟数后自动停止</li>
            <li><Text strong>时间段模式</Text> — 在指定的时间段内运行（如 9:00-17:00）</li>
            <li><Text strong>点击间隔</Text> — 两次点击之间的等待秒数</li>
            <li><Text strong>选择位置</Text> — 将鼠标移到目标位置后点击"选择位置"按钮</li>
          </ul>
          <Paragraph type="warning">
            注意：自动点击使用 Windows API 模拟鼠标操作，请确保点击位置准确，避免误操作。
          </Paragraph>
        </Card>
      </Typography>
    </div>
  )
}
