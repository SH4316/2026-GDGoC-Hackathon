"""Read a horizontal three-station sign and validate it against registered service paths."""
import io
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps
from rapidocr import LangRec, ModelType, OCRVersion, RapidOCR

from arrows import find_bands, side_arrows, title_pointers, under_title_arrows
from routes import CODE, compact, match_layout, station_evidence

ROOT = Path(__file__).resolve().parent


def load_ocr():
    models = ROOT / ".runtime/models"
    return RapidOCR(params={
        "Global.use_cls": False, "Global.log_level": "error",
        "Det.ocr_version": OCRVersion.PPOCRV5, "Det.model_type": ModelType.MOBILE,
        "Det.model_path": str(models / "ch_PP-OCRv5_det_mobile.onnx"),
        "Rec.ocr_version": OCRVersion.PPOCRV5, "Rec.model_type": ModelType.MOBILE,
        "Rec.lang_type": LangRec.KOREAN,
        "Rec.model_path": str(models / "korean_PP-OCRv5_rec_mobile.onnx"),
        "Det.limit_type": "max", "Det.limit_side_len": 1280,
        "EngineConfig.onnxruntime.intra_op_num_threads": 2,
        "EngineConfig.onnxruntime.inter_op_num_threads": 1,
    })


def pending(reason):
    return {"status": "pending", "reason": reason}


def rectify(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 30, 90)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    for contour in sorted(contours, key=cv2.contourArea, reverse=True):
        if cv2.contourArea(contour) < gray.size * 0.05:
            break
        poly = cv2.approxPolyDP(contour, 0.02 * cv2.arcLength(contour, True), True)
        if len(poly) != 4 or not cv2.isContourConvex(poly):
            continue
        # The sign is horizontal. Sort the two corners on each short edge by y.
        corners = sorted(poly[:, 0], key=lambda p: p[0])
        tl, bl = sorted(corners[:2], key=lambda p: p[1])
        tr, br = sorted(corners[2:], key=lambda p: p[1])
        width = int(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl)))
        height = int(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr)))
        if height < 30 or not 2.8 <= width / height <= 14:
            continue
        matrix = cv2.getPerspectiveTransform(np.float32([tl, tr, br, bl]), np.float32(
            [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]]))
        return cv2.warpPerspective(image, matrix, (width, height))
    return None


@dataclass
class Reading:
    text: str
    x: int
    y: int
    w: int
    h: int

    @property
    def center(self):
        return self.x + self.w / 2, self.y + self.h / 2


def read_labels(image, ocr):
    result = ocr(image, use_det=True)
    readings = []
    for text, score, box in zip(result.txts or (), result.scores or (),
                                () if result.boxes is None else result.boxes):
        if score >= 0.65:
            readings.append(Reading(text, *cv2.boundingRect(box.astype(np.int32))))

    # Small white codes inside coloured discs can escape the full-board text detector.
    saturation = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)[:, :, 1]
    contours, _ = cv2.findContours(cv2.inRange(saturation, 55, 255), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:32]:
        x, y, w, h = cv2.boundingRect(contour)
        if h < 12 or not 0.72 < w / h < 1.32 or not 0.55 < cv2.contourArea(contour) / (w * h) < 0.9:
            continue
        band = image[y + round(.22 * h):y + round(.78 * h), x:x + w]
        badge = ocr(cv2.resize(band, (144, 64), interpolation=cv2.INTER_CUBIC), use_det=False)
        if badge.txts and badge.scores[0] >= 0.80 and CODE.fullmatch(compact(badge.txts[0])):
            readings.append(Reading(badge.txts[0], x, y, w, h))
    return readings


def interpret(image, readings, bands=None, *, require_band=False):
    observed = []
    for reading in sorted(readings, key=lambda r: r.center[0]):
        evidence = station_evidence(reading.text)
        if evidence is not None:
            observed.append((reading, evidence))
    if len(observed) < 3:
        return pending("station_text")
    matched, positions, reason = match_layout([e for _, e in observed], [r.text for r in readings])
    if reason:
        return pending(reason)

    groups = [[], [], []]
    for column, item in zip(positions, observed):
        groups[column].append(item)
    anchors, stations = [], []
    for stop, group in zip(matched, groups):
        # The largest name in each group anchors that column, including signs where
        # the current station's number sits at the far end of a wide nameplate.
        anchor, _ = max(group, key=lambda pair: (pair[1].name_read, pair[0].h))
        anchors.append(anchor)
        stations.append({"code": stop.code, "name": stop.name,
                         "nameRead": any(e.name_read for _, e in group),
                         "codeRead": any(e.code_read for _, e in group)})
    left, mid, right = anchors
    dx = mid.center[0] - left.center[0], right.center[0] - mid.center[0]
    # A large title can be split into unreadable glyphs while the code above
    # it and English name below remain legible. They occupy one title column.
    for code, evidence in groups[1]:
        if not evidence.code_read or evidence.name_read or not stations[1]["nameRead"]:
            continue
        if (abs(code.center[0] - mid.center[0]) < max(mid.w, code.w) / 2
                and abs(code.center[1] - mid.center[1]) < .8 * min(dx)):
            top, bottom = min(code.y, mid.y), max(code.y + code.h, mid.y + mid.h)
            mid = anchors[1] = Reading(mid.text, mid.x, top, mid.w, bottom - top)
            break
    ys = [r.center[1] for r in anchors]
    rise = min(ys[0], ys[2]) - ys[1]
    tiered = (.55 * mid.h < rise < min(.85 * sum(dx), 3.5 * mid.h)
              and abs(ys[0] - ys[2]) < 1.4 * max(left.h, right.h)
              and mid.h >= max(left.h, right.h))
    if min(dx) <= 0 or min(dx) < .35 * max(dx) or (not tiered and max(ys) - min(ys) > max(r.h for r in anchors)):
        return pending("layout")
    for index, (anchor, group) in enumerate(zip(anchors, groups)):
        for reading, evidence in group:
            x, y = reading.center
            nearest = min(abs(x - r.center[0]) for r in anchors)
            same_column = abs(x - anchor.center[0]) <= nearest + reading.h / 2
            if tiered and index == 1 and evidence.code_read and y < ys[1] + rise / 2:
                same_column = left.center[0] < x < right.center[0]
            if not same_column and evidence.code_read and not evidence.name_read:
                # A detached badge may sit in the gap between two names. Do not
                # reassign a badge printed over another station's name.
                spacing = dx[0] if index == 0 or (index == 1 and x < anchor.center[0]) else dx[1]
                in_gap = all(abs(x - other.center[0]) > other.w / 2 + reading.w / 2
                             for other in anchors if other is not anchor)
                same_column = in_gap and abs(x - anchor.center[0]) <= .7 * spacing
            same_row = abs(y - anchor.center[1]) <= 1.5 * max(reading.h, anchor.h)
            if not (same_column and same_row):
                return pending("layout")

    if bands is None:
        bands = find_bands(image)
    aligned = [band for band in bands if band.below_labels(anchors)]
    if require_band and not aligned:
        return pending("layout")
    arrows = {(d, d) for band in aligned for d in band.directions}
    arrows.update((d, d) for d in under_title_arrows(image, anchors))
    for side, label, spacing in (("left", left, dx[0]), ("right", right, dx[1])):
        for direction in side_arrows(image, label, spacing):
            arrows.add((side, direction))
    if tiered:
        arrows.update(title_pointers(image, mid, groups[1], min(ys[0], ys[2])))
    layout = {"line": matched[1].line, "left": stations[0], "current": stations[1], "right": stations[2]}
    if not arrows:
        return {**pending("arrow_missing"), **layout}
    directions = {direction for _, direction in arrows}
    if len(directions) != 1:
        return pending("direction_conflict")
    direction = directions.pop()
    if (direction, direction) not in arrows:
        return pending("direction_conflict")
    return {"status": "recognized", **layout, "arrow": direction,
            "toward": stations[0 if direction == "left" else 2]["name"]}


def zoom_readings(image, readings, ocr, source=None):
    observed = [r for r in readings if station_evidence(r.text) is not None]
    if len(observed) < 2:
        return None
    left = min(r.x for r in observed)
    right = max(r.x + r.w for r in observed)
    top = min(r.y for r in observed)
    bottom = max(r.y + r.h for r in observed)
    height = np.median([r.h for r in observed])
    span = right - left
    if span < 4 * height or bottom - top > .6 * span:
        return None
    pad_x = round(max(.85 * span, 5 * height))
    pad_y = round(max(.2 * (bottom - top), 2.2 * height))
    x, y = max(0, left - pad_x), max(0, top - pad_y)
    crop = image[y:bottom + pad_y, x:right + pad_x]
    scale = min(4, 1680 / max(crop.shape[:2]))
    if scale < 1.1:
        return None
    zoom = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    if source is not None:
        # Locate text on the small overview, then sample the corresponding
        # pixels from the camera original. EXIF is applied in both spaces.
        with Image.open(io.BytesIO(source), formats=["JPEG", "PNG"]) as picture:
            if max(picture.size) > 1.25 * max(image.shape[:2]):
                photo = ImageOps.exif_transpose(picture)
                sx, sy = photo.width / image.shape[1], photo.height / image.shape[0]
                box = (round(x * sx), round(y * sy),
                       round((x + crop.shape[1]) * sx), round((y + crop.shape[0]) * sy))
                detail = photo.crop(box).convert("RGB").resize((zoom.shape[1], zoom.shape[0]), Image.Resampling.LANCZOS)
                zoom = cv2.cvtColor(np.asarray(detail), cv2.COLOR_RGB2BGR)
    fresh = read_labels(zoom, ocr)
    named, badges = [], []
    for reading in fresh:
        clue = station_evidence(reading.text)
        if clue and clue.name_read:
            named.append((reading, clue))
        if clue and clue.code_read:
            badges.append((reading, clue))

    # Keep independent badge/line evidence. Replace a low-resolution name
    # only when the zoomed OCR actually reads a station at that location.
    for original in readings:
        evidence = station_evidence(original.text)
        mapped = Reading(original.text, round((original.x - x) * scale), round((original.y - y) * scale),
                         max(1, round(original.w * scale)), max(1, round(original.h * scale)))
        if evidence and evidence.name_read and not evidence.code_read:
            cx, cy = mapped.center
            replacements = [e for r, e in named if r.x <= cx <= r.x + r.w and r.y <= cy <= r.y + r.h]
            confirmed = any(e.candidates & evidence.candidates for e in replacements)
            for r, badge in badges:
                if abs(cx - r.center[0]) <= 2 * mapped.w and abs(cy - r.center[1]) <= mapped.h:
                    confirmed |= any(e.candidates & badge.candidates for e in replacements)
            if confirmed:
                continue
        fresh.append(mapped)
    return interpret(zoom, fresh)


def inspect_board(candidate, ocr, *, enhance=False, zoom_text=False, source=None):
    scale = min(4 if enhance else 2.5, 1680 / max(candidate.shape[:2]))
    board = cv2.resize(candidate, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    bands = find_bands(board)
    readings = read_labels(board, ocr)
    result = interpret(board, readings, bands, require_band=enhance)
    if enhance and result.get("reason") == "station_text":
        # Recover dark ink on unevenly lit blue panels. Both exposures must agree
        # on any overlapping names or numbers. Measure arrows on the colour input.
        gray = cv2.cvtColor(board, cv2.COLOR_BGR2GRAY).astype(np.float32)
        sigma = max(5, gray.shape[0] / 14)
        detail = gray - cv2.GaussianBlur(gray, (0, 0), sigma)
        deviation = np.sqrt(cv2.GaussianBlur(detail ** 2, (0, 0), sigma))
        enhanced = np.clip(128 + 48 * detail / np.maximum(deviation, 3), 0, 255).astype(np.uint8)
        readings.extend(read_labels(cv2.cvtColor(enhanced, cv2.COLOR_GRAY2BGR), ocr))
        result = interpret(board, readings, bands, require_band=enhance)
    if zoom_text and result.get("reason") in ("station_text", "topology_conflict"):
        zoomed = zoom_readings(board, readings, ocr, source)
        if zoomed and (zoomed["status"] == "recognized" or "current" in zoomed):
            return zoomed
    return result


def recognize(image, ocr, source=None):
    # Several independent nameboards can appear across opposite platforms.
    bands = find_bands(image)
    if len(bands) > 1:
        # A small distant sign on the opposite platform should not supply
        # direction evidence for the board filling the foreground.
        if bands[0].width < .45 * image.shape[1] or bands[0].width < 3 * bands[1].width:
            return pending("layout")
    if bands:
        result = inspect_board(bands[0].panel(image), ocr, enhance=True)
        if result.get("reason") not in ("station_text", "layout", "arrow_missing"):
            return result
    panel = rectify(image)
    if panel is not None:
        result = inspect_board(panel, ocr)
        if result.get("reason") != "station_text":
            return result
    return inspect_board(image, ocr, zoom_text=True, source=source)


def consensus(results):
    if len(results) == 1:
        return results[0]
    accepted = [r for r in results if r["status"] == "recognized"]
    layouts = {(r["line"], r["left"]["code"], r["current"]["code"], r["right"]["code"])
               for r in results if "current" in r}
    directions = {r["arrow"] for r in accepted}
    conflict = any(r.get("reason") in ("topology_conflict", "direction_conflict", "layout") for r in results)
    if len(layouts) > 1 or len(directions) > 1 or conflict:
        return pending("frame_conflict")
    if len(accepted) < 2:
        return pending("more_frames")
    combined = accepted[0].copy()
    for position in ("left", "current", "right"):
        combined[position] = {**combined[position],
                              "nameRead": any(r[position]["nameRead"] for r in accepted),
                              "codeRead": any(r[position]["codeRead"] for r in accepted)}
    return combined


def decode(data):
    with Image.open(io.BytesIO(data), formats=["JPEG", "PNG"]) as picture:
        w, h = picture.size
        if min(w, h) < 16 or w * h > 16_000_000:
            raise ValueError("image dimensions")
        picture.thumbnail((1800, 1800))
        rgb = np.asarray(ImageOps.exif_transpose(picture).convert("RGB"))
        return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def read_frames(stream, count):
    frames = []
    while count is None or len(frames) < count:
        size = stream.read(4)
        if not size and count is None:
            break
        if len(size) != 4:
            raise ValueError("incomplete frame header")
        length = int.from_bytes(size, "big")
        if length > 6 * 1024**2:
            raise ValueError("oversized frame")
        data = stream.read(length)
        if len(data) != length:
            raise ValueError("incomplete frame")
        frames.append(data)
    return frames


def read_request(frames, ocr):
    results = []
    for data in frames:
        try:
            overview = decode(data)
        except (ValueError, OSError, Image.DecompressionBombError, SyntaxError):
            return {"error": "invalid_image"}, ocr
        if ocr is None:
            ocr = load_ocr()
        results.append(recognize(overview, ocr, source=data))
    return consensus(results), ocr


def main():
    cv2.setNumThreads(1)
    stream = sys.stdin.buffer
    worker = "--worker" in sys.argv
    output = sys.stdout
    if worker:
        # Reserve the original pipe for JSON and send library diagnostics to stderr.
        output = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8")
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    ocr = None
    while True:
        count = None
        if worker:
            header = stream.read(1)
            if not header:
                break
            count = header[0]
            if not 1 <= count <= 3:
                return 2
        try:
            frames = read_frames(stream, count)
        except ValueError:
            return 2
        if not frames:
            break
        response, ocr = read_request(frames, ocr)
        del frames
        if not worker and "error" in response:
            return 2
        print(json.dumps(response, ensure_ascii=False), file=output, flush=True)
        if not worker:
            break
    return 0


if __name__ == "__main__":
    sys.exit(main())
