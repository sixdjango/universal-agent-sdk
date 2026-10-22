# Grok Auto 权限

Status: draft
Translation: current

[English](auto-permissions.md)

用户可以独立于 Plan 模式选择 Ask、Auto 或 Always Approve。Auto 请求官方 Grok
运行时对工具操作进行分类。适配器不实现自己的分类器，也不会自动批准 Grok 留给
用户处理的请求。用户问题和实施计划的决定仍需明确回答。

只有初始化报告的运行时版本达到 manifest 中经过验证的 Auto 最低版本时，才提供
Auto。旧版或未知版本会拒绝 Auto，包括恢复的旧配置，并在创建或复制会话前返回
错误。Auto 需要稳定的客户端标识。new/load/resume/fork 均显式设置两个权限标志；
未指定选择时继承当前适配器的客户端策略，否则使用 Ask。运行中通过既有的客户端
范围原生通知切换。离开 YOLO 后，适配器立即停止自动批准新请求；已转发的请求仍由
宿主负责。

配置值表示请求的策略。Grok 原生切换没有确认回执，也没有有效状态查询接口。
它自身的功能开关可以禁用 Auto，让运行时按 Ask 执行。选项描述必须说明这一可能。
版本兼容和配置 setter 返回成功均不证明 Auto 已生效。适配器不能覆盖原生开关、
复制原生策略解析，或虚构有效状态信号。若要提供有效状态控件，需要目前尚不存在的
上游协议支持。

宿主必须对活动会话发送标准配置 setter，或随下一次会话／回合提交携带选择。
编辑宿主草稿不等于运行时切换。宿主能力目录和运行时分发属于宿主发布流程；
本独立适配器不会发布或更新这些产物。

## 证据与验证

- [适配器](../src/proxy.js)、[确定性测试](../test/proxy.test.js)。
- [原生探针](../scripts/probe-auto-permissions.mjs)：运行官方二进制，使用隔离配置和
  历史、本地合成模型响应，观察原生模式、分类器调用、交互请求及实际工具执行。
- [决策与限制](../.agents/notes/implemented/feature/2026-10-07-native-auto-permissions.zh.md)。
