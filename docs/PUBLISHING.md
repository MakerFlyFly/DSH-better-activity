# 源码提交与发布流程

0.2.0 已完成本地审查。源码仓库为 [MakerFlyFly/DSH-better-activity](https://github.com/MakerFlyFly/DSH-better-activity)，分支 main，包版本为 dsh-better-activity@0.2.0。源码提交涵盖插件、测试、说明、截图和 CI；Release、npm 与插件目录材料仍为未发布的草稿。

## 材料

[中文说明](../README.md) · [English](../README_EN.md) · [版本记录](../CHANGELOG.md) · [验证](VALIDATION.md) · [Release 草稿](releases/v0.2.0.md) · [目录草稿](SUBMISSION.md)

## 构建与用户安装分开

独立构建工具副本固定于 compatibility.json 中的源码提交，只应用 scripts/patches/remote-generator.patch 修复元数据生成；该修复不进入用户安装包。前端仅引用原版API，不能借用侧栏浏览器或接收游标补丁。

CI 另用 prepare-runtime.mjs 从 npm 安装官方 DSH 0.2.2-rc.2，真实 Loader 使用该运行时验证最终 tgz。不能将构建工具副本用于宣称免补丁安装。BetterClassifier 共存检查可以显式选用支持它的源码环境，结果必须单列。

CI 在 main 推送和 Pull Request 时构建、测试、打包，结果以 [Actions](https://github.com/MakerFlyFly/DSH-better-activity/actions/workflows/ci.yml) 为准；工作流不自动创建 Release 或发布 npm。包发布和目录提交需要另行明确授权，执行前核对账号、版本、SHA256SUMS 及对应材料。

参考 [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 的文档与发布组织方式，本项目不依赖其侧栏服务，也未增加文件管理或搜索等功能。
