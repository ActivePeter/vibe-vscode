# 全屏登录与实例认证

> - 关联 Issue:[feat: 增加全屏登录与首次注册认证](https://github.com/ActivePeter/vibe-vscode/issues/2)
> - 对应 PR:[feat: require login authentication for hosted VS Code](https://github.com/ActivePeter/vibe-vscode/pull/15)
> - 实现范围:PR #15 当前分支;代码链接相对本文解析,随实现一同更新。
> - 范围:托管 Web 入口、单实例管理员账号与 18080 开发部署
> - 非目标:多用户公开注册、用户间文件或 Terminal 隔离、第三方 OAuth / OIDC
> - 安装、配置、升级与回滚操作以 [Releases and installation][release-doc] 与 [deploy-vscode-18080 SKILL][skill-doc] 为准;本文不重复维护操作手册。

## 1. 背景与目标

改动前,托管部署的链路是:

```mermaid
flowchart LR
    Browser[任何可访问公开端口的浏览器] --> Caddy[Caddy 终结 TLS]
    Caddy --> Remote[私有 socket 上的 Remote Server<br/>without-connection-token]
    Remote --> Workbench[Workbench、静态资源与 WebSocket]
```

问题在于连接 token 关闭后,实例对网络上的任何人开放;而 VS Code 自带的 token 机制只是 URL 参数,既不是登录,也没有会话生命周期。

目标是让**所有托管 HTTP 与 WebSocket 请求在到达 VS Code 路由前先通过登录**;首个注册者成为唯一管理员,之后公开注册关闭;会话持久、滑动续期、可退出;登录页全屏且自包含,不依赖 Workbench 资源;开发部署与正式发布共用同一套鉴权契约。

## 2. 术语

- **Remote Server**:`server-main.js` 进程,[`remoteExtensionHostAgentServer.ts`][agent-server] 在其中分发 HTTP 与 WebSocket 请求,[`webClientServer.ts`][web-client] 渲染 Workbench 页面与静态资源。
- **Caddy `forward_auth`**:Caddy 在反代每个请求前,先向鉴权端点发一个子请求,只有 2xx 才把原请求送往后端;WebSocket 升级请求同样经过它。
- **Better Auth**:嵌入 Remote Server 进程内的认证库。本设计只在进程内调用它的 `handler`,把它的原始 API 当作内部实现,不对外暴露。
- **单管理员 / `instanceOwner`**:用户表上一个固定值、唯一约束的字段,让并发注册也只能写入一条记录。
- **滑动续期**:会话在被使用且距上次续期超过 `updateAge` 时刷新过期时间,Caddy 把续期产生的 `Set-Cookie` 回传浏览器。

## 3. 结果与安全边界

未登录浏览器只能取得 Remote Server 返回的全屏注册或登录文档,不能取得 Workbench 启动配置、静态资源、管理连接或 Extension Host WebSocket。登录页不是 Workbench 内的遮罩;Caddy 在请求到达正常 VS Code 路由前,对所有非认证 HTTP 请求与 WebSocket 握手执行 `forward_auth`。Remote Server 只监听私有运行目录内的 Unix socket(开发部署目录为 `0700`,systemd 目录为 `0750`,仅专用组可访问),公开网络只暴露 Caddy 的 HTTPS / WSS 入口。

已建立 WebSocket 的帧不会重新触发 `forward_auth`;退出会撤销后续 HTTP 请求与握手的授权,不会主动断开已建立连接。

认证只证明浏览器可以访问这个单用户实例。它不会在共享的 Remote Server 内建立多租户文件、进程或 Terminal 权限边界。

## 4. 责任与 authority

| 角色 | 唯一拥有的状态或不变量 | 依赖 | 明确不拥有 |
| --- | --- | --- | --- |
| Remote Server 内的 Better Auth([`vibeAuthentication.ts`][auth]) | 首个管理员、密码验证、持久会话、滑动续租、可信 Origin 与失败限速 | CLI 提供的 auth state 目录、公开 Origin 和 Node 内置 SQLite | 公开 TLS、Workbench 资源授权策略 |
| Remote Server HTTP adapter([`vibeAuthenticationServer.ts`][auth-server]) | 全屏表单、`/auth/*` contract、请求大小与 `return_to` 边界 | Better Auth | 密码 hash 算法、会话存储实现 |
| Caddy Gateway([`Caddyfile`][caddyfile]) | 每个公开的非认证请求必须先得到 `/auth/verify` 的 2xx;续租 cookie 必须返回浏览器 | Remote Server 私有 socket | 账号、密码与会话生命周期 |
| VS Code Server([`webClientServer.ts`][web-client]) | 已获准连接的 Workbench 与远端能力;从已验证的公开 Origin 投影 `remoteAuthority` | 认证服务提供的固定公开身份 | 浏览器登录状态与登录 UI |
| Deployment Entry Point([`deploy-18080.sh`][deploy]) | 两进程生命周期、私有 socket、健康门、不可变 release 与回滚 | 环境 state、TLS material、构建产物 | 账号内容与会话 token |

Better Auth 和 VS Code 路由处于同一个 Remote Server 进程,共享同一个私有 Unix socket;Caddy 是唯一另一个常驻进程。认证数据库的打开、迁移和关闭属于 Remote Server 生命周期。部署入口只创建父目录并传入位置,不读取账号或会话内容。

## 5. 方案:五个任务与对应模块

鉴权横跨网关、Remote Server、认证库和部署编排四层,拆成五个任务。下表是"哪个文件做什么、为什么必须在这一层做"的唯一出处。

| 任务 | 要解决什么 | 模块 | 为什么必须动这一层 |
|---|---|---|---|
| **A. 在 Remote Server 内嵌入认证域** | 账号、密码校验、会话、限速、可信 Origin,以及持久化 | [`vibeAuthentication.ts`][auth]:Better Auth 配置、SQLite 数据库与 secret 的创建和权限、单管理员约束 | 认证状态必须与 Remote Server 同生命周期打开和关闭;放进同一进程后只剩一个私有 socket,不再需要 sidecar |
| **B. 对外 HTTP 契约与全屏页面** | 浏览器看到的只有登录 / 注册 / 退出页和 `/auth/*` 契约 | [`vibeAuthenticationServer.ts`][auth-server]:显式路由、`return_to` 与请求体边界、表单到 Better Auth 的适配、自包含 HTML、CSP 与打包的双语 JSON 文案 | Better Auth 的原始 API 面(`/update-user`、`/list-sessions` 等)不该暴露;显式路由把可达面收敛到第 8 节的契约 |
| **C. 接入 Remote Server 生命周期** | 鉴权路由要在原有"仅 GET、连接 token"检查之前处理;资源随服务器一起释放 | [`remoteExtensionHostAgentServer.ts`][agent-server]:`handleRequest` 先交给鉴权,创建失败时释放,禁止与连接 token 同时启用;[`webClientServer.ts`][web-client]:`remoteAuthority` 从配置的公开 Origin 投影 | 登录表单是 POST,原有分支会以 405 截断;`remoteAuthority` 与 cookie 的 Origin 必须是同一个公开身份 |
| **D. 网关强制授权** | 除鉴权路由外的一切请求先过 `/auth/verify` | [`Caddyfile`][caddyfile]:`@authentication` 直通、其余 `forward_auth`、续期 cookie 回传与 HTTP-only 鉴权子请求 | 只有网关能在请求到达 VS Code 路由前统一拦截 HTTP 与 WebSocket;后端私有 socket 不需要自己判断 |
| **E. 部署编排、健康门与回滚** | 两进程启动、鉴权状态目录、健康检查、不可变 release 与回滚 | [`deploy-18080.sh`][deploy] 及其[测试][deploy-tests]、[`SKILL.md`][skill-doc] | 状态目录权限、socket 归属、"未登录根路径必须 303"等门禁只能在部署入口验证 |

```mermaid
flowchart LR
  B[浏览器] -->|HTTPS / WSS| C[Caddy]
  C -->|/auth/* 直通| R[Remote Server<br/>vibeAuthenticationServer]
  C -->|其余请求先 forward_auth /auth/verify| R
  R -->|204 + 可选 Set-Cookie| C
  C -->|放行并回传续期 cookie| W[Workbench 路由 / WebSocket]
  R -->|303 → /auth/login 或 /auth/register| B
  R -->|进程内 handler| A[认证域 + Better Auth]
  A -->|读写| D[(SQLite<br/>better-auth.sqlite3)]
  A -.->|secret| S[(better-auth.secret)]
  E[deploy-18080.sh] -->|状态目录 · socket · 健康门| R
  E --> C
```

读图顺序:D 在网关拦截 → B 决定是放行、跳转还是 401 → A 在进程内完成凭据与会话 → C 保证鉴权先于原有路由并共享公开身份 → E 把这些接进部署与健康门。

## 6. 全流程时序

本节分两个视角、三个场景。6.1 是用户操作流程,只看用户在浏览器里做了什么、看到了什么,Caddy 与 Remote Server 合并为"服务"。6.2 是内部运行流程,把服务拆成 Caddy、Remote Server 请求分发、鉴权 adapter、Better Auth、SQLite、Workbench 服务端,每张图后列出由哪个文件的哪个函数完成、传递了什么。两个视角都按首次注册、后续登录、退出三个场景组织;部署启动只出现在内部视角,作为三个场景的前置。

### 6.1 用户操作流程

#### 首次注册

实例刚部署完、还没有管理员时,第一个打开地址的人被带去注册,注册成功即登录并回到最初想打开的地址。

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant Browser as 浏览器
    participant Service as 服务<br/>Caddy + Remote Server

    User->>Browser: 打开 https://host/?folder=…
    Browser->>Service: GET /?folder=…(无 cookie)
    Service-->>Browser: 303 到注册页,return_to 记住原地址
    Browser-->>User: 显示注册页(用户名、密码、确认密码,中英文自动选择)
    User->>Browser: 填写并提交
    Browser->>Service: POST /auth/register
    Service-->>Browser: 303 回原地址,附会话 cookie
    Browser->>Service: GET /?folder=…(带 cookie)
    Service-->>Browser: Workbench 页面
    Browser-->>User: 进入 Workbench,之后同一浏览器不再需要登录
```

用户可见的失败:两次密码不一致或用户名不合法时留在注册页并提示;两个人同时注册时只有一个成功,另一个被转到登录页;提交过快时提示稍后再试。

#### 后续登录

管理员已存在,换了浏览器、清了 cookie、或会话超过 TTL 未使用时,打开地址会被带到登录页。注册页此时不再可用,访问它会转到登录页。

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant Browser as 浏览器
    participant Service as 服务<br/>Caddy + Remote Server

    User->>Browser: 打开 https://host/?folder=…
    Browser->>Service: GET /?folder=…(无 cookie 或会话已过期)
    Service-->>Browser: 303 到登录页,return_to 记住原地址
    Browser-->>User: 显示登录页
    User->>Browser: 输入用户名、密码并提交
    Browser->>Service: POST /auth/login
    Service-->>Browser: 303 回原地址,附会话 cookie
    Browser->>Service: GET /?folder=…(带 cookie)
    Service-->>Browser: Workbench 页面
    Browser-->>User: 进入 Workbench
    Note over Browser,Service: 之后每个请求都带 cookie,持续使用时会话自动续期,不会中途被踢出
```

用户可见的失败:用户名或密码错误时留在登录页并提示;连续错误过多时提示稍后再试;从别的站点提交表单时提示来源不被信任。已登录状态下再打开登录页会直接回到 return_to。

#### 退出

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant Browser as 浏览器
    participant Service as 服务<br/>Caddy + Remote Server

    User->>Browser: 打开 https://host/auth/logout
    Browser->>Service: GET /auth/logout(带 cookie)
    Service-->>Browser: 确认页,显示当前用户名
    User->>Browser: 点击确认退出
    Browser->>Service: POST /auth/logout
    Service-->>Browser: 303 到登录页,清除会话 cookie
    Browser-->>User: 显示登录页
```

只有当前浏览器的会话被删除,其他设备上的登录不受影响。没有会话时访问退出页直接转到登录页。

### 6.2 内部运行流程

#### 前置:部署启动与健康门

```mermaid
sequenceDiagram
    autonumber
    participant Deploy as deploy-18080.sh
    participant Caddy as Caddy
    participant Remote as Remote Server<br/>remoteExtensionHostAgentServer
    participant Auth as Better Auth<br/>vibeAuthentication
    participant DB as SQLite

    Deploy->>Deploy: 停旧服务前用临时状态预检 Origin、TTL 与数据库初始化,创建 state/auth 与代际 socket 目录
    Deploy->>Remote: 启动共享 launcher,传 --auth-state-dir、--public-origin、TTL、--without-connection-token 与 --socket-path
    Remote->>Remote: 打开认证状态前拒绝连接 token 冲突或缺少私有 socket
    Remote->>Auth: createVibeAuthenticationServer(args, basePath)
    Auth->>Auth: 校验 Origin 与 TTL,读取或以 wx 创建 secret(0600)
    Auth->>DB: 打开 node:sqlite 数据库(0600,WAL),runMigrations
    Auth-->>Remote: HTTP adapter 与已验证的 publicOrigin
    Deploy->>Caddy: 启动,注入 AUTH_ADDRESS,AUTH_PATH,BACKEND_ADDRESS
    Deploy->>Remote: 私有 socket GET /auth/health 期望 204,GET / 期望 200
    Deploy->>Caddy: 公开 GET /auth/api/status 期望 200,GET /(无 cookie)期望 303
    Deploy->>Deploy: 健康门全部通过后原子提升 last-known-good
```

1. [`deploy-18080.sh`][deploy] 的 `validate_authentication_configuration` 检查 base path 和公开 Origin 输入;`validate_runtime_dependencies` 在临时状态调用真正的认证服务验证 Origin、TTL 与数据库初始化,完成后释放并删除临时状态,不打开用户数据库。候选验证成功后才允许停止旧服务;`run_gateway_stack` 创建 `<state>/auth`(`0700`)与代际 socket 目录,设置 `umask 0077`。
2. 以 `bin/vibe-vscode-server` 启动 Remote Server,使用开发部署与正式 systemd 共用的 `--auth-state-dir`、`--public-origin`、`--auth-session-ttl-seconds`、`--without-connection-token` 和 `--socket-path` CLI 契约。
3. [`remoteExtensionHostAgentServer.ts`][agent-server] 的 `createServer` 先拒绝连接 token 冲突和缺少私有 socket,再调用 `createVibeAuthenticationServer(args, serverBasePath)`。认证服务在打开持久状态前验证 Origin 与 TTL,随后读取或独占创建 secret、打开数据库、跑迁移,由 HTTP adapter 包装。后续 Remote Server 构造失败时释放已打开的认证服务。
4. 部署脚本启动 Caddy,注入 `VIBE_VSCODE_AUTH_ADDRESS`、`VIBE_VSCODE_AUTH_PATH`、`VIBE_VSCODE_BACKEND_ADDRESS`;[`Caddyfile`][caddyfile] 据此生成 `@authentication` 直通与 `forward_auth` 两条路径。
5. `is_runtime_healthy` 依次探测:私有 socket `/auth/health` 204、私有 Workbench 200、公开 `/auth/api/status` 200、公开根路径无 cookie 303。全部通过后 `promote_runtime` 原子切换 `last-known-good`。

#### 场景一:首次注册

```mermaid
sequenceDiagram
    autonumber
    participant Browser as 浏览器
    participant Caddy as Caddy
    participant Remote as Remote Server<br/>remoteExtensionHostAgentServer
    participant AuthSrv as vibeAuthenticationServer
    participant Auth as Better Auth<br/>vibeAuthentication
    participant DB as SQLite

    Note over Browser,DB: 首次访问,尚无管理员
    Browser->>Caddy: GET /?folder=…(无 cookie)
    Caddy->>Remote: forward_auth GET /auth/verify,剥除升级头,保留原始请求类别与 URI
    Remote->>AuthSrv: handleRequest 首先调用 handle(),命中 /auth/*
    AuthSrv->>Auth: invokeBetterAuth GET /get-session,使用配置的 Origin 与归一化 client IP
    Auth->>DB: 查会话
    Auth-->>AuthSrv: 无会话
    AuthSrv->>Auth: registrationOpen
    Auth->>DB: SELECT 1 FROM user LIMIT 1
    Auth-->>AuthSrv: 用户表为空
    AuthSrv-->>Caddy: 303 /auth/register?return_to=/?folder=…
    Caddy-->>Browser: 303
    Browser->>Caddy: GET /auth/register
    Caddy->>Remote: @authentication 直通
    Remote->>AuthSrv: handleRegisterPage,resolveLocale,renderPage 带 CSP nonce
    AuthSrv-->>Browser: 200 自包含 HTML

    Note over Browser,DB: 提交注册,创建唯一管理员
    Browser->>Caddy: POST /auth/register(表单)
    Caddy->>Remote: @authentication 直通
    Remote->>AuthSrv: handleRegister,readForm 上限 16 KiB 且单值,校验确认密码,registrationOpen
    AuthSrv->>Auth: invokeBetterAuth POST /sign-up/email,email 固定,username,password
    Auth->>Auth: origin 校验(固定 trustedOrigins 列表),限速,密码哈希
    Auth->>DB: INSERT user(instanceOwner 唯一约束)与 session
    Auth-->>AuthSrv: 200 与 Set-Cookie __Secure-vibe.session_token
    AuthSrv-->>Browser: 303 到 return_to,附 Set-Cookie
    Note over Browser,DB: 浏览器带 cookie 重新请求 return_to,进入场景二的"已登录请求"
```

6. 浏览器请求 Workbench 根路径。Caddy 对非认证路径先发 `forward_auth` 子请求 `GET /auth/verify`,携带 `X-Forwarded-Method`、`X-Forwarded-Uri` 和表示原始请求类别的 `X-Forwarded-Upgrade`;剥除真正的 `Connection`、`Upgrade` 头,确保鉴权子请求进入 HTTP handler。
7. Remote Server 的 `handleRequest` 第一步把请求交给 `VibeAuthenticationServer.handle`,路径以 `/auth` 开头即由 `dispatch` 处理,原有的"仅 GET"与连接 token 分支不会介入。
8. `handleVerify` 调 `readSession`,后者经 `invokeBetterAuth` 构造一个指向 `${publicOrigin}${apiPath}/get-session` 的 `Request`,以固定 Origin 设置 `host`,以 Caddy 归一化后的客户端地址设置 `x-vibe-client-ip`,交给 Better Auth 的 `handler`。无会话返回 `{ authenticated: false }`。
9. `isNavigationRequest` 判定这是页面导航(`Sec-Fetch-Mode: navigate` 或 `Accept: text/html`,非 WebSocket),`registrationOpen` 查用户表为空,于是 303 到 `/auth/register`,`return_to` 经 `sanitizeReturnTo` 收敛到 base path 内。
10. 浏览器请求 `/auth/register`,Caddy 的 `@authentication` 直接反代;`handleRegisterPage` 用 `resolveLocale` 选语言,`renderPage` 生成带 CSP nonce 的自包含页面。
11. 表单 POST 到 `/auth/register`。`handleRegister` 用 `readForm` 读取(`application/x-www-form-urlencoded`,上限 16 KiB,超限排空后 413),`getSingleFormValue` 只接受单值,先比对两次密码,再查 `registrationOpen`。
12. `invokeBetterAuth POST /sign-up/email`,email 固定为 `administrator@vibe.invalid`,`name` 与 `username` 取表单值。Better Auth 依固定 `trustedOrigins` 列表校验 `Origin`,按 `/sign-up/email` 每分钟 5 次限速,哈希密码,插入用户与会话。`instanceOwner` 的唯一约束保证并发注册只有一条能提交。
13. `copyBetterAuthHeaders` 把 `Set-Cookie` 与 `Retry-After` 原样带回,成功则 303 到 `return_to`;失败时 `readBetterAuthError` 取错误码映射为本地化文案,重渲染注册页。

#### 场景二:后续登录

```mermaid
sequenceDiagram
    autonumber
    participant Browser as 浏览器
    participant Caddy as Caddy
    participant Remote as Remote Server<br/>remoteExtensionHostAgentServer
    participant AuthSrv as vibeAuthenticationServer
    participant Auth as Better Auth<br/>vibeAuthentication
    participant DB as SQLite

    Note over Browser,DB: 访问,无会话,管理员已存在
    Browser->>Caddy: GET /?folder=…(无 cookie 或已过期)
    Caddy->>Remote: forward_auth GET /auth/verify
    Remote->>AuthSrv: handleVerify,readSession
    AuthSrv->>Auth: GET /get-session
    Auth->>DB: 查会话,不存在或已过期
    Auth-->>AuthSrv: 无会话
    AuthSrv->>Auth: registrationOpen
    Auth->>DB: SELECT 1 FROM user LIMIT 1
    Auth-->>AuthSrv: 用户表非空
    AuthSrv-->>Browser: 303 /auth/login?return_to=…(经 Caddy)
    Browser->>Caddy: GET /auth/login
    Caddy->>Remote: @authentication 直通
    Remote->>AuthSrv: handleLoginPage,registrationOpen 为 false,readSession 无会话,renderPage
    AuthSrv-->>Browser: 200 登录页

    Note over Browser,DB: 提交凭据
    Browser->>Caddy: POST /auth/login(表单)
    Caddy->>Remote: @authentication 直通
    Remote->>AuthSrv: handleLogin,readForm,username NFC 归一化,sanitizeReturnTo
    AuthSrv->>Auth: invokeBetterAuth POST /sign-in/username,rememberMe true
    Auth->>Auth: origin 校验,/sign-in/username 每分钟 5 次限速,比对密码哈希
    Auth->>DB: 查用户,INSERT session
    Auth-->>AuthSrv: 200 与 Set-Cookie,或 401 / 403 / 429
    AuthSrv-->>Browser: 303 到 return_to,附 Set-Cookie,失败则以原状态码重渲染登录页
```

14. 无会话且用户表非空时,`handleVerify` 对导航请求 303 到 `/auth/login`;非导航请求(fetch、WebSocket)返回 401 JSON,不跳转。
15. `handleLoginPage` 先查 `registrationOpen`,为真则改去注册页;再 `readSession`,已登录则直接 303 到 `return_to`;否则渲染登录页。`handleRegisterPage` 反向对称:`registrationOpen` 为假时改去登录页。
16. `handleLogin` 用 `readFormOrReply` 读表单,用户名做 NFC 归一化,`return_to` 从表单隐藏域取并经 `sanitizeReturnTo`。`invokeBetterAuth POST /sign-in/username` 带 `rememberMe: true`;Better Auth 校验 `Origin`、按 `/sign-in/username` 每分钟 5 次限速、比对密码哈希,成功则插入新会话。
17. `copyBetterAuthHeaders` 带回 `Set-Cookie` 与 `Retry-After`。失败时按 429、403 或 `INVALID_ORIGIN`、其他分别映射为"稍后再试"、"来源不被信任"、"用户名或密码错误",以 Better Auth 的状态码重渲染登录页并回填用户名。

登录成功后浏览器带 cookie 重新请求 `return_to`,进入下面的"已登录请求与续期"。每个非认证 HTTP 请求、静态资源、manifest 分块与 WebSocket 握手都走一遍这张图;已建立连接的帧不重新验证。

```mermaid
sequenceDiagram
    autonumber
    participant Browser as 浏览器
    participant Caddy as Caddy
    participant Remote as Remote Server<br/>remoteExtensionHostAgentServer
    participant AuthSrv as vibeAuthenticationServer
    participant Auth as Better Auth<br/>vibeAuthentication
    participant DB as SQLite
    participant Web as webClientServer<br/>Workbench

    Browser->>Caddy: GET /(带 cookie)
    Caddy->>Caddy: 删除客户端可能带来的 X-Vibe-Auth-Set-Cookie
    Caddy->>Remote: forward_auth GET /auth/verify
    Remote->>AuthSrv: handleVerify,readSession
    AuthSrv->>Auth: GET /get-session
    Auth->>DB: 查会话,距上次续期超过 updateAge 则刷新过期时间
    Auth-->>AuthSrv: 会话有效,可能附续期 Set-Cookie
    AuthSrv-->>Caddy: 204,可能附 Set-Cookie
    Caddy->>Caddy: copy_headers 把 Set-Cookie 存为 X-Vibe-Auth-Set-Cookie,有值则以 +Set-Cookie 回传
    Caddy->>Remote: reverse_proxy 已授权的原请求,上游剥掉 X-Vibe-Auth-Set-Cookie
    Remote->>Web: 原有路由,仅 GET,无连接 token
    Web->>Web: remoteAuthority 取配置的 publicOrigin,不信任请求头覆盖
    Web-->>Browser: workbench.html,再走 PR #14 的分块缓存启动
    Browser->>Caddy: WebSocket 升级(带 cookie)
    Caddy->>Remote: forward_auth /auth/verify,无 cookie 时 401 且不跳转
    Caddy->>Remote: 代理升级到扩展宿主
```

18. 每个非 `/auth/*` 请求(含 WebSocket 升级)都重复第 6 到 8 步。Caddy 先删除客户端可能伪造的 `X-Vibe-Auth-Set-Cookie`。
19. Better Auth 的 `get-session` 在距上次续期超过 `updateAge` 时刷新过期时间并返回新的 `Set-Cookie`;`handleVerify` 在 204 前检查成功响应最多携带一个 cookie。拒绝响应可清除多个旧 cookie,由 Caddy 原样回传,不走成功续租的单 cookie 桥接。
20. Caddy 的 `forward_auth` 用 `copy_headers Set-Cookie>X-Vibe-Auth-Set-Cookie` 暂存,`@renewedSession` 匹配到时以 `+Set-Cookie` 加到响应,再 `reverse_proxy` 原请求到同一 socket,并在上游剥掉该头。
21. Remote Server 进入原有路由。[`webClientServer.ts`][web-client] 用 `getWebClientRemoteAuthority` 从认证服务已验证的 `publicOrigin` 取公开身份写入 `remoteAuthority`,忽略请求中的 Host 和转发端口,渲染 `workbench.html`;之后走 PR #14 的分块缓存启动,静态资源与 manifest 同样逐个经过 `forward_auth`。
22. 鉴权路由和子请求中的 `Connection`、`Upgrade` 被剥除,不能进入 Node 独立的升级事件绕过 HTTP 鉴权。`X-Forwarded-Upgrade` 仅用于判别无登录握手应返回 401 而非导航 303;只有验证成功后的原请求可以升级。

#### 场景三:退出

```mermaid
sequenceDiagram
    autonumber
    participant Browser as 浏览器
    participant Caddy as Caddy
    participant Remote as Remote Server<br/>remoteExtensionHostAgentServer
    participant AuthSrv as vibeAuthenticationServer
    participant Auth as Better Auth<br/>vibeAuthentication
    participant DB as SQLite

    Browser->>Caddy: GET /auth/logout
    Caddy->>Remote: @authentication 直通
    Remote->>AuthSrv: handleLogoutPage,readSession,无会话则 303 /auth/login
    AuthSrv-->>Browser: 200 确认页,显示用户名
    Browser->>Caddy: POST /auth/logout
    Caddy->>Remote: @authentication 直通
    Remote->>AuthSrv: handleLogout,readForm,invokeBetterAuth POST /sign-out
    Auth->>DB: 删除当前会话
    AuthSrv-->>Browser: 303 /auth/login,附过期 cookie
```

23. `GET /auth/logout` 需要有效会话,否则 303 到登录页;有会话时渲染确认页并显示用户名。
24. `POST /auth/logout` 经 `invokeBetterAuth POST /sign-out` 删除当前会话,303 到 `/auth/login` 并附过期 cookie;后续请求不再获准,其他浏览器的会话不受影响;已有 WebSocket 的边界见第 3 节。

### 6.3 失败分支

每一步的失败出口见第 9 节的表:manifest 与 secret 损坏在部署启动时失败关闭;并发注册由唯一约束裁决;凭据错误、跨源、超限、限速在注册与登录时以 401 / 403 / 413 / 429 返回并重渲染页面;会话缺失时按导航与否分别 303 与 401。

所有注册请求都为用户写入同一个不可伪造的 `instanceOwner` 值,该字段在数据库中具有唯一约束。因此并发首次注册也只能提交一个管理员;胜出的请求建立账号和会话,其他请求看到注册已关闭。账号一旦存在,`/auth/register` 只会转向登录流程。数据库、secret 或 schema 无法安全读取时启动失败关闭,不会清空状态后重新开放注册。

## 7. 各任务的关键实现与取舍

### A. 认证域(`vibeAuthentication.ts`)

- **持久化**:`<state>/auth/better-auth.sqlite3` 与 `better-auth.secret`,目录 `0700`,文件 `0600`;secret 为 32 字节 base64url,以 `wx` 独占创建,存在则读取并校验格式,格式不对直接启动失败,不重建、不清空。数据库开启 WAL、外键、5 秒 busy timeout;启动时跑 Better Auth 迁移。
- **单管理员**:用户表附加字段 `instanceOwner`,固定值、`input: false`、唯一约束。任何注册都写同一个值,数据库层面保证只有一条能提交;`registrationOpen` 就是"用户表是否为空"。
- **会话**:`expiresIn` 默认 12 小时(可配 60 秒到 7 天),`updateAge` 取 5 分钟与半个 TTL 的较小值;cookie 前缀 `vibe`,`Secure` / `HttpOnly` / `SameSite=Lax`,`Path` 限定到 server base path。
- **限速**:存 SQLite,默认 100 次每分钟;`/sign-in/username`、`/sign-up/email` 各 5 次每分钟;`/get-session` 免限速,因为 Caddy 对每个 Workbench 资源都会调它。
- **续租 cookie**:显式关闭 `session.cookieCache`,成功的 `/auth/verify` 最多发一个 `session_token` cookie;拒绝时允许多个清除 cookie。HTTP 请求与握手触发续租,单靠已建立 WebSocket 的帧不会续租。
- **可信 Origin**:运维通过 `--public-origin` 指定唯一的浏览器可见 HTTPS Origin。`create` 在打开持久状态前验证并规范化它,Better Auth 的 `baseURL`、`trustedOrigins`、HTTP adapter 的 Request URL 与 Workbench 公开身份共用该值,不从请求头决定可信来源。
- **取舍**:嵌入进程而不是 sidecar,是为了一个进程、一个 socket、一次生命周期;用 Better Auth 而不是自研,是为了不自己维护密码哈希、会话与限速。使用 Node 内置 `node:sqlite` 的 `DatabaseSync`,不新增原生 SQLite 构建依赖;数据库文件与 secret 格式保持不变。

### B. HTTP 契约与页面(`vibeAuthenticationServer.ts`)

- 仅开放第 8 节的显式认证路由;其余认证子路径一律 405。
- `/auth/verify` 是 Caddy 契约:有会话 204;无会话且是页面导航(`Sec-Fetch-Mode: navigate` 或 `Accept: text/html`,非 WebSocket)303 到注册或登录页并带 `return_to`;其余 401。
- `return_to` 只接受当前 base path 内的绝对路径,拒绝 `//`、跨 base path、鉴权路由自身和超长值;表单只接受单值字段,请求体上限 16 KiB,超限先排空再 413。
- 页面是自包含 HTML 与内联样式,CSP `default-src 'none'; style-src 'nonce-…'; form-action 'self'; frame-ancestors 'none'`,无脚本,`X-Frame-Options: DENY`;英文与简中 JSON 文案在模块加载时各读一次并缓存,由 `?lang=` 或 `Accept-Language` 选用;所有插值经 `escapeHtml`。
- 到 Better Auth 的适配:用 `fromNodeHeaders` 转换请求头,按固定 Origin 设置 URL 与 `host`,按 Caddy 归一化后的 `X-Forwarded-For` 首值设置 `x-vibe-client-ip`,按路由构造 JSON 请求;`Set-Cookie` 与 `Retry-After` 原样回传;错误码映射为本地化文案,不透传 Better Auth 原文。

### C. Remote Server 接入

- `handleRequest` 第一步交给鉴权服务器,命中 `/auth*` 即返回;因此登录 POST 不会被原有"仅 GET"分支以 405 截断。
- `--auth-state-dir` 是唯一启用入口,须同时提供 `--public-origin`、`--socket-path` 和 `--without-connection-token`;冲突在打开认证数据库前拒绝,后续构造失败会释放认证服务。
- `webClientServer.ts` 从已验证的公开 Origin 取 `remoteAuthority`,不允许 Host、转发 Host 或转发端口覆盖;未开启此认证的上游 token server 保持原来的 proxy host 回退契约。

### D. Caddy

- `@authentication` 匹配 `/auth` 与 `/auth/*`,直接反代到 Remote Server socket。
- 其余请求进入 `route`:先删除客户端可能带来的 `X-Vibe-Auth-Set-Cookie`,`forward_auth` 到 `/auth/verify` 并把其 `Set-Cookie` 复制成该头,有值时以 `+Set-Cookie` 回传浏览器,再反代并在上游剥掉该头。
- 鉴权路由与子请求只允许 HTTP;升级头剥除与原请求放行顺序见第 6.2 节的已登录请求时序。公开身份来自配置,不依赖原始代理头。

### E. 部署脚本

- 新 runtime 只有 Caddy 与内嵌 Better Auth 的 Remote Server 两进程,没有 sidecar 或额外 auth socket。`vibe-release.json` 的 `authentication: "embedded-cli-v1"` 声明共享 CLI 契约,不靠空的编译标记模块。
- 每次启动按代际命名 socket(`backend-<pid>-<n>.sock`),通过 tmux 环境传递,避免新旧代际抢同一路径;鉴权状态目录 `0700`,进程 `umask 0077`。
- TTL 范围由认证服务唯一校验,CLI 只做 `Number()` 解析;候选预检在临时状态调用该服务,不重复维护 shell 范围规则。`set_runtime_link` 原子化并处理失败;`promote_runtime` 与 `cleanup_inactive_releases` 分离,晋升失败回滚、清理失败仅告警。

## 8. HTTP contract

下列路径都加上可选的 server base path:

| 路径 | 方法 | 行为 |
| --- | --- | --- |
| `/auth` 或 `/auth/` | GET / HEAD | 登录页面别名 |
| `/auth/register` | GET / HEAD / POST | 首次注册页面与唯一管理员创建 |
| `/auth/login` | GET / HEAD / POST | 登录页面与 Better Auth 凭据验证 |
| `/auth/logout` | GET / HEAD / POST | 退出确认与当前会话撤销 |
| `/auth/api/status` | GET | 返回 `authenticated`、`registrationOpen` 和已登录用户名 |
| `/auth/verify` | GET / HEAD | Caddy `forward_auth` contract;已登录返回 204,页面导航返回 303,非导航与 WebSocket 返回 401 |
| `/auth/health` | GET | Remote Server 内部认证状态检查,返回 204 |

Caddy 将认证路由直接转发到同一个 Remote Server socket;其他路径必须先通过 `/auth/verify`。Remote Server 在认证路由处理之后才进入原有的仅 GET、连接 token 和 Workbench 路由,所以登录表单 POST 不会被原有 405 分支截断。启用嵌入式认证时必须同时使用 `--without-connection-token`,因为私有 socket 和强制 Caddy 边界已经成为唯一入口;配置冲突会使启动失败。

## 9. 请求授权与失败处理

| 情况 | 行为 | 用户看到 / 恢复方式 |
|---|---|---|
| 首次访问,尚无管理员 | `/auth/verify` 对导航返回 303 到 `/auth/register` | 全屏注册页;创建后 303 回原地址 |
| 已有管理员,浏览器无会话 | 导航 303 到 `/auth/login`;非导航与 WebSocket 401 | 登录页;登录后 303 回 `return_to` |
| 并发首次注册 | 唯一约束只允许一条提交 | 一个 303,其余 409 并提示改用登录 |
| 用户名或密码错误 | Better Auth 返回错误,页面重渲染 | 401 与本地化提示;连续 5 次后 429 |
| 跨站表单或 Origin 不匹配 | Better Auth origin 校验拒绝 | 403,提示从同一地址重新打开 |
| 请求体超过 16 KiB | 排空后拒绝 | 413 |
| 会话使用超过 `updateAge` | `/auth/verify` 续期并经 Caddy 回传 `Set-Cookie` | 请求会刷新会话;持久化账号和有效会话不因重启丢失 |
| 退出 | `/sign-out` 撤销当前会话 | 303 到登录页;其他浏览器会话不受影响 |
| secret 或数据库损坏 | 启动失败 | 服务端报错,不清空状态、不重开注册 |
| 同时配置连接 token | 构造阶段抛错 | 服务端报错,要求 `--without-connection-token` |
| 共享 launcher 缺少鉴权 CLI 参数 | 拒绝启动 | 按安装文档配置持久状态与公开 Origin |

本次从原生 SQLite 依赖切换为 Node 内置 SQLite,沿用既有 `better-auth.sqlite3` 与 `better-auth.secret`,不重建账号或清空会话。

## 10. 部署、健康与回滚

新不可变 release 同时包含声明 `embedded-cli-v1` 的 metadata、Caddyfile、Node runtime、Better Auth 依赖、登录 JSON 文案和 VS Code 构建输出。可变认证状态位于 release 与 checkout 之外,运行时只启动 Remote Server 与 Caddy。部署健康门要求:

- Remote Server 私有 socket 的 `/auth/health` 返回 204;
- 公开 `/auth/api/status` 返回 200;
- 无 cookie 的 Workbench 根路径返回 303,而不是 Workbench HTML;
- 同一个私有 socket 的 Workbench 路由返回 200;
- Caddy 监听公开的 `0.0.0.0:18080`。

新候选和选定快照必须声明共享 CLI 契约。唯一兼容桥是恢复已验证健康、但尚未采用 CLI 的旧 embedded release 时传入它原来的环境参数;它不能成为新选定快照,也不会启动 sidecar。切换前的候选验证失败不停止旧服务,切换后的启动或健康失败恢复原健康版本。

`VIBE_VSCODE_PUBLIC_ORIGIN` 必须从运维配置或用户确认得到,不能用探针的 localhost 地址代替浏览器真实地址。配置缺失时保留现有服务,不启动更新。可伪造代理头的安全边界由下列回归测试验证,不再数 Caddyfile 行数或 grep HTML。

## 11. 验证

| 验证层 | 关键场景 |
| --- | --- |
| [认证域与 HTTP 回归][auth-tests] | 未注册时的导航与 WebSocket 门禁;注册、持久化、续期、退出;并发单管理员;`/verify` 免限速;固定 Origin 与伪造请求头、CLI 校验、双语资源、限速与越界请求体;状态损坏时失败关闭 |
| [Web Client 服务端回归][web-client-tests] | 固定公开身份不被伪造 Host/端口覆盖,原 token server 回退,以及缓存与启动路径 |
| [部署 transaction 回归][deploy-tests] | 配置校验、健康门调用顺序、代际 socket 分配、指针替换失败、晋升与清理失败路径 |
| [真实 Caddy 门禁回归][gateway-tests] | 未登录导航 303、资源与握手 401,认证路径无法升级或路径归一化绕过;伪造 Origin 403、登录后 HTTP 200/WS 101、单 cookie 续租、退出撤销与多 cookie 清理 |
| [发布与 launcher 回归][release-tests] | metadata、资源完整性、开发/正式 CLI 参数一致性与 systemd 环境展开 |

## 12. 代码责任地图

| 责任 | 入口 |
| --- | --- |
| Better Auth 配置、SQLite、单管理员约束与会话 | [`vibeAuthentication.ts`][auth] |
| HTTP contract、全屏页面与 Better Auth adapter | [`vibeAuthenticationServer.ts`][auth-server] |
| Remote Server 生命周期与认证初始化 | [`remoteExtensionHostAgentServer.ts`][agent-server] |
| 公开路由、`forward_auth` 与续租 cookie 传递 | [`Caddyfile`][caddyfile] |
| 已验证公开 Origin 到 Workbench `remoteAuthority` 的投影 | [`webClientServer.ts`][web-client] |
| 构建、两进程编排、不可变 release 与健康门 | [`deploy-18080.sh`][deploy] |
| 认证域与 HTTP 回归 | [`vibeAuthentication.test.ts`][auth-tests] |
| 部署 transaction 回归 | [`deploy-18080.test.sh`][deploy-tests] |
| 真实 Caddy 安全边界回归 | [`authentication-gateway.test.ts`][gateway-tests] |

[release-doc]: ../../docs/release.md
[skill-doc]: ../../.agents/skills/deploy-vscode-18080/SKILL.md
[auth]: ../../src/vs/server/node/vibeAuthentication.ts
[auth-server]: ../../src/vs/server/node/vibeAuthenticationServer.ts
[agent-server]: ../../src/vs/server/node/remoteExtensionHostAgentServer.ts
[web-client]: ../../src/vs/server/node/webClientServer.ts
[caddyfile]: ../../resources/server/vibe-vscode/Caddyfile
[deploy]: ../../.agents/skills/deploy-vscode-18080/scripts/deploy-18080.sh
[deploy-tests]: ../../.agents/skills/deploy-vscode-18080/tests/deploy-18080.test.sh
[auth-tests]: ../../src/vs/server/test/node/vibeAuthentication.test.ts
[web-client-tests]: ../../src/vs/server/test/node/webClientServer.test.ts
[gateway-tests]: ../../.agents/skills/deploy-vscode-18080/tests/authentication-gateway.test.ts
[release-tests]: ../../build/lib/test/webClientRelease.test.ts
