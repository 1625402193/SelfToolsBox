import { useState, useRef, useEffect, useCallback } from 'react'
import { Card, Button, Space, message, Switch, Input, Tag, Collapse, Popconfirm, Select, TimePicker, Checkbox, Progress, Modal } from 'antd'
import {
  PlusOutlined,
  DeleteOutlined,
  PoweroffOutlined,
  PlayCircleOutlined,
  FolderOpenOutlined,
  FileAddOutlined,
  ClockCircleOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  StopOutlined,
  SyncOutlined,
  DownOutlined,
  RightOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'

const api = (window as any).electronAPI

// =============== 类型定义 ===============

interface TriggerTime {
  id: string
  time: string    // HH:mm
  days: number[]  // 0-6, 0=周日
}

interface LogEntry {
  time: string
  source: string
  type: 'info' | 'success' | 'error' | 'warning'
  message: string
}

// 软件开关任务（每个任务自带触发时间）
interface AppTask {
  id: string
  name: string
  exePath: string
  processName: string
  action: 'open' | 'close'
  closeMode: 'graceful' | 'force'
  silent: boolean
  enabled: boolean
  triggers: TriggerTime[]
}

// SVN 更新任务
interface SvnTask {
  id: string
  name: string
  paths: string[]
  preBat: string
  postBat: string
  enabled: boolean
  enablePreBat: boolean
  enableSvn: boolean
  enablePostBat: boolean
}

// 开关任务组（触发时间在每个任务上）
interface AppTaskGroup {
  tasks: AppTask[]
  enabled: boolean
}

// 更新任务组
interface SvnTaskGroup {
  triggers: TriggerTime[]
  tasks: SvnTask[]
  enabled: boolean
}

// 全局配置
interface ScheduleConfig {
  timerEnabled: boolean       // 定时器总开关
  appGroup: AppTaskGroup      // 开关任务组
  svnGroup: SvnTaskGroup      // 更新任务组
}

const dayNames = ['日', '一', '二', '三', '四', '五', '六']

const defaultConfig: ScheduleConfig = {
  timerEnabled: false,
  appGroup: { tasks: [], enabled: true },
  svnGroup: { triggers: [], tasks: [], enabled: true },
}

export default function ScheduledTasks() {
  const [config, setConfig] = useState<ScheduleConfig>(defaultConfig)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [runningStates, setRunningStates] = useState<{ [processName: string]: boolean }>({})
  const [appGroupRunning, setAppGroupRunning] = useState(false)
  const [svnGroupRunning, setSvnGroupRunning] = useState(false)
  const [svnProgress, setSvnProgress] = useState<{ [taskId: string]: { current: number; total: number; text: string } }>({})
  const [confirmVisible, setConfirmVisible] = useState(false)
  const [executionPlan, setExecutionPlan] = useState<{ sliceName: string; steps: string[] }[]>([])
  const [appGroupExpanded, setAppGroupExpanded] = useState(true)
  const [svnGroupExpanded, setSvnGroupExpanded] = useState(true)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastTriggeredRef = useRef<{ [key: string]: string }>({})
  const logsEndRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<{ app: boolean; svn: boolean }>({ app: false, svn: false })

  // =============== 加载 & 保存 ===============

  useEffect(() => {
    api.configRead().then((res: any) => {
      if (res.success && res.data?.scheduleConfig) {
        // 确保每个 appTask 都有 triggers 数组（兼容旧版数据）
        const loaded = res.data.scheduleConfig as ScheduleConfig
        if (loaded.appGroup?.tasks) {
          const groupTriggers: TriggerTime[] = (loaded.appGroup as any).triggers || []
          loaded.appGroup.tasks = loaded.appGroup.tasks.map((t: any) => ({
            ...t,
            triggers: t.triggers || (groupTriggers.length > 0 ? [...groupTriggers] : []),
          }))
          // 删除组级 triggers（已迁移到任务级）
          delete (loaded.appGroup as any).triggers
        }
        setConfig(loaded)
        // 如果做了迁移则保存
        const cfgData = res.data
        cfgData.scheduleConfig = loaded
        api.configWrite(cfgData)
      } else if (res.success) {
        // 兼容旧数据
        const migrated: ScheduleConfig = { ...defaultConfig }

        // 迁移 unifiedTaskGroups
        if (res.data?.unifiedTaskGroups) {
          const groups = res.data.unifiedTaskGroups as any[]
          const appGroups = groups.filter((g: any) => g.type === 'app')
          const svnGroups = groups.filter((g: any) => g.type === 'svn')

          // 合并所有 app 组的任务，把组级 triggers 分配给每个任务
          const allAppTasks: AppTask[] = []
          for (const g of appGroups) {
            const groupTriggers: TriggerTime[] = g.triggers || []
            if (g.appTasks) {
              for (const t of g.appTasks) {
                allAppTasks.push({ ...t, triggers: t.triggers || groupTriggers })
              }
            }
          }
          if (allAppTasks.length > 0) {
            migrated.appGroup = { tasks: allAppTasks, enabled: true }
            migrated.timerEnabled = appGroups.some((g: any) => g.enabled)
          }

          // 合并所有 svn 组的触发时间和任务
          const allSvnTriggers: TriggerTime[] = []
          const allSvnTasks: SvnTask[] = []
          for (const g of svnGroups) {
            if (g.triggers) allSvnTriggers.push(...g.triggers)
            if (g.svnSlices) allSvnTasks.push(...g.svnSlices)
          }
          if (allSvnTasks.length > 0 || allSvnTriggers.length > 0) {
            migrated.svnGroup = { triggers: allSvnTriggers, tasks: allSvnTasks, enabled: true }
            migrated.timerEnabled = migrated.timerEnabled || svnGroups.some((g: any) => g.enabled)
          }
        } else {
          // 迁移更旧的数据格式
          if (res.data?.scheduledTaskGroups) {
            const groupTriggers: TriggerTime[] = []
            for (const old of res.data.scheduledTaskGroups) {
              if (old.triggers) groupTriggers.push(...old.triggers)
              if (old.tasks) {
                migrated.appGroup.tasks.push(...old.tasks.map((t: any) => ({ ...t, triggers: t.triggers || groupTriggers })))
              }
            }
            migrated.timerEnabled = true
          }
          if (res.data?.svnSlices?.length > 0) {
            migrated.svnGroup.tasks = res.data.svnSlices.map((s: any) => ({
              enabled: true, enablePreBat: true, enableSvn: true, enablePostBat: true, ...s,
            }))
            if (res.data.svnSchedule?.enabled) {
              migrated.svnGroup.triggers.push({
                id: Date.now().toString() + '_svn',
                time: res.data.svnSchedule.time || '09:00',
                days: res.data.svnSchedule.days || [1, 2, 3, 4, 5],
              })
            }
            migrated.timerEnabled = true
          }
        }

        if (migrated.appGroup.tasks.length > 0 || migrated.svnGroup.tasks.length > 0) {
          setConfig(migrated)
          const cfgData = res.data || {}
          cfgData.scheduleConfig = migrated
          api.configWrite(cfgData)
        }
      }
    })
  }, [])

  const saveConfig = useCallback(async (newConfig: ScheduleConfig) => {
    const res = await api.configRead()
    const cfgData = res.success ? res.data : {}
    cfgData.scheduleConfig = newConfig
    await api.configWrite(cfgData)
  }, [])

  const updateConfig = useCallback((updates: Partial<ScheduleConfig>) => {
    setConfig(prev => {
      const next = { ...prev, ...updates }
      saveConfig(next)
      return next
    })
  }, [saveConfig])

  // =============== 日志 ===============

  const addLog = useCallback((source: string, type: LogEntry['type'], msg: string) => {
    const now = new Date()
    const time = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${now.toLocaleTimeString('zh-CN')}`
    setLogs(prev => {
      const newLogs = [...prev, { time, source, type, message: msg }]
      return newLogs.length > 500 ? newLogs.slice(-500) : newLogs
    })
    setTimeout(() => logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
  }, [])

  // =============== 定时器 ===============

  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }

    if (!config.timerEnabled) {
      api.powerAllowSleep?.()
      return
    }

    // 检查是否有有效的定时任务
    const appValid = config.appGroup.enabled && config.appGroup.tasks.some(t => t.enabled && t.triggers.length > 0)
    const svnValid = config.svnGroup.enabled && config.svnGroup.triggers.length > 0 && config.svnGroup.tasks.some(t => t.enabled && t.paths.length > 0)

    if (appValid || svnValid) {
      api.powerPreventSleep?.()

      timerRef.current = setInterval(() => {
        const now = new Date()
        const currentDay = now.getDay()
        const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

        // 检查开关任务组：按单个任务触发
        if (appValid && !appGroupRunning) {
          for (const task of config.appGroup.tasks) {
            if (!task.enabled || task.triggers.length === 0) continue
            for (const trigger of task.triggers) {
              if (trigger.days.includes(currentDay) && trigger.time === currentTime) {
                const key = `app-${task.id}-${trigger.id}-${currentTime}`
                if (lastTriggeredRef.current[key] === currentTime) continue
                lastTriggeredRef.current[key] = currentTime
                message.info(`⏰ 开关任务 [${task.name}] 定时触发`)
                executeSingleAppTask(task)
              }
            }
          }
        }

        // 检查更新任务组
        if (svnValid && !svnGroupRunning) {
          for (const trigger of config.svnGroup.triggers) {
            if (trigger.days.includes(currentDay) && trigger.time === currentTime) {
              const key = `svn-${trigger.id}-${currentTime}`
              if (lastTriggeredRef.current[key] === currentTime) continue
              lastTriggeredRef.current[key] = currentTime
              message.info('⏰ 更新任务组 定时触发')
              executeSvnGroup()
            }
          }
        }
      }, 30000)
    } else {
      api.powerAllowSleep?.()
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [config, appGroupRunning, svnGroupRunning])

  // 清理 lastTriggeredRef
  useEffect(() => {
    const cleanup = setInterval(() => {
      const now = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`
      for (const [key, time] of Object.entries(lastTriggeredRef.current)) {
        if (time !== now) delete lastTriggeredRef.current[key]
      }
    }, 60000)
    return () => clearInterval(cleanup)
  }, [])

  // =============== 执行：单个开关任务（定时触发时调用） ===============

  const executeSingleAppTask = async (task: AppTask) => {
    setAppGroupRunning(true)
    abortRef.current.app = false

    addLog('开关任务组', 'info', `⏰ 定时触发: ${task.name}`)
    if (task.action === 'open') {
      addLog('开关任务组', 'info', `🚀 启动: ${task.name} (${task.exePath})`)
      const result = await api.appLaunch(task.exePath, task.silent)
      if (result.success) {
        addLog('开关任务组', 'success', `✅ ${task.name} 启动成功 (PID: ${result.pid})`)
      } else {
        addLog('开关任务组', 'error', `❌ ${task.name} 启动失败: ${result.error}`)
      }
    } else {
      addLog('开关任务组', 'info', `🛑 关闭: ${task.name} (${task.processName})`)
      const result = await api.appKill(task.processName, task.closeMode === 'force')
      if (result.success) {
        addLog('开关任务组', 'success', `✅ ${task.name} 已关闭`)
      } else {
        addLog('开关任务组', 'error', `❌ ${task.name} 关闭失败: ${result.error}`)
      }
    }

    setAppGroupRunning(false)
    refreshRunningStates()
  }

  // =============== 执行：所有开关任务（手动执行时调用） ===============

  const executeAppGroup = async () => {
    const enabledTasks = config.appGroup.tasks.filter(t => t.enabled)
    if (enabledTasks.length === 0) return

    setAppGroupRunning(true)
    abortRef.current.app = false
    addLog('开关任务组', 'info', `⏰ 开始执行（${enabledTasks.length} 个任务）...`)

    for (const task of enabledTasks) {
      if (abortRef.current.app) break
      if (task.action === 'open') {
        addLog('开关任务组', 'info', `🚀 启动: ${task.name} (${task.exePath})`)
        const result = await api.appLaunch(task.exePath, task.silent)
        if (result.success) {
          addLog('开关任务组', 'success', `✅ ${task.name} 启动成功 (PID: ${result.pid})`)
        } else {
          addLog('开关任务组', 'error', `❌ ${task.name} 启动失败: ${result.error}`)
        }
      } else {
        addLog('开关任务组', 'info', `🛑 关闭: ${task.name} (${task.processName})`)
        const result = await api.appKill(task.processName, task.closeMode === 'force')
        if (result.success) {
          addLog('开关任务组', 'success', `✅ ${task.name} 已关闭`)
        } else {
          addLog('开关任务组', 'error', `❌ ${task.name} 关闭失败: ${result.error}`)
        }
      }
    }

    addLog('开关任务组', abortRef.current.app ? 'warning' : 'success', abortRef.current.app ? '⚠ 已中止' : '✅ 执行完毕')
    setAppGroupRunning(false)
    refreshRunningStates()
  }

  // =============== 执行：更新任务组 ===============

  const executeSvnGroup = async () => {
    const enabledTasks = config.svnGroup.tasks.filter(t => t.enabled && t.paths.length > 0)
    if (enabledTasks.length === 0) return

    setSvnGroupRunning(true)
    abortRef.current.svn = false
    addLog('更新任务组', 'info', `🚀 开始并行执行 ${enabledTasks.length} 个任务...`)

    // 初始化进度
    for (const task of enabledTasks) {
      const total = (task.enablePreBat && task.preBat ? 1 : 0)
        + (task.enableSvn ? task.paths.length : 0)
        + (task.enablePostBat && task.postBat ? 1 : 0)
      setSvnProgress(prev => ({ ...prev, [task.id]: { current: 0, total, text: '等待中...' } }))
    }

    const hasAnyPreBat = enabledTasks.some(t => t.enablePreBat && t.preBat)

    if (hasAnyPreBat) {
      // 阶段一：并行前置BAT
      addLog('更新任务组', 'info', '⏱ 阶段一：并行执行前置BAT...')
      const preBatTasks = enabledTasks.filter(t => t.enablePreBat && t.preBat)
      await Promise.allSettled(preBatTasks.map(async (task) => {
        if (abortRef.current.svn) return
        const batName = task.preBat.split(/[\\/]/).pop() || task.preBat
        setSvnProgress(prev => ({ ...prev, [task.id]: { ...prev[task.id], text: `前置BAT: ${batName}` } }))
        addLog('更新任务组', 'info', `[${task.name}] 🔧 前置BAT: ${task.preBat}`)
        const result = await api.runBat(task.preBat)
        if (result.success) {
          addLog('更新任务组', 'success', `[${task.name}] ✅ 前置BAT完成`)
          if (result.output) addLog('更新任务组', 'info', result.output)
        } else {
          addLog('更新任务组', 'error', `[${task.name}] ❌ 前置BAT失败: ${result.error}`)
        }
        setSvnProgress(prev => ({ ...prev, [task.id]: { ...prev[task.id], current: 1, text: '前置BAT完成' } }))
      }))

      if (!abortRef.current.svn) {
        addLog('更新任务组', 'info', '⏱ 阶段二：并行执行SVN Update和后置BAT...')
        await Promise.allSettled(enabledTasks.map(task => runSvnPhase2(task)))
      }
    } else {
      await Promise.allSettled(enabledTasks.map(task => runSvnFull(task)))
    }

    addLog('更新任务组', abortRef.current.svn ? 'warning' : 'success', abortRef.current.svn ? '⚠ 已中止' : '🎉 全部完成！')
    message.success(abortRef.current.svn ? '已中止' : '更新任务组执行完毕')
    setSvnGroupRunning(false)
  }

  const runSvnPhase2 = async (task: SvnTask) => {
    const preBatDone = task.enablePreBat && task.preBat ? 1 : 0
    const total = preBatDone + (task.enableSvn ? task.paths.length : 0) + (task.enablePostBat && task.postBat ? 1 : 0)
    let stepDone = preBatDone

    const updateProg = (text: string) => {
      setSvnProgress(prev => ({ ...prev, [task.id]: { current: stepDone, total, text } }))
    }

    if (task.enableSvn && !abortRef.current.svn) {
      for (const projPath of task.paths) {
        if (abortRef.current.svn) break
        const dirName = projPath.split(/[\\/]/).pop() || projPath
        updateProg(`SVN: ${dirName}`)
        addLog('更新任务组', 'info', `[${task.name}] 📥 SVN Update: ${projPath}`)
        const result = await api.svnUpdate(projPath)
        if (result.success) {
          addLog('更新任务组', result.hasConflict ? 'warning' : 'success',
            result.hasConflict ? `[${task.name}] ⚠ 有冲突: ${projPath}` : `[${task.name}] ✅ SVN完成: ${projPath}`)
          if (result.output) addLog('更新任务组', 'info', result.output)
        } else {
          addLog('更新任务组', 'error', `[${task.name}] ❌ SVN失败: ${projPath} - ${result.error}`)
        }
        stepDone++
        updateProg(`完成: ${dirName}`)
      }
    }

    if (task.enablePostBat && task.postBat && !abortRef.current.svn) {
      const batName = task.postBat.split(/[\\/]/).pop() || task.postBat
      updateProg(`后置BAT: ${batName}`)
      addLog('更新任务组', 'info', `[${task.name}] 🔧 后置BAT: ${task.postBat}`)
      const result = await api.runBat(task.postBat)
      if (result.success) {
        addLog('更新任务组', 'success', `[${task.name}] ✅ 后置BAT完成`)
        if (result.output) addLog('更新任务组', 'info', result.output)
      } else {
        addLog('更新任务组', 'error', `[${task.name}] ❌ 后置BAT失败: ${result.error}`)
      }
      stepDone++
    }

    setSvnProgress(prev => ({ ...prev, [task.id]: { current: total, total, text: '完成' } }))
  }

  const runSvnFull = async (task: SvnTask) => {
    const total = (task.enablePreBat && task.preBat ? 1 : 0)
      + (task.enableSvn ? task.paths.length : 0)
      + (task.enablePostBat && task.postBat ? 1 : 0)
    let stepDone = 0

    const updateProg = (text: string) => {
      setSvnProgress(prev => ({ ...prev, [task.id]: { current: stepDone, total, text } }))
    }

    addLog('更新任务组', 'info', `[${task.name}] ▶ 开始执行`)
    updateProg('准备中...')

    if (task.enablePreBat && task.preBat && !abortRef.current.svn) {
      const batName = task.preBat.split(/[\\/]/).pop() || task.preBat
      updateProg(`前置BAT: ${batName}`)
      addLog('更新任务组', 'info', `[${task.name}] 🔧 前置BAT: ${task.preBat}`)
      const result = await api.runBat(task.preBat)
      if (result.success) {
        addLog('更新任务组', 'success', `[${task.name}] ✅ 前置BAT完成`)
        if (result.output) addLog('更新任务组', 'info', result.output)
      } else {
        addLog('更新任务组', 'error', `[${task.name}] ❌ 前置BAT失败: ${result.error}`)
      }
      stepDone++
    }

    if (task.enableSvn && !abortRef.current.svn) {
      for (const projPath of task.paths) {
        if (abortRef.current.svn) break
        const dirName = projPath.split(/[\\/]/).pop() || projPath
        updateProg(`SVN: ${dirName}`)
        addLog('更新任务组', 'info', `[${task.name}] 📥 SVN Update: ${projPath}`)
        const result = await api.svnUpdate(projPath)
        if (result.success) {
          addLog('更新任务组', result.hasConflict ? 'warning' : 'success',
            result.hasConflict ? `[${task.name}] ⚠ 有冲突: ${projPath}` : `[${task.name}] ✅ SVN完成: ${projPath}`)
          if (result.output) addLog('更新任务组', 'info', result.output)
        } else {
          addLog('更新任务组', 'error', `[${task.name}] ❌ SVN失败: ${projPath} - ${result.error}`)
        }
        stepDone++
      }
    }

    if (task.enablePostBat && task.postBat && !abortRef.current.svn) {
      const batName = task.postBat.split(/[\\/]/).pop() || task.postBat
      updateProg(`后置BAT: ${batName}`)
      addLog('更新任务组', 'info', `[${task.name}] 🔧 后置BAT: ${task.postBat}`)
      const result = await api.runBat(task.postBat)
      if (result.success) {
        addLog('更新任务组', 'success', `[${task.name}] ✅ 后置BAT完成`)
        if (result.output) addLog('更新任务组', 'info', result.output)
      } else {
        addLog('更新任务组', 'error', `[${task.name}] ❌ 后置BAT失败: ${result.error}`)
      }
      stepDone++
    }

    setSvnProgress(prev => ({ ...prev, [task.id]: { current: total, total, text: '完成' } }))
  }

  // =============== 进程状态 ===============

  const refreshRunningStates = async () => {
    const allProcessNames = new Set<string>()
    for (const task of config.appGroup.tasks) {
      if (task.processName) allProcessNames.add(task.processName)
    }
    const states: { [key: string]: boolean } = {}
    for (const pName of allProcessNames) {
      const res = await api.appIsRunning(pName)
      states[pName] = res.running
    }
    setRunningStates(states)
  }

  useEffect(() => {
    if (config.appGroup.tasks.length > 0) refreshRunningStates()
  }, [config.appGroup.tasks.length])

  // =============== CRUD：开关任务的触发时间 ===============

  const addAppTaskTrigger = (taskId: string) => {
    const task = config.appGroup.tasks.find(t => t.id === taskId)
    if (!task) return
    const newTrigger: TriggerTime = { id: Date.now().toString(), time: '09:00', days: [1, 2, 3, 4, 5] }
    updateAppTask(taskId, { triggers: [...task.triggers, newTrigger] } as any)
  }

  const removeAppTaskTrigger = (taskId: string, triggerId: string) => {
    const task = config.appGroup.tasks.find(t => t.id === taskId)
    if (!task) return
    updateAppTask(taskId, { triggers: task.triggers.filter(t => t.id !== triggerId) } as any)
  }

  const updateAppTaskTrigger = (taskId: string, triggerId: string, updates: Partial<TriggerTime>) => {
    const task = config.appGroup.tasks.find(t => t.id === taskId)
    if (!task) return
    updateAppTask(taskId, { triggers: task.triggers.map(t => t.id === triggerId ? { ...t, ...updates } : t) } as any)
  }

  // =============== CRUD：更新任务组的触发时间 ===============

  const addSvnTrigger = () => {
    const newTrigger: TriggerTime = { id: Date.now().toString(), time: '09:00', days: [1, 2, 3, 4, 5] }
    updateConfig({ svnGroup: { ...config.svnGroup, triggers: [...config.svnGroup.triggers, newTrigger] } })
  }

  const removeSvnTrigger = (triggerId: string) => {
    updateConfig({ svnGroup: { ...config.svnGroup, triggers: config.svnGroup.triggers.filter(t => t.id !== triggerId) } })
  }

  const updateSvnTrigger = (triggerId: string, updates: Partial<TriggerTime>) => {
    updateConfig({ svnGroup: { ...config.svnGroup, triggers: config.svnGroup.triggers.map(t => t.id === triggerId ? { ...t, ...updates } : t) } })
  }

  // =============== CRUD：开关任务 ===============

  const addAppTask = () => {
    const newTask: AppTask = {
      id: Date.now().toString(),
      name: `开关任务 ${config.appGroup.tasks.length + 1}`,
      exePath: '', processName: '', action: 'open', closeMode: 'force', silent: false, enabled: true,
      triggers: [{ id: Date.now().toString() + '_t', time: '09:00', days: [1, 2, 3, 4, 5] }],
    }
    updateConfig({ appGroup: { ...config.appGroup, tasks: [...config.appGroup.tasks, newTask] } })
  }

  const removeAppTask = (taskId: string) => {
    updateConfig({ appGroup: { ...config.appGroup, tasks: config.appGroup.tasks.filter(t => t.id !== taskId) } })
  }

  const updateAppTask = (taskId: string, updates: Partial<AppTask>) => {
    updateConfig({ appGroup: { ...config.appGroup, tasks: config.appGroup.tasks.map(t => t.id === taskId ? { ...t, ...updates } : t) } })
  }

  const selectExe = async (taskId: string) => {
    const filePath = await api.selectFile({ filters: [{ name: '可执行文件', extensions: ['exe', 'lnk', 'bat', 'cmd'] }] })
    if (filePath) {
      const fileName = filePath.split(/[\\/]/).pop() || ''
      const processName = fileName.endsWith('.lnk') ? '' : fileName
      updateAppTask(taskId, { exePath: filePath, processName })
    }
  }

  // =============== CRUD：更新任务 ===============

  // 从名称中提取末尾编号
  const extractSvnTaskNumber = (name: string): number => {
    const match = name.match(/(\d+)\s*$/)
    return match ? parseInt(match[1], 10) : 0
  }

  // 判断是否为默认命名风格（更新任务 N / 任务 N）
  const isDefaultSvnTaskName = (name: string): boolean => /^(?:更新)?任务\s*\d+$/.test(name)

  const addSvnTask = () => {
    // 找到下一个未使用的编号（避免删除中间任务后再次添加导致重名）
    const usedNumbers = config.svnGroup.tasks
      .map(t => extractSvnTaskNumber(t.name))
      .filter(n => n > 0)
    const nextNumber = usedNumbers.length > 0 ? Math.max(...usedNumbers) + 1 : 1
    const newTask: SvnTask = {
      id: Date.now().toString(),
      name: `更新任务 ${nextNumber}`,
      paths: [], preBat: '', postBat: '', enabled: true, enablePreBat: true, enableSvn: true, enablePostBat: true,
    }
    updateConfig({ svnGroup: { ...config.svnGroup, tasks: [...config.svnGroup.tasks, newTask] } })
  }

  const removeSvnTask = (taskId: string) => {
    // 仅对默认命名风格的任务自动重编号，保留用户自定义名称
    const remaining = config.svnGroup.tasks.filter(t => t.id !== taskId)
    const renumbered = remaining.map((t, idx) => {
      if (!isDefaultSvnTaskName(t.name)) return t
      const m = t.name.match(/^((?:更新)?任务)/)
      const prefix = m ? m[1] : '更新任务'
      return { ...t, name: `${prefix} ${idx + 1}` }
    })
    updateConfig({ svnGroup: { ...config.svnGroup, tasks: renumbered } })
  }

  const updateSvnTask = (taskId: string, updates: Partial<SvnTask>) => {
    updateConfig({ svnGroup: { ...config.svnGroup, tasks: config.svnGroup.tasks.map(t => t.id === taskId ? { ...t, ...updates } : t) } })
  }

  const addSvnPath = async (taskId: string) => {
    const dir = await api.openDirectory()
    if (dir) {
      const task = config.svnGroup.tasks.find(t => t.id === taskId)
      // 单路径模式：直接覆盖；如已有路径则提示
      if (task && task.paths[0] && task.paths[0] !== dir) {
        const confirmed = window.confirm(`当前任务已配置路径：\n${task.paths[0]}\n\n是否替换为：\n${dir}？`)
        if (!confirmed) return
      }
      if (task) updateSvnTask(taskId, { paths: [dir] })
    }
  }

  const removeSvnPath = (taskId: string, _pathToRemove: string) => {
    const task = config.svnGroup.tasks.find(t => t.id === taskId)
    if (task) updateSvnTask(taskId, { paths: [] })
  }

  const selectBatFile = async (taskId: string, field: 'preBat' | 'postBat') => {
    const filePath = await api.selectFile({ filters: [{ name: 'Batch Files', extensions: ['bat', 'cmd'] }] })
    if (filePath) updateSvnTask(taskId, { [field]: filePath })
  }

  // =============== 手动执行 SVN ===============

  const handleManualSvnRun = () => {
    const enabledTasks = config.svnGroup.tasks.filter(t => t.enabled && t.paths.length > 0)
    if (enabledTasks.length === 0) { message.warning('没有可执行的更新任务'); return }

    const hasAnyPreBat = enabledTasks.some(t => t.enablePreBat && t.preBat)
    const plan: { sliceName: string; steps: string[] }[] = []

    if (hasAnyPreBat) {
      const phase1Steps: string[] = []
      for (const task of enabledTasks) {
        if (task.enablePreBat && task.preBat) phase1Steps.push(`[${task.name}] 🔧 前置BAT: ${task.preBat}`)
      }
      if (phase1Steps.length > 0) plan.push({ sliceName: '⏱ 阶段一：并行执行所有前置BAT', steps: phase1Steps })
      for (const task of enabledTasks) {
        const steps: string[] = []
        if (task.enableSvn) for (const p of task.paths) steps.push(`📥 SVN Update: ${p}`)
        if (task.enablePostBat && task.postBat) steps.push(`🔧 后置BAT: ${task.postBat}`)
        if (steps.length > 0) plan.push({ sliceName: `⏱ 阶段二 - ${task.name}（并行）`, steps })
      }
    } else {
      for (const task of enabledTasks) {
        const steps: string[] = []
        if (task.enableSvn) for (const p of task.paths) steps.push(`📥 SVN Update: ${p}`)
        if (task.enablePostBat && task.postBat) steps.push(`🔧 后置BAT: ${task.postBat}`)
        if (steps.length > 0) plan.push({ sliceName: task.name, steps })
      }
    }

    if (plan.length === 0) { message.warning('当前配置下没有需要执行的操作'); return }
    setExecutionPlan(plan)
    setConfirmVisible(true)
  }

  const confirmAndRun = () => {
    setConfirmVisible(false)
    executeSvnGroup()
  }

  const getLogColor = (type: LogEntry['type']) => {
    switch (type) {
      case 'success': return '#52c41a'
      case 'error': return '#ff4d4f'
      case 'warning': return '#faad14'
      default: return '#333'
    }
  }

  const getSvnTotalPercent = () => {
    const progs = config.svnGroup.tasks.filter(t => svnProgress[t.id]).map(t => svnProgress[t.id])
    if (progs.length === 0) return 0
    const total = progs.reduce((s, p) => s + p.total, 0)
    const done = progs.reduce((s, p) => s + p.current, 0)
    return total === 0 ? 0 : Math.round((done / total) * 100)
  }

  // =============== 渲染：单个开关任务的触发时间 ===============

  const renderAppTaskTriggers = (task: AppTask) => (
    <div style={{ marginBottom: 8, padding: '8px 0', borderBottom: '1px dashed #f0f0f0' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <ClockCircleOutlined style={{ marginRight: 6, color: '#fa8c16' }} />
        <span style={{ fontSize: 12, fontWeight: 500, marginRight: 8 }}>触发时间</span>
        <Button size="small" icon={<PlusOutlined />} onClick={() => addAppTaskTrigger(task.id)} disabled={appGroupRunning}>添加</Button>
      </div>
      {task.triggers.length === 0 ? (
        <div style={{ color: '#999', fontSize: 12, paddingLeft: 20 }}>暂无触发时间（仅手动执行时可用）</div>
      ) : (
        <Space direction="vertical" style={{ width: '100%', paddingLeft: 20 }}>
          {task.triggers.map((trigger, idx) => (
            <div key={trigger.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Tag color="orange">#{idx + 1}</Tag>
              <TimePicker value={dayjs(trigger.time, 'HH:mm')} format="HH:mm" size="small"
                onChange={(_, timeStr) => { if (timeStr) updateAppTaskTrigger(task.id, trigger.id, { time: timeStr as string }) }} />
              <span style={{ fontSize: 12 }}>每周：</span>
              {dayNames.map((name, dayIdx) => (
                <Checkbox key={dayIdx} checked={trigger.days.includes(dayIdx)}
                  onChange={e => {
                    const newDays = e.target.checked ? [...trigger.days, dayIdx].sort() : trigger.days.filter(d => d !== dayIdx)
                    updateAppTaskTrigger(task.id, trigger.id, { days: newDays })
                  }}>{name}</Checkbox>
              ))}
              <Button size="small" danger icon={<DeleteOutlined />} onClick={() => removeAppTaskTrigger(task.id, trigger.id)} disabled={appGroupRunning} />
            </div>
          ))}
        </Space>
      )}
    </div>
  )

  // =============== 渲染：更新任务组的触发时间 ===============

  const renderSvnTriggers = () => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <ClockCircleOutlined style={{ marginRight: 6 }} />
        <span style={{ fontWeight: 500, marginRight: 8 }}>触发时间</span>
        <Button size="small" icon={<PlusOutlined />} onClick={addSvnTrigger} disabled={svnGroupRunning}>添加</Button>
      </div>
      {config.svnGroup.triggers.length === 0 ? (
        <div style={{ color: '#999', fontSize: 12, paddingLeft: 20 }}>暂无触发时间（手动执行不需要配置）</div>
      ) : (
        <Space direction="vertical" style={{ width: '100%', paddingLeft: 20 }}>
          {config.svnGroup.triggers.map((trigger, idx) => (
            <div key={trigger.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Tag color="orange">#{idx + 1}</Tag>
              <TimePicker value={dayjs(trigger.time, 'HH:mm')} format="HH:mm" size="small"
                onChange={(_, timeStr) => { if (timeStr) updateSvnTrigger(trigger.id, { time: timeStr as string }) }} />
              <span style={{ fontSize: 12 }}>每周：</span>
              {dayNames.map((name, dayIdx) => (
                <Checkbox key={dayIdx} checked={trigger.days.includes(dayIdx)}
                  onChange={e => {
                    const newDays = e.target.checked ? [...trigger.days, dayIdx].sort() : trigger.days.filter(d => d !== dayIdx)
                    updateSvnTrigger(trigger.id, { days: newDays })
                  }}>{name}</Checkbox>
              ))}
              <Button size="small" danger icon={<DeleteOutlined />} onClick={() => removeSvnTrigger(trigger.id)} disabled={svnGroupRunning} />
            </div>
          ))}
        </Space>
      )}
    </div>
  )

  // =============== 主渲染 ===============

  const appTaskCount = config.appGroup.tasks.length
  const svnTaskCount = config.svnGroup.tasks.length

  return (
    <div>
      <div className="page-title">定时任务</div>

      {/* ====== 全局定时器开关 ====== */}
      <Card size="small"
        style={{ marginBottom: 16, background: config.timerEnabled ? '#f6ffed' : '#fff2f0', borderColor: config.timerEnabled ? '#b7eb8f' : '#ffccc7' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Space>
            <Switch checked={config.timerEnabled} onChange={v => updateConfig({ timerEnabled: v })}
              checkedChildren="开" unCheckedChildren="关" />
            <span style={{ fontWeight: 600, fontSize: 16 }}>
              {config.timerEnabled ? '⏰ 定时器已开启' : '⏸ 定时器已关闭'}
            </span>
          </Space>
          <Button size="small" onClick={() => { setLogs([]); setSvnProgress({}) }}>清空日志</Button>
        </div>
      </Card>

      {/* ====== 开关任务组 ====== */}
      <Card
        size="small"
        title={
          <Space>
            <span style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }} onClick={() => setAppGroupExpanded(!appGroupExpanded)}>
              {appGroupExpanded ? <DownOutlined style={{ fontSize: 12, marginRight: 6 }} /> : <RightOutlined style={{ fontSize: 12, marginRight: 6 }} />}
            </span>
            <Switch size="small" checked={config.appGroup.enabled}
              onChange={v => updateConfig({ appGroup: { ...config.appGroup, enabled: v } })}
              disabled={appGroupRunning} />
            <PoweroffOutlined style={{ color: '#722ed1' }} />
            <span style={{ fontWeight: 600 }}>开关任务组</span>
            <Tag color="purple">{appTaskCount} 个任务</Tag>
            {appGroupRunning && <Tag color="processing">执行中...</Tag>}
          </Space>
        }
        extra={
          <Space>
            {appGroupRunning ? (
              <Button size="small" danger icon={<StopOutlined />} onClick={() => { abortRef.current.app = true }}>中止</Button>
            ) : (
              <Button type="primary" icon={<PlayCircleOutlined />} onClick={executeAppGroup}
                disabled={!config.appGroup.tasks.some(t => t.enabled)}
                style={{ fontWeight: 600 }}>
                手动执行
              </Button>
            )}
            <Button size="small" icon={<CheckCircleOutlined />} onClick={refreshRunningStates}>刷新状态</Button>
          </Space>
        }
        style={{ marginBottom: 16, opacity: config.appGroup.enabled ? 1 : 0.6 }}
      >
        {appGroupExpanded && (
          <>
            {/* 开关任务列表 */}
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontWeight: 500, marginRight: 8 }}>任务列表</span>
              <Button size="small" icon={<PlusOutlined />} onClick={addAppTask} disabled={appGroupRunning}>添加任务</Button>
            </div>

            {config.appGroup.tasks.length === 0 ? (
              <div style={{ color: '#999', textAlign: 'center', padding: 16 }}>暂无任务，点击"添加任务"</div>
            ) : (
              <Collapse
                size="small"
                defaultActiveKey={config.appGroup.tasks.map(t => t.id)}
                items={config.appGroup.tasks.map(task => ({
                  key: task.id,
                  label: (
                    <Space>
                      <Switch size="small" checked={task.enabled} onChange={v => updateAppTask(task.id, { enabled: v })}
                        onClick={e => e.stopPropagation()} disabled={appGroupRunning} />
                      <span style={{ opacity: task.enabled ? 1 : 0.5 }}>{task.name}</span>
                      <Tag color={task.action === 'open' ? 'green' : 'red'}>{task.action === 'open' ? '启动' : '关闭'}</Tag>
                      {task.triggers.length > 0 && <Tag color="orange">{task.triggers.length} 个触发时间</Tag>}
                      {task.processName && (
                        <Tag color={runningStates[task.processName] ? 'green' : 'default'}
                          icon={runningStates[task.processName] ? <CheckCircleOutlined /> : <CloseCircleOutlined />}>
                          {runningStates[task.processName] ? '运行中' : '未运行'}
                        </Tag>
                      )}
                    </Space>
                  ),
                  extra: (
                    <Popconfirm title="删除此任务？" onConfirm={e => { e?.stopPropagation(); removeAppTask(task.id) }}
                      onCancel={e => e?.stopPropagation()}>
                      <Button size="small" danger icon={<DeleteOutlined />} disabled={appGroupRunning} onClick={e => e.stopPropagation()} />
                    </Popconfirm>
                  ),
                  children: (
                    <Space direction="vertical" style={{ width: '100%' }}>
                      {/* 触发时间（绑定到每个任务） */}
                      {renderAppTaskTriggers(task)}

                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>任务名：</span>
                        <Input size="small" value={task.name} onChange={e => updateAppTask(task.id, { name: e.target.value })} style={{ width: 120 }} />
                        <Select size="small" value={task.action} onChange={v => updateAppTask(task.id, { action: v })} style={{ width: 80 }}
                          options={[{ value: 'open', label: '启动' }, { value: 'close', label: '关闭' }]} />
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>软件路径：</span>
                        <Input size="small" value={task.exePath} onChange={e => updateAppTask(task.id, { exePath: e.target.value })}
                          placeholder="选择或输入 exe 路径" style={{ flex: 1, minWidth: 200 }} />
                        <Button size="small" icon={<FolderOpenOutlined />} onClick={() => selectExe(task.id)}>选择</Button>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>进程名：</span>
                        <Input size="small" value={task.processName} onChange={e => updateAppTask(task.id, { processName: e.target.value })}
                          placeholder="如 WXWork.exe" style={{ width: 200 }} />
                        {task.action === 'close' && (
                          <>
                            <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>关闭方式：</span>
                            <Select size="small" value={task.closeMode} onChange={v => updateAppTask(task.id, { closeMode: v })} style={{ width: 100 }}
                              options={[{ value: 'force', label: '强制关闭' }, { value: 'graceful', label: '优雅关闭' }]} />
                          </>
                        )}
                        {task.action === 'open' && (
                          <Checkbox checked={task.silent} onChange={e => updateAppTask(task.id, { silent: e.target.checked })}>静默启动</Checkbox>
                        )}
                      </div>
                    </Space>
                  ),
                }))}
              />
            )}
          </>
        )}
      </Card>

      {/* ====== 更新任务组 ====== */}
      <Card
        size="small"
        title={
          <Space>
            <span style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }} onClick={() => setSvnGroupExpanded(!svnGroupExpanded)}>
              {svnGroupExpanded ? <DownOutlined style={{ fontSize: 12, marginRight: 6 }} /> : <RightOutlined style={{ fontSize: 12, marginRight: 6 }} />}
            </span>
            <Switch size="small" checked={config.svnGroup.enabled}
              onChange={v => updateConfig({ svnGroup: { ...config.svnGroup, enabled: v } })}
              disabled={svnGroupRunning} />
            <SyncOutlined style={{ color: '#13c2c2' }} />
            <span style={{ fontWeight: 600 }}>更新任务组</span>
            <Tag color="cyan">{svnTaskCount} 个任务</Tag>
            {svnGroupRunning && <Tag color="processing">执行中...</Tag>}
          </Space>
        }
        extra={
          <Space>
            {svnGroupRunning ? (
              <Button size="small" danger icon={<StopOutlined />} onClick={() => { abortRef.current.svn = true }}>中止</Button>
            ) : (
              <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleManualSvnRun}
                disabled={!config.svnGroup.tasks.some(t => t.enabled && t.paths.length > 0)}
                style={{ fontWeight: 600 }}>
                手动执行
              </Button>
            )}
          </Space>
        }
        style={{ marginBottom: 16, opacity: config.svnGroup.enabled ? 1 : 0.6 }}
      >
        {/* SVN 进度条（始终显示，即使收起也展示） */}
        {svnGroupRunning && (
          <div style={{ marginBottom: 12 }}>
            <Progress percent={getSvnTotalPercent()} status="active" size="small" />
            {config.svnGroup.tasks.filter(t => svnProgress[t.id]).map(task => (
              <div key={task.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <span style={{ fontSize: 12, width: 80, flexShrink: 0 }}>{task.name}:</span>
                <Progress percent={svnProgress[task.id]?.total > 0 ? Math.round((svnProgress[task.id].current / svnProgress[task.id].total) * 100) : 0}
                  size="small" style={{ flex: 1, margin: 0 }}
                  status={svnProgress[task.id]?.current === svnProgress[task.id]?.total ? 'success' : 'active'} />
                <span style={{ fontSize: 11, color: '#999', width: 120, flexShrink: 0 }}>{svnProgress[task.id]?.text}</span>
              </div>
            ))}
          </div>
        )}

        {svnGroupExpanded && (
          <>
            {/* 触发时间 */}
            {renderSvnTriggers()}

            {/* 更新任务列表 */}
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontWeight: 500, marginRight: 8 }}>任务列表</span>
              <Button size="small" icon={<PlusOutlined />} onClick={addSvnTask} disabled={svnGroupRunning}>添加任务</Button>
            </div>

            {config.svnGroup.tasks.length === 0 ? (
              <div style={{ color: '#999', textAlign: 'center', padding: 16 }}>暂无任务，点击"添加任务"</div>
            ) : (
              <Collapse
                size="small"
                defaultActiveKey={config.svnGroup.tasks.map(t => t.id)}
                items={config.svnGroup.tasks.map(task => ({
                  key: task.id,
                  label: (
                    <Space>
                      <Checkbox checked={task.enabled} onChange={e => { e.stopPropagation(); updateSvnTask(task.id, { enabled: e.target.checked }) }}
                        onClick={e => e.stopPropagation()} disabled={svnGroupRunning} />
                      <span style={{ opacity: task.enabled ? 1 : 0.5 }}>{task.name}</span>
                      <Tag color={task.paths[0] ? 'blue' : 'default'}>{task.paths[0] ? '已配置' : '未配置'}</Tag>
                      {task.preBat && <Tag color={task.enablePreBat ? 'orange' : 'default'}>{task.enablePreBat ? '前置BAT' : '前置BAT(禁用)'}</Tag>}
                      {task.postBat && <Tag color={task.enablePostBat ? 'green' : 'default'}>{task.enablePostBat ? '后置BAT' : '后置BAT(禁用)'}</Tag>}
                      {!task.enableSvn && <Tag color="default">SVN(禁用)</Tag>}
                    </Space>
                  ),
                  extra: (
                    <Popconfirm title="确认删除？" onConfirm={e => { e?.stopPropagation(); removeSvnTask(task.id) }}
                      onCancel={e => e?.stopPropagation()}>
                      <Button size="small" danger icon={<DeleteOutlined />} disabled={svnGroupRunning} onClick={e => e.stopPropagation()} />
                    </Popconfirm>
                  ),
                  children: (
                    <Space direction="vertical" style={{ width: '100%', opacity: task.enabled ? 1 : 0.5 }}>
                      <div>
                        <span style={{ marginRight: 8 }}>任务名称：</span>
                        <Input size="small" value={task.name} onChange={e => updateSvnTask(task.id, { name: e.target.value })}
                          style={{ width: 200 }} disabled={svnGroupRunning} />
                      </div>
                      <Card size="small" title="工程目录" extra={
                        <Space size={4}>
                          <Button size="small" icon={<FolderOpenOutlined />} onClick={() => addSvnPath(task.id)} disabled={svnGroupRunning}>
                            {task.paths[0] ? '更换' : '选择目录'}
                          </Button>
                          {task.paths[0] && (
                            <Button size="small" onClick={() => removeSvnPath(task.id, task.paths[0])} disabled={svnGroupRunning}>
                              清除
                            </Button>
                          )}
                        </Space>
                      }>
                        {task.paths[0] ? (
                          <div style={{ fontSize: 12, wordBreak: 'break-all' }} title={task.paths[0]}>
                            {task.paths[0].length > 80 ? '...' + task.paths[0].slice(-80) : task.paths[0]}
                          </div>
                        ) : (
                          <div style={{ color: '#999', textAlign: 'center' }}>未选择目录</div>
                        )}
                      </Card>
                      <div>
                        <Space>
                          <Switch size="small" checked={task.enablePreBat} onChange={v => updateSvnTask(task.id, { enablePreBat: v })} disabled={svnGroupRunning} />
                          <span style={{ opacity: task.enablePreBat ? 1 : 0.5 }}>前置BAT：</span>
                          <Input size="small" value={task.preBat} onChange={e => updateSvnTask(task.id, { preBat: e.target.value })}
                            placeholder="可选" style={{ width: 300, opacity: task.enablePreBat ? 1 : 0.5 }} disabled={svnGroupRunning || !task.enablePreBat} />
                          <Button size="small" icon={<FileAddOutlined />} onClick={() => selectBatFile(task.id, 'preBat')} disabled={svnGroupRunning || !task.enablePreBat}>选择</Button>
                          {task.preBat && <Button size="small" onClick={() => updateSvnTask(task.id, { preBat: '' })} disabled={svnGroupRunning}>清除</Button>}
                        </Space>
                      </div>
                      <div>
                        <Space>
                          <Switch size="small" checked={task.enableSvn} onChange={v => updateSvnTask(task.id, { enableSvn: v })} disabled={svnGroupRunning} />
                          <span style={{ opacity: task.enableSvn ? 1 : 0.5 }}>执行 SVN Update</span>
                        </Space>
                      </div>
                      <div>
                        <Space>
                          <Switch size="small" checked={task.enablePostBat} onChange={v => updateSvnTask(task.id, { enablePostBat: v })} disabled={svnGroupRunning} />
                          <span style={{ opacity: task.enablePostBat ? 1 : 0.5 }}>后置BAT：</span>
                          <Input size="small" value={task.postBat} onChange={e => updateSvnTask(task.id, { postBat: e.target.value })}
                            placeholder="可选" style={{ width: 300, opacity: task.enablePostBat ? 1 : 0.5 }} disabled={svnGroupRunning || !task.enablePostBat} />
                          <Button size="small" icon={<FileAddOutlined />} onClick={() => selectBatFile(task.id, 'postBat')} disabled={svnGroupRunning || !task.enablePostBat}>选择</Button>
                          {task.postBat && <Button size="small" onClick={() => updateSvnTask(task.id, { postBat: '' })} disabled={svnGroupRunning}>清除</Button>}
                        </Space>
                      </div>
                    </Space>
                  ),
                }))}
              />
            )}
          </>
        )}
      </Card>

      {/* ====== SVN 确认弹窗 ====== */}
      <Modal title="确认执行 SVN 操作" open={confirmVisible} onOk={confirmAndRun} onCancel={() => setConfirmVisible(false)}
        okText="确认执行" cancelText="取消" width={600}>
        <div style={{ maxHeight: 400, overflow: 'auto' }}>
          {executionPlan.some(item => item.sliceName.includes('阶段一')) ? (
            <p style={{ marginBottom: 8, color: '#fa8c16', fontWeight: 500 }}>
              ⚡ 阶段一并行执行前置BAT → 等全部完成 → 阶段二并行执行SVN和后置BAT
            </p>
          ) : (
            <p style={{ marginBottom: 8, color: '#1677ff', fontWeight: 500 }}>⚡ 各任务将并行执行</p>
          )}
          {executionPlan.map((item, idx) => (
            <Card key={idx} size="small" title={`📋 ${item.sliceName}`} style={{ marginBottom: 8 }}>
              {item.steps.map((step, stepIdx) => (
                <div key={stepIdx} style={{ padding: '4px 0', fontSize: 13 }}>{step}</div>
              ))}
            </Card>
          ))}
        </div>
      </Modal>

      {/* ====== 执行日志 ====== */}
      <Card size="small" title="执行日志" style={{ marginTop: 16 }}>
        <div style={{ maxHeight: 300, overflow: 'auto', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6 }}>
          {logs.length === 0 ? (
            <div style={{ color: '#999', textAlign: 'center' }}>暂无日志</div>
          ) : (
            logs.map((log, i) => (
              <div key={i} style={{ color: getLogColor(log.type) }}>
                <span style={{ color: '#888' }}>[{log.time}]</span>
                <span style={{ color: '#1677ff', marginLeft: 4 }}>[{log.source}]</span>
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
