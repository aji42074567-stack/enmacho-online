#!/usr/bin/env python3
"""冥職紹介ページ用の立ち絵を量産する。

_wip_src/<src>_{m,f}_stand.png (緑背景の原画・ローカルのみ) を
1) クロマキー除去(Codexスキル同梱の remove_chroma_key.py を利用)
2) 余白トリム
3) 高さ960pxへ縮小
4) WebP(アルファ付き)で assets/meishoku/<job>_{m,f}.webp へ出力
する。原画を差し替えたら再実行すれば同じ名前で作り直せる。
"""
import os, subprocess, tempfile
from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOVER = os.path.expanduser('~/.codex/skills/.system/imagegen/scripts/remove_chroma_key.py')
OUT_DIR = os.path.join(REPO, 'assets', 'meishoku')
JOBS = {  # 出力名(冥職ID) : 原画の接頭辞
    'rasetsu': 'rasetsu',
    'kagehoshi': 'kagebo',
    'jugonshi': 'jugon',
    'gohousou': 'goho',
}
TARGET_H = 960

os.makedirs(OUT_DIR, exist_ok=True)
for job, src in JOBS.items():
    for g in ('m', 'f'):
        src_path = os.path.join(REPO, '_wip_src', f'{src}_{g}_stand.png')
        out_path = os.path.join(OUT_DIR, f'{job}_{g}.webp')
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
            tmp_path = tmp.name
        subprocess.run(['python3', REMOVER, '--input', src_path, '--out', tmp_path,
                        '--auto-key', 'border', '--soft-matte',
                        '--transparent-threshold', '12', '--opaque-threshold', '220',
                        '--despill', '--force'], check=True, capture_output=True)
        im = Image.open(tmp_path).convert('RGBA')
        bbox = im.getchannel('A').getbbox()
        if bbox:
            pad = 8
            bbox = (max(0, bbox[0]-pad), max(0, bbox[1]-pad),
                    min(im.width, bbox[2]+pad), min(im.height, bbox[3]+pad))
            im = im.crop(bbox)
        if im.height > TARGET_H:
            im = im.resize((round(im.width*TARGET_H/im.height), TARGET_H), Image.LANCZOS)
        im.save(out_path, 'WEBP', quality=85, method=6)
        os.unlink(tmp_path)
        print(f'{out_path}  {im.size}  {os.path.getsize(out_path)//1024}KB')
