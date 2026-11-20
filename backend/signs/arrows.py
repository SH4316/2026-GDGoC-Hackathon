"""Recognize platform-sign direction markers and locate their supporting panels."""
from dataclasses import dataclass

import cv2
import numpy as np


@dataclass
class Band:
    x: int
    width: int
    y: float
    slope: float
    thickness: float
    directions: set[str]

    def height_at(self, x):
        return self.y + (x - self.x) * self.slope

    def below_labels(self, anchors):
        left, _, right = anchors
        span = right.center[0] - left.center[0]
        if not .5 * self.width < span < 1.25 * self.width:
            return False
        if left.center[0] > self.x + self.width / 3 or right.center[0] < self.x + 2 * self.width / 3:
            return False
        for anchor in anchors:
            x, y = anchor.center
            if not self.x - anchor.w / 2 <= x <= self.x + self.width + anchor.w / 2:
                return False
            if not 0 < self.height_at(x) - y < .46 * self.width:
                return False
        return True

    def panel(self, image):
        # Remove the slope of the stripe while retaining the original left/right order.
        # A little margin includes names overhanging either tip.
        pad = max(4, round(2 * self.thickness))
        width = self.width + 2 * pad
        above = round(self.width * .43)
        x = self.x - pad
        transform = np.float32([[1, 0, x], [self.slope, 1, self.height_at(x) - above]])
        return cv2.warpAffine(image, transform, (width, above + 3 * pad),
                              flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                              borderMode=cv2.BORDER_REPLICATE)


def hooked_end(profile, thickness):
    # From the tip inward the bevel grows from the straight shaft, protrudes
    # by roughly one shaft thickness, then rejoins the shaft.
    head = profile[:min(len(profile) // 4, round(6 * thickness))]
    protrusion = np.flatnonzero(head > .5 * thickness)
    if not len(protrusion):
        return False
    first, last = protrusion[0], protrusion[-1]
    peak = np.argmax(head)
    rising = head[:peak]
    bevel = np.count_nonzero((rising > .12 * thickness) & (rising < .9 * head[peak]))
    return (bevel >= max(1, .18 * thickness) and
            last - first + 1 <= 1.25 * len(protrusion) and
            .15 * thickness <= first <= 3 * thickness and
            .35 * thickness <= len(protrusion) <= 4 * thickness and
            last < len(head) - 1 and
            .65 * thickness <= head.max() <= 2.8 * thickness)


def find_bands(image):
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    yellow = cv2.inRange(hsv, (8, 74, 42), (44, 255, 255))
    blue = cv2.inRange(hsv, (90, 65, 16), (140, 255, 255))
    return hooked_bands(yellow, blue)


def hooked_bands(foreground, background):
    bands = []
    for contour in cv2.findContours(foreground, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        x, y, w, h = cv2.boundingRect(contour)
        if w < 52 or w < 1.8 * h or cv2.contourArea(contour) < 1.8 * w:
            continue
        component = np.zeros((h, w), np.uint8)
        cv2.drawContours(component, [contour], 0, 1, -1, offset=(-x, -y))
        top = component.argmax(axis=0)
        bottom = h - 1 - component[::-1].argmax(axis=0)
        xs = np.arange(w)
        middle = slice(w // 4, 3 * w // 4)
        thickness = np.median(bottom[middle] - top[middle] + 1)
        if not 1.5 < thickness < w / 7:
            continue
        slope, intercept = np.polyfit(xs[middle], top[middle], 1)
        shaft_top = slope * xs + intercept
        shaft_bottom = np.polyval(np.polyfit(xs[middle], bottom[middle], 1), xs)
        residual = np.maximum(abs(shaft_top[middle] - top[middle]), abs(shaft_bottom[middle] - bottom[middle]))
        if np.percentile(residual, 90) > .3 * thickness:
            continue
        # Check the panel colour along the shaft, not just at its tip.
        sample = xs[middle]
        ys = np.rint(y + shaft_top[sample] - thickness).astype(int)
        if ys.min() < 0 or ys.max() >= background.shape[0] or np.mean(background[ys, x + sample] > 0) < .65:
            continue
        excess = np.maximum(shaft_top - top, bottom - shaft_bottom)
        directions = {d for d, profile in (("left", excess), ("right", excess[::-1]))
                      if hooked_end(profile, thickness)}
        if directions:
            bands.append(Band(x, w, y + intercept, slope, thickness, directions))
    return sorted(bands, key=lambda b: b.width, reverse=True)


def under_title_arrows(image, anchors):
    left, mid, right = anchors
    cx = mid.center[0]
    spacing = min(cx - left.center[0], right.center[0] - cx)
    x0, y0 = max(0, int(cx - .75 * spacing)), max(0, mid.y + mid.h)
    roi = image[y0:int(y0 + .65 * spacing), x0:int(cx + .75 * spacing)]
    if not roi.size:
        return set()
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    blue = cv2.inRange(hsv, (90, 65, 16), (140, 255, 255))
    light = cv2.inRange(hsv, (0, 0, 65), (180, 75, 255))
    return {direction for band in hooked_bands(blue, light)
            if 0 < band.x and band.x + band.width < roi.shape[1]
            and .35 * spacing <= band.width <= 1.3 * spacing
            and abs(x0 + band.x + band.width / 2 - cx) < .25 * spacing
            for direction in band.directions}


def arrow_templates():
    # Both filled arrowheads and the common open, thick-stroked arrow.
    templates = []
    for head in (.42, .52):
        for shaft in (.12, .20, .30):
            for filled in (True, False):
                outer = head if filled else head + min(.21, shaft)
                inner = head if filled else min(.31, 1.4 * shaft)
                points = [(0, .5), (head, 0), (outer, 0), (inner, .5 - shaft / 2),
                          (1, .5 - shaft / 2), (1, .5 + shaft / 2),
                          (inner, .5 + shaft / 2), (outer, 1), (head, 1)]
                mask = np.zeros((32, 32), np.uint8)
                cv2.fillPoly(mask, [np.int32(np.array(points) * 31)], 1)
                templates.append(mask.astype(bool))
    # Narrow line arrows have rounded ends and a thin diagonal stroke.
    for stroke in (2, 3):
        mask = np.zeros((40, 40), np.uint8)
        cv2.line(mask, (3, 19), (33, 19), 1, stroke)
        cv2.polylines(mask, [np.int32([(18, 4), (3, 19), (18, 34)])], False, 1, stroke)
        x, y, w, h = cv2.boundingRect(mask)
        templates.append(cv2.resize(mask[y:y+h, x:x+w], (32, 32), interpolation=cv2.INTER_NEAREST).astype(bool))
    return templates


TEMPLATES = arrow_templates()


def triangle_direction(contour):
    x, y, w, h = cv2.boundingRect(contour)
    vertices = cv2.approxPolyDP(contour, .075 * cv2.arcLength(contour, True), True)
    if len(vertices) != 3 or not .36 < cv2.contourArea(contour) / (w * h) < .65:
        return None
    top, tip, bottom = sorted(vertices[:, 0], key=lambda v: v[1])
    if abs(top[0] - bottom[0]) > .24 * w or abs(tip[1] - y - h / 2) > .23 * h:
        return None
    return "left" if tip[0] < top[0] else "right"


def template_direction(mask, x, y, w, h):
    component = cv2.resize(mask[y:y+h, x:x+w], (32, 32), interpolation=cv2.INTER_NEAREST) > 0
    scores = [max(np.count_nonzero(t & sample) / np.count_nonzero(t | sample) for t in TEMPLATES)
              for sample in (component, np.fliplr(component))]
    if max(scores) >= .68 and abs(scores[0] - scores[1]) >= .17:
        return "left" if scores[0] > scores[1] else "right"
    return None


def side_arrows(image, label, spacing):
    cx, cy = label.center
    radius = spacing * 0.64
    x0, y0 = max(0, int(cx - radius)), max(0, int(cy - 1.6 * label.h))
    roi = image[y0:int(cy + 1.6 * label.h), x0:int(cx + radius)]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    found = set()
    # The higher contrast cut separates bright arrows that touch a lit nameplate.
    for polarity, threshold in ((cv2.THRESH_BINARY_INV, 5), (cv2.THRESH_BINARY, -5), (cv2.THRESH_BINARY, -15)):
        mask = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, polarity, 41, threshold)
        contours, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            x, y, w, h = cv2.boundingRect(contour)
            if not (.29 * label.h <= h <= 1.7 * label.h and .55 <= w / h <= 2.7):
                continue
            if abs(y0 + y + h / 2 - cy) > label.h:
                continue
            direction = template_direction(mask, x, y, w, h)
            if direction:
                found.add(direction)

    # Local adaptive thresholding can hollow out a broad arrow. A single
    # intensity cut preserves its solid shaft. Search outside the name only,
    # including the taller Korean row when the anchor is an English subtitle.
    wide_y = max(0, int(cy - 2.6 * label.h))
    wide = image[wide_y:int(cy + 2.6 * label.h), x0:int(cx + radius)]
    gray = cv2.cvtColor(wide, cv2.COLOR_BGR2GRAY)
    max_height = min(.42 * spacing, (3 if label.text.isascii() else 1.8) * label.h)
    for polarity in (cv2.THRESH_BINARY, cv2.THRESH_BINARY_INV):
        mask = cv2.threshold(gray, 0, 255, polarity | cv2.THRESH_OTSU)[1]
        for contour in cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)[0]:
            x, y, w, h = cv2.boundingRect(contour)
            if not (.35 * label.h <= h <= max_height and .6 <= w / h <= 2.6):
                continue
            if x0 + x < label.x + label.w and x0 + x + w > label.x:
                continue
            if abs(wide_y + y + h / 2 - cy) > 1.25 * label.h or x == 0 or x + w == mask.shape[1]:
                continue
            direction = template_direction(mask, x, y, w, h)
            if direction:
                found.add(direction)

    # Platform screen doors can use a coloured triangular pointer without a shaft.
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, (8, 60, 90), (44, 255, 255))
    for c in cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        x, y, w, h = cv2.boundingRect(c)
        if not max(6, .22 * label.h) <= h <= label.h or not .55 < w / h < 1.5:
            continue
        direction = triangle_direction(c)
        if direction and abs(y0 + y + h / 2 - cy) <= label.h:
            found.add(direction)
    return found


def title_pointers(image, mid, group, side_y):
    # On two-tier boards the triangular pointer is printed directly below
    # the current station number, between the title and the row of neighbours.
    found = set()
    for code, evidence in group:
        if not evidence.code_read or evidence.name_read:
            continue
        x0 = max(0, int(code.x - .65 * code.w))
        x1 = int(code.x + 1.65 * code.w)
        y0 = code.y + code.h
        y1 = int(min(y0 + 3 * code.h, side_y))
        if y1 <= y0:
            continue
        gray = cv2.cvtColor(image[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
        for polarity in (cv2.THRESH_BINARY, cv2.THRESH_BINARY_INV):
            mask = cv2.threshold(gray, 0, 255, polarity | cv2.THRESH_OTSU)[1]
            for c in cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)[0]:
                x, y, w, h = cv2.boundingRect(c)
                if not max(6, .2 * code.h) <= h <= code.h or not .55 < w / h < 1.5:
                    continue
                direction = triangle_direction(c)
                side = "left" if x0 + x + w / 2 < mid.center[0] else "right"
                if direction:
                    found.add((side, direction))
    return found
