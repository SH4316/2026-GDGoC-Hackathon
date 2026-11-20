#!/bin/sh
set -eu
cd "$(dirname "$0")"
python3 -m venv .runtime
.runtime/bin/python -m pip install --disable-pip-version-check -r requirements.txt
.runtime/bin/python - <<'PY'
from pathlib import Path
from rapidocr import EngineType, LangDet, LangRec, ModelType, OCRVersion
from rapidocr.inference_engine.base import FileInfo
from rapidocr.utils.download_models import download_task
from rapidocr.utils.typings import TaskType

models = Path(".runtime/models")
models.mkdir(exist_ok=True)
for task, lang in [(TaskType.DET, LangDet.CH), (TaskType.REC, LangRec.KOREAN)]:
    download_task(models, FileInfo(EngineType.ONNXRUNTIME, OCRVersion.PPOCRV5, task, lang, ModelType.MOBILE))
PY
