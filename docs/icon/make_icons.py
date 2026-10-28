# -*- coding: utf-8 -*-
"""
LanLink 像素风图标生成器
- 双网格：32x32 主稿（>=32px 尺寸最近邻放大）+ 16x16 专用稿（favicon）
- 最近邻整数倍缩放，保证像素锐利（crisp），无抗锯齿、无圆角
- 配色取自 NES.css (scss/base/variables.scss) 与项目 theme.css
  primary #209cee / hover #108de0 / shadow #006bb3
  success #92cc41 / warning #f7d51d / error #e76e55
- 风格：NES.css 硬边方块、右下角硬投影
运行：python make_icons.py
"""
import os
from PIL import Image

# ---------- 调色板（NES.css） ----------
BLUE       = "#209cee"   # is-primary normal
BLUE_HOVER = "#108de0"   # is-primary hover
BLUE_DEEP  = "#006bb3"   # is-primary shadow（硬投影）
WHITE      = "#ffffff"
INK        = "#20232a"
GREEN      = "#92cc41"   # is-success
YELLOW     = "#f7d51d"    # is-warning
RED        = "#e76e55"   # is-error

HERE = os.path.dirname(os.path.abspath(__file__))
PNG_DIR = os.path.join(HERE, "png")
os.makedirs(PNG_DIR, exist_ok=True)


def hex_rgba(h: str, alpha=255):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) + (alpha,)


class Grid:
    def __init__(self, size):
        self.size = size
        self.m = [[None] * size for _ in range(size)]

    def rect(self, x, y, w, h, color):
        for j in range(y, y + h):
            for i in range(x, x + w):
                if 0 <= i < self.size and 0 <= j < self.size:
                    self.m[j][i] = color

    def px(self, x, y, color):
        if 0 <= x < self.size and 0 <= y < self.size:
            self.m[y][x] = color

    def tile(self, shadow_w=3, base=BLUE, shadow=BLUE_DEEP):
        n = self.size
        self.rect(0, 0, n, n, base)
        self.rect(n - shadow_w, 0, shadow_w, n, shadow)
        self.rect(0, n - shadow_w, n - shadow_w, shadow_w, shadow)


# ================= 方案 A：双机直连（P2P 双向数据流） =================
def a_master():
    g = Grid(32)
    g.tile()
    # 左设备（显示器）
    g.rect(4, 10, 7, 7, WHITE)
    g.rect(5, 11, 5, 5, BLUE)
    g.rect(6, 13, 2, 2, GREEN)
    g.rect(7, 17, 2, 2, WHITE)
    g.rect(5, 19, 5, 1, WHITE)
    # 右设备（镜像）
    g.rect(21, 10, 7, 7, WHITE)
    g.rect(22, 11, 5, 5, BLUE)
    g.rect(24, 13, 2, 2, GREEN)
    g.rect(23, 17, 2, 2, WHITE)
    g.rect(22, 19, 5, 1, WHITE)
    # 双向数据缆 + 对向箭头
    g.rect(12, 13, 8, 2, WHITE)
    g.rect(11, 13, 1, 2, WHITE)                       # 左尖
    g.rect(12, 12, 2, 1, WHITE); g.rect(12, 15, 2, 1, WHITE)   # 左翼
    g.rect(20, 13, 1, 2, WHITE)                       # 右尖
    g.rect(18, 12, 2, 1, WHITE); g.rect(18, 15, 2, 1, WHITE)  # 右翼
    g.rect(15, 13, 2, 2, GREEN)                      # 传输中的数据包
    return g


def a_small():
    g = Grid(16)
    g.tile(shadow_w=2)
    # 左设备
    g.rect(1, 4, 5, 5, WHITE)
    g.rect(2, 5, 3, 3, BLUE)
    g.px(3, 9, WHITE); g.rect(1, 10, 3, 1, WHITE)
    # 右设备（避开右侧投影）
    g.rect(9, 4, 5, 5, WHITE)
    g.rect(10, 5, 3, 3, BLUE)
    g.px(11, 9, WHITE); g.rect(9, 10, 3, 1, WHITE)
    # 数据缆 + 数据包，两端并入设备框
    g.rect(6, 6, 3, 1, WHITE)
    g.px(7, 6, GREEN)
    return g


# ================= 方案 B：L 字母标 + 前进箭头 =================
def b_master():
    g = Grid(32)
    g.tile()
    g.rect(10, 8, 4, 16, WHITE)        # L 竖笔
    g.rect(10, 20, 15, 4, WHITE)      # L 横笔，接到箭头根
    g.rect(25, 20, 2, 4, WHITE)       # 钝头前进箭头，与横笔相连
    g.rect(19, 9, 3, 3, GREEN)        # 在线状态点
    return g


def b_small():
    g = Grid(16)
    g.tile(shadow_w=2)
    g.rect(4, 2, 3, 11, WHITE)          # 竖笔
    g.rect(4, 11, 9, 3, WHITE)         # 横笔，接到箭头根
    g.rect(13, 11, 1, 3, WHITE)        # 箭头尖，与横笔相连
    g.rect(9, 3, 2, 2, GREEN)          # 在线点
    return g


# ================= 方案 C：闪电直传 =================
def c_master():
    g = Grid(32)
    g.tile()
    bolt = [
        (17, 8, 5, 1), (16, 9, 4, 1), (15, 10, 4, 1),
        (16, 11, 5, 1), (15, 12, 5, 1), (14, 13, 5, 1),
        (15, 14, 3, 1), (13, 15, 5, 1), (14, 16, 3, 1),
        (12, 17, 5, 1), (13, 18, 3, 1), (11, 19, 5, 1),
    ]
    for x, y, w, h in bolt:
        g.rect(x, y, w, h, YELLOW)
    return g


def c_small():
    g = Grid(16)
    g.tile(shadow_w=2)
    bolt = [
        (8, 3, 3, 1), (7, 4, 2, 1), (8, 5, 3, 1),
        (7, 6, 3, 1), (6, 7, 3, 1), (7, 8, 1, 1),
        (5, 9, 3, 1), (6, 10, 1, 1),
    ]
    for x, y, w, h in bolt:
        g.rect(x, y, w, h, YELLOW)
    return g


VARIANTS = [
    ("link", a_master, a_small),
    ("monogram", b_master, b_small),
    ("bolt", c_master, c_small),
]


# ---------- 渲染 ----------
def render(g: Grid, size: int) -> Image.Image:
    img = Image.new("RGBA", (g.size, g.size))
    for y in range(g.size):
        for x in range(g.size):
            c = g.m[y][x]
            img.putpixel((x, y), hex_rgba(c) if c else (0, 0, 0, 0))
    return img.resize((size, size), Image.NEAREST)


def write_svg(g: Grid, path: str, size=32):
    n = g.size
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {n} {n}" '
             f'shape-rendering="crispEdges" width="{size}" height="{size}">']
    for y in range(n):
        x = 0
        while x < n:
            c = g.m[y][x]
            if c is None:
                x += 1
                continue
            w = 1
            while x + w < n and g.m[y][x + w] == c:
                w += 1
            parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="1" fill="{c}"/>')
            x += w
    parts.append("</svg>")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(parts))


SIZES = [16, 32, 48, 64, 128, 256]


def main():
    for name, master_fn, small_fn in VARIANTS:
        master, small = master_fn(), small_fn()
        for s in SIZES:
            art = small if s <= 16 else master
            render(art, s).save(os.path.join(PNG_DIR, f"icon-{name}-{s}.png"))
        write_svg(master, os.path.join(HERE, f"icon-{name}.svg"))
        write_svg(small, os.path.join(HERE, f"icon-{name}-16.svg"))

    # 推荐方案（link）导出主用别名 lanlink-icon-*
    m, s = VARIANTS[0][1](), VARIANTS[0][2]()
    for sz in SIZES:
        art = s if sz <= 16 else m
        render(art, sz).save(os.path.join(PNG_DIR, f"lanlink-icon-{sz}.png"))
    write_svg(m, os.path.join(HERE, "lanlink-icon.svg"))
    write_svg(s, os.path.join(HERE, "lanlink-icon-16.svg"))

    # 联系表：上排 32 稿 ×12，下排 16 稿真实尺寸 ×12
    cell = 32 * 12
    sheet = Image.new("RGBA", (cell * 3 + 80, cell * 2 + 80), (240, 240, 240, 255))
    for k, (name, master_fn, small_fn) in enumerate(VARIANTS):
        sheet.alpha_composite(render(master_fn(), cell), (20 + k * (cell + 20), 20))
        sheet.alpha_composite(render(small_fn(), cell), (20 + k * (cell + 20), cell + 40))
    sheet.save(os.path.join(HERE, "_contact-sheet.png"))
    print("done:", [n for n, _, _ in VARIANTS])


if __name__ == "__main__":
    main()
