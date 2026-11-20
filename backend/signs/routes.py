"""Resolve station labels against consecutive stops on registered service paths."""
import json
import re
import unicodedata
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

# Branch suffixes are part of the public code, e.g. 211-3 and P144-1.
CODE = re.compile(r"(?<![A-Z0-9])(?:[A-Z][0-9]{1,3}|[0-9]{3})(?:-[0-9]{1,2})?(?![A-Z0-9-])")


def compact(text):
    text = unicodedata.normalize("NFKC", text).upper()
    return re.sub(r"[\s←→©ⓒ]", "", text).translate(str.maketrans("‐‑–−", "----"))


def name_key(text):
    return re.sub(r"[.·ㆍ’']", "", compact(text)).removesuffix("역")


@dataclass(frozen=True)
class Station:
    line: str
    code: str
    name: str


network = json.loads(Path(__file__).with_name("network.json").read_text(encoding="utf-8"))
by_name = defaultdict(set)
by_code = defaultdict(set)
paths_from_left = defaultdict(set)
for line, paths in network["lines"].items():
    for path in paths:
        stops = [Station(line, code, name) for code, name in path]
        for stop in stops:
            by_name[name_key(stop.name)].add(stop)
            english = network["englishNames"].get(stop.name)
            if english:
                by_name[name_key(english)].add(stop)
                # Long English names can wrap before a campus/location qualifier.
                if " at " in english:
                    by_name[name_key(english.split(" at ")[0])].add(stop)
            by_code[stop.code].add(stop)
        # Separate service paths avoid fictitious movements between two branches.
        for left, current, right in zip(stops, stops[1:], stops[2:]):
            paths_from_left[left].add((left, current, right))
            paths_from_left[right].add((right, current, left))

line_labels = {line: {line} for line in network["lines"]}
for n in (1, 2):
    line_labels[f"{n}호선"].add(f"인천{n}호선")
for alias, line in {"경의·중앙선": "경의중앙선", "수인·분당선": "수인분당선",
                    "용인경전철": "에버라인", "우이신설경전철": "우이신설선",
                    "김포도시철도": "김포골드라인"}.items():
    line_labels[alias] = {line}


@dataclass
class Evidence:
    candidates: set[Station]
    name_read: bool
    code_read: bool


def station_evidence(text):
    label = compact(text)
    # Try the full name first. Some names contain numbers, such as 4·19민주묘지.
    named = by_name.get(name_key(label))
    if named:
        return Evidence(named, True, False)

    codes = CODE.findall(label)
    remainder = CODE.sub("", label).replace("()", "")
    named = by_name.get(name_key(remainder)) or by_name.get(name_key(remainder.split("(")[0]))
    # A number in the middle of an unrelated sentence is not a station badge.
    # Keep a bare code or one adjacent to a single plausible (possibly misread) name.
    if codes and not named and remainder.strip("()"):
        if not (len(codes) == 1 and re.fullmatch(r"[가-힣]{1,10}", remainder.strip("()"))
                and (label.strip("()").startswith(codes[0]) or label.strip("()").endswith(codes[0]))):
            return None
    matches = [named] if named else []
    for code in codes:
        if re.fullmatch(r"D[0-9]", code):
            code = "D0" + code[1]
        matches.append(by_code.get(code, set()))
    if matches:
        return Evidence(set.intersection(*matches), bool(named), bool(codes))
    return None


def match_layout(observations, labels):
    """Assign every observation, in screen order, to one of three distinct stops."""
    allowed_lines = set(network["lines"])
    for label in labels:
        text = compact(label)
        hint = line_labels.get(text)
        if hint is not None:
            allowed_lines &= hint
        elif re.fullmatch(r"(?:서울(?:지하철)?|수도권)[1-9]호선", text):
            allowed_lines &= {text[-3:]}
        elif re.fullmatch(r"(?:부산|대구|광주|대전)[1-9]호선", text):
            return None, None, "topology_conflict"

    matches = []
    partial = False
    for left in observations[0].candidates:
        if left.line not in allowed_lines:
            continue
        for path in paths_from_left[left]:
            columns = []
            for obs in observations:
                column = next((i for i, stop in enumerate(path) if stop in obs.candidates), None)
                if column is None or (columns and column < columns[-1]):
                    break
                columns.append(column)
            if len(columns) == len(observations):
                if len(set(columns)) == 3:
                    matches.append((path, columns))
                else:
                    partial = True

    if len(matches) == 1:
        path, columns = matches[0]
        return path, columns, None
    if matches:
        return None, None, "ambiguous_line"
    return None, None, "station_text" if partial else "topology_conflict"
