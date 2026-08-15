# dsh-mobile

dsh web 的移动端适配插件。以 dsh 客户端插件形式挂载，**纯 CSS/JS 注入，不改 dsh 业务逻辑**；桌面（`>=1024px`）零改动。

- P1 侧边栏折叠 · 设置页单列
- P2 目录浏览移动端化 · 本地上传 · 顶部工具条

## 功能一览

| 功能 | 说明 |
|---|---|
| **侧边栏折叠** | `<1024px` 侧栏隐藏为覆盖式抽屉；注入汉堡按钮 + 点遮罩/菜单项/Escape 关闭 |
| **设置页单列** | `<1024px` 设置面板全屏化 + 两层导航（分区列表 → 具体设置项，带返回）；控件拉满宽度、触控 ≥44px |
| **目录浏览移动端化** | 仅对 dsh 已有的目录树（browse）对话框做样式适配：窄屏全屏 + Miller 双栏收敛为单栏 + 行高 ≥44px。是否开启 browse 由 profile 配置决定，插件不改业务 |
| **本地上传** | 输入框附件按钮 + 进度面板；批量上传、逐文件进度、落盘 `<当前会话工作区>/上传/`、重名自动改名、失败可重试 |
| **顶部工具条** | `≤1023px`：权限/模型选择从输入栏上移到会话头部，原头部条目收进 + 号弹出面板；桌面端全部还原 |

## 目录结构

```
src/client.tsx     浏览器半边：抽屉交互、上传按钮 + 进度面板、store
src/mobile.css     全部移动端结构样式（锚定 data-slot / 属性选择器）
src/index.ts       宿主半边：挂载 /dsh-mobile 上传通道
src/upload-host.ts 上传后端：分片落盘、改名、护栏、清扫
build.mjs          esbuild 构建（closure-factory 工件），--watch 热更
```

## 挂载

1. `~/.dsh/profiles/web/package.json` 的 dependencies 加 `"dsh-mobile": "link:/Users/zhouzihang/Projects/Ai/dsh-mobile"`，并 `pnpm install`。
2. `~/.dsh/profiles/web/cordis.patch.yml` 追加：
   ```yaml
   - insert:
       - id: dsh-mobile
         name: 'dsh-mobile'
   ```
3. 重启 `pnpm dsh web`（launchd 服务 `com.deepseek.dsh-web`，`launchctl kickstart -k gui/$(id -u)/com.deepseek.dsh-web`）。

## 日常使用

```sh
cd ~/Projects/Ai/dsh-mobile
node build.mjs          # 一次性构建
node build.mjs --watch  # 开发：浏览器半边热更
```

注意：浏览器半边（`lib/client.js`）热更；宿主半边（`lib/index.js`，上传通道）改动需重启 dsh web。

## 目录选择固定为 browse（应用内目录树）

**原因**：dsh 由 launchd 托管、绑定 `127.0.0.1`，远程访问走组网 + NGINX 转发。`directory-picker-auto` boot 采样只见「回环 + darwin」，误判成桌面场景而挂载 **native（Finder 选择器）**。手机上点"打开工作区/目录选择"会在无人值守的 Mac 上弹 Finder，浏览器侧无 UI、功能不可用。故显式固定为 **browse（应用内目录树）**。

**方法**（配置在 `~/.dsh/profiles/web/cordis.patch.yml`，profile 补丁层，非插件代码）：

```yaml
# 关掉 auto 判定（否则仍动态挂载 native），静态装配 browse 那一对。
- id: directory-picker
  disabled: true

- insert:
    - id: directory-picker-browse
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: directory-picker-browse-surface
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
```

要点：

- 两个 browse 包（host 后端 + client 界面）在 web-app bundle 已声明依赖，插到补丁列表即可。
- 生效需重启 dsh web。
- 回退默认行为（重新启用 auto）只需删掉这段并重启——会回到"远程弹 Finder、手机无 UI"的原问题。

## 上传传输设计

- 客户端按 **1 MiB 切片 base64** 走通用 RPC 通道 `/dsh-mobile`（`upload/begin|append|commit|abort`），复用宿主连接传输层的信任围栏，不新增 HTTP 面。
- 宿主只写 `<cwd>/上传/`：cwd 必须是**已存在的绝对路径目录**；文件名清洗为单路径段（剥分隔符/控制字符、240 字节截断），无法逃逸暂存目录。
- 重名改名用 **no-clobber `link()`**（EEXIST 换 `(1) (2) …` 至 999），无 TOCTOU 窗口，并发同名不互相覆盖。
- commit 校验 `received === expected`，不完整会话拒绝落盘；`.part` 临时文件 1 小时清扫、卸载时清除。

## 已确认的边界

- 目录浏览当前固定为 browse（见上节）。
- `<1024px` 详情列轨道归零；`≤767px` 隐藏 ContextMeter（给输入工具行让位）。
- `100dvh` 需 iOS 15.4+；旧版回退 `100vh`。
- 上传面板文案为中文；文件上限 2 GiB；空文件拒绝。

## 验收对照

- 手机/平板：主界面、侧边栏、设置页、目录选择、上传均可用 ✓；无横向滚动、触控 ≥44px ✓
- 目录浏览可经目录树选定宿主机路径（browse + 手机单栏化）✓
- 上传：入口、批量、进度、落盘 `./上传/`、重名自动改名 ✓
- 桌面（`>=1024px`）：除附件按钮移至 + 命令按钮右侧外，与改动前一致，无回归 ✓
