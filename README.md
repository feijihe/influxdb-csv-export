# InfluxDB CSV Export — 修复非安全上下文下消失的导出按钮

一个 Chrome MV3 扩展：当 InfluxDB 2.x 通过 `http://<局域网IP>:8086` 访问时，Data Explorer 里的 **CSV** 导出按钮会消失。本扩展把它加回来。

> Chrome extension (Manifest V3) that restores the missing Data Explorer **CSV** export button on InfluxDB instances reachable only over plain HTTP from a non-loopback origin.

> [!IMPORTANT]
> **扩展默认只对 `http://169.254.197.198:8086` 生效。** 换成别的地址后**完全不生效**（连 content script 都不会注入）。改法见 [修改适用地址](#修改适用地址)。

---

## 问题

InfluxDB 2.x 的 Data Explorer（`/orgs/<org>/data-explorer`）在打开 **View Raw Data** 后，工具栏上应该有一个 **CSV** 按钮，用来把查询结果导出成 CSV。但通过局域网地址访问时，这个按钮**根本不渲染**：

| 访问方式 | `View Raw Data` 旁是否有 CSV 按钮 |
| --- | --- |
| `http://127.0.0.1:8086` | 有 |
| `http://169.254.197.198:8086`（局域网 IP） | **没有** |

这**与 InfluxDB 版本无关，也与操作系统无关** —— 同一个服务端、同一个数据库、同一份 UI 产物，只是地址栏里的 origin 不同。

![局域网 IP 上原生按钮缺失，扩展补上了 CSV 按钮](docs/screenshot-with-extension.png)

*`http://169.254.197.198:8086`：原生按钮不存在，最右侧的 `CSV` 是本扩展注入的。*

![127.0.0.1 上原生 CSV 按钮正常](docs/screenshot-native-127.0.0.1.png)

*`http://127.0.0.1:8086`（SSH 隧道指向同一实例）：原生 `CSV` 按钮正常出现。*

## 原因

按钮的渲染条件是一个叫 `browserSupportsDownload` 的 state，它完全由 **ServiceWorker 注册结果**决定。InfluxDB 2.8.0 的 Data Explorer 产物里可以读到：

```js
// .../5d599ef646.js
class c extends PureComponent {
  constructor(e) {
    super(e);
    this.state = { browserSupportsDownload: false };
    e.workerRegistration && e.workerRegistration.then(
      e => "activated" == e.active.state
        ? this.setState({ browserSupportsDownload: true })
        : console.error("Feature not available, because ServiceWorker is registered but inactive."),
      e => console.error("Feature not available, because ServiceWorker registration failed: ", e)
    );
  }
  render() {
    return this.state.browserSupportsDownload
      ? <Button text="CSV" icon={Download_New} onClick={this.handleClick} testID="csv-download-button" />
      : null;   // ← 非安全上下文永远走这里
  }
}
```

而 **Chrome 只在「安全上下文」(secure context) 中暴露 `navigator.serviceWorker`**。`http://localhost`、`http://127.0.0.1` 以及任何 HTTPS 都算安全上下文；**`http://<局域网IP>` 不算**。

于是在局域网 IP 上：ServiceWorker 注册直接失败 → `browserSupportsDownload` 永远是 `false` → `render()` 返回 `null` → 按钮不存在。同一个浏览器、两个 origin 实测：

| | `http://169.254.197.198:8086` | `http://127.0.0.1:8086` |
| --- | --- | --- |
| `window.isSecureContext` | `false` | `true` |
| `navigator.serviceWorker` | **不存在** | 存在 |
| 原生 CSV 按钮 | 无 | 有 |

> 想复现这个对照，需要让两个 origin 指向**同一个** InfluxDB 实例，例如 SSH 隧道：
> `ssh -L 127.0.0.1:8086:169.254.197.198:8086 user@169.254.197.198`
> 这样唯一的变量就只剩 origin。

> **常见误解**：网上（例如 influxdata/influxdb#24364）把这类现象归因为「Windows 版有、Linux 版没有」。实测不成立 —— 把 InfluxDB 2.8.0 的 Windows 版和 Linux 版 UI 产物逐文件比对，`index.html` 引用同一个 `/64a6202951.js`，30 个 chunk 的 SHA-256 **全部一致**（约 10.5 MB，0 处差异）。真正的变量是访问地址，不是操作系统。

## 工作原理

关键点：**安全上下文的限制只作用于 ServiceWorker 注册**，并不影响 `fetch`、`Blob`、`URL.createObjectURL` 和 `<a download>`。所以本扩展完全不需要 ServiceWorker，自己取数、自己存盘即可。

1. **`inject.js`（页面主世界）** — hook `window.fetch` 和 `XMLHttpRequest`，把 InfluxDB UI 自己发出的 `POST /api/v2/query` 请求（URL + body）通过 `postMessage` 交给 content script。这跟原生 ServiceWorker 做的事是同一个思路。
2. **`content.js`（隔离世界）** — 把 `CSV` 按钮插进 `[data-testid="time-machine--bottom"]` 工具栏里**原生按钮所在的同一个位置**（`View Raw Data` 右侧、自动刷新下拉框 `.autorefresh-dropdown` 之前），并复刻原生的外观：`cf-button-sm` 尺寸 + `cf-icon Download_New` 图标 + `cf-button--label` 文字。点击时用捕获到的 body 重放同一个查询：
   ```js
   fetch(url, {
     method: 'POST',
     credentials: 'include',
     headers: { 'Content-Type': 'application/json', 'Accept': 'text/csv' },
     body: lastQuery.body
   })
   ```
   同源请求会自动带上会话 cookie，所以 `influxdb-oss-session` 即使是 `HttpOnly` 也没问题 —— 不需要读取它。
3. **存盘** — `new Blob([text], { type: 'text/csv' })` → `URL.createObjectURL` → `<a download="query.csv">`。

> 原生实现在服务端还依赖 `Prefer: return-download` 请求头。在 InfluxDB **2.8.0 OSS** 上实测该头**没有任何作用**：加与不加，响应头（`Content-Type: text/csv; charset=utf-8`、无 `Content-Disposition`）和字节数完全一致，CSV 本来就是 `POST /api/v2/query` 的默认返回。所以本扩展不需要它。

## 安装（加载本地扩展）

本扩展没有上架应用商店，需要用 Chrome 的「加载已解压的扩展程序」装到本地。**仓库根目录本身就是可加载的扩展**（`manifest.json` 就在根目录），不需要先打包。

### 步骤

1. 打开 Chrome，地址栏输入 `chrome://extensions/` 回车
2. 打开右上角的 **开发者模式** 开关
3. 点左上角的 **加载已解压的扩展程序**
4. 在目录选择框里选中**本仓库的根目录** —— 即含 `manifest.json` 的那一层（别选到 `docs/`，也别只选到它的父目录），确定
5. 列表里出现 **InfluxDB CSV Export (insecure-origin fix)** 就是装好了
6. 打开（或**刷新**）目标 InfluxDB 页面 —— 扩展只对加载之后打开的页面生效，加载前就开着的标签页要刷新一次

装好后可在目标页面按 F12，在 Console 里确认：

```js
document.documentElement.getAttribute('data-influx-csv-ext')   // "1"      → content script 已注入
document.getElementById('influx-csv-export-ext')                // <button> → 按钮已创建
```

如果第 4 步报错、或者扩展没出现在列表里，通常是 `manifest.json` 有语法错误或 `matches` 写得不合法，按提示修正后重新加载。

### 改完代码怎么重新加载

- 改的是 `content.js` / `inject.js`：到 `chrome://extensions/` 点该扩展卡片上的 **刷新** 图标（🔄），再刷新目标页面
- 改的是 `manifest.json`：同样点 **刷新**；`matches` 这类改动建议把目标标签页关掉重开
- 点了刷新还是没变化：把扩展 **移除**，再重新「加载已解压的扩展程序」

> 实测（Chrome 154 / Windows）：命令行的 `--load-extension` 不会加载扩展，必须走上面的界面操作。
> 自动化场景可以走 CDP：用 `--enable-unsafe-extension-debugging` 启动 Chrome，再调用 `Extensions.loadUnpacked`（`path` 指向本仓库根目录）。

## 修改适用地址

扩展默认只对 `http://169.254.197.198:8086` 生效。要换成别的实例（别的 IP、别的端口，或本机 `127.0.0.1`），改 `manifest.json` 里的 `matches`，然后重新加载扩展。

### 改哪两处

`manifest.json` 里有**两处** `matches`，**必须一起改**：

```json
{
  "content_scripts": [
    {
      "matches": ["http://169.254.197.198:8086/*"],
      "js": ["content.js"]
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["inject.js"],
      "matches": ["http://169.254.197.198:8086/*"]
    }
  ]
}
```

只改 `content_scripts.matches` 的后果：content script 照常注入、按钮也照常出现，但它加载不到 `chrome-extension://…/inject.js`，主世界嗅探器装不上 —— 表现为点按钮永远提示 `CSV: run a query first`。

### 常见改法

换成单个地址：

```json
"matches": ["http://192.168.1.50:8086/*"]
```

同时支持多个地址：

```json
"matches": [
  "http://169.254.197.198:8086/*",
  "http://127.0.0.1:8086/*",
  "http://192.168.1.50:8086/*"
]
```

端口不是 8086 时把端口一起改掉：

```json
"matches": ["http://192.168.1.50:9999/*"]
```

想恢复成「所有 http 站点都生效」：

```json
"matches": ["http://*/*", "https://*/*"]
```

这样写不会污染别的网站 —— `content.js` 会先判断页面是不是 InfluxDB（meta description / title），不是就直接退出；代价是 content script 会在每个 http 页面上都跑一次。

如果 InfluxDB 走的是 HTTPS，把协议相应换成 `https://`。

### 改完怎么让它生效

1. 保存 `manifest.json`
2. 到 `chrome://extensions/` 点该扩展卡片上的 **刷新**（🔄）
3. 刷新目标 InfluxDB 页面

> 实测 `matches` 的 host 部分带端口是被 Chrome 接受的（`http://169.254.197.198:8086/*` 能正常匹配并注入）；端口是否参与精确匹配语义未单独验证。若需要严格按端口区分，可在 `content.js` 里自行判断 `location.port`。
>
> `matches` 的 path 部分只支持 `/*` 这类通配，不能写正则；需要更细的 URL 条件时同样在 `content.js` 里判断。

## 使用

1. 打开 InfluxDB 的 Data Explorer 页面
2. 正常组查询（选 bucket / measurement / fields …）
3. 点一次 **SUBMIT**
4. 点 `View Raw Data` 右侧的 **CSV** 按钮（带下载图标，位置与原生按钮一致）→ 浏览器下载 `query.csv`

第 3 步是必需的：扩展要先「看到」一次查询请求才能重放它。在此之前点按钮会提示 `CSV: run a query first`。

按钮状态会实时反馈：`CSV …`（导出中）→ `CSV ✓`（成功）/ `CSV failed`（失败，鼠标悬停可看原因）。

## 验证

在目标页面的 DevTools Console 里可以直接确认：

```js
window.isSecureContext                                            // false → 就是本扩展要解决的场景
document.querySelector('[data-testid="csv-download-button"]')     // null   → 原生按钮确实不存在
document.getElementById('influx-csv-export-ext')                  // <button> → 扩展注入成功
document.documentElement.getAttribute('data-influx-csv-ext')      // "1"    → content script 已注入
```

在 `http://169.254.197.198:8086`（原生按钮缺失）上实测通过：

- `nativeCsv: false`、`extCsv: true`
- 点击后导出 **722 行 / 73,174 字节**，`_measurement=sensors`、`_field` 含 `F1` 与 `F2`
- 与在 `http://127.0.0.1:8086` 上点**原生**按钮得到的文件**结构完全一致**

（两者 SHA-256 不同是正常的：查询用的是「Past 1h」，两次 SUBMIT 相隔约 10 分钟，`_start` 随之前移，时间戳整体平移。示例文件见 [`docs/sample-export.csv`](docs/sample-export.csv)。）

## 已知限制

- **必须先点一次 SUBMIT**。扩展靠嗅探 UI 自己发出的查询请求来获知 Flux 语句；要「进页面即可导出」，需要改成从 Script Editor / Redux store 里取查询。
- **重放的是当时的时间范围**。捕获到的 body 里 `extern` 含已解析的绝对时间，所以导出的是「当时那次查询」的结果，而不是「重新查最近 1 小时」。需要后者就得自己重建 `range()`。
- **大结果集全量进内存**（原生是流式下载）。数据量很大时建议改用 `chrome.downloads` + 流式写入。
- **只对 `matches` 里写死的地址生效**。当前是 `http://169.254.197.198:8086/*`，换 IP / 换实例后扩展**完全不生效**（连 content script 都不会注入）。改法见 [修改适用地址](#修改适用地址)。
- **依赖 InfluxDB 的 DOM test id**（`time-machine--bottom`、`csv-download-button` 等）。已在 2.8.0 验证；其他大版本可能不同。
- **不支持 InfluxDB Cloud / HTTPS 之外的鉴权差异**：本扩展只复用页面自身的会话；若实例要求 token 而非 cookie，需要另行处理。

## 备选方案

如果你的目的只是「拿到 CSV」，下面两个办法都不需要装扩展：

1. **走本地回环访问**。`http://127.0.0.1:8086` 是安全上下文，原生按钮直接可用。远端实例可以用 SSH 隧道映射过来：
   ```bash
   ssh -L 127.0.0.1:8086:<influx-host>:8086 user@<influx-host>
   ```
2. **让 Chrome 信任该 origin**（临时方案）：
   ```
   chrome.exe --user-data-dir="<非默认配置目录>" \
              --unsafely-treat-insecure-origin-as-secure=http://169.254.197.198:8086
   ```
   实测有效：该 origin 上 `isSecureContext` 变为 `true`，**原生** CSV 按钮出现。但必须同时指定非默认的 `--user-data-dir`，否则参数会被忽略；且它会全局降低该 origin 的安全级别，不建议长期使用。

## 目录结构

```
.
├── manifest.json                  # MV3 清单；matches 决定对哪些地址生效
├── content.js                     # 隔离世界：注入嗅探器、加按钮、重放查询、存盘
├── inject.js                      # 页面主世界：hook fetch/XHR，捕获 /api/v2/query
├── docs/
│   ├── screenshot-with-extension.png    # 局域网 IP：原生缺失，扩展补上
│   ├── screenshot-native-127.0.0.1.png  # 回环地址：原生按钮正常
│   └── sample-export.csv                # 扩展导出的真实样例（722 行）
├── .gitattributes                 # 换行归一化；png/csv 按二进制处理
├── .gitignore
└── README.md
```

## 开发笔记

- 扩展**没有** background service worker，也没有任何网络权限声明：所有请求都从页面自身 origin 发出，靠 `credentials: 'include'` 复用页面会话。
- 调试时关注两处 DOM 标记：`html[data-influx-csv-ext="1"]`（content script 已注入）与 `#influx-csv-export-ext`（按钮已创建）。`inject.js` 通过 `<script src="chrome-extension://…">` 注入主世界；InfluxDB 页面未设置 CSP，因此不会被拦（若目标实例设置了 CSP，可改用 `chrome.scripting.executeScript({ world: 'MAIN' })`）。
- 主世界脚本用 `window.__influxCsvExportHooked` 做幂等保护，重复注入不会叠加 hook。
- 源码是 ES6（ES2015）。`inject.js` 里三处包装函数（`window.fetch`、`XMLHttpRequest.prototype.open|send`）**必须保持普通函数，不能改成箭头函数** —— 它们要把调用方的动态 `this` 原样转发给原始实现，而箭头函数没有自己的 `this`。
- `inject.js` 故意**不加** `'use strict'`：严格模式下，页面里未绑定的 `fetch(...)` 会让包装函数的 `this` 变成 `undefined` 而不是 `window`，从而改变转发给原始 `fetch` 的接收者。`content.js` 则一直是严格模式。
- 按钮的状态更新只改 `.cf-button--label` 节点的文字（`setLabel()`），**不要**直接给 `btn.textContent` 赋值 —— 那会清空 `innerHTML`，把图标一起抹掉。

## 测试环境

- Chrome 154.0.8037.99（Windows）
- InfluxDB v2.8.0 OSS，commit `40a633239e`，UI 前端 `5c07739`
- 未在 InfluxDB 1.x / 3.x、InfluxDB Cloud 上验证

## 许可证

尚未指定。如需开源请补充 `LICENSE`（例如 MIT）。
