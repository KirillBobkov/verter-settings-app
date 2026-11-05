import { Link } from 'react-router-dom'

/** Заглушки экранов, которые приходят в следующих фазах (см. README, дорожная карта). */
export function PlaceholderPage({ title, phase }: { title: string; phase: string }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      <p className="muted">
        Экран в разработке — фаза {phase}. Архитектура и контракты описаны в{' '}
        <code>docs/PLAN.md</code> репозитория <code>nats-hub</code> (Часть D).
      </p>
      <p>
        <Link to="/">← К мониторингу</Link>
      </p>
    </section>
  )
}
