# 当前交接（第三阶段 A–E 完成，等待 OpenAI 复核）

分支：`feat/event-protocol-security`（未合并 main）。`public/panel.html`、`docs/*` 与 main 零差异；`public/admin.html` 按授权重写。

## 提交
- 658f4c3 fix(3A): resolve batch-2 review P1 items
- aff80df feat(3A): access levels, ingest tokens, allowlist redaction, throttling
- e7df8d4 feat(3B): model registry with credential separation and safe removal
- 234cafe feat(3C): team registry, versioned templates, capability matcher, budget policy
- 25e140d feat(3D): simple model onboarding and team management in admin.html
- （本提交）test/docs(3E): acceptance tests, collaboration docs

## 测试
`npm test`：72 项全部通过（连跑两次）。`npm run test:ui`：管理界面浏览器走查通过（需 Playwright）。

## 仍未实现
1. 多用户账号与登录；目前单管理令牌，不支持公网多人安全使用。
2. 任务调度器（取消 / 重试 / 并行 / 预算执行）、多步骤工作流执行、人工审批界面（第四批）。
3. 工具执行（Tool Registry）、成果持久化（Artifact Manager 仅内存）。
4. 月度付费预算：只存储，不执行（缺乏经过验证的价格数据）。
5. 团队模板：30 类目录中 6 类有完整模板，24 类标为 planned。
6. 真实厂商 API 未联调（无密钥）；服务商接口地址已于 2026-11-05 对照官方文档核实。
7. HALOFLUX 许可证（PolyForm Noncommercial，且声明不提供商业授权）禁止公司内部使用，企业部署前需替换为独立授权的视觉实现。
