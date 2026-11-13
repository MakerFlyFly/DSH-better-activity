# 版本说明 / Changelog

以下为本地开发版本记录。`0.2.0` 是首次公开发布的候选版本，尚未提交或发布。

These are local development versions. `0.2.0` is the candidate for the first public release and has not been submitted or published.

## 0.2.0

- 原生底部入口和活动浮层，用户安装不再需要宿主补丁。
- 自动已读观察原生正文时间线；遮挡、后台和导航过渡期间暂停确认。
- 保留分组、摘要、状态、菜单、快捷键、原生搜索与已读同步。
- 已读格式和摘要投影不变，0.1.3 数据可直接沿用。

- Use a native footer launcher and activity dialog on unmodified DSH.
- Confirm reads from the published conversation timeline, only while foreground and unobscured.
- Preserve grouping, summaries, status, native navigation/search, menus and read synchronization.
- Keep the read and summary formats compatible with 0.1.3.

## 0.1.3

- 修复加粗、链接与代码混排时的摘要标记残留。
- 修复多反引号行内代码被误判为空代码块，以及较长结束围栏的识别。
- 保留代码字符，正确处理未闭合文本、转义和 Unicode 截断。
- 摘要缓存按新投影版本恢复；已读记录、Remote 字段和 DSH 补丁保持不变。

- Clean surrounding emphasis and links without modifying code content.
- Preserve inline code delimited by multiple backticks and recognize longer closing fences.
- Handle unfinished text, escapes and Unicode truncation.
- Recover summaries with a new projection version while preserving read state, Remote fields and DSH patches.

## 0.1.2

- 修复不同会话增量乱序、正文收到结果前自动已读，以及两种归档会话误显示。
- 合并并发重试，采用本地化审批说明，清理冗余开发依赖。
- 增加正文接收位置兼容补丁。

- Fix out-of-order updates, premature read acknowledgement and archived conversation visibility.
- Coalesce retries, localize approval descriptions and remove unused development dependencies.
- Add the conversation receipt cursor compatibility patch.

## 0.1.1

移除活动视图额外添加的搜索功能，保留 DSH 原生搜索。

Remove the extra activity search feature while preserving native DSH search.

## 0.1.0

首次本地实现：铃铛入口、活动分组、助手摘要、状态、原生跳转和持久已读同步。

Initial local implementation: bell toggle, activity grouping, assistant summaries, status, native navigation and persistent read synchronization.
