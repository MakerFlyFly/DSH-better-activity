// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { ActivityLauncher, ActivityOverlay } from '../packages/activity/src/client/Activity.tsx'
import type { ActivityLauncherProps, ActivityOverlayProps } from '../packages/activity/src/client/contract.ts'
import { createActivityView } from '../packages/activity/src/client/state.ts'
import { zh } from '../packages/activity/src/client/locales.ts'
import type { ActivityData, ActivityRow } from '../packages/activity/src/client/model.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

afterEach(cleanup)
const sample = (id: string, extra: Partial<ActivityRow> = {}): ActivityRow => ({
  id: id as SessionId, target: id as SessionId, title: id, project: 'DSH', preview: '公开的助手进展', status: 'completed', priority: 4,
  unread: false, current: false, activityAt: Date.now(), childrenRunning: 0, readTargets: [], ...extra,
})
function setup(rows: ActivityRow[], overrides: Partial<ActivityData> = {}, initialOpen = true, restored?: { scrollTop: number; limit: number }) {
  const data: ActivityData = { phase: 'ready', rows, moreLoading: false, mutationError: false, summaryError: false, catalogError: false, ...overrides }
  const storage = restored ? { getItem: () => JSON.stringify({ ...restored, open: initialOpen }), setItem: vi.fn() } : null
  const view = createActivityView(storage)
  view.state.update(value => { value.open = initialOpen })
  const open = vi.fn((_id: SessionId) => view.actions.close())
  const markRead = vi.fn(async () => true), refresh = vi.fn(async () => {}), contextMenu = vi.fn()
  const useView: ActivityOverlayProps['useView'] = select => select(useSyncExternalStore(view.state.subscribe, view.state.getSnapshot))
  const shared = {
    useActivity: select => select(data), useView,
    useShortcuts: select => select([{ id: 'better-activity.toggle', keys: ['Ctrl', 'Alt', 'U'], aria: 'Control+Alt+U' }]),
    useContextMenu: () => ({ getTriggerProps: ({ value }: { value: { sessionId: SessionId } }) => ({
      onContextMenu: (event: MouseEvent) => { event.preventDefault(); contextMenu(value.sessionId) },
    }) }),
    viewActions: view.actions, open, markRead, refresh, t: key => zh[key as keyof typeof zh],
  } as ActivityOverlayProps
  let wide = true
  let foreground = false
  const tree = () => <>
    <div aria-label="原生会话列表" data-sidebar-scrollport><input aria-label="原生会话搜索" /></div>
    <div><p>当前原生会话</p><textarea aria-label="原生输入框" /></div>
    <div data-sidebar-right-open><input aria-label="原生右侧面板" /></div>
    <Modal open={foreground} title="新的原生弹窗" closeLabel="关闭原生弹窗" onClose={() => { foreground = false }}><input data-modal-autofocus aria-label="原生弹窗输入框" /></Modal>
    <ActivityLauncher {...shared as ActivityLauncherProps} wide={wide} />
    <ActivityOverlay {...shared} />
  </>
  const rendered = render(tree())
  return { ...rendered, data, view, storage, open, markRead, refresh, contextMenu, redraw: () => rendered.rerender(tree()), narrow: () => { wide = false; rendered.rerender(tree()) }, foreground: () => { foreground = true; rendered.rerender(tree()) } }
}
const dialog = () => screen.getByRole('dialog', { name: '近期活动' })
const launcher = () => screen.getByRole('button', { name: '查看活动', exact: true })
const close = () => fireEvent.click(screen.getByRole('button', { name: '关闭活动' }))
const escape = () => fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape', code: 'Escape' })

describe('recent activity overlay', () => {
  it('keeps the native list and chat while the footer toggles its dialog', () => {
    setup([sample('活动会话')], {}, false)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(launcher().textContent).toBe('查看活动')
    expect(launcher().getAttribute('aria-keyshortcuts')).toBe('Control+Alt+U')
    fireEvent.click(launcher())
    expect(dialog().getAttribute('data-shortcut-modal')).toBe('sidebar')
    expect(launcher().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('当前原生会话')).toBeTruthy()
    expect(within(dialog()).queryByRole('textbox')).toBeNull()
    close()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('textbox', { name: '原生会话搜索' })).toBeTruthy()
  })
  it('keeps unread indication independent of the open state and labels the narrow launcher', () => {
    const h = setup([sample('未读', { unread: true })], {}, false)
    expect(screen.getByLabelText('有未读活动')).toBeTruthy()
    fireEvent.click(launcher())
    expect(screen.getByLabelText('有未读活动')).toBeTruthy()
    h.data.rows = [sample('未读')]; h.redraw()
    expect(screen.queryByLabelText('有未读活动')).toBeNull()
    expect(launcher().getAttribute('aria-expanded')).toBe('true')
    close(); h.narrow()
    expect(launcher().textContent).toBe('')
    expect(launcher().getAttribute('aria-label')).toBe('查看活动')
  })
  it('closes through Escape and the native backdrop', () => {
    setup([sample('会话')], {}, false)
    launcher().focus(); fireEvent.click(launcher())
    escape()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(launcher())
    fireEvent.click(launcher())
    fireEvent.click(dialog().parentElement!.firstElementChild!)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('yields to native search focus without restoring focus to its opener', () => {
    setup([sample('会话')], {}, false)
    launcher().focus(); fireEvent.click(launcher())
    const nativeSearch = screen.getByRole('textbox', { name: '原生会话搜索' })
    act(() => { nativeSearch.focus() })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(nativeSearch)
  })
  it('retains a restored dialog, scroll and focus when the background composer autofocuses', () => {
    const h = setup(Array.from({ length: 75 }, (_, index) => sample(`会话 ${index}`)), {}, true, { scrollTop: 443, limit: 100 })
    const scroller = screen.getByRole('region', { name: '活动列表' })
    expect(scroller.scrollTop).toBe(443)
    const selected = screen.getByRole('button', { name: '会话 8 · 已完成' })
    act(() => { selected.focus() })
    act(() => { screen.getByRole('textbox', { name: '原生输入框' }).focus() })
    expect(dialog()).toBeTruthy()
    expect(document.activeElement).toBe(selected)
    expect(scroller.scrollTop).toBe(443)
    expect(h.view.state.getSnapshot()).toMatchObject({ open: true, scrollTop: 443, limit: 100 })
    h.view.save()
    expect(JSON.parse(h.storage!.setItem.mock.calls.at(-1)![1])).toMatchObject({ open: true, scrollTop: 443 })
  })
  it('yields when native navigation focuses an open right panel', () => {
    setup([sample('会话')])
    const rightPanel = screen.getByRole('textbox', { name: '原生右侧面板' })
    act(() => { rightPanel.focus() })
    expect(screen.queryByRole('dialog', { name: '近期活动' })).toBeNull()
    expect(document.activeElement).toBe(rightPanel)
  })
  it('does not restore an older navigation target behind a newly opened modal', () => {
    const h = setup([sample('会话')], {}, false)
    launcher().focus(); fireEvent.click(launcher())
    act(() => {
      screen.getByRole('textbox', { name: '原生会话搜索' }).focus()
      h.foreground()
    })
    expect(screen.queryByRole('dialog', { name: '近期活动' })).toBeNull()
    expect(screen.getByRole('dialog', { name: '新的原生弹窗' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '原生弹窗输入框' }))
  })
  it('keeps the loading state until the native activity sources arrive', () => {
    setup([], { phase: 'loading' })
    expect(screen.getByRole('status', { name: '正在加载活动' })).toBeTruthy()
    expect(screen.queryByText('暂无活动')).toBeNull()
  })
  it('opens the actual waiting child, closes the overlay and preserves native context menus', () => {
    const h = setup([sample('父会话', { target: 'child' as SessionId, status: 'attention', priority: 0, preview: '请选择下一步' })])
    const row = screen.getByRole('button', { name: '父会话 · 等待你处理' })
    fireEvent.contextMenu(row)
    expect(h.contextMenu).toHaveBeenCalledWith('父会话')
    expect(dialog()).toBeTruthy()
    fireEvent.click(row)
    expect(h.open).toHaveBeenCalledWith('child')
    expect(h.markRead).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('retains its dialog for portaled menu focus and marks displayed versions as read', async () => {
    const h = setup([
      sample('任务进行中', { priority: 2, status: 'running' }),
      sample('已完成任务', { priority: 3, unread: true, readTargets: [{ sessionId: 'done' as SessionId, throughSeq: 12 }] }),
    ])
    fireEvent.click(screen.getByRole('button', { name: '活动选项' }))
    const item = await screen.findByRole('menuitem', { name: '全部标为已读' })
    act(() => { item.focus() })
    expect(dialog()).toBeTruthy()
    fireEvent.click(item)
    await waitFor(() => expect(h.markRead).toHaveBeenCalledWith([{ sessionId: 'done', throughSeq: 12 }]))
    expect(screen.getByRole('button', { name: '任务进行中 · 运行中' })).toBeTruthy()
    expect(dialog()).toBeTruthy()
  })
  it('gives the priority menu the first Escape and the dialog the next one', async () => {
    setup([sample('未读任务', { priority: 3, unread: true, readTargets: [{ sessionId: 'done' as SessionId, throughSeq: 12 }] })])
    fireEvent.click(screen.getByRole('button', { name: '活动选项' }))
    const item = await screen.findByRole('menuitem', { name: '全部标为已读' })
    act(() => { item.focus() })
    escape()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(dialog()).toBeTruthy()
    escape()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('releases navigation focus listeners when its overlay unmounts', () => {
    const h = setup([sample('会话')])
    h.unmount()
    const external = document.createElement('input')
    document.body.append(external)
    try {
      act(() => { external.focus() })
      expect(h.view.state.getSnapshot().open).toBe(true)
    } finally { external.remove() }
  })
  it('retains readable rows and provides retry when the connection fails', () => {
    const h = setup([sample('已有结果')], { phase: 'offline' })
    expect(screen.getByText('活动暂时无法更新')).toBeTruthy()
    expect(screen.getByRole('button', { name: '已有结果 · 已完成' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(h.refresh).toHaveBeenCalledOnce()
  })
  it('reports an unavailable archive baseline without an empty-list message or unrelated retry', () => {
    setup([], { phase: 'error', catalogError: true })
    expect(screen.getByText('会话列表暂时无法更新，请重新加载界面')).toBeTruthy()
    expect(screen.queryByText('暂无活动')).toBeNull()
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
    expect(screen.queryByRole('status', { name: '正在加载活动' })).toBeNull()
  })
  it('retains paging and scroll after closing and supports row keyboard navigation', () => {
    const h = setup(Array.from({ length: 75 }, (_, index) => sample(`会话 ${index}`)))
    expect(dialog().querySelectorAll('[data-activity-row]')).toHaveLength(50)
    fireEvent.click(screen.getByRole('button', { name: '显示更多' }))
    expect(dialog().querySelectorAll('[data-activity-row]')).toHaveLength(75)
    const rows = [...dialog().querySelectorAll<HTMLButtonElement>('[data-activity-row]')]
    act(() => { rows[0]!.focus() })
    fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[1])
    fireEvent.keyDown(rows[1]!, { key: 'End' })
    expect(document.activeElement).toBe(rows.at(-1))
    fireEvent.keyDown(rows.at(-1)!, { key: 'Home' })
    expect(document.activeElement).toBe(rows[0])
    const scroller = screen.getByRole('region', { name: '活动列表' })
    scroller.scrollTop = 260; fireEvent.scroll(scroller)
    act(() => { h.view.actions.toggle() })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(launcher())
    expect(dialog().querySelectorAll('[data-activity-row]')).toHaveLength(75)
    expect(screen.getByRole('region', { name: '活动列表' }).scrollTop).toBe(260)
  })
})
