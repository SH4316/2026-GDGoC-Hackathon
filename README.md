# 지하철 환승 통로 AR PoC

실내에서 바로 시작하려면 **태그로 실내 안내**를 누르고 후면 카메라로 등록된 AprilTag 하나를 비춘다. 태그 ID는 전체 공간에서 고유하다. 앱은 ID로 공간을 찾고, 그 공간에 등록된 태그의 위치와 방향으로 카메라의 미터 좌표와 AR 화살표를 계산한다. GPS 권한이나 목적지 입력은 필요 없다. 태그를 놓치면 위치를 다시 확인할 때까지 화살표를 숨긴다.

**역 안 AR 안내**와 **AR 카메라**에서 **디버그 활성화**를 누르면 기기의 가속도와 실내 위치를 서버에 자동 저장한다. 동작 센서 권한을 허용하고 등록된 태그를 비추면 **서버 저장**에 서버가 확인한 행 수가 표시된다. 앱은 매초 새 데이터를 기기의 IndexedDB에 보관한 뒤 전송한다. **디버그 수집 종료**, 카메라 중단, 지도 복귀 시에도 남은 행을 전송 대기열에 넣는다. 연결이 끊기면 같은 브라우저에서 앱을 열어 연결이 복구될 때 전송을 이어간다.

**수집 파일 → 서버 CSV 받기**로 저장한 자료를 내려받을 수 있다. 같은 탭에서는 **기기 CSV 받기**로 전송 대기 중인 자료도 받을 수 있다. 서버의 기본 저장 위치는 `data/recordings/<세션 UUID>/debug.sqlite`이며, `debug-session.json`에 시작 시각이 있다. `GET /api/recordings/<세션 UUID>/debug.csv`는 요청 시점까지 저장한 행을 시간순으로 제공한다.

CSV의 `elapsed_ms`는 수집 시작 후 경과 시간이다. 기기 축의 가속도와 중력 포함 가속도는 각각 m/s²로 기록한다. `space_id`는 좌표의 기준 공간이며, X·Y는 그 공간의 바닥 좌표, Z는 바닥 위 높이(m)다. `position_source`는 태그 측정(`tag`), 바닥 영상 보정(`floor`), 관성 추정(`motion`)을 구분한다. 관성 추정은 X·Y만 제공한다. 각 행에는 해당 시점에 받은 값만 들어가며, 센서 권한이 없어도 태그 위치는 수집할 수 있다.

첫 화면의 **도착지 설정**에서 장소나 역 이름을 검색해 결과를 선택하거나 지도의 도착 지점을 누른다. 기본 출발지는 현재 위치다. 위치 권한을 사용할 수 없으면 **출발지 변경**으로 출발점도 검색하거나 지도에서 선택한다.

1. **대중교통** 또는 **도보**를 선택하고 **길 안내 시작**을 누른다. 서버는 설정된 TMAP 또는 카카오맵 API로 경로를 조회하고, 앱은 OpenStreetMap 지도에 출발지, 도착지, 구간별 경로를 표시한다. 지도와 함께 표시되는 목록에서 출발부터 도착까지 모든 구간의 안내를 순서대로 읽을 수 있다. GPS로 구간 끝에 가까워지면 다음 구간이 목록과 지도에서 강조된다.
2. 안내를 시작한 뒤 후면 카메라를 허용한다. 역에 들어가 등록된 AprilTag를 비추면 기기가 위치를 계산하고 자동으로 **역 안 AR 안내**를 연다. AR 화살표는 관리자 페이지에 저장한 현재 공간의 실내 경로를 따른다. 특정 공간을 사용하려면 `/?space=공간ID`로 시작한다. 카메라 권한을 거부해도 지도 안내를 계속 사용할 수 있다.
3. 태그로 확인한 위치가 실내 경로의 끝점에서 1 m 이내이면 **2D 지도로 돌아가기** 버튼이 나타난다. 버튼을 누르면 기존 목적지와 안내 단계가 표시되고, 실내 안내만 시작했다면 도착지 설정 지도가 열린다. 이동 중에도 메뉴의 **2D 지도로**로 복귀할 수 있다. 다시 자동 전환하려면 **태그 인식 켜기**를 누른다. **안내 종료**는 카메라와 위치 추적을 종료한다.

길 안내 중에는 관리자 페이지의 **연결 역**에 등록된 태그를 비추면 GPS 없이도 경로에서 그 역까지 이동한 것으로 처리한다. 정왕역 → 초지역 → 소사역 경로에서 `abc`의 0번 태그를 비추면 초지역 환승 도보 구간이 열리고, 2번을 비추면 서해선 탑승 단계로 넘어간다. 중간 정차역에서는 열차 구간을 유지하며 마지막으로 확인한 역을 갱신한다. 역 자체를 도착지로 선택하면 해당 역 태그로 안내를 완료하고, 출구나 다른 장소를 선택하면 남은 구간을 계속 안내한다.

서버 키 설정은 아래 **장소 검색과 도보·대중교통 길찾기 API** 절에 있다. 실험 기록은 첫 화면의 **AR 카메라**에서 사용할 수 있다. 태그로 공간을 확인한 뒤 **기록 시작**을 누르면 그 공간의 좌표계로 후면 동영상과 기기의 가속도를 함께 수집한다. 공간을 확인하기 전에 기록을 시작하면 주소에서 지정한 공간 또는 기본 공간을 사용한다. **기록 종료 → 녹화 자료 받기**로 ZIP을 내려받아 Codex에 전달하면 나중에 3D 지도를 복원할 수 있다.

## 역 안내판의 현재역과 방면 읽기

첫 화면에서 **AR 카메라 → 안내판 읽기**를 연다. **사진 선택**으로 JPEG·PNG 한 장을 올리거나, 역명 세 개와 화살표가 한 화면에 들어오게 후면 카메라를 향한 뒤 **카메라로 읽기**를 누른다. 사진 선택은 카메라 권한 없이도 작동한다. 선택한 사진이나 촬영한 세 프레임은 같은 서버에서 메모리로 처리한다. 녹화와 별개로 동작하며 안내판 판독에는 AprilTag나 API 키가 필요 없다.

| 첨부 사진의 판독 결과 | 근거 |
| --- | --- |
| 서해선 · 현재역 초지 S26 | 중앙 역명과 원형 배지의 S26을 각각 인식 |
| 왼쪽 선부 S25 · 오른쪽 시우 S27 | 두 역명을 인식하고 작은 배지의 번호는 노선표에서 확인 |
| ← 선부 방면 | 선부 옆의 왼쪽 화살표를 검출하고 초지의 인접역인지 검증 |

화면의 방면은 촬영한 **안내판이 가리키는 쪽**이다. 열차의 실제 운행 방향을 알려면 열차 운행 정보가 추가로 필요하다. [검증에 사용한 초지역 사진](<experiments/corridor/ChatGPT Image Nov 20, 2026, 07_10_17 PM.png>)

### 설치와 실행

Docker Compose에서는 기존 `./scripts/compose-up.sh`로 실행한다. 백엔드 이미지 빌드 중에 CPU용 OCR과 두 모델을 설치한다. Compose 없이 실행할 때는 서버 PC에 Python 3.11 또는 3.12와 `venv`를 준비한 뒤 저장소 루트에서 아래 명령을 실행한다. 최초 설치는 PyPI와 ModelScope에 접속하며, 설치 후 판독은 로컬 모델을 사용한다.

```bash
./backend/signs/setup.sh
./scripts/start.sh
```

### 판정 방식과 지원 범위

- 판정은 서버에서 실행한다. 파란 안내판에 긴 노란 화살표가 있으면 OpenCV가 띠의 기울기에 맞춰 위쪽 역명 영역을 잘라낸다. 그 밖의 표지는 사각 테두리의 원근을 보정하거나 전체 사진에서 글자를 찾는다. 한국어 PP-OCRv5로 역명과 번호를 읽고, 글자가 작거나 조명이 불균일하면 해당 영역을 확대하거나 대비를 높여 다시 읽는다. 전체 사진에서 찾은 문자 영역을 재판독할 때 업로드 원본의 해상도가 충분히 높으면 원본의 해당 좌표에서 픽셀을 가져온다. 추론은 RapidOCR와 ONNX Runtime을 사용한다. [판독 코드](backend/signs/recognize.py) · [PaddleOCR 한국어 인식 모델](https://www.paddleocr.ai/v3.3.0/en/version3.x/module_usage/text_recognition.html) · [RapidOCR](https://github.com/RapidAI/RapidOCR)
- 수도권 **23개 노선**의 완행 정차 순서를 사용한다. 수도권 1~9호선, 인천 1·2호선, 서해선(일산~원시), 수인분당선, 경의중앙선, 경춘선, 경강선, 공항철도, 신분당선, 신림선, 우이신설선, 김포골드라인, 에버라인, 의정부경전철을 담았다. 2026년 11월 20일 기준 스냅샷에 환승역을 노선별로 세어 790개 항목이 있다. 이 중 739개는 좌우 인접역이 있는 현재역 후보이고 나머지는 경로 끝의 인접역으로 쓰인다. [역명과 역번호 출처](https://data.seoul.go.kr/dataList/OA-121/S/1/datasetView.do) · [운영기관 역사정보](https://data.kric.go.kr/rips/M_01_01/detail.do?id=1294) · [한국철도공사 수도권 노선도](https://info.korail.com/info/contents.do?key=2950)
- 세 역명이 한 줄인 표지와 현재역이 위에 있고 두 이웃역이 아래에 있는 표지를 처리한다. 한글·등록된 영문 역명과 역번호를 경로별 정차 순서에 대조한다. 문자 사이에 떨어진 번호는 역명과의 거리, 다른 글자와의 겹침, 노선 순서를 함께 확인한다. 종점처럼 한쪽 역명이 없는 안내판이나 급행 정차역만 나열한 안내판은 지원 범위 밖이다. 역을 추가하거나 개통·개명 사항을 반영할 때는 해당 노선의 정차 경로와 영문 표기를 수정한다. [판정용 노선 데이터](backend/signs/network.json)
- **고잔–초지–안산**처럼 두 노선이 승강장 구간을 공유하면 세 역명이 같아도 판정을 보류한다. 같은 배치에서 `452`가 읽히면 4호선, `K254`가 읽히면 수인분당선이다. 안내판에 적힌 노선명도 후보를 좁히는 데 쓴다. 서로 충돌하는 근거가 있으면 방면을 확정하지 않는다.
- 좌우 역명 옆의 굵은 화살표는 주변 밝기를 기준으로 글자와 분리해 윤곽을 대조한다. 파란 판 아래의 긴 노란 띠와 밝은 판에서 현재역 아래에 그려진 짧은 파란 띠는 몸통에서 비스듬히 돌출한 끝으로 방향을 읽는다. 두 줄 표지에서는 중앙 역번호 바로 아래의 삼각형도 검사한다. 화살표가 가리키는 쪽에 확인된 이웃역이 있어야 방면을 표시한다. 화살표만 빠졌으면 확인된 현재역을 표시하고, 서로 반대인 단서가 있으면 방면을 보류한다. 카메라는 세 프레임 중 둘 이상의 현재역·좌우역·화살표가 일치해야 한다. 한 프레임이라도 역 배치나 방향이 충돌하면 재촬영을 안내한다. [화살표 검출 코드](backend/signs/arrows.py)

### API와 회귀 검증

`POST /api/signs/recognize`는 multipart 폼의 `images` 필드로 JPEG·PNG 1~3장을 받는다. 파일당 최대 6 MiB, 1,600만 화소다. 사진 선택 화면에서는 이 제한을 넘는 사진만 기기에서 긴 변 최대 1,680px JPEG로 줄여 전송한다. 제한 안의 사진은 원본을 전송한다. 여러 장을 보내면 프레임 합의를 적용한다.

서버는 요청이 들어올 때 OCR 프로세스를 시작하고 최대 두 개까지 재사용한다. 각 프로세스는 매 요청의 프레임을 처리한 뒤 해제하고 모델은 메모리에 둔다. 5분간 새 요청이 없으면 프로세스를 종료하므로 이후 첫 요청에는 모델 로딩 시간이 다시 든다.

```bash
curl -F 'images=@"experiments/corridor/ChatGPT Image Nov 20, 2026, 07_10_17 PM.png";type=image/png' \
  http://localhost:8080/api/signs/recognize
backend/signs/.runtime/bin/python backend/tests/test_signs.py
```

HTTP 200의 `status`가 `recognized`이면 `line`, `left`, `current`, `right`, `arrow`, `toward`를 읽는다. 각 역의 `nameRead`는 한글이나 등록된 영문 역명을 읽었는지, `codeRead`는 사진의 역번호를 읽었는지 나타낸다. `pending`은 정상적으로 처리했으나 방면을 확정하기 어려운 경우이며 `reason`을 반환한다. 잘못된 사진은 400, 용량 초과는 413, 지원하지 않는 파일 형식은 415, OCR 설치 누락 또는 처리 슬롯 부족은 503, 시간 초과는 504다.

회귀 시험은 첨부된 초지 사진과 2호선 강남역 사진에서 현재역과 방면을 함께 검사한다. 강남역 사진의 결과는 **강남 222 · ← 교대 방면**이다. 분기·순환 경계, 공유 구간의 노선 판별, 반대 방향, 원근 변형, 화살표 소실과 프레임 간 충돌도 검사한다. [강남역 시험 사진](backend/tests/fixtures/gangnam-sign.jpg) · [사진 원본과 이용 조건 · Aspere, CC0](https://commons.wikimedia.org/wiki/File:Gangnam_Station_sign.jpg)

CPU 판독 API의 연속 요청 응답 시간 중앙값은 **630ms에서 191ms**로 줄었다. 기존 사진에서는 까치산·송정·구일·개봉의 방면을 추가로 읽었다. 마지막 변경에 쓰지 않은 새 사진 25장에서는 방면을 채점한 15장 중 전후 모두 6장을 맞혔고 잘못 표시한 방면은 없었다. [응답 시간과 최종 실사진 시험](experiments/station-signs/2026-11-20-performance.md) · [앞선 33장 시험](experiments/station-signs/2026-11-20-improved.md) · [최초 28장 시험](experiments/station-signs/2026-11-20.md)

## Scaniverse 복도 복원

[3D 모델(GLB)](experiments/corridor/reconstructed/corridor.glb) · [천장을 숨긴 미리보기](experiments/corridor/reconstructed/corridor-cutaway.png) · [생성 코드](experiments/corridor/reconstruct.py)

184132 스캔의 로컬 XZ 평면과 높이축 Y를 사용하며 단위는 m다. 동쪽 긴 복도 끝의 폭 2.18 m에 남쪽 복도의 모서리를 맞춰 사각 순환로를 연결했다. 두 스캔 구간의 바닥 높이가 약 0.8 m 어긋나므로 같은 층으로 가정해 바닥을 Y=0에 맞췄다. 천장고는 코드의 `RUNS`에 기록한 구간별 바닥과 천장의 높이 차이를 보간한다.

벽은 연결된 바닥의 외곽과 루프 안쪽 경계에 바닥부터 천장까지 세웠다. 교차부와 옆 통로 입구는 열려 있다. GLB에서 `Ceiling`을 숨기면 전체 동선을 볼 수 있다. `Walls`는 스캔에서 관측한 면을 벽 위치에 맞춘 부분이고, `Estimated walls`는 빈 부분을 채운 면이다. 두 그룹은 개별적으로 표시할 수 있다.

저장소 루트에서 아래 명령을 실행하면 원본 OBJ를 읽어 GLB와 미리보기를 다시 생성한다.

```sh
uv run experiments/corridor/reconstruct.py
```

## 바닥에 놓을 것

준비물은 스마트폰, A4 출력물, 줄자, 종이를 평평하게 고정할 테이프다. 평평한 바닥에서 출발점과 코너를 정하면 된다. 기본 코스는 **직진 2.00 m 후 오른쪽으로 1.75 m**다.

1. [실험 복도 태그 PDF](experiments/corridor/corridor-tags.pdf)를 A4 **실제 크기 100%**로 인쇄한다. 첫 세 장은 4·5·6번, 마지막 장은 3번이다. 관리자 페이지에서도 해당 공간을 선택한 뒤 **전체 인쇄**로 현재 배치의 도안을 받을 수 있다. 검은 정사각형의 한 변은 160 mm, 아래 검산선은 100 mm다. 흰 여백을 보존한다.
2. 바닥 출발점을 원점으로 잡는다. 출발할 때 정면을 +Y, 오른쪽을 +X로 두고 아래 위치에 **검은 정사각형의 중심**을 맞춘다. 종이의 ‘UP’ 쪽을 표의 방향으로 놓는다.
3. 바닥에 코너 (0, 2)와 도착점 (1.75, 2)를 표시한다. 다른 통로에서는 **관리자 페이지**에서 실측한 바닥 경계, 안내 경로, 태그 중심과 방향을 저장한다. 단위는 m이며 태그 회전은 +Y에서 시계 방향이다. 카메라 보정값은 아래 배치 API에서 설정한다.

| 태그 ID | X (m) | Y (m) | 인쇄물 위쪽 |
| --- | ---: | ---: | --- |
| 4 | −0.25 | 0 | 정면 (+Y) |
| 5 | +0.25 | 1 | 정면 (+Y) |
| 6 | −0.25 | 2 | 정면 (+Y) |
| 3 | 1 | 2.25 | 오른쪽 (+X) |

현재 저장된 배치에서 0·1·2번은 `abc`에 속한다. 실험 복도에 이전 도안을 설치했다면 0→4, 1→5, 2→6 순으로 같은 자리에 교체한다. 카메라 보정에는 기존 [A4 보정판](experiments/corridor/images/calibration-board.png)을 사용한다.

초지역 환승 시연은 `abc` 복도에서 진행한다. 4호선(452) 출발점은 0번 태그 (12.75, −21.01) m, 서해선(S26) 도착점은 2번 태그 (−4.37, 11.50) m다. 좌표는 복도 모델 기준이다. **태그로 실내 안내**에서 0번 태그를 비추고 약 32.5 m 직진한다. 1번 태그 (12.96, 11.53) m에서 왼쪽으로 꺾어 약 17.3 m 이동하면 2번 태그에 도착한다. 관리자 페이지의 **연결 역**에서 노선별로 **경로 출발점**과 **경로 도착점**을 지정하며, 좌표는 **안내 경로**의 첫 점과 마지막 점을 따른다.

## 관리자 페이지에서 지형과 AprilTag 관리

1. 카메라 화면의 **관리자 페이지** 또는 `/admin/`에서 공간을 선택한다. **새 공간**을 누르면 빈 배치가 열린다. **공간 이름**을 입력하고 **지형 모델 선택**으로 OBJ를 열면 업로드 전에도 3D로 확인할 수 있다. OBJ의 단위는 m이며 +X는 오른쪽, +Y는 높이, −Z는 공간의 정면이다.
   **연결 역**에서 역 이름·노선·역번호로 검색해 해당 역을 선택한 뒤 **배치 저장**을 누른다. 환승 통로는 연결할 노선을 각각 추가할 수 있다. 역을 변경하려면 기존 항목의 **해제**를 누르고 새 역을 선택해 저장한다. 태그로 공간을 인식하면 AR 안내에 연결한 역이 표시되고, 안내판 판독에 성공하면 해당 노선·역번호에 연결된 공간을 볼 수 있다.
2. **태그 생성**은 전체 공간에서 비어 있는 첫 번호(0~586)를 제안한다. **AprilTag ID**에 실제 인쇄물의 번호를 입력하고 **표면에 배치**를 누른 뒤 모델에서 태그 중심을 클릭하거나 탭한다. 같은 공간에 이미 등록한 ID를 다시 배치하면 위치가 갱신된다. 3D 뷰어에서 **드래그 → 이동**을 선택하면 마우스나 한 손가락으로 화면을 상하좌우로 옮길 수 있다. **회전**을 선택하면 같은 동작으로 모델을 돌린다. 뷰어에 초점을 둔 상태에서는 방향키로 이동하고, 스크롤이나 두 손가락 핀치로 확대·축소한다.
3. 태그의 중심 좌표, 높이, 면의 가로·세로축을 함께 저장한다. 바닥에 가까운 면은 공간 정면, 벽에 가까운 면은 위쪽을 인쇄물의 위쪽 기준으로 삼는다. 태그 편집에서 **방향 (°)**을 시계 방향으로 조정해 실제 인쇄물과 맞춘다. 3D에는 해당 번호의 tag36h11 패턴을 표시한다.
4. **평면**에서 바닥 경계와 안내 경로를 확인하고 필요하면 **지형 데이터**에서 편집한다. 안내 경로는 비워 둘 수 있다. 태그별 AR 모델도 연결할 수 있다. 지형과 태그 모델은 OBJ 또는 자체 텍스처·버퍼를 포함하는 GLB 2.0을 지원하며 파일당 최대 32 MiB다.
5. **배치 저장**을 누르면 해당 공간의 지형과 태그를 함께 저장한다. **AR 화면**을 누르면 선택한 공간의 배치로 카메라를 연다. 일반 카메라 주소에서 공간을 생략하면 태그로 공간을 찾는다. 기본 공간에 고정하려면 `?view=ar&space=default`로 연다. 같은 공간에서 모델을 교체할 때는 기존 태그 좌표가 새 모델의 원점·축과 일치하는지 확인한다.

도안은 좌표를 입력하기 전에도 인쇄할 수 있다. 설치할 공간과 번호는 **배치 저장**에 성공했을 때 확정된다. 다른 관리자가 같은 번호를 먼저 저장하면 서버가 해당 공간의 이름을 알려 준다. **AprilTag → 태그 생성**에서 ID를 정한 뒤 **이 태그 인쇄**를 누른다. 기존 태그는 목록의 **인쇄**, 여러 장은 **전체 인쇄**로 연다. 미리보기는 **자동 맞춤**으로 열리며 창 크기와 기기 방향에 맞춰 태그와 흰 여백을 최대 인쇄 기준 100%까지 표시한다. 용지가 화면보다 길면 태그를 중심으로 보여 준다. **인쇄 기준 100%**를 선택하면 작은 화면에서도 스크롤해 원래 배율로 볼 수 있다. 화면상 길이는 브라우저의 기준 단위를 사용하므로 모니터의 실제 픽셀 밀도에 따라 달라질 수 있다. 미리보기에서 **PDF 다운로드**를 누르면 선택한 태그를 PDF 한 파일로 저장한다. 바로 출력하려면 **인쇄**를 누르고 안내된 용지와 실제 크기(100%)를 선택한다. 장당 한 개의 태그가 나오며 검은 테두리 한 변은 공간의 `tagSideM` 길이다. 아래 검산선은 100 mm다.

백엔드는 처음 시작할 때 [기본 배치](backend/src/station.default.json)와 예시 복도 OBJ를 저장한다. 브라우저를 열기 전에도 API에서 태그 4·5·6·3, 3.75 m 경로, 바닥 경계와 모델을 받을 수 있다. 예시 지형은 위의 테스트 코스와 같은 좌표로 만든 도식이다. 이전 설치에서 기본 코스를 그대로 사용 중이면 예시 지형을 추가한다. 이미 수정한 배치는 보존하며, 지형을 등록하지 않은 배치에서는 **예시 지형 불러오기**를 선택할 수 있다.

기본 공간은 `data/station/station.json`, 추가 공간은 `data/station/spaces/<공간 ID>.json`, 모델은 `data/station/models/`에 보관한다. 이전 설치의 `frontend/public/station.json`이 서버에서 접근 가능하면 첫 실행에 해당 배치를 가져온다. 저장 폴더는 `STATION_DIR`로 변경할 수 있다. 서버에 접속할 수 있는 사람은 로그인이나 편집 키 없이 배치를 읽고 저장할 수 있다.

| API | 동작 |
| --- | --- |
| `GET /api/station` | 현재 `tagSideM`, `tags`, `route`, `camera`, 등록된 `terrain`과 응답 헤더 `ETag`를 반환한다. |
| `GET /api/station/rail-stops` | 안내판 판독에 사용하는 역 목록을 `{line, code, name}` 형식으로 반환한다. |
| `GET /api/station/spaces` | 공간의 `id`, 이름과 등록된 `stationLinks`를 반환한다. `line`과 `code` 쿼리를 함께 지정하면 해당 역에 연결된 공간만 조회한다. |
| `POST /api/station/spaces` | 고유한 `terrain.name`을 가진 배치를 새 공간으로 저장하고 `{id, station}`을 반환한다. |
| `GET` · `PUT /api/station/spaces/<id>` | 해당 공간의 배치를 조회·교체한다. 동시 수정은 공간별 `ETag`와 `If-Match`로 확인한다. 태그의 `surface`에는 `heightM`, `right`, `up`을 공간 좌표계(+Z가 높이)로 저장한다. |
| `GET /api/station/layouts` | 태그 인식에 사용하는 공간 ID와 배치 목록을 반환한다. |
| `GET /api/station/example-terrain` | 예시 지형의 이름, 바닥 경계, 모델 참조를 반환한다. |
| `PUT /api/station` | 수정한 배치를 JSON으로 저장한다. `terrain`에는 `name`과 선택 항목인 `outline`, `model`을 담는다. 조회한 `ETag`를 `If-Match`로 보내면 동시 수정 시 412를 반환한다. |
| `POST /api/station/models` | 멀티파트 `file`을 저장하고 지형 또는 태그의 `model`에 지정할 `{file, name}`을 반환한다. |
| `GET /api/station/models/<file>` | 해시 이름으로 지정한 모델의 원본 파일을 제공한다. |

배치의 `stationLinks`에는 역 목록에서 선택한 항목을 배열로 저장한다. 전체 연결을 해제하려면 `[]`를 보낸다. 기존 클라이언트가 이 필드를 생략하고 배치를 수정하면 저장된 연결을 유지한다.

## 아이폰·아이패드 웹 녹화

1. Safari에서 신뢰된 HTTPS 주소를 열고 **AR 카메라**를 선택해 후면 카메라를 허용한다. **기록 시작**을 누른 뒤 모션 접근 요청을 허용한다. PC 한 대에서는 `http://localhost:8080`으로도 시험할 수 있다.
2. 태그와 주변 바닥이 함께 보이도록 천천히 옆으로 이동한다. 같은 표면을 여러 위치에서 촬영하고 화면에서 가속도 샘플 수가 늘어나는지 확인한다. 모션 권한을 거부했거나 센서가 값을 제공하지 않으면 영상은 계속 저장되며 화면에 상태를 표시한다.
3. **기록 종료** 후 전송이 끝나면 **녹화 자료 받기**를 누른다. ZIP 하나에 동영상, 센서 측정값, 태그 배치와 관측 자세가 들어 있다. 녹화 중 인터넷 연결이 끊겨도 기기의 IndexedDB에 저장한 조각은 연결이 복구되면 전송한다. 다른 앱으로 전환하면 녹화를 마친다. 브라우저가 강제 종료된 경우 같은 탭에서 복구한 부분 기록은 마지막 영상 조각이 누락될 수 있다.
4. 실측 LiDAR를 함께 쓸 때는 LiDAR 탑재 기기의 스캔 앱에서 같은 공간을 촬영하고 PLY 또는 USDZ로 내보낸다. 웹의 **스캔 첨부**로 파일을 추가한 후 ZIP을 다시 받는다(첨부당 최대 256 MiB). 두 촬영에 공통으로 보이는 기준점을 남겨야 나중에 좌표계를 맞출 수 있다.

Safari에서 직접 수집하는 공간 관측값은 태그 기반 자세와 RGB 영상이다. iPhone·iPad의 후면 LiDAR 깊이 프레임은 ARKit 앱에서 읽을 수 있다. 홈 화면에 웹앱을 추가해도 Safari의 센서 접근 범위는 같다. [WebKit의 iOS WebXR 지원 설명](https://bugs.webkit.org/show_bug.cgi?id=309550#c2) · [Apple ARKit 깊이 API](https://developer.apple.com/documentation/arkit/ardepthdata)

### Codex에 전달하는 녹화 ZIP

| 파일 | 용도 |
| --- | --- |
| `manifest.json`, `session.json` | 시간 기준, 단위와 좌표축, 실제 녹화 형식과 모션 권한, 촬영 당시 태그 배치·경로·렌즈 보정값 |
| `video.mp4` 또는 `video.webm` | 후면 카메라의 연속 영상. 브라우저 지원 형식 중 MP4를 우선하며 오디오와 화면 조작부는 제외한다. |
| `motion.ndjson` | 센서 이벤트당 한 줄. `tMs`는 녹화 시작 후 경과 밀리초. `acceleration`과 `accelerationIncludingGravity`는 중력 제외·포함 기기축 XYZ 가속도(m/s²), `rotationRate`는 α·β·γ(°/s), `screenAngleDeg`는 화면 회전각이다. 제공되지 않는 벡터는 null이다. |
| `frames/000000/image.jpg`, `frame.json` | 최대 초당 두 장의 키프레임과 촬영 시각, 자세, 태그 ID, 재투영 오차, 카메라 내부 파라미터. 태그를 놓친 프레임은 `pose: null`이다. |
| `finish.json` | 전체 키프레임 수, 영상·센서 조각 수, 정상 종료 또는 중단 여부 |
| `lidar.ply` 또는 `lidar.usdz` | 첨부한 경우에 포함되는 스캔 원본. 외부 앱의 좌표계와 시간 기준을 따른다. |

키프레임의 `recordingTimeMs`와 모션의 `tMs`는 같은 브라우저 시계로 기록한다. 영상 재생 시각은 키프레임의 `mediaTimeS`에서 `session.capture.mediaTimeAtStartS`를 빼서 추정한다. 브라우저의 녹화 시작과 인코더 첫 프레임 사이에 지연이 있을 수 있어, 정밀 정렬에는 ZIP의 JPEG와 영상 프레임을 대조한다.

`cameraToWorld`는 카메라 좌표(오른쪽·아래·렌즈 앞)를 역 좌표(오른쪽·정면·위, m)로 바꾸는 행 우선 4×4 행렬이다. 렌즈 위치는 인덱스 3, 7, 11이다. `intrinsics`는 긴 변 최대 960 px인 JPEG 기준 `[fx, fy, cx, cy]`다. 원본 영상 해상도에 맞게 환산해야 하며 기본 대각 화각 70°에는 기기별 오차가 있다.

서버는 `data/recordings/<세션 UUID>/`에 자료를 보관한다. `GET /api/recordings/<세션 UUID>/capture.zip`은 전송 완료된 조각을 순서대로 묶어 전달한다. 새 녹화는 수집 단계에서 종료되며 3D 복원은 ZIP을 받은 뒤 진행한다. 이전 버전의 사진 전용 세션에는 기존 점군 복원과 다운로드를 제공한다.

## 마이크와 경로 대화

첫 화면의 **경로 대화** 마이크를 누른다. 메시지를 입력하거나 대화창의 마이크로 한국어 음성을 입력한 뒤 전송한다. **현재 위치 사용**을 누르면 기기 위치를 출발점으로 쓸 수 있다. 모호한 장소는 대화로 구체화하고, 제안에 표시된 출발지·도착지·이동 수단을 확인한 뒤 **수락하고 길 안내 시작**을 누른다. 지도는 제안에 포함된 경로로 바로 열린다.

Compose 2.23.1 이상에서 아래 명령으로 시작한다. 최초 한 번 계정에 로그인하면 CLIProxyAPI가 인증 정보를 `cliproxy_auth` 볼륨에 보관한다. 기기 인증은 터미널에 표시된 주소와 코드로 완료한다.

```bash
./scripts/compose-up.sh
docker compose exec cliproxyapi ./CLIProxyAPI -codex-device-login -no-browser
```

| 프로젝트 `.env` 설정 | 용도 |
| --- | --- |
| `CLIPROXY_BASE_URL` | 기본값은 Compose 내부 주소 `http://cliproxyapi:8317/v1`. 별도 프록시를 사용하면 백엔드에서 접근할 수 있는 주소를 지정한다. |
| `CLIPROXY_MODEL` | 기본값은 `gpt-6-luna`. 연결한 계정에서 도구 호출을 지원하는 모델 ID로 변경할 수 있다. |
| `CLIPROXY_API_KEY` | 백엔드와 프록시 사이의 클라이언트 키. 실행 스크립트가 비어 있는 키를 생성한다. 외부 프록시는 해당 서버의 클라이언트 키를 사용한다. |
| `TMAP_APP_KEY` 또는 `KAKAO_REST_API_KEY` | 장소 검색과 도보·대중교통 경로 조회에 사용한다. |

`POST /api/assistant`가 대화 기록과 선택한 지점을 받는다. 모델은 `search_places`로 장소와 주소를 찾고, `search_information`으로 한국어 위키백과에서 역·노선 정보를 찾아 출처를 제공한다. `propose_route`는 검색 결과 또는 사용자가 선택한 지점으로 길찾기 공급자를 호출한다. 지도에서 그릴 수 있는 경로가 있어야 수락 버튼이 나타난다. [CLIProxyAPI 도구 호출 지원](https://help.router-for.me/introduction/what-is-cliproxyapi)

## 장소 검색과 도보·대중교통 길찾기 API

저장소 루트에 `.env`가 없으면 `cp .env.example .env`로 만든다. 사용할 공급자의 키를 채운다.

```dotenv
TMAP_APP_KEY=
KAKAO_REST_API_KEY=
```

- **TMAP**은 SK open API에서 앱을 만든 뒤 같은 앱에 **TMAP** 상품(장소 검색·보행자 경로)과 **TMAP 대중교통** 상품을 신청한다. 앱 키를 `TMAP_APP_KEY`에 넣는다. 대중교통 무료 요금제는 하루 10건이다. [신청 절차](https://transit.tmapmobility.com/guide) · [일반 TMAP 상품](https://openapi.sk.com/products/detail?linkMenuSeq=27) · [대중교통 요금](https://transit.tmapmobility.com/)
- **카카오맵**은 카카오디벨로퍼스에서 **카카오맵 → 사용 설정 → 상태**를 **ON**으로 바꾼 뒤 REST API 키를 `KAKAO_REST_API_KEY`에 넣는다. [카카오맵 사용 설정](https://developers.kakao.com/docs/ko/kakaomap/common)

서버는 시작할 때 공급자를 선택한다. 두 키를 모두 채우면 TMAP을 사용한다. 카카오맵을 사용하려면 `TMAP_APP_KEY`를 비우고 재시작한다. 셸에서 설정한 값은 각 키의 `.env` 값보다 우선한다. 키는 백엔드에서만 사용한다.

로컬에서는 `./scripts/start.sh`, Docker에서는 `./scripts/compose-up.sh`를 실행한다. 키를 변경한 뒤 같은 명령으로 다시 실행한다. 앱에서 출발지와 도착지를 검색해 선택하고, **대중교통**과 **도보**를 각각 선택해 **길 안내 시작**을 누른다. 지도에서 경로와 단계별 안내, 하단의 공급자 이름을 확인한다.

| 요청 | 성공 응답에서 사용할 경로 데이터 |
| --- | --- |
| `GET /api/directions/places?q=장소명` | 장소명, 주소, WGS84 좌표. 선택한 결과가 길찾기의 출발지 또는 도착지가 된다. |
| `GET /api/directions/walk` | `route.properties`의 총거리(m)·소요 시간(초), `route.legs[].steps[]`의 도보 안내와 경로 좌표 |
| `GET /api/directions/transit` | `routes[]`의 후보별 거리·소요 시간·환승 횟수·요금, `steps[]`의 이동 수단·정류장·경로 좌표 |

도보·대중교통 요청은 WGS84 좌표 네 개를 쿼리로 받는다. `start_x`, `end_x`는 출발·도착지의 경도이고 `start_y`, `end_y`는 위도다. 아래 주소에서 `walk`를 `transit`으로 바꾸면 같은 구간의 대중교통 경로를 조회한다.

```bash
curl 'http://localhost:8080/api/directions/walk?start_x=127.11119217&start_y=37.39477123&end_x=127.12628814&end_y=37.41993056'
```

경로 응답의 `provider`는 `tmap` 또는 `kakao`다. `status`가 `OK`일 때 각 단계의 `path.points`를 `[경도, 위도]` 순서로 읽는다. 공급자가 경로를 찾지 못하면 HTTP 200과 탐색 상태(`NO_RESULTS` 등)를 반환한다. 잘못된 입력은 400, 호출 한도 초과는 429, 키 누락이나 권한 오류는 503, 공급자 통신·응답 오류는 502, 시간 초과는 504다. [TMAP 대중교통 명세](https://transit.tmapmobility.com/docs/routes) · [카카오맵 REST API 명세](https://developers.kakao.com/docs/ko/kakaomap/rest-api)

### 테스트용 영구 파일 캐시

`.env`에 `DIRECTIONS_TEST_CACHE=1`을 설정하면 장소 검색·도보·대중교통의 HTTP 200 응답을 `data/directions-cache/`에 JSON으로 저장한다. 로컬과 Compose에서 같은 호스트 경로를 사용한다. 경로를 바꾸려면 실행 명령 앞에 `DIRECTIONS_CACHE_DIR=경로`를 붙인다. 공급자와 검색어 또는 출발·도착 좌표가 같으면 재시작 후에도 만료 없이 파일을 재사용한다. 빈 검색 결과와 경로 없음도 같은 방식으로 재현된다. 새 응답이 필요하면 해당 JSON 파일을 지운다. 운영에서는 기본값인 `DIRECTIONS_TEST_CACHE=0`을 사용한다.

영구 캐시에는 모의 응답이나 별도로 저장·재사용 권한을 확보한 데이터를 사용한다. TMAP 약관은 저장 후 24시간 이상 사용을 제한하고, 카카오맵은 대중교통 응답의 캐싱과 장소 검색 결과의 저장을 제한한다. [TMAP 약관](https://tmapapi.tmapmobility.com/terms.html) · [TMAP 대중교통 약관](https://transit.tmapmobility.com/terms) · [카카오맵 대중교통 응답 안내](https://devtalk.kakao.com/t/api-api/151980) · [카카오맵 장소 검색 응답 안내](https://devtalk.kakao.com/t/api-db/152427)

## Docker Compose로 HTTPS 실행

`home.soohyuk.dev`가 가리키는 호스트에서 TCP 80과 443을 Docker에 할당하고 외부에서 접근할 수 있게 한다. 공유기 뒤에 있다면 두 포트를 호스트로 전달한다. 호스트의 Nginx 등에서 이미 포트를 사용 중이면 Compose를 시작하기 전에 두 포트를 비운다. [Caddy 자동 HTTPS](https://caddyserver.com/docs/automatic-https)

호스트에서 저장소 루트로 이동해 실행한다.

```bash
./scripts/compose-up.sh
```

Caddy가 `home.soohyuk.dev` 인증서를 발급하고 갱신하며 HTTP 요청을 HTTPS로 보낸다. 최초 발급은 컨테이너가 시작된 뒤 진행된다. `docker compose logs -f caddy`에서 확인하고 휴대폰으로 [https://home.soohyuk.dev](https://home.soohyuk.dev)를 연다. `docker compose down`으로 종료해도 인증서는 `caddy_data` 볼륨에 보관된다. [Caddy Docker 이미지](https://hub.docker.com/_/caddy)


기록은 호스트의 `./data/recordings`, 태그 배치와 모델은 `./data/station`에 읽기·쓰기 바인드 마운트하므로 컨테이너를 다시 만들어도 남는다. 저장 위치는 `RECORDINGS_DIR`과 `STATION_DIR`로 바꿀 수 있다. 래퍼가 두 폴더를 준비하고 현재 사용자의 UID/GID로 백엔드를 실행한다. 백엔드 TypeScript 수정은 `docker compose restart backend`로 반영한다.

이전 Compose 구성에서 업데이트할 때도 `./scripts/compose-up.sh`를 실행한다. 이 명령은 `backend` 서비스를 시작하고 기존 `collector` 컨테이너를 정리한다.

호스트에서 직접 확인할 때는 `http://localhost:8080`을 연다. `APP_PORT`는 이 로컬 HTTP 포트를 바꾼다.

## Compose 없이 실행

Bash와 Node.js 24.15 이상(npm 포함)이 있는 PC에서 저장소 루트의 스크립트를 실행한다. 첫 실행 시 의존성을 설치한다. 스크립트 하나가 Vite(0.0.0.0:8080)와 NestJS(127.0.0.1:8081)를 함께 시작하고 종료한다. 브라우저는 같은 주소의 `/api/recordings`를 사용한다.

```bash
./scripts/start.sh
```

저장 경로는 Compose와 같이 `data/recordings`이며 `RECORDINGS_DIR`로 바꿀 수 있다. API 포트는 `API_PORT`로 지정한다. PC에서는 `http://localhost:8080`을 연다. 같은 네트워크에서는 터미널의 `Network` 주소로 페이지에 접속할 수 있다. 포트를 바꾸려면 `APP_PORT=8090 ./scripts/start.sh`로 실행한다. 종료는 `Ctrl+C`다.

### 스마트폰에서 카메라 사용

모바일 브라우저는 일반 LAN IP의 HTTP 페이지에서 카메라 접근을 제한한다. Android에서는 USB 포트 전달로 휴대폰의 `localhost`에서 카메라를 쓸 수 있다. PC에 Android SDK Platform Tools를 설치하고, 휴대폰의 USB 디버깅을 켜고 PC 연결을 허용한 뒤 **두 번째 터미널**에서 실행한다. [보안 컨텍스트 명세](https://www.w3.org/TR/secure-contexts/#is-origin-trustworthy) · [Android ADB 포트 전달](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/docs/user/adb.1.md#networking)

```bash
adb reverse tcp:8080 tcp:8080
```

휴대폰의 Chrome에서 `http://localhost:8080`을 열고 카메라를 허용한다. PC 서버 포트를 변경했다면 명령의 두 번째 포트를 그 값으로 바꾼다.

기본 후면 렌즈를 태그와 그 앞의 바닥이 함께 보이게 기울인다. 출발점에서 정면 화살표, 코너에 접근하면 오른쪽 화살표를 확인한다. 다음 화살표가 화면 밖이어도 인식한 태그의 테두리와 ID, 위치를 확인한 태그의 모델은 보인다. 태그를 놓치면 표시를 지운다. 카메라 권한을 거부했다면 브라우저 사이트 설정에서 허용하고 **다시 연결**을 누른다. [합성 시험 영상에서의 직진·우회전 화살표](experiments/corridor/images/ar-camera.png)

### npm 개발 명령

프런트엔드 개발 명령만 사용할 때는 별도 터미널에서 저장소 루트의 `./scripts/collector.sh`로 수집 서버를 띄운다. 개발 서버(`npm run dev`, 기본 5173)와 빌드 미리보기(`npm run build` 후 `npm run preview`, 기본 4173)도 `0.0.0.0`에서 수신한다.

```bash
cd frontend
npm ci
npm test
npm run dev
```

## 호스트 Nginx와 Certbot으로 HTTPS 실행

호스트 Nginx로 직접 배포하는 경우에는 이 절차를 사용한다. Compose의 Caddy와 호스트 Nginx 중 TCP 80과 443을 사용할 서비스를 하나 선택한다. `home.soohyuk.dev`의 원본 호스트에서 실행한다. Ubuntu와 같은 systemd 환경에서 Bash, Node.js 24.15 이상(npm 포함), Nginx, Certbot의 Nginx 플러그인, `sudo` 권한이 필요하다. Ubuntu에서는 다음과 같이 설치한다.

```bash
sudo apt update
sudo apt install nginx certbot python3-certbot-nginx
```

도메인이 이 호스트를 가리키고 외부에서 TCP 80과 443으로 접근할 수 있어야 한다. 공유기 뒤의 호스트라면 두 포트를 전달한다. Cloudflare 프록시를 사용하는 경우 `http://home.soohyuk.dev/.well-known/acme-challenge/...` 요청이 최초 발급과 갱신 때 원본의 80번 포트에 도달해야 한다. 강제 HTTPS 규칙이 발급을 막으면 해당 경로를 규칙에서 제외한다. 인증서를 설치한 뒤 Cloudflare TLS 설정에는 Full (strict)를 사용한다. [Let's Encrypt HTTP-01](https://letsencrypt.org/docs/challenge-types/#http-01-challenge) · [Cloudflare Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)

```bash
./scripts/certbot-up.sh YOUR_CERTBOT_EMAIL
```

스크립트는 프런트엔드를 빌드해 `/var/www/2026-hackathon-2`에 배포하고, Nginx에 도메인을 등록한 다음 Certbot으로 인증서와 HTTPS 리다이렉트를 설정한다. 같은 명령으로 새 빌드를 배포할 수 있다. 호스트에 같은 도메인의 Nginx 설정이 이미 있다면 그 설정에 이 앱의 정적 파일 경로를 반영하고 Certbot을 적용한다.

이 호스트 방식에서는 별도 터미널이나 서비스로 `API_HOST=127.0.0.1 ./scripts/collector.sh`를 실행한다. Nginx는 `/api/` 요청을 루프백 8081번의 NestJS로 전달한다.

발급 후 휴대폰에서 `https://home.soohyuk.dev`를 열고 카메라를 허용한다. Ubuntu 패키지의 갱신 타이머와 이 인증서의 갱신 경로는 다음 명령으로 확인한다.

```bash
systemctl status certbot.timer
sudo certbot renew --cert-name 2026-hackathon-2-home.soohyuk.dev --dry-run
```

## 위치와 화살표 계산

- 워커가 OpenCV.js로 `tag36h11`의 ID와 네 꼭짓점을 검출한다. 지도에 등록된 태그의 3D 좌표로 PnP를 풀고 카메라 중심을 m 단위로 구한다. 여러 태그가 보이면 RANSAC 합의를 확인한다. 너무 작은 태그나 재투영 RMS가 2.5 px를 넘는 결과는 버린다. [OpenCV PnP](https://docs.opencv.org/4.12.0/d5/d1f/calib3d_solvePnP.html)
- 위치를 경로에 투영해 앞쪽에 있는 고정 화살표를 고른다. 기본 설정에서는 같은 평면에 놓인 태그로 바닥과 영상 사이의 호모그래피를 구해 화살표 꼭짓점을 그린다. 추적이 끊긴 프레임에서는 즉시 지우며, 새 결과가 멎어도 마지막 프레임 시각에서 350 ms 후 지운다. [OpenCV 평면 호모그래피](https://docs.opencv.org/4.12.0/d9/dab/tutorial_homography.html)
- 기본 대각 화각 70°는 기기 보정 전의 가정이므로 카메라 위치 수치와 화살표 선택 시점에는 기기별 오차가 있다. 브라우저가 저장한 실험 기록은 연결이 복구되면 전송을 이어간다.

**역 안 AR 안내**와 **AR 카메라**의 미니맵은 등록된 태그로 **내 위치**와 방향을 보정한다. **동작 센서 켜기**가 보이면 눌러 권한을 허용한다. 태그를 벗어나도 같은 바닥 무늬를 계속 확인할 수 있으면 가속도와 함께 **추정 위치**를 갱신한다. 바닥까지 놓치면 중력축 가속도로 걸음 주기를 찾고, 각 주기의 앞부분과 뒷부분에서 휴대폰 앞뒤로 가해진 수평 가속도를 비교한다. 연속된 걸음에서 방향이 확인되면 앞으로 걸을 때는 카메라가 향한 쪽으로, 뒷걸음칠 때는 그 반대쪽으로 위치를 갱신한다. 미니맵 화살표는 카메라가 향한 방향을 표시한다. 방향을 구분할 신호가 계속 부족하면 걸음에 따른 위치 갱신을 멈춘다. 한 걸음은 60cm로 시작하며, 직선 보행 후 태그로 확인한 이동 거리를 이용해 보정한다. 등록된 실내 경로의 1m 이내에서 폰의 방향과 경로가 20° 이내로 일치하면 해당 통로의 정방향 또는 역방향을 따른다. 걸음이 확인되지 않는 동안은 영상 기준 최대 1초, 반경 75cm까지만 가속도를 적분한다. 걸음이 멎거나 센서 입력이 끊기면 **마지막 위치**를 표시한다. 잠깐 가려졌던 바닥 무늬가 다시 일치하면 추적을 이어 간다. 등록된 태그를 다시 비추면 절대 위치를 갱신한다. 연속으로 보이는 태그의 좌표가 보행 속도로 설명하기 어려울 만큼 튀면 다음 관측으로 확인한다.

위치 보정은 AR 카메라를 열면 시작된다. 녹화 중에도 다른 공간의 태그를 인식하면 미니맵이 그 공간의 좌표로 갱신된다. 녹화 파일은 시작 공간의 좌표계를 사용하므로 다른 공간을 촬영한 키프레임은 `pose: null`로 저장된다.

## 현장 확인

1. 출발점 (0, 0)과 코너 (0, 2)에서 후면 렌즈를 바닥 표식 수직 위에 들고, 각각 세 번 멈춘다. 원격 브라우저 개발자도구에서 아래 코드를 실행해 태그 ID와 위치를 읽을 수 있다. 위치의 앞 두 성분을 줄자로 잰 X·Y와 비교한다.
2. 폰을 기울였을 때 화살표가 같은 바닥 지점을 가리키는지 확인한다. 알려진 태그를 모두 가렸다가 다시 비춰 화살표 소실과 재등장을 확인한다. 도착점에 서면 화살표가 사라진다.

```js
window.addEventListener('station-pose', ({ detail }) => console.log(detail));
```

검출 결과는 `spaceId`, 해당 공간 기준 `positionM` (X, Y, 바닥 위 높이), `tagIds`, `reprojectionPx`, `frameTimeMs`를 담는다. 추적 소실 이벤트의 값은 `null`이다. 재투영 오차 단위는 px이며, 현장 수평 위치 오차는 바닥 표식과의 거리로 확인한다.

### 특정 스마트폰을 보정할 때

PDF 5쪽의 보정판을 평평하게 붙인다. 실험에 쓸 후면 **영상 스트림**에서 줌, 해상도 비율, 화면 방향을 고정하고 보정판이 전부 보이는 프레임 15장 이상을 저장한다. 중앙과 네 모서리에서 거리와 기울기를 바꾼다. 영상 프레임은 원격 개발자도구에서 `document.querySelector('video')`를 원래 `videoWidth × videoHeight` 크기로 캔버스에 복사해 얻을 수 있다.

```bash
uv run experiments/corridor/calibrate.py /path/to/frames/*.jpg
```

출력한 JSON을 현재 배치의 `camera.calibration`에 넣고 `PUT /api/station`으로 저장한 뒤 카메라 페이지를 다시 연다. 위치와 화살표, 3D 모델이 실측 초점거리, 주점, 왜곡 계수를 사용한다. 실험 영상과 보정 영상의 방향이나 종횡비가 달라지면 같은 조건으로 다시 보정한다. [OpenCV 카메라 보정](https://docs.opencv.org/4.12.0/d4/d94/tutorial_camera_calibration.html)
