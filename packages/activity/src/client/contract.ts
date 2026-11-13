/** Derived slot props and the plugin's narrow injected actions. */
import type { InjectFace, PropsRuntime, PropsLocale, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { ActivityViewState, ActivityViewActions } from './state.ts'
import type { ActivityData } from './model.ts'
import type { ActivityKey } from './locales.ts'
import type { ReadAcknowledgement } from '../types.ts'
export interface ActivityInjected {
  hooks: { activity: HostObservable<ActivityData>; view: HostObservable<ActivityViewState>; shortcuts: HostObservable<readonly ShortcutCatalogEntry[]> }
  viewActions: ActivityViewActions
  open: (id: SessionId) => void
  refresh: () => Promise<void>
  markRead: (items: ReadAcknowledgement[]) => Promise<boolean>
}
type Shared = InjectFace<ActivityInjected> & PropsLocale<'betterActivity'>
export type ActivityLauncherProps = PropsRuntime<'sidebar.footer.action'> & Shared
export type ActivityOverlayProps = PropsRuntime<'shell.overlay'> & Shared
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { betterActivity: ActivityKey } }
