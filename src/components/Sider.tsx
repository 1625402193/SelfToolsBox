import { useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { Layout, Menu, Switch, Tooltip } from 'antd'
import {
  FolderOutlined,
  SwapOutlined,
  FileTextOutlined,
  CameraOutlined,
  AimOutlined,
  ClockCircleOutlined,
  StarOutlined,
  PushpinOutlined,
} from '@ant-design/icons'

const { Sider } = Layout

const edition = import.meta.env.VITE_EDITION || 'full'

// editions 列表：指定该菜单项在哪些版本中可见
// 注：「配置说明」「更新日志」已移至顶部原生菜单栏，不在侧边栏显示
const allMenuItems = [
  { key: '/classify', icon: <FolderOutlined />, label: '文件分类', editions: ['full', 'normal'] },
  { key: '/batch', icon: <SwapOutlined />, label: '批量移动', editions: ['full', 'normal'] },
  { key: '/rating', icon: <StarOutlined />, label: '媒体评分', editions: ['full', 'normal'] },
  { key: '/report', icon: <FileTextOutlined />, label: '日报周报', editions: ['full', 'work'] },
  { key: '/capture', icon: <CameraOutlined />, label: '截图录屏', editions: ['full', 'work', 'normal'] },
  { key: '/autoclick', icon: <AimOutlined />, label: '自动点击', editions: ['full', 'work', 'normal'] },
  { key: '/scheduled', icon: <ClockCircleOutlined />, label: '定时任务', editions: ['full', 'work'] },
]

const menuItems = allMenuItems.filter(item => item.editions.includes(edition))

export default function AppSider() {
  const location = useLocation()
  const navigate = useNavigate()
  const [alwaysOnTop, setAlwaysOnTop] = useState(true)

  // 读取主进程当前置顶状态，并监听菜单栏切换事件保持同步
  useEffect(() => {
    const api = window.electronAPI
    if (!api) return
    api.getAlwaysOnTop?.().then(res => {
      if (res?.success) setAlwaysOnTop(res.enabled)
    }).catch(() => {})
    const off = api.onAlwaysOnTopChanged?.(enabled => setAlwaysOnTop(enabled))
    return () => { off?.() }
  }, [])

  const handleToggle = async (checked: boolean) => {
    setAlwaysOnTop(checked)
    try {
      await window.electronAPI?.setAlwaysOnTop?.(checked)
    } catch {
      // 失败时回滚
      setAlwaysOnTop(!checked)
    }
  }

  return (
    <Sider width={180} theme="light" style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', borderBottom: '1px solid #f0f0f0' }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: '#1677ff' }}>
          {edition === 'work' ? '工具箱(工作版)' : edition === 'normal' ? '工具箱(普通版)' : '工具箱'}
        </span>
      </div>
      <Menu
        mode="inline"
        selectedKeys={[location.pathname]}
        items={menuItems}
        onClick={({ key }) => navigate(key)}
        style={{ borderRight: 0, flex: 1 }}
      />
      {/* 底部：窗口置顶开关 */}
      <div style={{ borderTop: '1px solid #f0f0f0', padding: '10px 12px' }}>
        <Tooltip title="开启后工具箱窗口始终显示在其他窗口之上（失去焦点时会临时让位，避免遮挡截图工具选区）" placement="right">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, color: '#555' }}>
              <PushpinOutlined style={{ marginRight: 6, color: alwaysOnTop ? '#1677ff' : '#bbb' }} />
              窗口置顶
            </span>
            <Switch size="small" checked={alwaysOnTop} onChange={handleToggle} />
          </div>
        </Tooltip>
      </div>
    </Sider>
  )
}
