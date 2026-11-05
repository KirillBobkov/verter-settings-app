import { HashRouter, Link, NavLink, Route, Routes } from 'react-router-dom'
import { useEffect } from 'react'
import { useConnection } from './stores/connection'
import { ConnectionBadge } from './components/ConnectionBadge'
import { MonitorPage } from './pages/MonitorPage'
import { SettingsPage } from './pages/SettingsPage'
import { PlaceholderPage } from './pages/PlaceholderPage'

const nav = [
  { to: '/', label: 'Мониторинг' },
  { to: '/map', label: 'Карта' },
  { to: '/battery-history', label: 'История BMS' },
  { to: '/settings', label: 'Настройки' },
]

export default function App() {
  const init = useConnection((s) => s.init)
  useEffect(() => {
    void init()
  }, [init])

  return (
    <HashRouter>
      <header className="topbar">
        <span className="brand">Verter · verter_01</span>
        <nav>
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <ConnectionBadge />
      </header>
      <main>
        <Routes>
          <Route path="/" element={<MonitorPage />} />
          <Route path="/map" element={<PlaceholderPage title="Живая карта" phase="M2" />} />
          <Route path="/battery-history" element={<PlaceholderPage title="История BMS" phase="M3" />} />
          <Route path="/camera" element={<PlaceholderPage title="Камера" phase="M4" />} />
          <Route path="/lidar" element={<PlaceholderPage title="Лидар" phase="M4" />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<PlaceholderPage title="Страница не найдена" phase="—" />} />
        </Routes>
      </main>
      <footer className="muted small">
        Программный стоп ≠ аппаратный аварийный выключатель. Ручное управление не включает
        объезд препятствий. <Link to="/settings">Выдача кредов</Link>.
      </footer>
    </HashRouter>
  )
}
