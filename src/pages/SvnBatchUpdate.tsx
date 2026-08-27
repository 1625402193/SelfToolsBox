import { useState, useRef, useCallback, useEffect } from 'react'
import { Card, Button, Space, message, Switch, Input, Tag, Collapse, Popconfirm, Progress, Modal, Checkbox, TimePicker } from 'antd'
import {
  PlusOutlined,
  DeleteOutlined,
  PlayCircleOutlined,
  FolderOpenOutlined,
  FileAddOutlined,
  StopOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'

const api = (window as any).electronAPI

// 单个任务片的配置
interface TaskSlice {
  id: string
  name: string
  paths: string[] // 工程路径列表（可多选）
  preBat: string // 前置 bat 文件路径（可选）
  postBat: string // 后置 bat 文件路径（可选）
  enabled: boolean // 是否参与执行
  enablePreBat: boolean // 是否执行前置 bat
  enableSvn: boolean // 是否执行 svn update
  enablePostBat: boolean // 是否执行后置 bat
}

// 执行日志条目
interface LogEntry {
  time: string
  sliceName: string
  type: 'info' | 'success' | 'error' | 'warning'
  message: string
}

// 定时任务配置
interface ScheduleConfig {
  enabled: boolean
  time: string // HH:mm 格式
  days: number[] // 0-6, 0=周日
}

export default function SvnBatchUpdate() {
  const [slices, setSlices] = useState<TaskSlice[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [progress, setProgress] = useState<{ [sliceId: string]: { current: number; total: number; text: string } }>({})
  const [overallProgress, setOverallProgress] = useState({ completed: 0, total: 0 })
  const [confirmVisible, setConfirmVisible] = useState(false)
  const [executionPlan, setExecutionPlan] = useState<{ sliceName: string; steps: string[] }[]>([])
  const [schedule, setSchedule] = useState<ScheduleConfig>({ enabled: false, time: '09:00', days: [1, 2, 3, 4, 5] })
  const logsEndRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef(false)
  const scheduleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const dayNames = ['日', '一', '二', '三', '四', '五', '六']

  // 加载保存的配置
  useEffect(() => {
    api.configRead().then((res: any) => {
      if (res.success && res.data?.svnSlices) {
        const loaded = res.data.svnSlices.map((s: any) => ({
          enabled: true,
          enablePreBat: true,
          enableSvn: true,
          enablePostBat: true,
          ...s,
        }))
        setSlices(loaded)
      }
      if (res.success && res.data?.svnSchedule) {
        setSchedule(res.data.svnSchedule)
      }
    })
  }, [])

  // 定时任务逻辑
  useEffect(() => {
    if (scheduleTimerRef.current) {
      clearInterval(scheduleTimerRef.current)
      scheduleTimerRef.current = null
    }

    if (schedule.enabled) {
      // 阻止系统休眠，确保熄屏后定时器仍能触发
      api.powerPreventSleep?.()
      scheduleTimerRef.current = setInterval(() => {
        const now = new Date()
        const currentDay = now.getDay()
        const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

        if (schedule.days.includes(currentDay) && currentTime === schedule.time && !isRunning) {
          // 触发执行
          message.info('⏰ 定时任务触发，开始执行...')
          triggerScheduledRun()
        }
      }, 30000) // 每30秒检查一次
    } else {
      // 定时关闭时允许系统恢复正常休眠
      api.powerAllowSleep?.()
    }

    return () => {
      if (scheduleTimerRef.current) {
        clearInterval(scheduleTimerRef.current)
      }
    }
  }, [schedule, isRunning, slices])

  // 定时触发执行（跳过确认弹窗）
  const triggerScheduledRun = () => {
    const enabledSlices = slices.filter(s => s.enabled && s.paths.length > 0)
    if (enabledSlices.length === 0) return
    runAllParallel(enabledSlices)
  }

  // 保存配置
  const saveConfig = useCallback(async (newSlices: TaskSlice[], newSchedule?: ScheduleConfig) => {
    const res = await api.configRead()
    const config = res.success ? res.data : {}
    config.svnSlices = newSlices
    if (newSchedule) config.svnSchedule = newSchedule
    await api.configWrite(config)
  }, [])

  // 保存定时配置
  const updateSchedule = (updates: Partial<ScheduleConfig>) => {
    const newSchedule = { ...schedule, ...updates }
    setSchedule(newSchedule)
    // 异步保存
    api.configRead().then((res: any) => {
      const config = res.success ? res.data : {}
      config.svnSchedule = newSchedule
      api.configWrite(config)
    })
  }

  const addLog = (sliceName: string, type: LogEntry['type'], msg: string) => {
    const time = new Date().toLocaleTimeString('zh-CN')
    setLogs(prev => {
      const newLogs = [...prev, { time, sliceName, type, message: msg }]
      return newLogs.length > 500 ? newLogs.slice(-500) : newLogs
    })
    setTimeout(() => logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
  }

  // 从名称中提取末尾编号
  const extractTaskNumber = (name: string): number => {
    const match = name.match(/(\d+)\s*$/)
    return match ? parseInt(match[1], 10) : 0
  }

  // 判断是否为默认命名风格（任务 N / 更新任务 N），用于自动重编号
  const isDefaultName = (name: string): boolean => /^(?:更新)?任务\s*\d+$/.test(name)

  // 检测现有任务使用的命名前缀
  const detectPrefix = (): '更新任务' | '任务' => {
    return slices.some(s => /^更新任务/.test(s.name)) ? '更新任务' : '任务'
  }

  // 添加新任务片
  const addSlice = () => {
    // 找到下一个未使用的编号（避免删除中间任务后再次添加导致重名）
    const usedNumbers = slices.map(s => extractTaskNumber(s.name)).filter(n => n > 0)
    const nextNumber = usedNumbers.length > 0 ? Math.max(...usedNumbers) + 1 : 1
    const prefix = detectPrefix()
    const newSlice: TaskSlice = {
      id: Date.now().toString(),
      name: `${prefix} ${nextNumber}`,
      paths: [],
      preBat: '',
      postBat: '',
      enabled: true,
      enablePreBat: true,
      enableSvn: true,
      enablePostBat: true,
    }
    const newSlices = [...slices, newSlice]
    setSlices(newSlices)
    saveConfig(newSlices)
  }

  // 删除任务片
  const removeSlice = (id: string) => {
    // 仅对默认命名风格的任务自动重编号，保留用户自定义名称
    const newSlices = slices
      .filter(s => s.id !== id)
      .map((s, idx) => {
        if (!isDefaultName(s.name)) return s
        const m = s.name.match(/^((?:更新)?任务)/)
        const prefix = m ? m[1] : '任务'
        return { ...s, name: `${prefix} ${idx + 1}` }
      })
    setSlices(newSlices)
    saveConfig(newSlices)
  }

  // 更新任务片
  const updateSlice = (id: string, updates: Partial<TaskSlice>) => {
    const newSlices = slices.map(s => s.id === id ? { ...s, ...updates } : s)
    setSlices(newSlices)
    saveConfig(newSlices)
  }

  // 添加工程路径（单路径：替换已有路径）
  const addPath = async (sliceId: string) => {
    const dir = await api.openDirectory()
    if (dir) {
      const slice = slices.find(s => s.id === sliceId)
      // 单路径模式：直接覆盖；如已有路径则提示
      if (slice && slice.paths[0] && slice.paths[0] !== dir) {
        const confirmed = window.confirm(`当前任务已配置路径：\n${slice.paths[0]}\n\n是否替换为：\n${dir}？`)
        if (!confirmed) return
      }
      if (slice) {
        updateSlice(sliceId, { paths: [dir] })
      }
    }
  }

  // 移除工程路径（清空）
  const removePath = (sliceId: string, _pathToRemove: string) => {
    const slice = slices.find(s => s.id === sliceId)
    if (slice) {
      updateSlice(sliceId, { paths: [] })
    }
  }

  // 选择 bat 文件
  const selectBatFile = async (sliceId: string, field: 'preBat' | 'postBat') => {
    const filePath = await api.selectFile({ filters: [{ name: 'Batch Files', extensions: ['bat', 'cmd'] }] })
    if (filePath) {
      updateSlice(sliceId, { [field]: filePath })
    }
  }

  // 生成执行计划并弹窗确认
  const handleRunAll = () => {
    const enabledSlices = slices.filter(s => s.enabled && s.paths.length > 0)
    if (enabledSlices.length === 0) {
      message.warning('没有可执行的任务片（请确保至少有一个任务片已启用且包含工程路径）')
      return
    }

    const hasAnyPreBat = enabledSlices.some(s => s.enablePreBat && s.preBat)
    const plan: { sliceName: string; steps: string[] }[] = []

    if (hasAnyPreBat) {
      // 阶段一：前置BAT
      const phase1Steps: string[] = []
      for (const slice of enabledSlices) {
        if (slice.enablePreBat && slice.preBat) {
          phase1Steps.push(`[${slice.name}] 🔧 前置BAT: ${slice.preBat}`)
        }
      }
      if (phase1Steps.length > 0) {
        plan.push({ sliceName: '⏱ 阶段一：并行执行所有前置BAT（等全部完成后进入阶段二）', steps: phase1Steps })
      }

      // 阶段二：SVN + 后置BAT
      const phase2Items: { sliceName: string; steps: string[] }[] = []
      for (const slice of enabledSlices) {
        const steps: string[] = []
        if (slice.enableSvn) {
          for (const p of slice.paths) {
            steps.push(`📥 SVN Update: ${p}`)
          }
        }
        if (slice.enablePostBat && slice.postBat) {
          steps.push(`🔧 后置BAT: ${slice.postBat}`)
        }
        if (steps.length > 0) {
          phase2Items.push({ sliceName: `⏱ 阶段二 - ${slice.name}（并行）`, steps })
        }
      }
      plan.push(...phase2Items)
    } else {
      // 没有前置BAT，全部并行
      for (const slice of enabledSlices) {
        const steps: string[] = []
        if (slice.enableSvn) {
          for (const p of slice.paths) {
            steps.push(`📥 SVN Update: ${p}`)
          }
        }
        if (slice.enablePostBat && slice.postBat) {
          steps.push(`🔧 后置BAT: ${slice.postBat}`)
        }
        if (steps.length > 0) {
          plan.push({ sliceName: slice.name, steps })
        }
      }
    }

    if (plan.length === 0) {
      message.warning('当前配置下没有需要执行的操作')
      return
    }

    setExecutionPlan(plan)
    setConfirmVisible(true)
  }

  // 用户确认后执行（并行）
  const runAll = async () => {
    setConfirmVisible(false)
    const enabledSlices = slices.filter(s => s.enabled && s.paths.length > 0)
    runAllParallel(enabledSlices)
  }

  // 并行执行所有任务片（有前置BAT时分阶段）
  const runAllParallel = async (enabledSlices: TaskSlice[]) => {
    setIsRunning(true)
    abortRef.current = false
    setLogs([])
    setProgress({})
    setOverallProgress({ completed: 0, total: enabledSlices.length })

    const hasAnyPreBat = enabledSlices.some(s => s.enablePreBat && s.preBat)

    if (hasAnyPreBat) {
      // === 阶段一：并行执行所有前置BAT，等全部完成 ===
      addLog('系统', 'info', `⏱ 阶段一：并行执行所有前置BAT...`)
      const preBatSlices = enabledSlices.filter(s => s.enablePreBat && s.preBat)
      
      // 初始化进度
      for (const slice of enabledSlices) {
        const sliceSteps = (slice.enablePreBat && slice.preBat ? 1 : 0) +
          (slice.enableSvn ? slice.paths.length : 0) +
          (slice.enablePostBat && slice.postBat ? 1 : 0)
        setProgress(prev => ({ ...prev, [slice.id]: { current: 0, total: sliceSteps, text: '等待中...' } }))
      }

      // 并行执行前置BAT
      const preBatPromises = preBatSlices.map(async (slice) => {
        if (abortRef.current) return
        const batName = slice.preBat.split(/[\\/]/).pop() || slice.preBat
        setProgress(prev => ({ ...prev, [slice.id]: { ...prev[slice.id], text: `执行前置BAT: ${batName}` } }))
        addLog(slice.name, 'info', `🔧 执行前置BAT: ${slice.preBat}`)
        const result = await api.runBat(slice.preBat)
        if (result.success) {
          addLog(slice.name, 'success', `✅ 前置BAT执行完成`)
          if (result.output) addLog(slice.name, 'info', result.output)
        } else {
          addLog(slice.name, 'error', `❌ 前置BAT执行失败: ${result.error}`)
        }
        setProgress(prev => ({ ...prev, [slice.id]: { ...prev[slice.id], current: 1, text: '前置BAT完成' } }))
      })

      await Promise.allSettled(preBatPromises)

      if (abortRef.current) {
        addLog('系统', 'warning', '⚠ 用户中止了执行')
        setIsRunning(false)
        return
      }

      addLog('系统', 'info', `✅ 阶段一完成，所有前置BAT已执行完毕`)
      addLog('系统', 'info', `⏱ 阶段二：并行执行 SVN Update 和后置BAT...`)

      // === 阶段二：并行执行所有任务片的 SVN + 后置BAT ===
      const phase2Promises = enabledSlices.map(slice => runSlicePhase2(slice))
      await Promise.allSettled(phase2Promises)
    } else {
      // 没有任何前置BAT，全部并行执行
      addLog('系统', 'info', `🚀 开始并行执行 ${enabledSlices.length} 个任务片...`)
      const promises = enabledSlices.map(slice => runSingleSlice(slice))
      await Promise.allSettled(promises)
    }

    if (abortRef.current) {
      addLog('系统', 'warning', '⚠ 用户中止了执行')
    } else {
      addLog('系统', 'success', '🎉 所有任务片执行完毕！')
    }
    setIsRunning(false)
    setOverallProgress(prev => ({ ...prev, completed: enabledSlices.length }))
    message.success(abortRef.current ? '已中止' : '所有任务执行完毕')
  }

  // 阶段二执行：SVN Update + 后置BAT（前置BAT已在阶段一完成）
  const runSlicePhase2 = async (slice: TaskSlice) => {
    const preBatDone = slice.enablePreBat && slice.preBat ? 1 : 0
    const sliceSteps = preBatDone +
      (slice.enableSvn ? slice.paths.length : 0) +
      (slice.enablePostBat && slice.postBat ? 1 : 0)
    
    let stepDone = preBatDone // 前置BAT已完成
    const updateSliceProgress = (text: string) => {
      setProgress(prev => ({ ...prev, [slice.id]: { current: stepDone, total: sliceSteps, text } }))
    }

    // 阶段二开始时立即更新进度显示，标记为"阶段二进行中"
    updateSliceProgress('阶段二开始...')
    addLog(slice.name, 'info', `▶ 阶段二开始: ${slice.name}`)

    // SVN Update
    let svnHardFailed = false // SVN 是否硬性失败（路径无效/TortoiseProc 未启动等，update 实际未运行）
    if (slice.enableSvn && !abortRef.current) {
      for (const projPath of slice.paths) {
        if (abortRef.current) break
        const dirName = projPath.split(/[\\/]/).pop() || projPath
        updateSliceProgress(`SVN Update 中: ${dirName}（等待TortoiseSVN窗口关闭）`)
        addLog(slice.name, 'info', `📥 SVN Update: ${projPath}`)
        const result = await api.svnUpdate(projPath)
        if (result.success) {
          if (result.hasConflict) {
            addLog(slice.name, 'warning', `⚠ SVN Update 完成但存在冲突: ${projPath}（请稍后手动处理）`)
          } else {
            addLog(slice.name, 'success', `✅ SVN Update 完成: ${projPath}`)
          }
          if (result.output) addLog(slice.name, 'info', result.output)
        } else {
          svnHardFailed = true
          addLog(slice.name, 'error', `❌ SVN Update 失败: ${projPath} - ${result.error}`)
          if (result.output) addLog(slice.name, 'info', result.output)
        }
        stepDone++
        updateSliceProgress(`SVN Update 完成: ${dirName}`)
      }
    }

    // 后置 bat（SVN 硬失败时跳过，避免"更新都没开始后置 BAT 就执行了"）
    if (slice.enablePostBat && slice.postBat && !abortRef.current) {
      if (svnHardFailed) {
        addLog(slice.name, 'warning', `⏭ 跳过后置BAT：因 SVN Update 未成功执行`)
      } else {
        const batName = slice.postBat.split(/[\\/]/).pop() || slice.postBat
        updateSliceProgress(`执行后置BAT: ${batName}`)
        addLog(slice.name, 'info', `🔧 执行后置BAT: ${slice.postBat}`)
        const result = await api.runBat(slice.postBat)
        if (result.success) {
          addLog(slice.name, 'success', `✅ 后置BAT执行完成`)
          if (result.output) addLog(slice.name, 'info', result.output)
        } else {
          addLog(slice.name, 'error', `❌ 后置BAT执行失败: ${result.error}`)
        }
        stepDone++
        updateSliceProgress('后置BAT完成')
      }
    }

    addLog(slice.name, 'info', `✔ 任务片完成: ${slice.name}`)
    setProgress(prev => ({ ...prev, [slice.id]: { current: sliceSteps, total: sliceSteps, text: '完成' } }))
    setOverallProgress(prev => ({ ...prev, completed: prev.completed + 1 }))
  }

  // 执行单个任务片（内部串行：前置bat → svn update → 后置bat）
  const runSingleSlice = async (slice: TaskSlice) => {
    const sliceSteps = (slice.enablePreBat && slice.preBat ? 1 : 0) +
      (slice.enableSvn ? slice.paths.length : 0) +
      (slice.enablePostBat && slice.postBat ? 1 : 0)
    
    let stepDone = 0
    const updateSliceProgress = (text: string) => {
      setProgress(prev => ({ ...prev, [slice.id]: { current: stepDone, total: sliceSteps, text } }))
    }

    addLog(slice.name, 'info', `▶ 开始执行任务片: ${slice.name}`)
    updateSliceProgress('准备中...')

    // 1. 前置 bat
    if (slice.enablePreBat && slice.preBat && !abortRef.current) {
      const batName = slice.preBat.split(/[\\/]/).pop() || slice.preBat
      updateSliceProgress(`执行前置BAT: ${batName}`)
      addLog(slice.name, 'info', `🔧 执行前置BAT: ${slice.preBat}`)
      const result = await api.runBat(slice.preBat)
      if (result.success) {
        addLog(slice.name, 'success', `✅ 前置BAT执行完成`)
        if (result.output) addLog(slice.name, 'info', result.output)
      } else {
        addLog(slice.name, 'error', `❌ 前置BAT执行失败: ${result.error}`)
      }
      stepDone++
      updateSliceProgress('前置BAT完成')
    }

    // 2. SVN Update
    let svnHardFailed = false
    if (slice.enableSvn && !abortRef.current) {
      for (const projPath of slice.paths) {
        if (abortRef.current) break
        const dirName = projPath.split(/[\\/]/).pop() || projPath
        updateSliceProgress(`SVN Update 中: ${dirName}（等待TortoiseSVN窗口关闭）`)
        addLog(slice.name, 'info', `📥 SVN Update: ${projPath}`)
        const result = await api.svnUpdate(projPath)
        if (result.success) {
          if (result.hasConflict) {
            addLog(slice.name, 'warning', `⚠ SVN Update 完成但存在冲突: ${projPath}（请稍后手动处理）`)
          } else {
            addLog(slice.name, 'success', `✅ SVN Update 完成: ${projPath}`)
          }
          if (result.output) addLog(slice.name, 'info', result.output)
        } else {
          svnHardFailed = true
          addLog(slice.name, 'error', `❌ SVN Update 失败: ${projPath} - ${result.error}`)
          if (result.output) addLog(slice.name, 'info', result.output)
        }
        stepDone++
        updateSliceProgress(`SVN Update 完成: ${dirName}`)
      }
    }

    // 3. 后置 bat（SVN 硬失败时跳过，避免"更新都没开始后置 BAT 就执行了"）
    if (slice.enablePostBat && slice.postBat && !abortRef.current) {
      if (svnHardFailed) {
        addLog(slice.name, 'warning', `⏭ 跳过后置BAT：因 SVN Update 未成功执行`)
      } else {
        const batName = slice.postBat.split(/[\\/]/).pop() || slice.postBat
        updateSliceProgress(`执行后置BAT: ${batName}`)
        addLog(slice.name, 'info', `🔧 执行后置BAT: ${slice.postBat}`)
        const result = await api.runBat(slice.postBat)
        if (result.success) {
          addLog(slice.name, 'success', `✅ 后置BAT执行完成`)
          if (result.output) addLog(slice.name, 'info', result.output)
        } else {
          addLog(slice.name, 'error', `❌ 后置BAT执行失败: ${result.error}`)
        }
        stepDone++
        updateSliceProgress('后置BAT完成')
      }
    }

    addLog(slice.name, 'info', `✔ 任务片完成: ${slice.name}`)
    setProgress(prev => ({ ...prev, [slice.id]: { current: sliceSteps, total: sliceSteps, text: '完成' } }))
    setOverallProgress(prev => ({ ...prev, completed: prev.completed + 1 }))
  }

  const stopExecution = () => {
    abortRef.current = true
  }

  const clearLogs = () => {
    setLogs([])
    setProgress({})
    setOverallProgress({ completed: 0, total: 0 })
  }

  const getLogColor = (type: LogEntry['type']) => {
    switch (type) {
      case 'success': return '#52c41a'
      case 'error': return '#ff4d4f'
      case 'warning': return '#faad14'
      default: return '#333'
    }
  }

  // 计算总进度
  const getTotalPercent = () => {
    if (overallProgress.total === 0) return 0
    const allSliceProgress = Object.values(progress)
    if (allSliceProgress.length === 0) return 0
    const totalSteps = allSliceProgress.reduce((sum, p) => sum + p.total, 0)
    const doneSteps = allSliceProgress.reduce((sum, p) => sum + p.current, 0)
    if (totalSteps === 0) return 0
    return Math.round((doneSteps / totalSteps) * 100)
  }

  return (
    <div>
      <div className="page-title">SVN批量更新</div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={addSlice} disabled={isRunning}>
          添加任务片
        </Button>
        {!isRunning ? (
          <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleRunAll} disabled={slices.length === 0} style={{ background: '#52c41a', borderColor: '#52c41a' }}>
            执行全部
          </Button>
        ) : (
          <Button danger icon={<StopOutlined />} onClick={stopExecution}>
            中止
          </Button>
        )}
        <Button size="small" onClick={clearLogs}>清空日志</Button>
      </Space>

      {/* 定时任务配置 */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Switch
            checked={schedule.enabled}
            onChange={v => updateSchedule({ enabled: v })}
            disabled={isRunning}
          />
          <ClockCircleOutlined />
          <span style={{ fontWeight: 500 }}>定时执行：</span>
          <TimePicker
            value={dayjs(schedule.time, 'HH:mm')}
            format="HH:mm"
            onChange={(_, timeStr) => { if (timeStr) updateSchedule({ time: timeStr as string }) }}
            disabled={!schedule.enabled || isRunning}
            size="small"
          />
          <span>每周：</span>
          {dayNames.map((name, idx) => (
            <Checkbox
              key={idx}
              checked={schedule.days.includes(idx)}
              onChange={e => {
                const newDays = e.target.checked
                  ? [...schedule.days, idx].sort()
                  : schedule.days.filter(d => d !== idx)
                updateSchedule({ days: newDays })
              }}
              disabled={!schedule.enabled || isRunning}
            >
              {name}
            </Checkbox>
          ))}
          {schedule.enabled && (
            <Tag color="green">
              ⏰ 已启用 - 每{schedule.days.map(d => '周' + dayNames[d]).join('、')} {schedule.time} 自动执行
            </Tag>
          )}
        </Space>
      </Card>

      {/* 总进度条 */}
      {overallProgress.total > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ marginBottom: 4, fontSize: 12, color: '#666' }}>
            总进度：{overallProgress.completed}/{overallProgress.total} 个任务片
          </div>
          <Progress
            percent={getTotalPercent()}
            status={isRunning ? 'active' : getTotalPercent() === 100 ? 'success' : 'normal'}
            size="small"
          />
          {/* 各任务片进度 */}
          {Object.keys(progress).length > 0 && (
            <div style={{ marginTop: 8 }}>
              {slices.filter(s => progress[s.id]).map(slice => (
                <div key={slice.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 12, width: 80, flexShrink: 0 }}>{slice.name}:</span>
                  <Progress
                    percent={progress[slice.id].total > 0 ? Math.round((progress[slice.id].current / progress[slice.id].total) * 100) : 0}
                    size="small"
                    style={{ flex: 1, margin: 0 }}
                    status={progress[slice.id].current === progress[slice.id].total ? 'success' : 'active'}
                  />
                  <span style={{ fontSize: 11, color: '#999', width: 120, flexShrink: 0 }}>{progress[slice.id].text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 任务片列表 */}
      {slices.length > 0 && (
        <Collapse
          defaultActiveKey={slices.map(s => s.id)}
          style={{ marginBottom: 16 }}
          items={slices.map(slice => ({
            key: slice.id,
            label: (
              <Space>
                <Checkbox
                  checked={slice.enabled}
                  onChange={e => { e.stopPropagation(); updateSlice(slice.id, { enabled: e.target.checked }) }}
                  onClick={e => e.stopPropagation()}
                  disabled={isRunning}
                />
                <span style={{ opacity: slice.enabled ? 1 : 0.5 }}>{slice.name}</span>
                <Tag color={slice.paths[0] ? 'blue' : 'default'}>{slice.paths[0] ? '已配置' : '未配置'}</Tag>
                {slice.preBat && <Tag color={slice.enablePreBat ? 'orange' : 'default'}>{slice.enablePreBat ? '前置BAT' : '前置BAT(禁用)'}</Tag>}
                {slice.postBat && <Tag color={slice.enablePostBat ? 'green' : 'default'}>{slice.enablePostBat ? '后置BAT' : '后置BAT(禁用)'}</Tag>}
                {!slice.enableSvn && <Tag color="default">SVN(禁用)</Tag>}
              </Space>
            ),
            extra: (
              <Popconfirm title="确认删除此任务片？" onConfirm={(e) => { e?.stopPropagation(); removeSlice(slice.id) }} onCancel={e => e?.stopPropagation()}>
                <Button size="small" danger icon={<DeleteOutlined />} disabled={isRunning} onClick={e => e.stopPropagation()} />
              </Popconfirm>
            ),
            children: (
              <Space direction="vertical" style={{ width: '100%', opacity: slice.enabled ? 1 : 0.5 }}>
                {/* 任务名称 */}
                <div>
                  <span style={{ marginRight: 8 }}>任务名称：</span>
                  <Input
                    size="small"
                    value={slice.name}
                    onChange={e => updateSlice(slice.id, { name: e.target.value })}
                    style={{ width: 200 }}
                    disabled={isRunning}
                  />
                </div>

                {/* 工程路径列表 */}
                <Card size="small" title="工程目录" extra={
                  <Space size={4}>
                    <Button size="small" icon={<FolderOpenOutlined />} onClick={() => addPath(slice.id)} disabled={isRunning}>
                      {slice.paths[0] ? '更换' : '选择目录'}
                    </Button>
                    {slice.paths[0] && (
                      <Button size="small" onClick={() => removePath(slice.id, slice.paths[0])} disabled={isRunning}>
                        清除
                      </Button>
                    )}
                  </Space>
                }>
                  {slice.paths[0] ? (
                    <div style={{ fontSize: 12, wordBreak: 'break-all' }} title={slice.paths[0]}>
                      {slice.paths[0].length > 80 ? '...' + slice.paths[0].slice(-80) : slice.paths[0]}
                    </div>
                  ) : (
                    <div style={{ color: '#999', textAlign: 'center' }}>未选择目录</div>
                  )}
                </Card>

                {/* 前置 BAT */}
                <div>
                  <Space>
                    <Switch
                      size="small"
                      checked={slice.enablePreBat}
                      onChange={v => updateSlice(slice.id, { enablePreBat: v })}
                      disabled={isRunning}
                    />
                    <span style={{ opacity: slice.enablePreBat ? 1 : 0.5 }}>前置BAT（Update前执行）：</span>
                    <Input
                      size="small"
                      value={slice.preBat}
                      onChange={e => updateSlice(slice.id, { preBat: e.target.value })}
                      placeholder="可选，留空则不执行"
                      style={{ width: 300, opacity: slice.enablePreBat ? 1 : 0.5 }}
                      disabled={isRunning || !slice.enablePreBat}
                    />
                    <Button size="small" icon={<FileAddOutlined />} onClick={() => selectBatFile(slice.id, 'preBat')} disabled={isRunning || !slice.enablePreBat}>
                      选择
                    </Button>
                    {slice.preBat && <Button size="small" onClick={() => updateSlice(slice.id, { preBat: '' })} disabled={isRunning}>清除</Button>}
                  </Space>
                </div>

                {/* SVN 开关 */}
                <div>
                  <Space>
                    <Switch
                      size="small"
                      checked={slice.enableSvn}
                      onChange={v => updateSlice(slice.id, { enableSvn: v })}
                      disabled={isRunning}
                    />
                    <span style={{ opacity: slice.enableSvn ? 1 : 0.5 }}>执行 SVN Update</span>
                  </Space>
                </div>

                {/* 后置 BAT */}
                <div>
                  <Space>
                    <Switch
                      size="small"
                      checked={slice.enablePostBat}
                      onChange={v => updateSlice(slice.id, { enablePostBat: v })}
                      disabled={isRunning}
                    />
                    <span style={{ opacity: slice.enablePostBat ? 1 : 0.5 }}>后置BAT（Update后执行）：</span>
                    <Input
                      size="small"
                      value={slice.postBat}
                      onChange={e => updateSlice(slice.id, { postBat: e.target.value })}
                      placeholder="可选，留空则不执行"
                      style={{ width: 300, opacity: slice.enablePostBat ? 1 : 0.5 }}
                      disabled={isRunning || !slice.enablePostBat}
                    />
                    <Button size="small" icon={<FileAddOutlined />} onClick={() => selectBatFile(slice.id, 'postBat')} disabled={isRunning || !slice.enablePostBat}>
                      选择
                    </Button>
                    {slice.postBat && <Button size="small" onClick={() => updateSlice(slice.id, { postBat: '' })} disabled={isRunning}>清除</Button>}
                  </Space>
                </div>
              </Space>
            ),
          }))}
        />
      )}

      {/* 执行确认弹窗 */}
      <Modal
        title="确认执行操作"
        open={confirmVisible}
        onOk={runAll}
        onCancel={() => setConfirmVisible(false)}
        okText="确认执行"
        cancelText="取消"
        width={600}
      >
        <div style={{ maxHeight: 400, overflow: 'auto' }}>
          {slices.filter(s => s.enabled && s.paths.length > 0).some(s => s.enablePreBat && s.preBat) ? (
            <p style={{ marginBottom: 8, color: '#fa8c16', fontWeight: 500 }}>
              ⚡ 执行策略：阶段一并行执行所有前置BAT → 等全部完成 → 阶段二并行执行SVN和后置BAT
            </p>
          ) : (
            <p style={{ marginBottom: 8, color: '#1677ff', fontWeight: 500 }}>⚡ 各任务片将并行执行（不互相等待）</p>
          )}
          <p style={{ marginBottom: 12, color: '#666' }}>以下是本次将要执行的操作列表：</p>
          {executionPlan.map((item, idx) => (
            <Card key={idx} size="small" title={`📋 ${item.sliceName}`} style={{ marginBottom: 8 }}>
              {item.steps.map((step, stepIdx) => (
                <div key={stepIdx} style={{ padding: '4px 0', fontSize: 13 }}>
                  {step}
                </div>
              ))}
            </Card>
          ))}
        </div>
      </Modal>

      {/* 执行日志 */}
      <Card size="small" title="执行日志" style={{ marginTop: 8 }}>
        <div style={{ maxHeight: 300, overflow: 'auto', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6 }}>
          {logs.length === 0 ? (
            <div style={{ color: '#999', textAlign: 'center' }}>暂无日志</div>
          ) : (
            logs.map((log, i) => (
              <div key={i} style={{ color: getLogColor(log.type) }}>
                <span style={{ color: '#888' }}>[{log.time}]</span>
                <span style={{ color: '#1677ff', marginLeft: 4 }}>[{log.sliceName}]</span>
                <span style={{ marginLeft: 4 }}>{log.message}</span>
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>
      </Card>
    </div>
  )
}
