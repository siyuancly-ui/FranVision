# FranVision 整体架构总览

> 本文档由 chat 讨论汇总整理，记录的是"为什么这么设计"和"当时决定了什么"。
> **如果本文档内容和某个模块自己的 CLAUDE.md 有出入，以该模块的 CLAUDE.md 为准**——
> 那边反映的是代码实际现状，这里保留的是决策背景，两者不保证时刻同步。
> 本文档基于历史对话整理，可能有遗漏或过时之处，欢迎随时补充修正。

---

## 一、项目愿景

FranVision 的长期目标：基于 **Wix + Velo** 搭建一套自己的地产摄影业务平台，逐步取代对 Zenfolio、Wave 等第三方平台的依赖。终态类似一个"自己的 Winsold"——**一个 Property Job → 一个客户交付页面**，包含照片、下载、Feature Sheet、视频、Floor Plan、Invoice、付款等所有内容。

**开发原则**：不追求一次性做完，采用模块化方式逐步增加功能；尽量利用 Wix 已有的 Hosting/CMS/Media Storage/Velo Backend，复杂自定义功能由独立代码组件实现。

---

## 二、Wix 网站现状

- 正式使用 **Wix Studio**（不是 Wix Harmony——Harmony 是 AI 生成建站工具，**不支持 Velo/Dev Mode**，踩过这个坑，已经切换过来）
- Workspace 名称：**FranVision Media**
- 网站名：**FranVision**（Blank Canvas 建的，非模板）
- 目前用**免费方案**开发测试，等到需要测试真实付款功能（Invoice/Payment 阶段）时再升级付费方案
- 现有的 **gta3d.ca** 域名和 Premium 方案挂在另一个叫"Hub"的旧网站上，跟本项目无关的历史内容混在一起，**计划等新系统开发到位后，再把域名和付费方案重新指派（reassign）过来**，Hub 会自动退回免费版但内容不会丢
- Wix 免费版本身支持 Velo/Dev Mode，不需要为了写代码这件事本身付费；付费市场卖的是"雇人帮你写"，跟"自己动手写代码"是两回事

---

## 三、已有模块现状

### 3.1 Job Generator
> 2026-09-08 起，本节只保留不常变的高层摘要；具体实现、confirmed decisions、已知局限见 `job-generator/CLAUDE.md`——那边才是随代码更新的现状来源，这里不再手动逐条同步。

- 以订单为中心：下单即创建 Job，固定 JobID（格式 `FVS-YYYYMMDD-XXX`）+ 拍摄详情
- 内嵌**计价引擎**（选服务→自动报价，`pricing/` 模块，从不重复实现）+ **佣金计算器**（跟计价完全独立，按摄影师分别配置费率，不是"一个共享费率+一个例外名单"）
- 原本是**本地桌面工具**（用 `fs.mkdirSync` 等操作本地文件系统，macOS 原生弹窗选文件夹），跟 Wix/云端无关
- **Dropbox 集成（持续在加）**：建 Job 时会同时在 Dropbox 建好对应文件夹骨架（命名规则不变，"日期+地址+客户姓名"，日期不补零）并贴隐藏 `jobId` 标签；此外还有**双向 Push/Pull 文件同步**（针对已经建好的 Job，把实际照片/视频跟 Dropbox 双向同步，两个方向各一个按钮，改过双方的文件算冲突、留给人工处理，不自动覆盖）。`job.json`/`Job Info.txt` 这两个文件设计为**永远只留本地**，不同步上 Dropbox。
- 待办：核心代码逻辑仍需重新打包，以后要适配进 Wix（Velo 后端）

### 3.2 Pricing Engine
- 纯 JS 计算逻辑，零依赖，UMD 模式写成，**Node 和浏览器通用**，天然适合直接搬进 Velo 后端
- 核心原则：**价格必须服务端权威重算，前端传来的总价只能当参考**——这条原则后续在下载权限判断等场景也复用
- 待办：原样复制进 Velo 的 backend 文件即可，几乎不用改动

### 3.3 Feature Sheet Builder
- 独立网站，跑在 **Cloudflare Worker**（当前域名是 Cloudflare 分配的默认域名，非自定义域名）
- 数据库用 **Supabase**：只有一张 `projects` 表（`id` = projectId，`data` 是 jsonb 大字段，里面塞了 propertyInfo/agentInfo/photos数组/colorTheme 等所有信息），照片文件存 Supabase **Storage** 的 `photos` bucket（原图 `<projectId>/<photoId>.<ext>`，缩略图 `<projectId>/<photoId>_thumb.jpg`）
- **现状**：照片是在 Feature Sheet Builder 网站里**独立手动上传**的，跟 Dropbox 完全没有关联，属于优先做出一个能独立使用的工具而选择的过渡方案
- **终态目标（已确认）**：Feature Sheet Builder 的独立上传功能以后要**取消**，全系统只保留 Dropbox 一个上传入口，Feature Sheet Builder 变成纯读取方
- **未来整合方向**：
  - 客户端**不需要**跟 Gallery 做 UI 整合——Feature Sheet 是交付邮件里独立的一个入口，跟 Gallery 是并列关系
  - 后台管理端**需要**并入 FranVision 统一管理系统，具体方式待定
  - 域名要换成 FranVision 自己的子域名（比如 `featuresheet.franvision.ca`）——技术上 Cloudflare 原生支持自定义域名绑定，只是还没配置，等正式域名定下来后是纯配置操作

---

## 四、存储架构决策

**数据库/存储三方分工：**

| 存什么 | 存在哪 | 说明 |
|---|---|---|
| 素材原始文件（HD照片、各比例MLS照片、视频、Floor Plan原图） | **Dropbox**（唯一上传入口） | 已按 Job 分好文件夹，固定命名规则（日期+地址+客户姓名） |
| 展示用轻量数据（缩略图、Feature Sheet Builder 选图用的小图） | **Supabase** | 与 Feature Sheet Builder 共享同一张 `projects` 表；Gallery 也读这里 |
| Job/客户/支付状态等结构化业务数据 | **Wix Data (CMS)** | Jobs 集合、客户信息、支付状态、Wave Invoice 编号等 |

**为什么不把照片迁移进 Wix Data**：Wix Data 单条记录上限约 512KB，权限控制粒度粗，大文件配额跟网站付费方案绑定，都不适合承载"按付款状态动态变化的媒体访问控制"这个需求，Supabase（RLS + Storage 私有桶）和 Dropbox（专业文件仓库）分别更适合各自的角色。

**Job ID 统一方案（已确认，是关键的一根线）**：
- 以后 Job Generator 生成的 JobID，**直接作为 Supabase `projects` 表的 `id`**，不再各自独立编号
- 历史遗留的 Job/project 暂不处理，等新系统跑稳定后再一次性迁移，**不阻塞当前进度**

**Dropbox 文件夹与 Job 的关联机制**：
- 不把 Job ID 塞进文件夹名字（会破坏"一眼看出是哪个 Job"的可读性）
- 改用 Dropbox 的 **Property（隐藏属性）** 功能：文件夹名字不变，贴一个看不见的标签
  - Property Template 名字：**FranVision Job**
  - `template_id`：`ptid:R599LCPosWEAAAAAAAAIFA`
  - 字段：`jobId`（字符串类型）
  - 已在 `job-generator/.env` 配置好，`dropbox-sync.js` 每次建 Job 时自动贴标签
- Dropbox 文件 ID 在"覆盖替换文件内容""移动/改名"时保持不变；但"删除后重新上传"会产生全新 ID，关联会断——**这个自愈机制（断链先挂起标记，同文件夹出现同名新文件时自动按文件名重新匹配，匹配不上转人工确认）是「Dropbox → Supabase 缩略图同步管道」（见七、进度快照里的下一步任务，独立 Cloudflare Worker，`photo-sync-worker` 分支）自己需要具备的能力，不是 Job Generator 的职责——Job Generator 本身不存这种 dropboxFileId 引用，也没有断链检测代码。2026-09-08 核实：job-generator 代码库里目前没有任何自动重新匹配逻辑；这个机制在 Worker 那边是否已经实现，需要去那个模块自己确认，本文档未验证。**

**低分辨率选图 ↔ 高清成品图联动机制**：
- 每张照片的 Supabase 记录里存一个 `dropboxFileId` 字段，指向 Dropbox 里的高清原图
- 日常选图/浏览走 Supabase 小图，加载快；只有"生成 PDF"这个动作才会去 Dropbox 拉取被选中那几张的高清原图，不影响日常体验

**Dropbox API 接入现状（已完成一次性设置）**：
- 已创建 Dropbox App，选择 **Full Dropbox** 权限（因为文件夹分散在账号各处，不是全塞在一个 App Folder 里）
- 已完成 OAuth 授权流程，拿到长期有效的 **refresh token**
- 因为只是自己账号自用，不涉及外部用户各自连接 Dropbox，**不需要经过 Dropbox 官方审核流程**
- **安全要求（反复强调）**：App Key / App Secret / Refresh Token 绝不能硬编码进代码或提交进 Git，一律走环境变量（`.env`，且确认 `.gitignore` 排除），长期目标是让这些凭证只活在云端密钥保管箱（Cloudflare Worker 的 secrets），不进入任何人的个人电脑

---

## 五、Gallery + PaymentGate 模块设计

> 详细规划见 `docs/Gallery_PaymentGate_架构规划.md`，这里只记要点。

**交付形态两层，彻底分开**：
1. **All-in-one 展示链接**：照片/视频/3D/Floor Plan 只读嵌入展示，**不可放大、不可下载**——因此**不需要水印**（反正拿不到大图原图）
2. **单项一键下载按钮**（MLS各比例、HD Photos、QR Code、Feature Sheet、Slideshow Video 等）：对应 Dropbox 里的实际文件，**未付款锁定，付款后解锁**

**下载按钮"表面在 FranVision，实际在 Dropbox"的实现方式**：
- 客户点击下载按钮 → 后台从 Dropbox 对应文件夹取文件 → 打包 zip → 返回下载，客户全程只看到自己的域名
- 打包压缩这种"重活"放在 **Cloudflare**（不放 Wix Velo，Velo 不适合处理大文件），建议**提前打包好**而不是现场压缩，避免超时

**支付两条路径**：
| 路径 | 自动化方式 |
|---|---|
| 信用卡 | **Wave Accounting 官方支持 Webhook**（含 invoice.paid 事件），客户在 Wave 上刷卡付款后，Webhook 自动触发解锁下载，不需要重新造收单系统 |
| e-Transfer (EMT) | 用 **Gmail API** 读取确认邮件，解析金额/汇款人，比对 Wave 未付款 Invoice 列表，自动匹配成功则解锁；设计"匹配成功/存疑/失败"三态，存疑转人工确认，避免误放行导致坏账 |

**当前痛点**：EMT 路径完全靠人工核对+对客户信任，坏账在增加，这是做 PaymentGate 自动化的直接动机。

**Gallery 开发顺序建议**（先 UI 骨架、后接数据、再加权限、最后接支付自动化）：
1. 文字/手绘想清楚页面分区
2. Wix Editor 里用假照片摆静态页面（无代码）
3. 接真实 Supabase 数据（开始写 Velo 代码）
4. 加权限判断（先用假开关测试未付款/已付款两态）
5. 接真实支付自动化（Wave Webhook + Gmail 比对）

**管理端策略**：不用提前给自己做管理界面，前期直接用 **Wix CMS 自带的表格编辑功能**当管理端，等发现某个操作频率高、步骤复杂了，再单独为那个操作做专属界面。

---

## 六、整体开发路线图（Wix 侧，宏观）

```
阶段1（进行中）：Feature Sheet Builder 独立嵌入
阶段2：接入 Jobs 数据表（Job Generator 的价值在此兑现）
阶段3：Gallery + 下载权限
阶段4：Invoice/Payment（Pricing Engine 的价值在此兑现）
阶段5：外部系统集成（Gmail/TickTick/会计系统）
```

Gallery + PaymentGate 模块内部的详细 7 阶段规划，见 `docs/Gallery_PaymentGate_架构规划.md` 第五节。

---

## 七、当前进度快照（写这份文档时的状态）

✅ Wix Studio 网站已建好（免费方案）
✅ Job Generator：Dropbox 建文件夹骨架 + 贴隐藏 jobId 标签、双向 Push/Pull 文件同步（含冲突检测/删除镜像）都已完成——**具体进度以 `job-generator/CLAUDE.md` 为准，此处不再逐条更新**
✅ Dropbox API 一次性设置完成（App、权限、refresh token、Property Template 全部就绪）
🔲 **下一步在做**：新建一个独立的 Cloudflare Worker，实现 Dropbox → Supabase 缩略图自动同步管道（含 Dropbox Webhook 监听、Cloudflare Image Resizing 生成缩略图、自愈机制）
🔲 待做：Gallery 展示层 UI、下载权限判断、Wave/Gmail 支付自动化、Feature Sheet Builder 上传功能下线与管理端整合

---

## 八、仓库与文档组织策略

所有模块（Job Generator、Pricing、Feature Sheet Builder、Dropbox 同步 Worker）统一放在同一个 GitHub 仓库 **FranVision** 下，建议结构：

```
FranVision/
├── CLAUDE.md              ← 总览：整个系统是什么、各模块怎么分工、指向 /docs
├── docs/                  ← 存放跨模块的整体架构规划文档（本文档、Gallery+PaymentGate规划等）
├── job-generator/
│   └── CLAUDE.md          ← 该模块自己的实现细节
├── pricing/
│   └── CLAUDE.md
├── feature-sheet-builder/
│   └── CLAUDE.md
└── dropbox-sync/
    └── CLAUDE.md
```

Claude Code 会自动叠加读取从当前目录往上的所有 CLAUDE.md，所以在具体模块文件夹里工作时，会同时拿到总览信息 + 该模块细节。

**交接策略**：
- Claude Code 侧：CLAUDE.md 随 Git 仓库天然共享，Franky clone 仓库即可获得全部背景，不需要额外操作
- Claude.ai 聊天侧：升级 Team 方案后，把这些文档上传进共享 Project 的知识库，邀请 Franky 加入（建议先给"Can view"权限），之后双方在该 Project 里的对话都能自动读到这些背景

---

## 待补充 / 需要你确认的空白

以下内容目前的记忆和对话记录里没有覆盖到，建议你之后补充：
- Job Generator、Pricing Engine 的具体代码实现细节（字段名、函数签名等）——这些应该已经在各自仓库的 CLAUDE.md 里，如果还没有，建议尽快让对应的 Claude Code 会话补上
- Feature Sheet Builder 具体的页面/交互设计细节
- Dropbox 同步 Worker 的实际开发进度（本文档写就时，这部分刚开始规划，可能已经有新进展）
