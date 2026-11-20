"""Regression checks for the photo, its layout, and burst agreement."""
import io
import json
import sys
import unittest
from unittest.mock import patch
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

PROJECT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT / "backend/signs"))
from arrows import find_bands
from routes import match_layout, station_evidence
from recognize import Reading, consensus, decode, interpret, load_ocr, recognize, rectify, zoom_readings

PHOTO = PROJECT / "experiments/corridor/ChatGPT Image Nov 20, 2026, 07_10_17 PM.png"


class SignRecognition(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.photo = decode(PHOTO.read_bytes())
        cls.ocr = load_ocr()

    def test_original(self):
        result = recognize(self.photo, self.ocr)
        self.assertEqual(result["status"], "recognized")
        self.assertEqual([result[k]["name"] for k in ("left", "current", "right")], ["선부", "초지", "시우"])
        self.assertEqual([result[k]["code"] for k in ("left", "current", "right")], ["S25", "S26", "S27"])
        self.assertEqual((result["line"], result["arrow"], result["toward"]), ("서해선", "left", "선부"))
        self.assertTrue(result["current"]["codeRead"])

    def test_arrow_changes_and_frame_disagreement(self):
        arrow = self.photo[130:172, 229:282].copy()
        board = self.photo.copy()
        board[130:172, 229:282] = board[130:172, 158:211]
        missing = recognize(board, self.ocr)
        self.assertEqual((missing["reason"], missing["current"]["name"]), ("arrow_missing", "초지"))
        self.assertNotIn("toward", missing)
        board[130:172, 843:896] = cv2.flip(arrow, 1)
        right = recognize(board, self.ocr)
        self.assertEqual((right["arrow"], right["toward"]), ("right", "시우"))
        board[130:172, 229:282] = arrow
        self.assertEqual(recognize(board, self.ocr)["reason"], "direction_conflict")
        left = recognize(self.photo, self.ocr)
        self.assertEqual(consensus([left, missing, left]), left)
        self.assertEqual(consensus([left, right, left])["reason"], "frame_conflict")
        self.assertEqual(consensus([right, missing, missing])["reason"], "more_frames")

    def test_perspective(self):
        h, w = self.photo.shape[:2]
        transform = cv2.getPerspectiveTransform(
            np.float32([(0, 0), (w-1, 0), (w-1, h-1), (0, h-1)]),
            np.float32([(70, 100), (1120, 160), (1090, 400), (25, 350)]))
        image = cv2.warpPerspective(self.photo, transform, (1200, 500), borderValue=(50, 50, 50))
        self.assertIsNotNone(rectify(image))
        self.assertEqual(recognize(image, self.ocr)["toward"], "선부")

    def test_name_number_and_topology(self):
        def read(left, current, right):
            return interpret(self.photo, [Reading(left, 297, 129, 78, 48),
                                          Reading(current, 481, 110, 117, 60),
                                          Reading(right, 706, 129, 76, 48)])

        self.assertEqual(read("시우", "S26", "선부")["toward"], "시우")
        self.assertEqual(read("신천", "신현", "시흥시청")["current"]["code"], "S20")
        self.assertEqual(read("선부", "초지(S25)", "시우")["reason"], "topology_conflict")
        self.assertEqual(read("달미", "S26", "시우")["reason"], "topology_conflict")
        self.assertEqual(read("", "초지", "")["reason"], "station_text")

    def test_gangnam_photo(self):
        # Aspere, Gangnam Station sign.jpg (CC0). Source linked in README.
        photo = decode((PROJECT / "backend/tests/fixtures/gangnam-sign.jpg").read_bytes())
        result = recognize(photo, self.ocr)
        self.assertEqual((result["line"], result["current"]["name"], result["current"]["code"]),
                         ("2호선", "강남", "222"))
        self.assertEqual((result["left"]["name"], result["right"]["name"], result["arrow"], result["toward"]),
                         ("교대", "역삼", "left", "교대"))

    def test_shared_tracks_need_independent_line_evidence(self):
        def read(center, hint=None):
            readings = [Reading("고잔", 297, 129, 78, 48), Reading(center, 481, 110, 117, 60),
                        Reading("안산", 706, 129, 76, 48)]
            if hint:
                readings.append(Reading(hint, 100, 85, 70, 35))
            return interpret(self.photo, readings)

        self.assertEqual(read("초지")["reason"], "ambiguous_line")
        self.assertEqual(read("초지(K254)")["line"], "수인분당선")
        self.assertEqual(read("초지 452")["line"], "4호선")
        self.assertEqual(read("초지", "수인·분당선")["current"]["code"], "K254")
        self.assertEqual(read("초지 452", "수인분당선")["reason"], "topology_conflict")
        self.assertEqual(read("초지 S26")["reason"], "topology_conflict")

    def test_loops_branches_and_public_code_formats(self):
        def read(left, current, right):
            return interpret(self.photo, [Reading(left, 297, 129, 78, 48), Reading(current, 481, 110, 117, 60),
                                          Reading(right, 706, 129, 76, 48)])

        for labels, line, code in [
            (("충정로", "시청역", "을지로입구"), "2호선", "201"),
            (("신설동", "２１１－３", "신답"), "2호선", "211-3"),
            (("광명", "P144", "독산"), "1호선", "P144"),
            (("역촌", "응암", "새절"), "6호선", "610"),
            (("신논현", "D7", "양재"), "신분당선", "D07"),
            (("솔밭공원", "4·19민주묘지", "가오리"), "우이신설선", "S112"),
            (("I110", "귤현", "박촌"), "인천1호선", "I111"),
            (("디지털미디어시티", "A042", "김포공항"), "공항철도", "A042"),
            (("S07", "풍산", "백마"), "서해선", "S08"),
            (("교대", "Gangnam", "역삼"), "2호선", "222"),
        ]:
            with self.subTest(labels=labels):
                result = read(*labels)
                self.assertEqual((result["line"], result["current"]["code"]), (line, code))
        self.assertEqual(read("길동", "강동", "둔촌동")["reason"], "topology_conflict")
        self.assertEqual(read("구산", "새절", "증산")["reason"], "topology_conflict")
        self.assertEqual(read("신촌", "서울역", "공덕")["reason"], "topology_conflict")

    def test_registered_paths_round_trip_with_printed_codes(self):
        lines = json.loads((PROJECT / "backend/signs/network.json").read_text(encoding="utf-8"))["lines"]
        for line, paths in lines.items():
            for path in paths:
                for triple in zip(path, path[1:], path[2:]):
                    for stops in (triple, triple[::-1]):
                        with self.subTest(line=line, stops=stops):
                            matched, _, reason = match_layout([station_evidence(code) for code, _ in stops], [line])
                            self.assertIsNone(reason)
                            self.assertEqual([(s.line, s.code, s.name) for s in matched],
                                             [(line, code, name) for code, name in stops])

    def test_three_labels_from_one_station_need_more_station_text(self):
        readings = [Reading("초지", 500, 110, 100, 55),
                    Reading("Choji", 510, 165, 60, 20), Reading("S26", 615, 117, 36, 34)]
        self.assertEqual(interpret(self.photo, readings), {"status": "pending", "reason": "station_text"})

    def test_hooked_stripe_must_span_the_names_and_have_one_bevel(self):
        image = np.full((260, 560, 3), (115, 50, 15), np.uint8)
        yellow = (4, 180, 245)
        # One straight shaft with a projecting bevel at its right tip.
        hook = np.int32([(20, 145), (540, 145), (518, 167), (505, 167), (519, 153), (20, 153)])
        readings = [Reading(name, x, 65, 60, 34) for name, x in (("금정", 90), ("산본", 250), ("수리산", 410))]
        cv2.fillPoly(image, [hook], yellow)
        for board, direction, station in [(image, "right", "수리산"), (cv2.flip(image, 1), "left", "금정")]:
            with self.subTest(direction=direction):
                result = interpret(board, readings)
                self.assertEqual((result["arrow"], result["toward"]), (direction, station))
        below = [Reading(r.text, r.x, 190, r.w, r.h) for r in readings]
        self.assertEqual(interpret(image, below)["reason"], "arrow_missing")
        double = cv2.bitwise_or(image, cv2.flip(image, 1))
        self.assertEqual(interpret(double, readings)["reason"], "direction_conflict")

        image[:] = (115, 50, 15)
        cv2.rectangle(image, (20, 145), (540, 153), yellow, -1)
        self.assertFalse(find_bands(image))
        cv2.rectangle(image, (505, 153), (519, 167), yellow, -1)
        self.assertFalse(find_bands(image))

    def test_detached_badge_needs_clear_space_between_names(self):
        blank = np.zeros((260, 600, 3), np.uint8)
        readings = [Reading("금정", 45, 90, 90, 48), Reading("산본", 275, 90, 90, 48),
                    Reading("수리산", 475, 90, 100, 48)]
        # The current station's separate code is closer to the left name.
        result = interpret(blank, [*readings, Reading("444", 173, 94, 30, 24)])
        self.assertTrue(result["current"]["codeRead"])
        self.assertEqual(result["reason"], "arrow_missing")
        overlap = interpret(blank, [*readings, Reading("444", 106, 94, 30, 24)])
        self.assertEqual(overlap["reason"], "layout")

    def test_number_inside_unrelated_sentence_is_not_station_evidence(self):
        self.assertIsNone(station_evidence("2부의 214이시합니다"))
        self.assertTrue(station_evidence("812").code_read)
        self.assertFalse(station_evidence("초지(S25)").candidates)

    def test_two_tier_title_pointer(self):
        board = np.full((320, 640, 3), 235, np.uint8)
        readings = [Reading("증미", 60, 190, 90, 36), Reading("가양", 245, 40, 100, 66),
                    Reading("907", 367, 40, 47, 25), Reading("양천향교", 460, 195, 150, 36)]
        self.assertEqual(interpret(board, readings)["reason"], "arrow_missing")
        cv2.fillPoly(board, [np.int32([(377, 84), (377, 107), (395, 95)])], (25, 25, 25))
        result = interpret(board, readings)
        self.assertEqual((result["current"]["name"], result["arrow"], result["toward"]), ("가양", "right", "양천향교"))

    def test_equal_size_opposing_platform_signs_hold(self):
        board = np.full((340, 560, 3), (115, 50, 15), np.uint8)
        hook = np.int32([(20, 130), (540, 130), (518, 152), (505, 152), (519, 138), (20, 138)])
        cv2.fillPoly(board, [hook], (4, 180, 245))
        reverse = hook.copy()
        reverse[:, 0] = 560 - reverse[:, 0]
        reverse[:, 1] += 150
        cv2.fillPoly(board, [reverse], (4, 180, 245))
        self.assertEqual(recognize(board, self.ocr), {"status": "pending", "reason": "layout"})

    def test_empty_frame(self):
        result = recognize(np.zeros((270, 1116, 3), np.uint8), self.ocr)
        self.assertEqual(result, {"status": "pending", "reason": "station_text"})

    def test_short_hook_below_current_name(self):
        board = np.full((320, 640, 3), 219, np.uint8)
        readings = [Reading(name, x, 100, 66, 40) for name, x in (("금정", 80), ("산본", 288), ("수리산", 490))]
        hook = np.int32([(244, 175), (398, 175), (387, 188), (379, 188), (387, 181), (244, 181)])
        cv2.fillPoly(board, [hook], (138, 66, 23))
        self.assertEqual(interpret(board, readings)["toward"], "수리산")
        self.assertEqual(interpret(cv2.flip(board, 1), readings)["toward"], "금정")
        board[:] = 219
        cv2.rectangle(board, (244, 175), (398, 181), (138, 66, 23), -1)
        self.assertEqual(interpret(board, readings)["reason"], "arrow_missing")

    def test_zoom_samples_original_pixels_in_display_orientation(self):
        overview = np.full((150, 200, 3), 128, np.uint8)
        pixels = np.full((900, 1200, 3), 128, np.uint8)
        pixels[385:520:5, 500:720] = 10
        photo = Image.fromarray(pixels)
        readings = [Reading("선부", 85, 68, 10, 5), Reading("초지", 108, 69, 11, 5)]
        crops = []
        with patch("recognize.read_labels", side_effect=lambda crop, ocr: crops.append(crop) or []):
            zoom_readings(overview, readings, None)
            for stored, orientation in [(photo, 1), (photo.transpose(Image.Transpose.ROTATE_90), 6)]:
                buf = io.BytesIO()
                exif = Image.Exif()
                exif[274] = orientation
                stored.save(buf, "PNG", exif=exif)
                zoom_readings(overview, readings, None, buf.getvalue())
        self.assertEqual(crops[0].std(), 0)
        self.assertGreater(crops[1].std(), 5)
        np.testing.assert_array_equal(crops[1], crops[2])


if __name__ == "__main__":
    unittest.main()
