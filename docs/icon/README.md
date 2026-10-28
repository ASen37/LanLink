# LanLink 像素图标（NES.css 风格）

为 LanLink 设计的一套 8-bit 像素项目图标，风格对齐项目现有 NES.css UI：硬边方块、右下角硬投影、
无圆角、无抗锯齿，配色直接取自 NES.css `scss/base/variables.scss` 与 `src/ui/theme.css`。

> 原有 `docs/logo.svg`、`src/ui/favicon.svg` 未改动；本目录为新增设计稿，按需自行替换。

## 设计概念

| 方案 | 文件前缀 | 含义 | 适用 |
| --- | --- | --- | --- |
| **A · link（推荐）** | `lanlink-icon-*` / `icon-link-*` | 两台显示器经双向数据缆直连，缆上绿色数据包 = P2P 局域网直传 | 主 logo、应用图标、README |
| B · monogram | `icon-monogram-*` | 像素字母 L + 前进箭头，右上角绿点 = 在线状态 | 紧凑 favicon、水印 |
| C · bolt | `icon-bolt-*` | 黄色闪电 = 高速直传 | 备用 / 徽章 |

## 配色（NES.css）

| 用途 | 色值 | 出处 |
| --- | --- | --- |
| 主色底 | `#209cee` | `is-primary` normal |
| 主色加深 | `#108de0` | `is-primary` hover |
| 硬投影 | `#006bb3` | `is-primary` shadow |
| 成功 / 数据包 / 在线点 | `#92cc41` | `is-success` |
| 闪电 | `#f7d51d` | `is-warning` |
| 图形 | `#ffffff` | — |

## 文件清单

```
docs/icon/
├─ make_icons.py            # 可复现生成脚本（改网格后重跑即可）
├─ icon-preview.html       # 浏览器预览页（亮/暗主题、多尺寸）
├─ _contact-sheet.png      # 三方案 × 32稿/16稿 对照图
├─ lanlink-icon.svg         # 推荐方案矢量稿（32 网格，crispEdges）
├─ lanlink-icon-16.svg      # 推荐方案 favicon 专用 16 网格
├─ icon-link.svg / icon-link-16.svg
├─ icon-monogram.svg / icon-monogram-16.svg
├─ icon-bolt.svg / icon-bolt-16.svg
└─ png/
   ├─ lanlink-icon-{16,32,48,64,128,256}.png   # 推荐方案全尺寸
   └─ icon-{link,monogram,bolt}-{16,32,48,64,128,256}.png
```

网格策略：32×32 主稿负责 ≥32px 尺寸（最近邻整数倍放大），16×16 专用稿负责 favicon，
避免小尺寸直接缩放导致碎块。所有 PNG 仅含上表调色板颜色，无抗锯齿中间色。

## 使用方式

### 1. 网页 favicon（桌面端 / 访客页）
当前 `src/ui/index.html` 引用 `/favicon.svg`，`src/ui/guest.html` 引用 `/guest/favicon.svg`。
替换时把对应 PNG/SVG 放到 `src/ui/`（访客页放到其静态目录），并把 `<link rel="icon">`
指向新文件；SVG 加 `image-rendering: pixelated` 保证锐利。

### 2. README 主图
将 `docs/logo.svg` 换成 `lanlink-icon.svg`（或引用 `png/lanlink-icon-256.png`）。

### 3. 重新生成
```bash
cd docs/icon
python make_icons.py
```
在脚本顶部 `variant_*` / `a_small` 等函数里改像素矩阵，重跑即刷新全部 PNG 与 SVG。

## 字体说明

本目录字形为纯像素块，未内嵌文字。页面字标使用项目自带的 Fusion Pixel 12px
（`src/ui/vendor/fusion-pixel-12px.woff2`，OFL-1.1）；`zpix-pixel-font` 仅作为
12px 像素比例与块面风格的参考，其 `zpix.ttf/woff2` 未包含在本仓库（商业产品需另行取得授权）。
