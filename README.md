# Project Harness MVP

独立的 Bun + TypeScript 程序，通过本地 oh-my-pi SDK 运行一个长期 Main 和多个长期 owner。Main 与人讨论项目、维护记忆和设计文档；每个 owner 在自己的工作区（Git worktree、继承的目录或绑定的已有 checkout）中负责一项需求，并使用原生 task agent 组织实施、review 和测试。

协作沿用 omp 的原生 TUI、IRC、Agent Hub 和会话转录。项目共识放在普通 Markdown 文件中，`project.json` 只保存项目根、工作区和会话绑定。

## 安装

需要 `omp.lock.json` 固定的 Bun（当前 **1.4.3**）、Git，以及固定提交的完整 omp fork checkout。当前目录关系为：

```text
~/projects/
├── project-harness/
└── oh-my-pi/
```

先取得 `omp.lock.json` 中的仓库和完整 commit；在该 checkout 安装依赖、构建 native：

```sh
cd ~/projects/oh-my-pi
bun install --frozen-lockfile
bun run build:native
```

native 构建需要仓库 `rust-toolchain.toml` 指定的 Rust，当前为 `nightly-2026-08-12`。安装 Rust 和下载构建依赖需要可用网络。

本项目使用 Bun 的已注册包链接。先注册四个运行依赖，以及两个测试依赖：

```sh
cd ~/projects/oh-my-pi/packages/coding-agent
bun link
cd ../natives
bun link
cd ../utils
bun link
cd ../tui
bun link
cd ../ai
bun link
cd ../catalog
bun link

cd ~/projects/project-harness
bun install --frozen-lockfile
bun run build:omp-native
bun run verify:omp
```

`package.json` 中的链接必须与注册名一致：

| 用途 | 注册名 |
| --- | --- |
| 运行依赖 | `@oh-my-pi/pi-coding-agent`、`@oh-my-pi/pi-natives`、`@oh-my-pi/pi-utils`、`@oh-my-pi/pi-tui` |
| 测试依赖 | `@oh-my-pi/pi-ai`、`@oh-my-pi/pi-catalog` |

对应写法是 `link:@oh-my-pi/pi-coding-agent` 等。当前使用的 Bun 未能解析先前的相对路径 `link:` 写法，因此安装依赖前需要完成上面的注册。

### 固定依赖与 native

本地链接只指定包位置，`bun.lock` 不会固定被链接的源码。`omp.lock.json` 另外固定 fork commit、官方基线、Bun 和原生构建输入。`verify:omp` 校验六包来自同一干净 checkout，以及实际加载 addon 的来源记录和 SHA256。

native 由匹配源码构建；此前 18.3.2 addon 回退不作为正式基线。Rust 使用仓库 `rust-toolchain.toml`，macOS 还需要 CMake/Ninja。构建记录位于 omp Git 元数据目录，不提交二进制。不要软链接旧版 `~/.omp/natives/` 缓存，loader 会清理它。

fork 分支、官方同步、双仓验证和回退步骤见 [维护指南](docs/omp-maintenance.md)。日常启动不会自动拉取或修改依赖。

## 嵌入核心 runtime

默认 `project` 仍运行 TUI；嵌入应用从 `src/runtime/index.ts` 导入 `startMainSession`，直接调用 SDK，无需终端或独立服务。

| 接口 | 作用 |
| --- | --- |
| `startMainSession(options, host)` | 创建/恢复项目唯一 Main 和关联 owner |
| `snapshot()` / `observe(listener)` | 当前执行快照与同一切点之后的事件 |
| `readSession(id, options)` | Main、owner 或子任务的原生会话历史与运行信息 |
| `readCooperation(options)` | 真实 IRC 消息、广播关联、投递回执与记录覆盖范围 |
| `submitMainInput()` / `getInputReceipt()` | 用户输入与受理查询，默认 follow-up |
| `respondToUIRequest()` | 回答 SDK 已发出的确认/选择/输入请求 |
| `abortMainTurn()` / `close()` | 停止当前执行 / 关闭项目并释放锁 |

启动会话不自动调用模型；恢复 owner 不自动继续执行。host 支持 `headless`、事件式 UI 和内部 TUI adapter。没有 UI 时保持原工具审批拒绝策略；计划认可仍由 Main 通过 IRC 完成。

执行 `bun run example:runtime` 可运行有限生命周期、确定性模型的嵌入示例。API 类型见 `src/runtime/contracts.ts`。

源码按职责组织：`src/runtime/` 包含核心会话、协作、项目持久化与静态提示词；`src/tui/` 包含终端交互和启动选择器；`src/web/` 包含本机浏览器工作台和 HTTP 同步层；`src/main.ts` 为 CLI 入口。

## 启动与恢复

沿用用户现有的 omp 模型与认证配置。最常用的方式：cd 到目标目录后直接启动，harness 自动采用当前目录：

```sh
cd /path/to/your/repo
project
```

- 当前目录没有项目时直接创建，项目名默认为目录名（小写 slug）。
- 当前目录已有项目时直接恢复，等价于显式 `--resume`；同一项目根绑定多个项目时会出现选择列表。
- **Git 仓库**：按现状绑定规范化后的主仓库根；`git init` 过但 0 提交的仓库自动补一个空初始提交（绝不暂存用户文件）。此操作要求仓库已配置 `user.name` 和 `user.email`；若 index 已有暂存内容，会拒绝启动并保留暂存内容。owner 的分支从这个提交创建。
- **非空且非 Git 的目录**：直接接管为项目根，不执行 `git init`、不改动任何用户文件。
- **完全空白的目录**：自动接管——`git init` 并补空初始提交，让 owner 缺省就能用 Git worktree 隔离。
- 显式 `--repo` 指定的目录无论是否为 Git 仓库都会被接管；指向不存在的路径会报错，不会隐式创建目录。

也可以显式指定，参数可按需组合：

```sh
project --repo /absolute/path/to/dir              # 项目名默认取目录名
project --repo /absolute/path/to/dir --project my-project
project --repo /absolute/path/to/dir --project my-project --resume
```

也可以在本目录执行 `bun link` 注册 CLI（bin 名为 `project`），或用 `bun run dev` 加同样的参数。确保 `~/.bun/bin` 在 PATH 中。

### 本机 Web 工作台

使用 `--web` 在本机启动浏览器界面，默认绑定 `127.0.0.1:4173`：

```sh
project --web
project --web --port 0                 # 由系统分配可用端口
project --web --repo /path/to/repo --project demo
bun run dev:web -- --repo /path/to/repo --project demo
```

启动后终端会打印实际访问地址。`--port` 仅能与 `--web` 一起使用。Web 模式不会打开终端选择器：同一项目根存在多个 harness 项目，或目录名无法生成有效 slug 时，请显式传入 `--project`。恢复与默认项目发现规则和 TUI 相同。关闭进程会停止本机 HTTP 服务、结束 runtime 并释放项目锁；关闭浏览器标签不会结束服务或 runtime。

界面使用深色配色，左侧导航选择 Main、owner 任务或全局协作；中央区域显示会话和消息，右侧面板查看运行活动与待响应请求。输入始终发给 Main。标题栏菜单可切换输入行为：`followUp` 将消息排到当前轮次之后，`steer` 用于引导正在进行的轮次。输入区只有一个主按钮：有草稿时发送消息；草稿为空且 Main 正在运行时用于停止 Main 当前轮次。停止也可从标题栏菜单选择。

连接中断时写操作会暂时禁用；连接恢复后，页面会从 runtime 获取新快照并重新同步当前会话和待响应请求。恢复期间不会自动重发尚未确认的输入；页面会查询原输入回执，用户可在确认结果后重试。

工作台展示 Main、owner、子代理会话与 IRC 的实际运行活动。空闲或某个工具调用结束不代表需求完成；Main 仍负责评估进展并与用户讨论。首版输入发送给 Main，不提供直接向 owner/IRC 发消息、图片输入或共享资料浏览。

项目名和 owner ID 使用 1–64 字符的小写字母、数字和单连字符 slug；owner ID `main` 为保留身份。Git 目录的项目根绑定到规范化后的主仓库根路径（含其子目录与 linked worktree）；非 Git 目录的项目根就是该目录本身（规范化路径）。

已有项目无需显式 `--resume`，按项目根和项目名匹配到已存在的项目即自动恢复。启动期间持有项目独占锁，同一项目不能被两个 harness 进程同时打开。

## 工作目录与协作

项目数据位于仓库外：

```text
~/.local/share/project-harness/<项目根路径哈希>/<项目名>/
├── project.json
├── main/
│   ├── memory/MEMORY.md
│   ├── wiki/README.md
│   └── tmp/
├── shared/
│   └── <ownerId>/
│       ├── requirement.md
│       ├── plan.md
│       └── progress.md
├── worktrees/<ownerId>/
├── observations/cooperation.jsonl
└── sessions/
    ├── <Main 会话>.jsonl
    └── <Main artifacts 目录>/
        └── <ownerId>.jsonl
```

- **Main**：cwd 为 `main/`，附加工作区为整个 `shared/`。维护记忆索引、主题记忆文件和设计 wiki；具体代码调查交给 owner。
- **owner**：cwd 为主工作区，附加工作区为 `shared/<ownerId>/` 及其余 workspace 条目。缺省时：Git 项目根分配独立 worktree（分支 `project-agent/<项目名>/<ownerId>`，从已提交的 HEAD 创建）；非 Git 项目根直接继承项目根本身。
- **workspace 条目**：`spawn_owner` 可传 `workspace`（绝对路径，或 `[{from, checkout?}]` 列表）绑定已有目录。无 `checkout` 的条目原地使用该目录；有 `checkout` 的条目从所在 Git 仓按该分支切出 worktree（分支已存在则附着），落点在 `worktrees/<ownerId>[-N]`。第一个条目为主工作区（会话 cwd），其余条目进附加根。工作区目录跨 owner 独占，也不能指向 harness 自管的 `main/`、`shared/`。
- **owner 的 task agent**：继承 owner 的工作区；task isolation 关闭，因此共用工作区，需要协调同时修改同一文件的行为。

这些配置是工作区上下文，不构成文件系统沙箱。

日常流程：

1. 人与 Main 明确需求和验收条件；Main 写 `shared/<ownerId>/requirement.md`。
2. Main 调用唯一新增工具 `spawn_owner({ownerId,title})`，创建长期 owner；同 ID、同标题的已存活 owner 幂等返回。
3. owner 读需求、写 `plan.md`，通过原生 `write` 向 `agent://Main` 发送 IRC 消息请求审阅。
4. Main 通过 IRC 讨论方案，认可后用 `write` 向 `agent://<ownerId>` 明确通知实施。审批是角色提示约定，没有程序级实施闸门。
5. owner 用原生 task 做实施、review 和测试，更新 `progress.md` 并主动向 Main 发 IRC 汇报；Main 根据证据更新 wiki 和记忆。

`requirement.md` 主要由 Main 维护，`plan.md`、`progress.md` 主要由 owner 维护。文件记录当前共识；IRC 用于提醒、追问、审阅和继续指令。可用 `history://<ownerId>` 查看转录。

`spawn_owner` 成功只表示会话已创建并绑定，不表示计划或代码已经完成。恢复后的 owner 保持空闲，等待 Main 的下一条消息，不自动重发历史任务。

## 检查

```sh
bun run check
bun test
bun run test:integration
```

当前已通过：

- 项目持久化测试：9 个用例，覆盖显式恢复、进程锁、并发绑定更新、目录归属、脏文件和新提交保留，以及缺失会话/分支错绑拒绝恢复。
- 启动解析测试：8 个用例，覆盖项目名 slug 化、数据目录枚举（跳过损坏条目、按最近使用排序）、cwd 自动采用仓库、已有项目自动恢复、多项目选择和错误提示。
- 会话恢复校验：4 个用例，覆盖缺失或错误的原始 cwd、SDK 静默 cwd 回退，以及额外工作目录错绑。
- SDK 集成测试：两个真实 SDK owner 会话使用确定性的 mock provider，覆盖计划文件、原生 IRC、task 工作区继承及退出后恢复为空闲。
- TypeScript 检查。
- 真实终端的首次启动与 `--resume` 启动，均可显示原生 TUI，并在 SIGTERM 后保存会话、释放项目锁。

这里的“真实 SDK 会话”使用真实会话持久化和工具执行，模型响应由 mock provider 提供。尚未完成联网模型下的人工协作验收。

## 常见问题与边界

- **包无法解析**：确认已在对应 omp 包目录执行 `bun link`，再在 harness 执行 `bun install`。
- **native addon 无法加载**：优先完成 omp 的 `bun setup`。若使用当前环境的兼容性回退，确认是普通文件副本且平台正确；不要依赖会被清理的旧缓存软链接。
- **owner 创建中途失败**：错误会列出保留的工作区（含分支）、会话路径。先人工检查这些资源及日志；MVP 不自动收养、删除或重建未绑定资源，下次发现冲突会明确报错。
- **恢复时会话或工作区目录缺失、仓库或分支错绑**：启动失败，不自动创建替代会话。先定位并恢复正确资源；绑定的外部目录不可移动或重命名。owner 在原分支上的新提交和脏修改允许保留。
- **同仓多 owner**：同一仓库的不同分支可各切一个 worktree 并行；同一分支不能被两个 worktree 同时检出（Git 限制）。继承型条目跨 owner 独占，第二个缺省 spawn 会被拒绝并提示显式分流。
- **退出**：停止接收新 owner，abort/dispose 已创建会话，保留共享文件、代码 worktree、分支和转录。使用同一项目名加 `--resume` 恢复。

MVP 没有结构化进度状态、审批状态机、额外项目面板或完整 task observer UI。提交、合并、推送和 PR 均需遵守目标仓库规则并取得授权，runtime 不自动执行。omp 的必要 SDK 补丁由 fork 的 `harness-runtime` 分支维护；native 是忽略的本机构建产物，依赖基线与升级约束见维护指南。
