#!/usr/bin/env python3
"""Render the CineTray icon set as PNGs with nothing but the stdlib.

Draws at 4x resolution and box-downsamples for clean edges, so no
image library is needed to regenerate assets/icons/*.png.
"""

import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "assets" / "icons"
SS = 4  # supersample factor

BG_TOP = (26, 27, 36)
BG_BOTTOM = (12, 13, 18)
RING = (255, 255, 255, 0.07)
TRI_TOP = (255, 98, 116)
TRI_BOTTOM = (255, 45, 85)
TRAY = (255, 77, 109, 0.55)


def sd_rounded_rect(px, py, cx, cy, hw, hh, r):
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    ax, ay = max(qx, 0.0), max(qy, 0.0)
    outside = (ax * ax + ay * ay) ** 0.5
    return min(max(qx, qy), 0.0) + outside - r


def point_in_tri(px, py, a, b, c):
    def edge(x0, y0, x1, y1):
        return (px - x0) * (y1 - y0) - (py - y0) * (x1 - x0)

    d1 = edge(a[0], a[1], b[0], b[1])
    d2 = edge(b[0], b[1], c[0], c[1])
    d3 = edge(c[0], c[1], a[0], a[1])
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def lerp(c1, c2, t):
    return tuple(round(a + (b - a) * t) for a, b in zip(c1[:3], c2[:3]))


def render(size):
    w = size * SS
    buf = [[(0, 0, 0, 0)] * w for _ in range(w)]
    m = 0.02 * size
    half = (size - 2 * m) / 2
    cx = cy = size / 2
    radius = 0.23 * size
    edge = 0.018 * size

    tri = (
        (cx - 0.075 * size, cy - 0.16 * size),
        (cx - 0.075 * size, cy + 0.16 * size),
        (cx + 0.135 * size, cy),
    )
    tri_cy = cy
    tri_top = cy - 0.16 * size

    tray_hw = 0.20 * size
    tray_hh = 0.035 * size
    tray_cx = cx
    tray_cy = 0.835 * size
    tray_r = 0.03 * size

    for y in range(w):
        py = (y + 0.5) / SS
        for x in range(w):
            px = (x + 0.5) / SS
            d = sd_rounded_rect(px, py, cx, cy, half, half, radius)
            if d > 0:
                continue
            t = py / size
            col = lerp(BG_TOP, BG_BOTTOM, t)
            if -edge <= d <= 0:  # inner ring near the border
                col = lerp(col, (255, 255, 255), RING[3])
            if point_in_tri(px, py, *tri):
                k = max(0.0, min(1.0, (py - tri_top) / (tri_cy - tri_top)))
                col = lerp(TRI_TOP, TRI_BOTTOM, k)
            elif sd_rounded_rect(px, py, tray_cx, tray_cy, tray_hw, tray_hh, tray_r) <= 0:
                col = lerp(col, TRAY[:3], TRAY[3])
            buf[y][x] = (col[0], col[1], col[2], 255)

    # box downsample
    out = []
    for oy in range(size):
        row = bytearray()
        for ox in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    pr, pg, pb, pa = buf[oy * SS + sy][ox * SS + sx]
                    r += pr
                    g += pg
                    b += pb
                    a += pa
            n = SS * SS
            row += bytes((r // n, g // n, b // n, a // n))
        out.append(bytes(row))
    return out


def write_png(path, size, rows):
    def chunk(typ, data):
        payload = typ + data
        return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    raw = b"".join(b"\x00" + row for row in rows)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(data)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        write_png(OUT / ("icon%d.png" % size), size, render(size))
        print("icon%d.png" % size)


if __name__ == "__main__":
    main()
