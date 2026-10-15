# SillyTavern 本地适配 1.1.0

这一目录归档已在 Windows + SillyTavern 1.19.0 上实际运行的适配代码。Python 引擎、世界包与原始 Skill 保持上游版本；本次添加宿主工具、存档面板和自定义世界准备流程。

## 行为

- `AdultTensionCommand` 调用限定的原生引擎命令，以原始 JSON 回执为准；按用户数据目录隔离 SQLite 存档，同目录串行写入。
- `AdultTensionReference` 按标题和游标读取原始文档，默认每页 5000 字符、最多 6000；所有原文仍可读到。
- `AdultTensionWorldDraft` 分段保存世界字段，支持按稳定 ID 更新数组项；最后交给原引擎完整校验。
- 当前玩家要求随简短状态附加到模型请求。自定义准备期间禁止继续写旧世界、读入其他世界或不带 `custom_world` 随机开局。
- 上下文中既没有当前玩家消息也没有其保留副本时，停止生成并显示原因。
- 面板提供自定义/取消自定义、引擎检查、世界与存档列表、导入和导出。删除存档必须经本地确认。

## 目录与恢复

`deployment/` 内路径相对于 SillyTavern 根目录；`data/default-user` 表示被验收的默认用户配置。多用户安装应把前端扩展复制到目标用户对应的 `extensions/adult-tension`，不能复制其他人的数据。

1. 停止 SillyTavern，备份待替换的适配源码文件。
2. 将 `deployment/` 中的五个源码文件放到同名路径。
3. 将本仓库 `skill/adult-tension/` 复制到 ST 的 `data/adult-tension/upstream/skill/adult-tension/`。保持该目录内全部内容完整。
4. 在 ST 配置中启用 server plugins，启动 ST；启用模型函数调用。
5. 使用带有 `data.extensions.adult_tension` 标记的角色卡。角色描述应包含原始 Skill，并说明 CLI 命令通过 `AdultTensionCommand` 执行、参考资料通过 `AdultTensionReference` 读取。
6. 刷新浏览器后选择角色，在扩展面板点击“自定义世界”，再发送设定。

本归档不携带用户角色卡、聊天、提示词预设、账号配置、API 密钥、数据库或导出存档。升级只替换列出的代码；不得覆盖用户自己的 `adult-tension` 存档目录。

桥接当前使用 `C:\Windows\py.exe -3`，已验证 Windows 环境；其他系统需显式适配 Python 启动入口。本目录没有安装时自动改用户配置的脚本。

## DeepSeek 的宿主修复

当前官方思考模式在带工具时要求回传历史 assistant 的原始推理。对应 ST 修复保存在 [SillyTavern fork](https://github.com/today080221/SillyTavern)：历史预算计入并保留推理、转换成 `reasoning_content`，且不把带工具元数据的 assistant 消息合并丢失。

调试后使用 262144 上下文、32768 最大输出、40 轮工具续接、high 推理。它们是上限；实际费用由输入、输出和缓存计费决定。打开的旧页面可能再次保存旧设置，调整后需要刷新并核对。

## 复现验收

在此目录运行 `node tests/run.mjs`。它只在系统临时目录安装测试副本、使用合成的非情色请求，并实际运行 Python 引擎；不读取宿主用户数据，也不调用收费模型。

范围：意图识别、旧存档隔离、资料分页完整性、增量草稿、真实自定义建局、请求保留、上下文不足停止、其他角色不注入，共 11 组断言。ST 的 DeepSeek 转换与预算回归在 ST fork 的测试中。

另已完成真实 DeepSeek 接口建局以及隔离 ST 浏览器流式建局。用户原有提示词与具体剧情未作为测试输入；这些证据不代表任何任意设定或长线叙事质量都已通过验收。
