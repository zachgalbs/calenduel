import { Component, type ReactNode } from 'react'

// Around the pages that load on demand (Compete and parts of
// Account). A deploy replaces those files, so a tab opened before it can't
// fetch them any more: without this, the whole app goes blank. With it, only
// that page asks for a reload. It never reloads by itself, because a reload in
// the middle of a session would lose the recording; these pages aren't shown
// during a session anyway.
export default class PageBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.error('page failed to load', error)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="page-failed" role="alert">
        <p>This couldn't load.</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}
