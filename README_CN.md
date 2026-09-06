# vibe vscode

[English](README.md) | [简体中文](README_CN.md)

> **长期愿景：** 让开发环境常驻在个人工作站或云端。无论身在何处，打开浏览器就能继续工作，立即开始 vibe coding。

vibe vscode 基于 Code - OSS 构建，目标是从“Agent 前工程时代的便携开发编辑器”演进为可长期运行、可在多个任务上下文之间即时切换的开发工作台。当前工作的重点不是替换 VS Code 已有的编辑、终端和扩展能力，而是在其上增加一层稳定的工作上下文管理，让项目、终端和 Agent 会话在切换与网络波动中保持连续。

## 功能路线图

状态标识：✅ 已实现　🚧 进行中　⬜ 未实现

- ✅ **Web 优先运行**：vibe vscode 首先为浏览器而设计。我们推荐把开发环境放在一台常驻机器或云端，通过网页随时进入工作台。项目、终端和 Agent 任务运行在服务端，网页负责交互与状态投影，无需安装桌面客户端。

  - ✅ **页面加载缓存与续传**：核心启动资源压缩、分块并校验后缓存在浏览器中，加载时显示下载进度。刷新或重新打开浏览器可复用缓存，下载中断后只补齐缺失分块，版本更新时复用未变化的内容，减少重复下载并改善弱网加载体验。
  - 🚧 **非阻塞的远程连接体验**：计划用状态栏中的重连或不可用状态替代模态打断，在网络恢复后立即推动重试，并保持当前工作内容打开；当前实现尚未包含这项能力。

  安装依赖后，可用两个终端快速启动开发环境：

  ```bash
  # 终端 1：持续编译
  npm run watch

  # 终端 2：启动 Web 工作台，访问 http://localhost:8080
  ./scripts/code-web.sh .
  ```

- ✅ **Logical Workspace（逻辑工作区）**：可从状态栏或命令面板创建、选择逻辑工作区，无需重新加载页面。切换时会保存并恢复主侧栏、底部面板和辅助侧栏的显隐、尺寸及活动视图。
  - **远程权威状态**：Workspace catalog、布局和编辑器工作集保存在 Remote SQLite；其他页面刷新或重连后读取最新快照，每个页面只在本地保存自己的当前 Workspace 选择。
  - **终端隔离与持久化**：终端归属于创建它的逻辑工作区，归属随 PTY 进程 metadata 持久化。切换工作区时，终端只在前台与后台之间迁移，不会被关闭；稳定的逻辑终端 ID 会贯穿本地/远程 PTY、持久化进程重连和页面恢复。
  - ⬜ **Chat / Agent Session Tab 工作集**：Session catalog 与 Agent Sessions 列表保持全局，不归属于任何逻辑工作区。未来每个 Workspace 只恢复自己打开的 Session Tabs；相同 Session 可以同时出现在多个 Workspace，关闭 Tab 不会删除 Session。PR #1 已撤掉提前接入的单一 owner 与列表过滤，尚不把 Session Tab 恢复标为已实现。

  ![Logical Workspace 演示](vibe_vscode_doc/pics/vibe_vscode_workspace.gif)

- ✅ **Project Context（项目上下文）**：支持在同一个多根物理 Workspace 中选择或添加项目目录。Explorer 与 Source Control 通过同一状态投影同步更新：切换 Project 会聚焦 Explorer 根目录，Git 仅展示当前 Project 内的仓库，同时保留已打开的编辑器、终端与会话；状态栏分别显示当前 Workspace 和 Project。
- ⬜ **全屏会话管理面板**：提供覆盖整个工作台的会话管理界面，用于集中查看、创建、切换和管理 Agent 会话。
- ⬜ **文档驱动开发**：支持在编辑器中选中文档内容，通过右键菜单以选区作为上下文创建新的 Agent 会话，让需求和设计文档直接驱动开发。
- ⬜ **Codex Agent 优先交互**：以 Codex Agent 作为首要会话形态，优先完善会话创建、交互、状态呈现与恢复体验。

## 非目标

- **Electron 桌面产品**：vibe vscode 的产品迭代、回归验证和发布只面向 Remote Web（浏览器 Workbench + Remote Server）。仓库保留上游 Code - OSS 的 Electron 源码以便后续同步，但不发布、不测试、不维护也不承诺桌面 Electron 兼容性；Electron 专属回归不作为 PR 门禁。

## 上游项目

vibe vscode 基于 Code - OSS。有关上游仓库、参与贡献和许可证的完整信息，请参阅[英文 README 的 Code - OSS 部分](README.md#visual-studio-code---open-source-code---oss)。
