# NyaModifyHeader

一个从零编写、可直接审计的 Chrome Manifest V3 扩展，用声明式规则设置、追加或移除请求头和响应头。

本项目不包含远程代码、遥测、广告 SDK 或内容脚本。扩展自身的网络连接由 CSP 明确禁止。

## 安装

1. 打开 `chrome://extensions/`。
2. 启用右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目目录 `NyaModifyHeader`。
5. 点击工具栏中的 NyaModifyHeader 图标。
6. 需要规则实际生效时，点击“授权”。

初次安装不会自动取得网站访问权限。HTTP/HTTPS 权限只会在用户点击授权按钮后申请，也可以在管理页随时撤销。

响应状态码和 Body 覆盖依赖页面加载时注入的本地调试拦截器。首次授权后请刷新正在调试的页面；撤销权限后，已打开页面刷新后才会移除拦截器。

## 两个界面

### Popup

点击工具栏图标后，popup 只显示网址模式匹配当前标签页 URL 的规则，以及“所有网站”规则。其他网站的规则不会展示。

popup 支持：

- 查看当前页面相关规则。
- 快速启用或停用规则。
- 暂停或启用全部规则。
- 为当前网站新建规则。
- 打开完整规则管理页。

这里的“当前网站相关”按当前标签页 URL 判断。例如页面是 `https://app.example.com/`，而一条规则只匹配 `https://api.example.com/*`，该规则仍会正常修改 API 请求，但不会出现在这个页面的 popup 列表中。它始终可以在完整管理页查看。

### 完整管理页

点击 popup 右上角的管理图标或“管理全部规则”，会在正常标签页中打开完整管理页。

管理页支持全部规则的搜索、筛选、新建、编辑、复制、删除、启停、导入和导出。每条规则可以包含多项 Header 修改，也可以只配置响应状态码或响应 Body 覆盖。

## 多网址匹配

一条逻辑规则最多可以填写 20 个包含模式和 20 个排除模式，每行一个。

- 多个包含模式之间是“或”：命中任意一个即可运行。
- 多个排除模式之间也是“或”：命中任意一个便不运行。
- 包含模式留空表示所有已授权网站。
- 每个包含模式会编译为一条 Chrome DNR 动态规则，该规则会携带全部 Header 修改项。
- 所有启用规则合计最多编译为 5000 条动态规则。

### 通配符

这是 NyaModifyHeader 自己的简化语法，不是 Google 搜索语法，也不是直接暴露 Chrome DNR `urlFilter`。

```text
https://api.example.com/*
*://*.example.com/*
http://localhost:*/*
```

- `*` 匹配任意数量字符。
- `?` 匹配一个字符。
- 开头的 `*://` 只匹配 HTTP 和 HTTPS。
- `*://*.example.com/*` 同时匹配 `example.com` 和任意层级子域名。
- 简写 `example.com` 会自动规范化为 `*://example.com/*`。

### 正则表达式

切换到“正则表达式”后，每行填写一个正则：

```text
^https://api\.example\.com/v[12]/
^https?://[^/]+\.example\.org/
```

Chrome 使用 RE2 正则引擎。保存前会调用 `declarativeNetRequest.isRegexSupported()` 检查，因此前后查找、反向引用等 RE2 不支持的功能会被拒绝，不会留下半套配置。

## 规则行为

- 每条逻辑规则可以包含 0 到 20 项 Header 修改；只改响应状态码或 Body 时可以不配置 Header。
- 每项独立选择请求头/响应头、设置/追加/移除、Header 名称和值。
- 同一规则可以同时修改多个请求头和响应头，适合集中配置 CORS。
- 同一方向中不允许两项重复修改同名 Header，避免执行顺序不明确。
- 不选择资源类型表示应用于 Chrome 支持的全部资源类型。
- 优先级数字越大越优先；修改同一 Header 的规则应使用不同优先级。
- 响应调试覆盖支持可选的 `HTTP 状态码`（200-599）和整段 `响应 Body` 替换；多个命中规则分别按优先级取得状态码和 Body。
- 每条规则可以限定请求方法，例如只匹配 `OPTIONS`、`GET` 或 `POST`；不选择时匹配全部方法。
- 响应状态码和 Body 覆盖只包装页面 JavaScript 看到的 Fetch / XHR 响应，不会改变 Chrome Network 面板中的真实 HTTP 响应，也不作用于图片、脚本等其他资源。
- 复制规则后，副本默认停用，避免立即产生重复修改。
- 导入文件会先做完整校验，任一字段无效时不会写入部分规则。
- v1/v2 的单 Header 规则会自动迁移为只有一项的规则。
- v1 的 `urlFilter` 会迁移为“旧版 DNR”模式，保持原有 Chrome 匹配语义；可在管理页改成通配符或正则。

快捷键：

- `Ctrl/Cmd + N`：新建规则
- `Ctrl/Cmd + S`：保存规则
- `Esc`：返回规则列表或关闭编辑

## 隐私与权限

运行时只使用：

- `storage`：将配置保存在 `chrome.storage.local`。
- `declarativeNetRequestWithHostAccess`：让 Chrome 自身执行 Header 修改规则。
- `activeTab`：用户打开 popup 时读取当前标签页 URL，以筛选相关规则。
- 可选的 `http://*/*` 与 `https://*/*`：用户授权后，使规则能作用于网页请求。

扩展不会：

- 读取或保存网页正文、浏览历史、命中网址和请求日志。
- 使用 `fetch`、XHR、WebSocket、Beacon 或其他方式向外发送数据。
- 注入 content script 或加载 CDN、远程字体、远程图片和远程脚本。
- 使用 `storage.sync` 将规则同步到云端。

Header 值会以明文保存在当前 Chrome Profile 中，也会出现在用户主动导出的 JSON 文件中。不要把本扩展当作密码保险库。

## Chrome 限制

- Chrome 不允许扩展修改 `chrome://`、Chrome Web Store 等受保护页面。
- 部分敏感或保留 Header 不允许修改；Chrome 拒绝规则时，界面会保留输入并显示错误。
- `append` 对可修改 Header 的限制比 `set` 更严格，实际能力以当前 Chrome 版本为准。
- 多个扩展同时修改同一 Header 时，最终结果还会受到 Chrome 的扩展间规则排序影响。
- 本地响应覆盖无法让 `OPTIONS` 预检请求绕过浏览器 CORS 校验；本地调试应让后端或网关处理预检，测试和生产环境继续使用网关方案。
- 浏览器自动发出的 CORS `OPTIONS` 预检不会经过页面 Fetch / XHR 包装，因此请求方法匹配可以限制它的 Header 修改，但普通 MV3 扩展不能把它的真实状态码或 Body 改成 200；手动发出的 OPTIONS 请求不受此限制。

## 开发与验证

本项目没有构建步骤或运行时依赖：

```powershell
node --test
node --check src/core.js
node --check src/background.js
node --check src/client.js
node --check src/popup.js
node --check src/manager.js
```

本地预览：

```powershell
node scripts/serve.mjs 48731
```

- Popup：`http://127.0.0.1:48731/popup.html?site=https://api.example.com/dashboard`
- 管理页：`http://127.0.0.1:48731/manager.html`

普通网页环境使用内存中的演示规则，不会写入 Chrome 扩展存储。

## License

项目代码使用 MIT License。Lucide 图标子集许可见 `THIRD_PARTY_NOTICES.md`。
