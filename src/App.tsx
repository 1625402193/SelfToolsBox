import { useLocation, useNavigate } from 'react-router-dom'
import { useEffect } from 'react'
import { Layout } from 'antd'
import AppSider from './components/Sider'
import FileClassify from './pages/FileClassify'
import BatchMove from './pages/BatchMove'
import DailyReport from './pages/DailyReport'
import ScreenCapture from './pages/ScreenCapture'
import AutoClick from './pages/AutoClick'
import ScheduledTasks from './pages/ScheduledTasks'
import ConfigDoc from './pages/ConfigDoc'
import MediaRating from './pages/MediaRating'
import Changelog from './pages/Changelog'

const { Content } = Layout
const edition = import.meta.env.VITE_EDITION || 'full'

// 各版本可访问的路由
const routePermissions: Record<string, string[]> = {
  full: ['/classify', '/batch', '/rating', '/report', '/capture', '/autoclick', '/scheduled', '/config', '/changelog'],
  work: ['/report', '/capture', '/autoclick', '/scheduled', '/changelog'],
  normal: ['/classify', '/batch', '/rating', '/capture', '/autoclick', '/config', '/changelog'],
}
const allowedRoutes = routePermissions[edition] || routePermissions.full
const canAccess = (path: string) => allowedRoutes.includes(path)

// 文档类页面：放在顶部原生菜单栏，不在侧边栏显示
const docPages = [
  { label: '配置说明', route: '/config' },
  { label: '更新日志', route: '/changelog' },
]

export default function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const currentPath = location.pathname

  // 各版本默认路由
  const defaultRoute = edition === 'work' ? '/report' : edition === 'normal' ? '/classify' : '/classify'

  useEffect(() => {
    if (currentPath === '/') {
      navigate(defaultRoute, { replace: true })
    }
  }, [currentPath, defaultRoute, navigate])

  // 向主进程上报本版本可访问的文档类页面，并监听菜单栏点击跳转
  useEffect(() => {
    const api = window.electronAPI
    if (!api) return
    api.menuSetup?.(docPages.filter(p => canAccess(p.route)))
    const off = api.onMenuNavigate?.(route => {
      if (canAccess(route)) navigate(route)
    })
    return () => { off?.() }
  }, [navigate])

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <AppSider />
      <Layout>
        <Content style={{ margin: 16, padding: 24, background: '#fff', borderRadius: 8, overflow: 'auto' }}>
          {/* 使用 display 控制显隐，避免组件卸载导致运行状态丢失 */}
          {canAccess('/classify') && (
            <div style={{ display: currentPath === '/classify' ? 'block' : 'none' }}>
              <FileClassify />
            </div>
          )}
          {canAccess('/batch') && (
            <div style={{ display: currentPath === '/batch' ? 'block' : 'none' }}>
              <BatchMove />
            </div>
          )}
          {canAccess('/rating') && (
            <div style={{ display: currentPath === '/rating' ? 'block' : 'none' }}>
              <MediaRating />
            </div>
          )}
          {canAccess('/report') && (
            <div style={{ display: currentPath === '/report' ? 'block' : 'none' }}>
              <DailyReport />
            </div>
          )}
          {canAccess('/capture') && (
            <div style={{ display: currentPath === '/capture' ? 'block' : 'none' }}>
              <ScreenCapture />
            </div>
          )}
          {canAccess('/autoclick') && (
            <div style={{ display: currentPath === '/autoclick' ? 'block' : 'none' }}>
              <AutoClick />
            </div>
          )}
          {canAccess('/scheduled') && (
            <div style={{ display: currentPath === '/scheduled' ? 'block' : 'none' }}>
              <ScheduledTasks />
            </div>
          )}
          {canAccess('/config') && (
            <div style={{ display: currentPath === '/config' ? 'block' : 'none' }}>
              <ConfigDoc />
            </div>
          )}
          {canAccess('/changelog') && (
            <div style={{ display: currentPath === '/changelog' ? 'block' : 'none' }}>
              <Changelog />
            </div>
          )}
        </Content>
      </Layout>
    </Layout>
  )
}
