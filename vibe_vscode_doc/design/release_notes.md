# Release 文案:来源、确认与门禁

> - 对应 PR:见 PR 描述
> - 实现:[`build/lib/releaseNotes.ts`](../../build/lib/releaseNotes.ts)、[`build/release-notes.ts`](../../build/release-notes.ts)、[`release.yml`](../../.github/workflows/release.yml)、[`.github/release.yml`](../../.github/release.yml)、[`docs/release-notes/`](../../docs/release-notes/)
> - 操作手册:[docs/release.md](../../docs/release.md) 的 Release notes 一节

> 范围:`Vibe Release` 工作流(`.github/workflows/release.yml`)创建的 GitHub Release 正文。
> 非目标:版本号策略、多平台产物。

## 1. 现状与问题

`publish` 步骤固定执行 `gh release create --draft --title "Vibe VS Code <tag>" --generate-notes`。正文是 GitHub 按上一个 release 以来合并的 PR 自动生成的清单,没有"这个版本给用户带来什么、升级要注意什么"。文案不在仓库里,不经 review;CI 没有任何输入口。

## 2. 目标

- 文案与代码同一个 commit,能在 PR 里 review,tag 打出去时自动带上。
- 发布前有一次人工确认,确认时还能改。
- 紧急修补不被文案卡死,但缺文案的 release 必须显式可见,不能悄悄发出去。

## 3. 两种来源的取舍

| | A. 仓库文档 `docs/release-notes/<tag>.md` | B. 触发 CI 时输入 |
|---|---|---|
| 写在哪 | 与代码同 PR,`docs/release-notes/` 下按 tag 命名 | Actions 页面 `workflow_dispatch` 的输入框 |
| 谁 review | PR reviewer | 无人,触发者自己 |
| 可追溯 | git 历史 | 只在 workflow run 的输入里 |
| 多行正文 | 天然支持 | GitHub 的 `string` 输入是单行文本框,长正文不可用 |
| 与 tag 绑定 | 文件名即 tag,`source` job 可校验 | 靠触发者填对 |
| 紧急发布 | 多一次提交 | 立即 |

B 的输入框只适合一句话。所以设计上:A 是正式来源,B 退化为"一行标题 + 是否允许无文案发布"的开关,人工确认放在草稿发布这一步,那里可以自由编辑正文。

## 4. 方案

### 4.1 文案文件

- 路径 `docs/release-notes/<tag>.md`,`<tag>` 与 git tag 完全一致,例如 `docs/release-notes/v1.135.0-vibe.1.md`。
- 模板 `docs/release-notes/TEMPLATE.md`,四段固定标题:本版内容、升级须知(破坏性变更、状态目录、回滚)、安装(链接 `docs/release.md`)、已知问题。CI 在末尾自动追加校验和与源码 commit,不用手写。
- 文案随功能 PR 一起提交;版本还没定时先写成 `docs/release-notes/next.md`,打 tag 的 PR 把它改名为正式 tag 名。

### 4.2 实现

解析逻辑在 `build/lib/releaseNotes.ts` 的 `resolveReleaseNotes(tag, dir, options)`,由只依赖 Node 内置模块的 `build/release-notes.ts` 暴露成 CLI,因为 release 工作流的 `source` 与 `publish` job 不安装构建依赖。规则:文件 `docs/release-notes/<tag>.md` 存在则首个非空行必须是包含 tag 的一级标题;缺失时只有 `--allow-missing` 才产出占位正文;正文末尾总是追加生成的"产物"段(tag、源码 commit、每个 `.sha256` 的校验和)。单元测试在 `build/lib/test/releaseNotes.test.ts`,随 `test-build-scripts` 运行。

1. `source` job 在校验 tag 之后立即执行该 CLI,文件缺失即失败;只有 `workflow_dispatch` 且勾选 `allow_missing_notes` 才放行。push tag 触发时没有这个开关。
2. `publish` job 以 sparse checkout 取回文案与 CLI,用下载的 `.sha256` 生成附录,`gh release create --notes-file --generate-notes` 创建草稿;GitHub 会把自动生成的 PR 清单接在文件正文之后。
3. `.github/release.yml` 按 PR label 给该清单分类(feat / fix / docs 与 ci / 其他),排除 `dependencies`。

`workflow_dispatch` 的输入改为两项:`tag`(已有)、`allow_missing_notes`(boolean,默认 false)。不再提供正文输入框。

### 4.3 人工确认

保持 `--draft`。维护者在 GitHub Releases 页面看到草稿:标题、由文件生成的正文、附录的 PR 清单、两个产物。确认或修改正文后点 Publish,这一步是唯一的"用户确认"。文案文件与最终正文不一致时,以发布时的正文为准,但差异应回写到文件(下一版 PR 顺手补)。

### 4.4 门禁

- `source`:tag 正则、tag 指向 commit、文案文件存在(或显式放行)。
- 文案文件的首个标题必须含 tag 字符串,防止复制上一版忘改。
- `validate`、`package` 不变。

## 5. 发布顺序(一次完整发布)

1. 功能 PR 里带上或更新 `docs/release-notes/next.md`。
2. 发布 PR:把 `next.md` 改名为 `<tag>.md`,补齐升级须知;合并到 main。
3. 在 main 的合并 commit 上打 tag 并 push,或在 Actions 里 dispatch 该 tag。
4. CI 校验、打包、创建草稿。
5. 维护者检查草稿正文与产物,Publish。
6. 事后如需改正文,直接改 release;下一版 PR 同步回文件。

## 6. 改动量

- `release.yml`:约 +25 行。
- `.github/release.yml`:约 15 行。
- `docs/release-notes/TEMPLATE.md`:约 20 行;`docs/release.md` 加一小节说明。
- 第一版文案 `docs/release-notes/<tag>.md`:随首个发布 PR 提供。
