# /// script
# requires-python = ">=3.10"
# dependencies = ["opencv-python-headless==4.13.0.92", "numpy>=2,<3"]
# ///
"""Fit station.json's optional camera.calibration from the same rear video stream."""
import argparse
import json
import sys
from pathlib import Path

import cv2 as cv
import numpy as np


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("images", nargs="+", type=Path)
    parser.add_argument("--square-mm", type=float, default=20)
    args = parser.parse_args()
    if not np.isfinite(args.square_mm) or args.square_mm <= 0:
        parser.error("--square-mm에 실측 한 칸 길이를 입력하세요.")
    shape, views = None, []
    for path in args.images:
        frame = cv.imread(str(path), cv.IMREAD_GRAYSCALE)
        if frame is None or (shape and frame.shape != shape):
            parser.error(f"{path}: 같은 해상도와 방향으로 촬영한 보정판 사진이 필요합니다.")
        shape = frame.shape
        ok, corners = cv.findChessboardCornersSB(frame, (9, 6), flags=cv.CALIB_CB_NORMALIZE_IMAGE)
        if ok:
            views.append(corners)
    if len(views) < 10:
        parser.error(f"보정판 검출 {len(views)}장. 각도와 거리를 달리해 15장 이상 촬영하세요.")
    h, w = shape
    centers = np.array([v.reshape(-1, 2).mean(axis=0) / [w, h] for v in views])
    if np.min(np.ptp(centers, axis=0)) < .2:
        parser.error("화면 중앙과 네 모서리에 보정판을 두고 다시 촬영하세요.")
    grid = np.zeros((54, 3), np.float32)
    grid[:, :2] = np.mgrid[0:9, 0:6].T.reshape(-1, 2) * args.square_mm / 1000
    rms, K, d, _, _ = cv.calibrateCamera([grid] * len(views), views, (w, h), None, None)
    if not np.isfinite(rms) or rms > 1.5 or not np.all(np.isfinite(d)) or not np.all(np.isfinite(K)):
        parser.error(f"재투영 RMS {rms:.2f} px. 평평한 보정판으로 다시 촬영하세요.")
    print(f"보정판 {len(views)}장, RMS {rms:.3f} px", file=sys.stderr)
    print(json.dumps(dict(width=w, height=h, fx=K[0,0], fy=K[1,1], cx=K[0,2], cy=K[1,2],
                          distortion=d.ravel().tolist()), indent=2))


if __name__ == "__main__":
    main()
