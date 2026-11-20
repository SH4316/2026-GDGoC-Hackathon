# 지하철 환승 통로 AR PoC

스마트폰에서 주소를 열고 브라우저의 카메라 권한을 허용하면 후면 영상이 바로 열린다. 등록된 AprilTag가 보이면 스마트폰의 위치를 통로 좌표계에서 추정하고, 진행할 방향을 바닥 화살표 하나로 표시한다. 영상 처리와 위치 계산은 스마트폰 안에서 실행한다.

## 바닥에 놓을 것

준비물은 스마트폰, A4 출력물, 줄자, 종이를 평평하게 고정할 테이프다. 평평한 바닥에서 출발점과 코너를 정하면 된다. 기본 코스는 **직진 2.00 m 후 오른쪽으로 1.75 m**다.

![출발점, 코너, 도착점과 네 태그의 중심 좌표 및 인쇄물 방향](experiments/corridor/images/floor-layout.png)

1. [태그·보정판 PDF](experiments/corridor/field-kit.pdf)에서 1~4쪽을 A4 **실제 크기 100%**로 인쇄한다. 검은 정사각형의 한 변은 160 mm, 아래 검산선은 100 mm다. 흰 여백을 보존한다.
2. 바닥 출발점을 원점으로 잡는다. 출발할 때 정면을 +Y, 오른쪽을 +X로 두고 아래 위치에 **검은 정사각형의 중심**을 맞춘다. 종이의 ‘UP’ 쪽을 표의 방향으로 놓는다.
3. 바닥에 코너 (0, 2)와 도착점 (1.75, 2)를 표시한다. 다른 통로에 맞출 때는 실측한 태그 중심, 방향, 경로 꼭짓점을 [배치 파일](frontend/public/station.json)에 입력한다. 단위는 m이며 태그 회전은 +Y에서 시계 방향이다.

| 태그 ID | X (m) | Y (m) | 인쇄물 위쪽 |
| --- | ---: | ---: | --- |
| 0 | −0.25 | 0 | 정면 (+Y) |
| 1 | +0.25 | 1 | 정면 (+Y) |
| 2 | −0.25 | 2 | 정면 (+Y) |
| 3 | 1 | 2.25 | 오른쪽 (+X) |

A4 인쇄용 PNG는 300 dpi다. [태그 0](experiments/corridor/images/tag-0.png) · [태그 1](experiments/corridor/images/tag-1.png) · [태그 2](experiments/corridor/images/tag-2.png) · [태그 3](experiments/corridor/images/tag-3.png) · [보정판](experiments/corridor/images/calibration-board.png)

## HTTP로 실행

### Docker Compose

Docker Engine과 Docker Compose가 실행 가능한 PC에서 저장소 루트의 스크립트를 실행한다.

```bash
./scripts/compose-up.sh
```

스크립트는 `docker compose up --build --wait --remove-orphans`를 실행한다. 프런트엔드를 빌드하고 Nginx가 `station.json`을 제공할 때까지 기다린다. 같은 Compose 프로젝트에서 이전 tunnel처럼 현재 설정에서 빠진 서비스의 컨테이너를 정리한다.

PC에서는 `http://localhost:8080`, 같은 네트워크의 다른 기기에서는 `http://<PC의 IP>:8080`을 연다. 포트를 바꾸려면 `APP_PORT=8090 ./scripts/compose-up.sh`로 실행한다. 종료는 `docker compose down`이다.

### Vite 개발 서버

Bash와 Node.js 24.15 이상(npm 포함)이 있는 PC에서 저장소 루트의 스크립트를 실행한다. 첫 실행 시 의존성을 설치하고 Vite를 `0.0.0.0:8080`에서 시작한다.

```bash
./scripts/start.sh
```

PC에서는 `http://localhost:8080`을 연다. 같은 네트워크에서는 터미널의 `Network` 주소로 페이지에 접속할 수 있다. 포트를 바꾸려면 `APP_PORT=8090 ./scripts/start.sh`로 실행한다. 종료는 `Ctrl+C`다.

### 스마트폰에서 카메라 사용

모바일 브라우저는 일반 LAN IP의 HTTP 페이지에서 카메라 접근을 제한한다. Android에서는 USB 포트 전달로 휴대폰의 `localhost`에서 카메라를 쓸 수 있다. PC에 Android SDK Platform Tools를 설치하고, 휴대폰의 USB 디버깅을 켜고 PC 연결을 허용한 뒤 **두 번째 터미널**에서 실행한다. [보안 컨텍스트 명세](https://www.w3.org/TR/secure-contexts/#is-origin-trustworthy) · [Android ADB 포트 전달](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/docs/user/adb.1.md#networking)

```bash
adb reverse tcp:8080 tcp:8080
```

휴대폰의 Chrome에서 `http://localhost:8080`을 열고 카메라를 허용한다. PC 서버 포트를 변경했다면 명령의 두 번째 포트를 그 값으로 바꾼다.

기본 후면 렌즈를 태그와 그 앞의 바닥이 함께 보이게 기울인다. 출발점에서 정면 화살표, 코너에 접근하면 오른쪽 화살표를 확인한다. 화살표를 그릴 바닥 위치가 화면 밖에 있거나 태그를 놓치면 영상만 보인다. 카메라 권한을 거부했다면 브라우저 사이트 설정에서 허용하고 화면을 한 번 누르거나 새로고침한다. [합성 시험 영상으로 캡처한 직진·우회전 AR 화면](experiments/corridor/images/ar-camera.png)

### 고정 도메인에서 Certbot으로 HTTPS 실행

`home.soohyuk.dev`의 원본 호스트에서 실행한다. Ubuntu와 같은 systemd 환경에서 Bash, Node.js 24.15 이상(npm 포함), Nginx, Certbot의 Nginx 플러그인, `sudo` 권한이 필요하다. Ubuntu에서는 다음과 같이 설치한다.

```bash
sudo apt update
sudo apt install nginx certbot python3-certbot-nginx
```

도메인이 이 호스트를 가리키고 외부에서 TCP 80과 443으로 접근할 수 있어야 한다. 공유기 뒤의 호스트라면 두 포트를 전달한다. Cloudflare 프록시를 사용하는 경우 `http://home.soohyuk.dev/.well-known/acme-challenge/...` 요청이 최초 발급과 갱신 때 원본의 80번 포트에 도달해야 한다. 강제 HTTPS 규칙이 발급을 막으면 해당 경로를 규칙에서 제외한다. 인증서를 설치한 뒤 Cloudflare TLS 설정에는 Full (strict)를 사용한다. [Let's Encrypt HTTP-01](https://letsencrypt.org/docs/challenge-types/#http-01-challenge) · [Cloudflare Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)

```bash
./scripts/certbot-up.sh YOUR_CERTBOT_EMAIL
```

스크립트는 프런트엔드를 빌드해 `/var/www/2026-hackathon-2`에 배포하고, Nginx에 도메인을 등록한 다음 Certbot으로 인증서와 HTTPS 리다이렉트를 설정한다. 같은 명령으로 새 빌드를 배포할 수 있다. 호스트에 같은 도메인의 Nginx 설정이 이미 있다면 그 설정에 이 앱의 정적 파일 경로를 반영하고 Certbot을 적용한다.

발급 후 휴대폰에서 `https://home.soohyuk.dev`를 열고 카메라를 허용한다. Ubuntu 패키지의 갱신 타이머와 이 인증서의 갱신 경로는 다음 명령으로 확인한다.

```bash
systemctl status certbot.timer
sudo certbot renew --cert-name 2026-hackathon-2-home.soohyuk.dev --dry-run
```

### npm 개발 명령

개발 서버(`npm run dev`, 기본 5173)와 빌드 미리보기(`npm run build` 후 `npm run preview`, 기본 4173)도 `0.0.0.0`에서 수신한다.

```bash
cd frontend
npm ci
npm test
npm run dev
```

## 위치와 화살표 계산

- 워커가 OpenCV.js로 `tag36h11`의 ID와 네 꼭짓점을 검출한다. 지도에 등록된 태그의 3D 좌표로 PnP를 풀고 카메라 중심을 m 단위로 구한다. 여러 태그가 보이면 RANSAC 합의를 확인한다. 너무 작은 태그나 재투영 RMS가 2.5 px를 넘는 결과는 버린다. [OpenCV PnP](https://docs.opencv.org/4.12.0/d5/d1f/calib3d_solvePnP.html)
- 위치를 경로에 투영해 앞쪽에 있는 고정 화살표를 고른다. 기본 설정에서는 같은 평면에 놓인 태그로 바닥과 영상 사이의 호모그래피를 구해 화살표 꼭짓점을 그린다. 추적이 끊긴 프레임에서는 즉시 지우며, 새 결과가 멎어도 마지막 프레임 시각에서 350 ms 후 지운다. [OpenCV 평면 호모그래피](https://docs.opencv.org/4.12.0/d9/dab/tutorial_homography.html)
- 기본 대각 화각 70°는 기기 보정 전의 가정이므로 카메라 위치 수치와 화살표 선택 시점에는 기기별 오차가 있다. 빌드는 카메라와 정적 파일만 사용한다.

## 현장 확인

1. 출발점 (0, 0)과 코너 (0, 2)에서 후면 렌즈를 바닥 표식 수직 위에 들고, 각각 세 번 멈춘다. 원격 브라우저 개발자도구에서 아래 코드를 실행해 태그 ID와 위치를 읽을 수 있다. 위치의 앞 두 성분을 줄자로 잰 X·Y와 비교한다.
2. 폰을 기울였을 때 화살표가 같은 바닥 지점을 가리키는지 확인한다. 알려진 태그를 모두 가렸다가 다시 비춰 화살표 소실과 재등장을 확인한다. 도착점에 서면 화살표가 사라진다.

```js
window.addEventListener('station-pose', ({ detail }) => console.log(detail));
```

검출 결과는 `positionM` (X, Y, 바닥 위 높이), `tagIds`, `reprojectionPx`, `frameTimeMs`를 담는다. 추적 소실 이벤트의 값은 `null`이다. 재투영 오차 단위는 px이며, 현장 수평 위치 오차는 바닥 표식과의 거리로 확인한다.

### 특정 스마트폰을 보정할 때

PDF 5쪽의 보정판을 평평하게 붙인다. 실험에 쓸 후면 **영상 스트림**에서 줌, 해상도 비율, 화면 방향을 고정하고 보정판이 전부 보이는 프레임 15장 이상을 저장한다. 중앙과 네 모서리에서 거리와 기울기를 바꾼다. 영상 프레임은 원격 개발자도구에서 `document.querySelector('video')`를 원래 `videoWidth × videoHeight` 크기로 캔버스에 복사해 얻을 수 있다.

```bash
uv run experiments/corridor/calibrate.py /path/to/frames/*.jpg
```

출력한 JSON을 배치 파일의 `camera.calibration`에 넣고 다시 빌드한다. 보정 후에는 위치와 화살표 모두 실측 초점거리, 주점, 왜곡 계수를 사용한다. 실험 영상과 보정 영상의 방향이나 종횡비가 달라지면 같은 조건으로 다시 보정한다. [OpenCV 카메라 보정](https://docs.opencv.org/4.12.0/d4/d94/tutorial_camera_calibration.html)
