# 五分钟测试指南 · TESTING

> 这是个实验插件：**按场景把当前会话用不到的工具藏起来**，让工具表变短。
> 它只动"这一个会话"，撤销即恢复；不改文件、不发请求、不联网。
>
> **我需要的是"它在你的机器上成不成立"，不是"好不好用"。**

## 0. 前提

```
DSH Desktop（我用 0.2.x 验的，但版本不挑）
Node >= 22
Windows / macOS / Linux 都行（我只在 Windows 验过）
```

## 1. 安装（两次命令）

```powershell
# 把仓库克隆到任意目录
git clone https://github.com/hotmemory/dsh-scene-packs C:/path/to/dsh-scene-packs

# 在 DSH 里（让 agent 执行，或设置页装 bundle）：
plugin_manager({ action: 'install_bundle', target: 'C:/path/to/dsh-scene-packs' })
```

装完刷新页面，应该多出 5 个工具：`scene_list / scene_scan / scene_switch / scene_now / scene_assign`。

## 2. 三件要确认的事

### ① scan 能发现你的工具

```
scene_scan
```

**期望**：报"扫到 N 个工具；新增 M 个"，并把带前缀的（`cv_*`、`audio_*`、`image_*`）自动归组。
**失败长什么样**：报"拿不到 agent 作用域" —— 这是我唯一不确定的地方，请把你看到的原文发我。

### ② switch 真的让工具消失（这是核心）

挑一个你装了第三方工具包（有 `cv_*` 或 `audio_*` 这类）的会话：

```
scene_switch {scene: "chat"}
```

**期望**：下一轮那些工具从工具表里消失，**调用会报 `unknown tool`**。
**注意**：`scene_now` 会回读——**但它的"被掩"是查 `get(name, scope)`，最终以"调用会不会 unknown tool"为准。**

### ③ 重载不留孤儿（这条最重要）

```
1. scene_switch 到某个会掩工具的场景
2. 关掉插件，再打开（plugin_manager set_plugin enabled false/true）
3. scene_now
```

**期望**：掩码全部撤销，工具都回来，`场景=(未设)`。
**如果没回来**：重启 DSH 或开新会话能恢复；**请务必告诉我你的 DSH 版本和复现步骤**。

## 3. 顺便跑一下单元测试（不需要 DSH）

```powershell
node test.mjs
```

**期望**：`✓ 8 组断言全部通过`。挂了就把输出发我。

## 4. 卡住怎么办

```
改配置：<仓库>/cordis.patch.yml 里 dataDir 默认 ~/.dsh/scene-packs
数据：  ~/.dsh/scene-packs/{packs.json,inventory.json} —— 删掉即回到默认
彻底退：plugin_manager({action:'set_plugin', target:'<entryId>', enabled:false})
       或 plugin_manager({action:'remove_bundle', target:...})
```

**——它不可能弄坏你的文件或 DSH：只注册工具，只在会话作用域加一层掩码。**

## 5. 我最想知道的四件事

| 什么 | 为什么 |
|---|---|
| 你的 DSH 版本 + 系统 | 我只在 Windows 0.2.x 验过 |
| `scene_switch` 后调用被掩工具是不是 `unknown tool` | 这是"真的生效"的唯一证据 |
| 关插件再开后，工具回不回来 | 我踩过"孤儿掩码"的坑，想知道别人会不会复现 |
| 有没有某个工具**掩不掉** | 文档说只能掩"全局继承"的工具；preset 里的（fs/web/office）应该掩不掉 |

**有结果发我一句就行，哪怕是"没跑起来"。——"装不上"也是有效结果。**
