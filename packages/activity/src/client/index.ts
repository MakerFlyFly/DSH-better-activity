/** Client registrations for the independent activity browser. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import remote from 'dsh-better-activity/remote'
import { ActivityController } from './controller.ts'
import { createActivityView } from './state.ts'
import { ActivityOverlay, ActivityLauncher } from './Activity.tsx'
import { en, zh } from './locales.ts'
import type { ActivityInjected } from './contract.ts'

/** Services used by the activity feature. */
export const inject = ['slots', 'remote', 'sessions', 'workspaces', 'uiSession', 'uiConversation', 'uiWorkspace', 'layout', 'shortcuts', 'locale', 'contextMenus']
/** @param ctx - Client plugin scope. */
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(remote)
  ctx.inject(['remote.betterActivity'], install)
}
function install(ctx: Context): void {
  const view = createActivityView()
  const controller = new ActivityController(ctx, view)
  const id = 'better-activity'
  ctx.effect(() => ctx.locale.register('betterActivity', { zh, en }), 'better-activity: dictionaries')
  const t = ctx.locale.bind('betterActivity')
  const toggle = view.actions.toggle
  const save = (): void => { view.save() }
  window.addEventListener('pagehide', save)
  ctx.effect(() => () => { window.removeEventListener('pagehide', save); view.save() }, 'better-activity: view preference')
  const injectProps = (): ActivityInjected => ({
    hooks: { activity: controller.data, view: view.state, shortcuts: ctx.shortcuts.catalog }, viewActions: view.actions,
    open: sessionId => { ctx.uiWorkspace.openSession(sessionId); view.actions.close() }, refresh: () => controller.refresh(), markRead: items => controller.markRead(items),
  })
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id, locale: 'betterActivity', inject: injectProps }, ActivityLauncher))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id, locale: 'betterActivity', inject: injectProps }, ActivityOverlay))
  ctx.effect(() => ctx.shortcuts.register({
    id: 'better-activity.toggle' as ShortcutCommandId, label: () => t('activity'), aliases: ['activity'],
    defaults: {
      'desktop:windows': { code: 'KeyU', modifiers: ['primary', 'alt'] }, 'desktop:linux': { code: 'KeyU', modifiers: ['primary', 'alt'] },
      'desktop:macos': { code: 'KeyU', modifiers: ['primary', 'alt'] }, 'web:windows': { code: 'KeyU', modifiers: ['primary', 'alt'] }, 'web:macos': { code: 'KeyU', modifiers: ['primary', 'alt'] },
    }, regions: ['page', 'editable'], modals: ['sidebar'], resolve: () => ({ status: 'handled', run: toggle }),
  }), 'better-activity: shortcut')
}
