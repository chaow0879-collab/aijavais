# R55 安全修复与产品联合候选

唯一作者/集成人Codex，分支`integrate/codex-r55-security-product-final`，起点R53 `397b46c18e25aaddc3e92886693da4ef3f2528d3`。R53/R51及Claude源分支冻结不改。任务#38允许本分支修V2隔离与后端，Claude #37 R54专属页面/测试/文档不编辑。真实模型、收费、Secrets、main、生产、状态ref及持续调度仍无授权，E4/E5继续NOT_RUN。

## 原独立失败与复现

R51独立审计[#6706878270](https://github.com/chaow0879-collab/aijavais/issues/2#issuecomment-6706878270)仅非live ACCEPT_WITH_FOLLOWUP，0P0/0P1/2P2；独立CI42360045723是failure，不能改写为全绿。原SHA3d693734/后续R53继承的QA终态检查抹去目录ctime，导致AUD-R51-01越界文件先写后删被接受；AUD-R51-02允许tests/内链接指向外部/非授权内部并修改实际哨兵。

本轮先在未修改的397b46c实际Git临时仓库复现，两次verifyChanges均错误true，外部**自有临时**sentinel确实从safe变changed。记录`/tmp/r55-original-reproduction.json`，没有生产/宿主敏感路径操作。后续通过拒绝终态坏例与运行时内核边界双重修复，不拿mtime推断当运行隔离。

## 运行时保护与失败关闭

Landlock ABI查询在当前云内核返回ENOSYS，未假称可用。选择现有Bubblewrap：强制user/PID/network/mount等独立命名空间、禁嵌套userns、全部capability丢弃、最小新env、只读源码与Git元数据、仅绑定确切授权写路径、私有HOME/TMP，其余宿主HOME/凭据/控制面数据不挂载。V2现有进程监督器包装这一隔离命令，未增加Agent Runner或调度器。

`workspace-isolation.status()`在自有临时目录**实际**验证授权写成功、源码写和父目录逃逸失败；能力不可用/探针不通过/品牌伪造时`BLOCKED_OS_WRITE_ISOLATION`，不降级成chmod、Node权限或未隔离执行。GitHub-hosted内核若不允许userns，则OS正例明确BLOCKED/skip，不能被说成通过；相同环境下源码live常量仍false。

源目录与授权目标逐级O_NOFOLLOW打开，再用`--ro-bind-fd/--bind-fd`固定inode，防检查后替换链接使挂载跟随到宿主外部。Bubblewrap不保留这些设置用FD给最终子进程；没有继承宿主凭据env。运行中的链接替换只能在命名空间内，读写不能逃到未挂载的宿主文件；指向源码非写范围的写入受只读挂载拒绝。运行前后拒绝所有symlink、nlink!=1文件及特殊文件，清理只恢复目录权限，不chmod可能别名到外部的文件。

QA可以读整个已批准源码、写tests授权子树；runtime库只读；HOME/TMP为私有可写例外。只读Git元数据意味着不可信子进程不能直接git add/commit；由父控制器先验收实际改动再用固定参数/禁hooks的Git提交授权路径。合法QA写入+真实提交保留正例。Developer也只能写声明且已存在的具体目录/文件；不能以授权一个文件而开放整个父目录。

终态inspect保留普通目录ctime与NUL/提交历史检查，拒绝root写后删；只有当前分支Git提交确实需要的精确Git父目录允许目录时间变化，Git写操作不开放给子进程。**verifyChanges只是事后作用域检查，不是运行时隔离证明**；真正受控进程必须经过品牌化隔离计划。原isolation/health的独立clone语义不等于OS沙箱已运行。

边界：依赖可信Linux内核、Bubblewrap安装及宿主控制器/管理员，非对抗恶意宿主root；不声称能防内核漏洞。私有scratch不是可交付成果，文件必须从授权workspace验收入库。所有官方模型/远端写仍编译期禁用；新OS能力不是费用/身份或真实执行许可。

## R54后端合同（在R53上增量兼容）

全部原`/api/v2/universal/*`保留登录/同源JSON、逐岗同意/预算、永久requestId与Schema v4。所有新绑定字段可选，原R53请求体仍支持；提供时必须严格匹配，不忽略错误声明：

- start/rework批准可携带`projectId`、`expectedProjectVersion`、`expiresAt`（epoch毫秒，必须未来、最多1小时）；错误引用409 `approval_ref_mismatch`，过期403 `approval_expired`。省略expiry由服务器绑定15分钟；下一模型/工具派发前复查到期，进行中的请求可能已有费用，不能宣称撤销。
- review/deliver/accept可携带`runId`和`expectedRound`，不一致409 `round_conflict`；criteria仍必须有expectedRound。
- GET universal/run增加`criteria:{round,artifactId,checks}`。未保存时unverified，服务端已存逐条检查可刷新恢复；批准后也可读批量声明，专业质量仍NOT_VERIFIED。
- 重复deliver返回已有文件完整metadata+downloadUrl+`duplicate/noReplay`，不重新生成。跨run/round/hash验收保护保持。
- GET workbench保留原R52 event/artifact schema及seq。snapshot新增project_id/round，artifact带round/format/source_artifact_id/source_sha256；事件补actor/round/message_id。cursor/limit必须合法整数，超出本work历史409，不静默接受错误ref；超过5000历史可读后续页，50000为明确限额，不能无声截断。
- 成本USD仍null、vendorInvoiceReconciled=false。正规模型/工具缺口和PLAN_SIMULATED如实展示，未验证供应商额度不自动放行。

R54已正式READY且冻结于`3fbd6ff5db2f1a9032a02f9b48a965abc461d500`，原CI42436933716两job成功。相对R52的唯一提交精确cherry-pick为`48bef2a8e861caa355d1abba2d7248016029013e`，13路径专属blob/mode不改，`r55-sources.js`逐一核对；没有merge其旧父链。

R54原overlay固定跑历史397b46c后端；不能拿它冒充最终R55验证。`run-r54-integrated.cjs --node|--browser`仅在内存中将原helper的固定后端SHA替换为当前HEAD，仍运行原件Node/Chromium断言，临时Git clone精确最终后端，保留所有Claude文件字节。证据另记原helper散列、R54来源、实际backend SHA。它不是生产执行器，不启动真实模型。验收/取消重复请求仍由原状态机409安全拒绝，并未新增请求级幂等协议；start/rework/deliver/criteria保留持久requestId。

## 验证与交付口径

```sh
node --test tests/security-r55/*.test.js
node --test tests/universal-workflow-r53/*.test.js
node tools/universal-workflow-r53/r55-sources.js
npm test
```

安全用例使用真实Git、Node固定Stub、独立命名空间、外部自有哨兵，包含合法写+控制器提交、写后删、内外链接/hardlink、目录遍历、Git元数据、FD挂载前替换、并发、失效计划。原R47–R51 SHA/签名/lease/HALT/CAS/未知账单测试全部保留；不修改旧断言或把stub当真实模型。

新增8个未在实现中硬编码的陌生/跨域目标，实际Node HTTP+临时SQLite+本地Mock，多岗执行→来源事件→DOCX/XLSX/PPTX→服务器criteria→hash/round验收。全部文件ZIP CRC与独立python-docx/openpyxl/python-pptx解析；只是Mock流程/真实文件，不是领域专家或真实厂商质量通过。`R55_EVIDENCE_DIR`归档8任务计数/回执/文件；精确最终计数、SHA、CI及R54状态由#38唯一最终报告给出。

回滚无DDL迁移，仍Schema v4；先停唯一实例、保留完整DATA/WAL/费用/请求墓碑/历史文件和unknown预留，不删除锁/墓碑后重派。隔离不可用时保持BLOCKED。任何真实试点仍需同SHA独立审计/QA、官方合法身份、可强制USD/Token上限、可信签署/受保护ref、Owner单次GO及停止机制。

检查点CI42437074558的原V2静态安全断言正确发现新策略模块引入进程API；未改断言，已把固定OS自测的spawnSync移回原cli-runner，隔离策略只生成计划/FD，无进程或网络能力。新增并发链接替换子进程、内层namespace不可用真实BLOCKED、实际SQLite unknown/tombstone不被越界写损坏的测试。首次并发fixture将合法在scope内的空隙文件写误判为逃逸，修正为只按受保护目标实际改变或内核拒绝判断；未放宽哨兵不变断言。小Git fixture还需显式带上被测模块文件，缺文件的失败与OS失败分开记录。
