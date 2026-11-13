/** Locale-owned product text. */
export const zh = {
  activity: '查看活动', title: '近期活动', close: '关闭活动', list: '活动列表', priority: '优先事项', today: '今天', yesterday: '昨天',
  more: '显示更多', options: '活动选项',
  markAll: '全部标为已读', empty: '暂无活动', retry: '重试',
  unavailable: '活动暂时无法更新', readFailed: '未能保存已读状态', loading: '正在加载活动',
  catalogUnavailable: '会话列表暂时无法更新，请重新加载界面',
  attention: '等待你处理', failed: '运行失败', running: '运行中', completed: '已完成',
  stopped: '已停止', interrupted: '运行已中断', idle: '尚无进展', unread: '有未读活动', children: '子任务运行中',
  locale: 'zh-CN',
} as const
export type ActivityKey = keyof typeof zh
export const en: Record<ActivityKey, string> = {
  activity: 'View activity', title: 'Recent activity', close: 'Close activity', list: 'Activity list', priority: 'Priority', today: 'Today', yesterday: 'Yesterday',
  more: 'Show more', options: 'Activity options',
  markAll: 'Mark all as read', empty: 'No activity yet', retry: 'Retry',
  unavailable: 'Activity could not be updated', readFailed: 'Read status could not be saved', loading: 'Loading activity',
  catalogUnavailable: 'Conversations could not be updated. Reload the app to try again.',
  attention: 'Needs your attention', failed: 'Failed', running: 'Running', completed: 'Completed',
  stopped: 'Stopped', interrupted: 'Interrupted', idle: 'No progress yet', unread: 'Unread activity', children: 'subtasks running', locale: 'en-US',
}
