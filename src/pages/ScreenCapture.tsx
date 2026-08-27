import { useState, useRef, useCallback, useEffect } from 'react'
import { Card, Button, Slider, Space, message, Row, Col, Statistic, Tag, InputNumber } from 'antd'
import { CameraOutlined, VideoCameraOutlined, StopOutlined, FolderOpenOutlined, SaveOutlined, CopyOutlined, ExpandOutlined, ReloadOutlined, FolderViewOutlined } from '@ant-design/icons'

const api = window.electronAPI

export default function ScreenCapture() {
  // 截图状态
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null)
  const [screenshotInfo, setScreenshotInfo] = useState('')
  const [screenshotFolder, setScreenshotFolder] = useState('')

  // 录屏状态
  const [isRecording, setIsRecording] = useState(false)
  const [recordFps, setRecordFps] = useState(10)
  const [maxRecordSeconds, setMaxRecordSeconds] = useState(60)
  const [recordFrameCount, setRecordFrameCount] = useState(0)
  const [recordElapsed, setRecordElapsed] = useState(0)
  const [recordStatus, setRecordStatus] = useState('就绪')
  const [recordFolder, setRecordFolder] = useState('')

  // 区域选择（截图和录屏共用）
  const [region, setRegion] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  // 录屏相关 refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<number>(0)
  const frameCountRef = useRef(0)
  const animFrameRef = useRef<number>(0)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // 启动时加载持久化配置
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const result = await api.configRead()
        if (result.success && result.data) {
          if (result.data.screenshotFolder) setScreenshotFolder(result.data.screenshotFolder)
          if (result.data.recordFolder) setRecordFolder(result.data.recordFolder)
          if (result.data.recordFps) setRecordFps(result.data.recordFps)
          if (result.data.maxRecordSeconds) setMaxRecordSeconds(result.data.maxRecordSeconds)
        }
      } catch (err) {
        // 忽略加载失败
      }
    }
    loadConfig()
  }, [])

  // 保存配置到磁盘
  const saveConfig = async (updates: Record<string, any>) => {
    try {
      const result = await api.configRead()
      const existing = (result.success && result.data) || {}
      await api.configWrite({ ...existing, ...updates })
    } catch (err) {
      // 忽略保存失败
    }
  }

  // 鼠标拖拽框选区域
  const selectRegion = async () => {
    try {
      const result = await api.selectRegion()
      if (result) {
        setRegion({ x: result.x, y: result.y, w: result.width, h: result.height })
        message.success(`已选择区域: (${result.x}, ${result.y}) ${result.width}x${result.height}`)
      }
    } catch (err: any) {
      message.error('选择区域失败: ' + err.message)
    }
  }

  // 选择区域并立即截图（截图模块专用）
  const selectAndScreenshot = async () => {
    try {
      const sel = await api.selectRegion()
      if (!sel) return
      setRegion({ x: sel.x, y: sel.y, w: sel.width, h: sel.height })
      const result = await api.screenshotRegion({ x: sel.x, y: sel.y, width: sel.width, height: sel.height })
      if (result.success && result.dataUrl) {
        setScreenshotUrl(result.dataUrl)
        setScreenshotInfo(`区域截图 (${sel.width}x${sel.height}) - ${new Date().toLocaleString('zh-CN')}`)
        message.success('区域截图完成')
      } else {
        message.error(result.error || '截图失败')
      }
    } catch (err: any) {
      message.error('截图失败: ' + err.message)
    }
  }

  // 手动调整区域坐标
  const handleRegionChange = (field: 'x' | 'y' | 'w' | 'h', value: number | null) => {
    if (!region) return
    setRegion({ ...region, [field]: value || 0 })
  }

  // 打开截图保存目录
  const openScreenshotFolder = async () => {
    if (screenshotFolder) {
      await api.openPath(screenshotFolder)
    } else {
      message.info('暂无保存目录，请先设置保存目录')
    }
  }

  // 打开录屏保存目录
  const openRecordFolder = async () => {
    if (recordFolder) {
      await api.openPath(recordFolder)
    } else {
      message.info('暂无保存目录，请先设置保存目录')
    }
  }

  // 全屏截图
  const takeFullscreenScreenshot = async () => {
    try {
      const sources = await api.getCaptureSources()
      const screenSource = sources.find(s => s.id.startsWith('screen:'))
        || sources.find(s => s.name === 'Entire Screen' || s.name === 'Screen 1')
        || sources[0]
      if (screenSource && screenSource.thumbnail) {
        setScreenshotUrl(screenSource.thumbnail)
        setScreenshotInfo(`全屏截图 - ${new Date().toLocaleString('zh-CN')}`)
        message.success('全屏截图完成')
      } else {
        message.error('未获取到屏幕源，截图失败')
      }
    } catch (err: any) {
      console.error('截图失败:', err)
      message.error('截图失败: ' + err.message)
    }
  }

  // 区域截图
  const takeRegionScreenshot = async () => {
    if (!region) return message.warning('请先选择区域')
    try {
      const result = await api.screenshotRegion({ x: region.x, y: region.y, width: region.w, height: region.h })
      if (result.success && result.dataUrl) {
        setScreenshotUrl(result.dataUrl)
        setScreenshotInfo(`区域截图 (${region.w}x${region.h}) - ${new Date().toLocaleString('zh-CN')}`)
        message.success('区域截图完成')
      } else {
        message.error(result.error || '截图失败')
      }
    } catch (err: any) {
      message.error('截图失败: ' + err.message)
    }
  }

  // 保存截图
  const saveScreenshot = async () => {
    if (!screenshotUrl) return
    let dir = screenshotFolder
    if (!dir) {
      dir = await api.openDirectory()
    }
    if (!dir) return
    if (dir !== screenshotFolder) {
      setScreenshotFolder(dir)
      await saveConfig({ screenshotFolder: dir })
    }
    const result = await api.saveScreenshot(dir, screenshotUrl)
    if (result.success) {
      message.success(`已保存: ${result.fileName}`)
    } else {
      message.error(result.error || '保存失败')
    }
  }

  // 选择截图保存目录
  const browseScreenshotFolder = async () => {
    const dir = await api.openDirectory()
    if (dir) {
      setScreenshotFolder(dir)
      await saveConfig({ screenshotFolder: dir })
    }
  }

  // 选择录屏保存目录
  const browseRecordFolder = async () => {
    const dir = await api.openDirectory()
    if (dir) {
      setRecordFolder(dir)
      await saveConfig({ recordFolder: dir })
    }
  }

  // 复制到剪贴板
  const copyToClipboard = async () => {
    if (!screenshotUrl) return
    try {
      const result = await api.copyImageToClipboard(screenshotUrl)
      if (result.success) {
        message.success('已复制到剪贴板')
      } else {
        message.error(result.error || '复制失败')
      }
    } catch (err: any) {
      message.error('复制失败: ' + err.message)
    }
  }

  // 检测浏览器支持的录屏格式
  const getSupportedMimeType = () => {
    const types = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ]
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) return type
    }
    return ''
  }

  // 开始录屏（支持区域裁剪）
  const startRecording = useCallback(async () => {
    try {
      const mimeType = getSupportedMimeType()
      if (!mimeType) {
        message.error('当前环境不支持录屏，请更新 Electron 或系统')
        return
      }

      const sourceResult = await api.getScreenSourceId(
        region ? { x: region.x, y: region.y, width: region.w, height: region.h } : undefined
      )
      if (!sourceResult.success || !sourceResult.sourceId) {
        message.error('获取屏幕源失败: ' + (sourceResult.error || '未知错误'))
        return
      }

      // 获取屏幕尺寸信息用于坐标映射
      const screenBounds = await api.getScreenBounds()
      // 真正录制的那块显示器（区域所在屏；无 region 时回退主屏）
      const recordingDisplay = sourceResult.display || {
        id: 0,
        bounds: { x: 0, y: 0, width: screenBounds.width, height: screenBounds.height },
        scaleFactor: screenBounds.scaleFactor,
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceResult.sourceId,
            minWidth: 1280,
            maxWidth: 3840,
            minHeight: 720,
            maxHeight: 2160,
            minFrameRate: 1,
            maxFrameRate: recordFps,
          }
        } as any,
      })

      streamRef.current = stream
      chunksRef.current = []
      frameCountRef.current = 0

      let recordStream: MediaStream

      if (region) {
        const video = document.createElement('video')
        video.srcObject = stream
        video.muted = true
        videoRef.current = video

        await video.play()

        const canvas = document.createElement('canvas')
        // 用物理像素避免模糊
        canvas.width = region.w * recordingDisplay.scaleFactor
        canvas.height = region.h * recordingDisplay.scaleFactor
        const ctx = canvas.getContext('2d')!
        canvasRef.current = canvas

        // 关键：源视频是 recordingDisplay 这一块屏，不是整个虚拟桌面
        // 把 region 绝对坐标转换为相对该显示器的坐标
        const relX = region.x - recordingDisplay.bounds.x
        const relY = region.y - recordingDisplay.bounds.y

        // 用 setInterval 而不是 requestAnimationFrame 驱动绘制。
        // 原因：录制时会弹出遮罩窗口覆盖应用，Chromium 对后台/不可见页面的 RAF 会节流到 1fps，
        // 导致 canvas 实际只更新了远少于预期的帧 → captureStream 按实际时间戳记录 → 视频时长远短于录制时长。
        // setInterval 不受页面可见性节流影响，能保证 canvas 按目标帧率稳定更新。
        const drawInterval = Math.round(1000 / recordFps)
        let drawReady = false
        let cachedScaleX = 0
        let cachedScaleY = 0
        let cachedSx = 0
        let cachedSy = 0
        let cachedSw = 0
        let cachedSh = 0

        const drawFrame = () => {
          if (!videoRef.current || !canvasRef.current) return
          if (!drawReady) {
            const vw = videoRef.current.videoWidth
            const vh = videoRef.current.videoHeight
            if (!vw || !vh) return // 视频尺寸还没就绪，跳过这一帧
            cachedScaleX = vw / recordingDisplay.bounds.width
            cachedScaleY = vh / recordingDisplay.bounds.height
            // clamp 到源视频内，避免坐标越界裁剪失败
            cachedSx = Math.max(0, Math.min(vw - 1, relX * cachedScaleX))
            cachedSy = Math.max(0, Math.min(vh - 1, relY * cachedScaleY))
            cachedSw = Math.max(1, Math.min(vw - cachedSx, region.w * cachedScaleX))
            cachedSh = Math.max(1, Math.min(vh - cachedSy, region.h * cachedScaleY))
            drawReady = true
          }
          const c = canvasRef.current.getContext('2d')!
          c.drawImage(
            videoRef.current,
            cachedSx, cachedSy, cachedSw, cachedSh,
            0, 0,
            canvas.width, canvas.height
          )
        }

        // 先填一帧底色，确保 canvas 有内容（避免首帧 captureStream 不发帧）
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, canvas.width, canvas.height)

        // 立即尝试第一帧
        drawFrame()
        // 用 setInterval 定时绘制（存到 animFrameRef 里复用，停止时清理）
        animFrameRef.current = window.setInterval(drawFrame, drawInterval) as unknown as number

        recordStream = canvas.captureStream(recordFps)
      } else {
        recordStream = stream
      }

      const recorder = new MediaRecorder(recordStream, {
        mimeType,
        videoBitsPerSecond: 8_000_000, // 8 Mbps 高清码率
      })
      mediaRecorderRef.current = recorder

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data)
          setRecordFrameCount((c) => c + 1)
        }
      }

      recorder.onstop = async () => {
        // 兜底清理（正常路径下 stopRecording 已做过，这里防止 track ended 等异步路径）
        if (animFrameRef.current) {
          clearInterval(animFrameRef.current)
          animFrameRef.current = 0
        }
        if (timerRef.current) {
          clearInterval(timerRef.current)
          timerRef.current = 0
        }
        if (videoRef.current) {
          videoRef.current.pause()
          videoRef.current.srcObject = null
          videoRef.current = null
        }
        canvasRef.current = null
        setIsRecording(false)

        // 关闭录制高亮遮罩（兜底）
        try { await api.hideRecordingOverlay() } catch (e) {}

        const blob = new Blob(chunksRef.current, { type: 'video/webm' })
        if (blob.size === 0) {
          message.error('录制数据为空，未生成文件（请检查屏幕源/帧率设置）')
          setRecordStatus('录制失败：数据为空')
          return
        }
        let dir = recordFolder
        if (!dir) {
          dir = await api.openDirectory()
        }
        if (dir) {
          if (dir !== recordFolder) {
            setRecordFolder(dir)
            await saveConfig({ recordFolder: dir })
          }
          const buffer = await blob.arrayBuffer()
          const u8 = new Uint8Array(buffer)
          const fileName = `recording_${new Date().toISOString().replace(/[:.]/g, '-')}.webm`
          const result = await api.saveBuffer(`${dir}/${fileName}`, u8)
          if (result.success) {
            const sizeMb = (u8.byteLength / 1024 / 1024).toFixed(2)
            message.success(`录制完成，已保存: ${fileName} (${sizeMb} MB)`)
          } else {
            message.error(result.error || '保存失败')
          }
        }
        setRecordStatus('录制完成')
      }

      stream.getVideoTracks()[0].onended = () => {
        stopRecording()
      }

      recorder.start(1000)
      setIsRecording(true)
      setRecordStatus(region ? `正在录制区域 (${region.w}x${region.h})...` : '正在录制...')

      // 仅在区域录制时显示高亮遮罩（其它区域变暗，区域内保持清晰）
      if (region) {
        try {
          await api.showRecordingOverlay({ x: region.x, y: region.y, width: region.w, height: region.h })
        } catch (e) {
          // 遮罩失败不影响录制
        }
      }

      const startTime = Date.now()
      timerRef.current = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000)
        setRecordElapsed(elapsed)
        if (elapsed >= maxRecordSeconds) {
          stopRecording()
          setRecordStatus(`已达最大录制时长 ${maxRecordSeconds} 秒，自动停止`)
        }
      }, 1000)
    } catch (err: any) {
      console.error('录屏启动失败:', err)
      message.error('录屏启动失败: ' + err.message)
      setIsRecording(false)
      try { await api.hideRecordingOverlay() } catch (e) {}
    }
  }, [recordFps, maxRecordSeconds, recordFolder, region])

  // 停止录屏
  const stopRecording = useCallback(() => {
    // 1. 立即清理绘制定时器
    if (animFrameRef.current) {
      clearInterval(animFrameRef.current)
      animFrameRef.current = 0
    }
    // 2. 立即停止计时器（防止节流解除后"追赶"执行导致时间跳变）
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = 0
    }
    // 3. 立即更新 UI 状态
    setIsRecording(false)
    // 4. 立即关闭遮罩（不等 onstop）
    try { api.hideRecordingOverlay() } catch (e) {}
    // 5. 停止 MediaRecorder（会异步触发 onstop 做文件保存）
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
    }
    // 6. 停止源视频流
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
    }
    if (videoRef.current) {
      videoRef.current.pause()
      videoRef.current.srcObject = null
      videoRef.current = null
    }
    canvasRef.current = null
  }, [])

  // 帧率和最大时长变化时持久化
  const handleFpsChange = async (val: number) => {
    setRecordFps(val)
    await saveConfig({ recordFps: val })
  }
  const handleMaxSecondsChange = async (val: number) => {
    setMaxRecordSeconds(val)
    await saveConfig({ maxRecordSeconds: val })
  }

  return (
    <div>
      <div className="page-title">截图录屏</div>

      <Row gutter={16}>
        {/* 截图部分 */}
        <Col span={12}>
          <Card size="small" className="section-card" title="截图" extra={
            <Space>
              <Button size="small" icon={<CameraOutlined />} onClick={takeFullscreenScreenshot}>全屏截图</Button>
              <Button size="small" type="primary" icon={<ExpandOutlined />} onClick={selectAndScreenshot}>选择区域</Button>
              {region && <Button size="small" icon={<ReloadOutlined />} onClick={takeRegionScreenshot}>重新截取</Button>}
            </Space>
          }>
            <Space direction="vertical" style={{ width: '100%' }}>
              {/* 区域微调 */}
              {region && (
                <div>
                  <Space style={{ flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, color: '#666' }}>区域微调：</span>
                    <span style={{ fontSize: 12, color: '#999' }}>X:</span>
                    <InputNumber size="small" min={0} value={region.x} onChange={v => handleRegionChange('x', v)} style={{ width: 65 }} />
                    <span style={{ fontSize: 12, color: '#999' }}>Y:</span>
                    <InputNumber size="small" min={0} value={region.y} onChange={v => handleRegionChange('y', v)} style={{ width: 65 }} />
                    <span style={{ fontSize: 12, color: '#999' }}>宽:</span>
                    <InputNumber size="small" min={1} value={region.w} onChange={v => handleRegionChange('w', v)} style={{ width: 65 }} />
                    <span style={{ fontSize: 12, color: '#999' }}>高:</span>
                    <InputNumber size="small" min={1} value={region.h} onChange={v => handleRegionChange('h', v)} style={{ width: 65 }} />
                  </Space>
                </div>
              )}
              <div>
                <Space>
                  <Button size="small" icon={<FolderOpenOutlined />} onClick={browseScreenshotFolder}>保存目录</Button>
                  {screenshotFolder && (
                    <Button size="small" type="link" icon={<FolderViewOutlined />} onClick={openScreenshotFolder}>
                      打开文件夹
                    </Button>
                  )}
                  {screenshotFolder && <span style={{ fontSize: 12, color: '#999' }}>{screenshotFolder}</span>}
                </Space>
              </div>
              {screenshotUrl && (
                <div>
                  <img src={screenshotUrl} alt="截图预览" className="preview-image" />
                  <div style={{ marginTop: 8 }}>
                    <Space>
                      <Button icon={<SaveOutlined />} onClick={saveScreenshot}>保存</Button>
                      <Button icon={<CopyOutlined />} onClick={copyToClipboard}>复制到剪贴板</Button>
                    </Space>
                  </div>
                </div>
              )}
              {region && <div><Tag color="blue">区域: ({region.x}, {region.y}) {region.w}x{region.h}</Tag></div>}
              {screenshotInfo && <div style={{ fontSize: 12, color: '#999' }}>{screenshotInfo}</div>}
            </Space>
          </Card>
        </Col>

        {/* 录屏部分 */}
        <Col span={12}>
          <Card size="small" className="section-card" title="录屏" extra={
            <Space>
              {!isRecording ? (
                <Button type="primary" icon={<VideoCameraOutlined />} onClick={startRecording}>开始录制</Button>
              ) : (
                <Button danger icon={<StopOutlined />} onClick={stopRecording}>停止录制</Button>
              )}
            </Space>
          }>
            <Space direction="vertical" style={{ width: '100%' }}>
              <div>
                <span>录制帧率: </span>
                <Slider min={1} max={30} value={recordFps} onChange={handleFpsChange} disabled={isRecording}
                  marks={{ 1: '1', 10: '10', 24: '24', 30: '30' }} />
              </div>
              <div>
                <span>最大时长 (秒): </span>
                <Slider min={5} max={1800} value={maxRecordSeconds} onChange={handleMaxSecondsChange} disabled={isRecording}
                  marks={{ 5: '5s', 60: '1min', 300: '5min', 900: '15min', 1800: '30min' }} />
              </div>
              <div>
                <Space>
                  <Button size="small" icon={<ExpandOutlined />} onClick={selectRegion} disabled={isRecording}>选择区域</Button>
                  {region && <Button size="small" icon={<ReloadOutlined />} onClick={selectRegion} disabled={isRecording}>重选</Button>}
                  {region && <Tag color="blue">({region.x}, {region.y}) {region.w}x{region.h}</Tag>}
                  {region && <Tag color="green">仅录制选中区域</Tag>}
                </Space>
              </div>
              {/* 录屏区域微调 */}
              {region && !isRecording && (
                <div style={{ paddingLeft: 8 }}>
                  <Space style={{ flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, color: '#666' }}>微调：</span>
                    <span style={{ fontSize: 12, color: '#999' }}>X:</span>
                    <InputNumber size="small" min={0} value={region.x} onChange={v => handleRegionChange('x', v)} style={{ width: 65 }} />
                    <span style={{ fontSize: 12, color: '#999' }}>Y:</span>
                    <InputNumber size="small" min={0} value={region.y} onChange={v => handleRegionChange('y', v)} style={{ width: 65 }} />
                    <span style={{ fontSize: 12, color: '#999' }}>宽:</span>
                    <InputNumber size="small" min={1} value={region.w} onChange={v => handleRegionChange('w', v)} style={{ width: 65 }} />
                    <span style={{ fontSize: 12, color: '#999' }}>高:</span>
                    <InputNumber size="small" min={1} value={region.h} onChange={v => handleRegionChange('h', v)} style={{ width: 65 }} />
                  </Space>
                </div>
              )}
              <div>
                <Space>
                  <Button size="small" icon={<FolderOpenOutlined />} onClick={browseRecordFolder} disabled={isRecording}>保存目录</Button>
                  {recordFolder && (
                    <Button size="small" type="link" icon={<FolderViewOutlined />} onClick={openRecordFolder}>
                      打开文件夹
                    </Button>
                  )}
                  {recordFolder && <span style={{ fontSize: 12, color: '#999' }}>{recordFolder}</span>}
                </Space>
              </div>
              <Row gutter={16}>
                <Col><Statistic title="已录帧数" value={recordFrameCount} /></Col>
                <Col><Statistic title="已录时长" value={recordElapsed} suffix="秒" /></Col>
              </Row>
              <div>
                <Tag color={isRecording ? 'red' : 'default'}>{recordStatus}</Tag>
              </div>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  )
}
