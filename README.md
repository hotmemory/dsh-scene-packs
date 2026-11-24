# dsh-scene-packs · 场景工具包

按场景给「当前这个 agent」的工具表收窄：只留下本场景要用的第三方工具。
**per-agent、即时生效、撤销即恢复，不重启、不开新会话、不影响别的会话。**

> **English:** Per-session tool packs for [DSH](https://github.com/deepseek-harness).
> Mask the tools a session does not need, using the built-in `ctx.tools.restrict()` —
> agent-scoped, instant, reversible, and it never touches other sessions or scheduled jobs.
> A JSON scene table decides what stays; an auto-maintained inventory tracks every tool it has
> ever seen. Install with `plugin_manager({action:"install_bundle", target:"<this dir>"})`.

## 安装

```powershell
# 在 DSH 里：
plugin_manager({ action: 'install_bundle', target: 'C:/path/to/dsh-scene-packs' })
# 然后（客户端无面板，只有工具）直接可用：
scene_list        # 看默认场景表
scene_scan        # 扫一次，把你现有的第三方工具记进清单
scene_switch      # 切到某个场景
```

数据落在 `~/.dsh/scene-packs/{packs.json,inventory.json}`，**手改 `packs.json` 也生效**。

## 为什么不是"按包启停"

按包启停是全局的：关掉 `cv-recall`，定时任务和子代理也一起没有。而且粒度是整包——
`dsh-better-ears` 一个包里既有只读探针（`audio_probe`，任何场景都该在），又有吃识别模型的
（`audio_speech`，只有看视频时才要），**按包分不了。**

`ctx.tools.restrict()` 按**工具名**工作，粒度正好是我们要的。

## 五个工具

| 工具 | 干什么 |
|---|---|
| `scene_list` | 有哪些场景、每个场景允许什么、受管工具数 |
| `scene_scan` | 全量对账一次：读当前可见工具，新增的按前缀猜归属写进清单 |
| `scene_switch {scene}` | 切场景：先撤旧掩码，再按「受管 − 本场景允许」下 deny |
| `scene_now` | 回读：受管的每个工具现在是被掩还是在（用 `get(name,scope)`） |
| `scene_assign {tool, scene}` | 把工具归到某场景；`scene=none` 从受管移除（永不被掩） |

## 数据文件（手改也生效）

```
~/.dsh/scene-packs/packs.json       场景表：managed / prefixes / scenes
~/.dsh/scene-packs/inventory.json   清单：每个工具第一次见到、前缀猜的归属、是不是全局工具
```

`packs.json` 结构：

```json
{
  "managed": ["cv_learn", "cv_recall", "cv_act", "audio_probe"],
  "prefixes": { "cv_": "gaming", "audio_": "media", "image_": "media" },
  "scenes": {
    "chat":   { "allowed": [] },
    "gaming": { "allowed": ["cv_*", "independent_input"] },
    "media":  { "allowed": ["audio_*", "image_*"] },
    "full":   { "allowed": ["*"] }
  }
}
```

## 三条不变量（代码保证，不靠调用方）

1. **每个 agent 最多一个掩码**：切换前一定先 dispose 旧的（`restrict` 是叠加的，留着会越切越少）
2. **永不屏蔽自己**：`scene_*` 开头的名字永远不进 deny 名单——**一次误配不能把我锁在门外**
3. **未知名字不进名单**：不存在的、作用域内的名字只记警告，不让整次切换失败

## 三个实测出来的坑（2026-11-25）

**一、必须从 `exec.agent.ctx.tools` 调，不能从宿主 ctx**
宿主 ctx 上会报：`tools.restrict() requires a scoped context (agent.ctx): a context-global
restriction would mask every agent`。**这是 DSH 故意拦的，不是 bug。**

**二、回读不能用 `definitions()` / `schemas()`**
两个都把被掩掉的工具报成"还在"（实测：`cv_learn` 明明已经是 `unknown tool`，它们仍列着）。
**只有 `get(name, scope)` 会读成不存在。** 教训：回读要选对 API，否则"以为验证过了"。

**三、插件重载会留下孤儿掩码**
旧实现把撤销句柄放在模块内 `Map`，重载后模块实例换了，句柄丢了，**掩码却还挂在 agent 上，
从此撤不掉。**
修法：句柄挂进程级 `globalThis.__dshScenePacks`，并且**每次 `apply()` 先全撤**。
宁可多出工具，也不留撤不掉的掩码。

**如果已经被孤儿掩码挡住**：重启 DSH，或开一个新会话（掩码属于那个会话的 agent 作用域）。

## 只能管"全局继承"的工具

`restrict` 只对**继承来的全局工具**生效。preset 里的（`fs` / `web` / `pwsh` / `office` /
`subagent` / `todo` / `schedule`）是作用域内注册，传进去会报 `scope-local`，会被跳过并警告。

**想连那些一起收窄，只能换 preset——那是新会话的事，不是这个插件的事。**

## 为什么默认 deny 而不是 allow

```
deny   没归组的包 = 仍然可见 = 漏配只是多一个工具
allow  没归组的包 = 隐身 = 漏配会砍掉我要用的东西
```

**在"AI 给自己配工具"这件事上，fail-open 是对的。**
