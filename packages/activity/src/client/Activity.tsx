/** Sidebar launcher and the window-owned recent activity dialog. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { IconCloseOutlineRegular, IconEllipsisOutlineRegular, isBehindModal, Menu, Modal, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ActivityLauncherProps, ActivityOverlayProps } from './contract.ts'
import { dateBucket, type ActivityRow } from './model.ts'
import css from './activity.module.css'

/** Bell outline matching the user-supplied activity reference. */
function Bell() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 20a3 3 0 0 0 6 0M5 9a7 7 0 0 1 14 0v4.5l1.5 3a1 1 0 0 1-.9 1.5H4.4a1 1 0 0 1-.9-1.5l1.5-3Z" />
  </svg>
}

/** @param props - Footer geometry, activity state and toggle action. @returns Activity launcher. */
export function ActivityLauncher({ useActivity, useView, useShortcuts, viewActions, wide, t }: ActivityLauncherProps) {
  const unread = useActivity(data => data.rows.some(row => row.unread || row.status === 'attention'))
  const opened = useView(value => value.open)
  const shortcut = useShortcuts(entries => entries.find(entry => entry.id === 'better-activity.toggle'))
  return <Tooltip label={t('activity')} shortcutKeys={shortcut?.keys} side={wide ? 'top' : 'right'} portal>
    <button type="button" className={clsx(css.launcher, !wide && css.rail, opened && css.active)} aria-label={t('activity')}
      aria-haspopup="dialog" aria-expanded={opened} aria-keyshortcuts={shortcut?.aria} onClick={viewActions.toggle}>
      <span className={css.launcherIcon}><Bell />{unread && <span className={css.unread} aria-label={t('unread')} />}</span>
      {wide && <span className={css.launcherLabel}>{t('activity')}</span>}
    </button>
  </Tooltip>
}

function dateLabel(row: ActivityRow, now: number, t: ActivityOverlayProps['t']): { key: string; label: string } {
  const bucket = dateBucket(row.activityAt, now)
  return { key: bucket.key, label: bucket.kind === 'today' || bucket.kind === 'yesterday' ? t(bucket.kind)
    : new Intl.DateTimeFormat(t('locale'), bucket.kind === 'weekday' ? { weekday: 'long' } : { year: 'numeric', month: 'long', day: 'numeric' }).format(bucket.date) }
}

/** @param props - Window view state and native activity actions. @returns The active dialog, if opened. */
export function ActivityOverlay(props: ActivityOverlayProps) {
  const opened = props.useView(value => value.open)
  const externalFocus = useRef<HTMLElement | null>(null)
  const closeForNavigation = useCallback((target: HTMLElement): void => {
    externalFocus.current = target
    props.viewActions.close()
  }, [props.viewActions])
  useLayoutEffect(() => {
    if (opened) return
    const target = externalFocus.current
    externalFocus.current = null
    // The primitive returns focus during cleanup; native navigation keeps its chosen destination.
    if (target?.isConnected && !target.closest('[hidden], [inert]') && !isBehindModal(target)) target.focus({ preventScroll: true })
  }, [opened])
  return opened ? <ActivityDialog {...props} closeForNavigation={closeForNavigation} /> : null
}

function ActivityDialog({ useActivity, useView, useContextMenu, viewActions, open, markRead, refresh, t, closeForNavigation }: ActivityOverlayProps & {
  closeForNavigation: (target: HTMLElement) => void
}) {
  const data = useActivity(value => value)
  const view = useView(value => value)
  const menus = useContextMenu()
  const content = useRef<HTMLDivElement | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  const restoreTop = useRef<number | null>(view.scrollTop)
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now)
  const rememberScroll = useCallback((): void => {
    if (scroller.current) viewActions.rememberScroll(scroller.current.scrollTop)
  }, [viewActions])
  const close = useCallback((): void => { rememberScroll(); viewActions.close() }, [rememberScroll, viewActions])
  useLayoutEffect(() => {
    const node = scroller.current
    if (node && restoreTop.current !== null) {
      node.scrollTop = restoreTop.current
      if (data.rows.length > 0 || data.phase === 'ready') restoreTop.current = null
    }
  }, [data.rows.length, data.phase])
  useLayoutEffect(() => {
    const node = scroller.current
    return () => { if (node) viewActions.rememberScroll(node.scrollTop) }
  }, [viewActions])
  useLayoutEffect(() => {
    const dialog = content.current?.closest<HTMLElement>('[role="dialog"]')
    if (!dialog) return
    let previous = dialog.contains(document.activeElement) ? document.activeElement as HTMLElement : dialog
    const focus = (event: FocusEvent): void => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (dialog.contains(target)) { previous = target; return }
      if (target.closest('[role="menu"]')) return
      const navigation = target.closest('[data-sidebar-scrollport], [role="dialog"][aria-modal="true"], [data-sidebar-right-open], [data-sidebar-right-session] [data-dockkit-float]')
      if (navigation && !target.closest('[hidden], [inert]')) { rememberScroll(); closeForNavigation(target); return }
      // A background composer's startup autofocus does not dismiss a restored activity dialog.
      if (document.activeElement === target && !isBehindModal(dialog)) {
        const destination = previous.isConnected && dialog.contains(previous) && !previous.closest('[hidden], [inert]') ? previous : dialog
        destination.focus({ preventScroll: true })
      }
    }
    document.addEventListener('focusin', focus)
    return () => { document.removeEventListener('focusin', focus) }
  }, [closeForNavigation, rememberScroll])
  useEffect(() => {
    const next = new Date(); next.setHours(24, 0, 0, 0)
    const timer = window.setTimeout(() => { setNow(Date.now()) }, next.getTime() - Date.now() + 50)
    return () => { window.clearTimeout(timer) }
  }, [now])
  const groups = useMemo(() => {
    const result: { key: string; label: string; rows: ActivityRow[] }[] = []
    for (const row of data.rows.slice(0, view.limit)) {
      const label = row.priority < 4 ? { key: 'priority', label: t('priority') } : dateLabel(row, now, t)
      let group = result.find(value => value.key === label.key)
      if (!group) { group = { ...label, rows: [] }; result.push(group) }
      group.rows.push(row)
    }
    return result
  }, [data.rows, view.limit, now, t])
  const acknowledgeAll = async (): Promise<void> => {
    setMenuOpen(false); setBusy(true)
    try { await markRead(data.rows.flatMap(row => row.readTargets)) } finally { setBusy(false) }
  }
  const notice = data.catalogError ? t('catalogUnavailable') : data.mutationError ? t('readFailed') : data.phase === 'offline' || data.phase === 'error' || data.summaryError ? t('unavailable') : null
  return <Modal open headless title={t('title')} onClose={close} shortcutModal="sidebar" className={css.dialog}>
    <div ref={content} className={css.root}>
      <header className={css.dialogHeader}><h2>{t('title')}</h2><button type="button" className={css.iconButton} aria-label={t('close')} onClick={close}><IconCloseOutlineRegular size={14} /></button></header>
      {notice && <div className={css.notice} role="status">{notice}{!data.catalogError && <button type="button" onClick={() => { void refresh() }}>{t('retry')}</button>}</div>}
      <div ref={scroller} className={css.scroller} role="region" aria-label={t('list')} onScroll={rememberScroll} onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-activity-row]')]
        const position = buttons.indexOf(document.activeElement as HTMLButtonElement)
        if (position < 0) return
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, position + (event.key === 'ArrowDown' ? 1 : -1)))
        event.preventDefault(); buttons[next]?.focus()
      }}>
        {groups.map(group => <section key={group.key} className={css.group} aria-label={group.label}>
          <div className={css.heading}><span>{group.label}</span>{group.key === 'priority' && <Menu open={menuOpen} onClose={() => setMenuOpen(false)} portal align="end" dense
            items={[{ id: 'read', label: t('markAll'), disabled: busy || data.phase !== 'ready' || !data.rows.some(row => row.unread) }]}
            onSelect={() => { void acknowledgeAll() }}
            anchor={<button type="button" className={css.iconButton} aria-label={t('options')} onClick={() => setMenuOpen(value => !value)}><IconEllipsisOutlineRegular /></button>} />}</div>
          <ul className={css.list}>{group.rows.map(row => <li key={row.id}>
            <button type="button" data-activity-row className={clsx(css.row, row.current && css.selected)} aria-current={row.current ? 'page' : undefined}
              aria-label={`${row.title} · ${t(row.status)}${row.unread ? ` · ${t('unread')}` : ''}`} onClick={() => { rememberScroll(); open(row.target) }}
              {...menus.getTriggerProps({ kind: 'session', value: { sessionId: row.id, displayTitle: row.title } })}>
              <span className={css.titleLine}><span className={css.title}>{row.title}</span>{row.project && <span className={css.project}>{row.project}</span>}
                <span className={css.status} title={t(row.status)}>{(row.priority < 4 || row.status === 'interrupted') && <StateDot state={row.status === 'running' ? 'ongoing' : row.status === 'attention' ? 'warning' : row.status === 'failed' || row.status === 'interrupted' ? 'error' : 'done'} />}</span>
              </span>
              <span className={css.preview}>{row.preview || t(data.moreLoading && row.status === 'idle' ? 'loading' : row.status)}</span>
              {row.childrenRunning > 0 && <span className={css.children}>{row.childrenRunning} {t('children')}</span>}
            </button>
          </li>)}</ul>
        </section>)}
        {!notice && data.phase === 'loading' && data.rows.length === 0 ? <div role="status" aria-label={t('loading')} className={css.skeletons}>{[0, 1, 2, 3].map(id => <div key={id} className={css.skeleton} />)}</div>
          : !notice && data.phase === 'ready' && data.rows.length === 0 && <p className={css.empty}>{t('empty')}</p>}
        {data.rows.length > view.limit && <button type="button" className={css.more} onClick={viewActions.more}>{t('more')}</button>}
      </div>
    </div>
  </Modal>
}
