#!/usr/bin/env python3
"""이리로 개발용 서버.

  python3 serve.py              (포트를 바꾸려면: python3 serve.py 8010 8453)

- 노트북에서 볼 때:  http://localhost:8000
- 폰에서 볼 때:      https://<노트북 IP>:8443  (같은 와이파이 또는 폰 핫스팟에 연결)

폰 브라우저는 https 가 아니면 카메라와 동작 센서를 쓰지 못하게 막는다. 그래서 임시 인증서를
만들어 https 로도 연다. 임시 인증서라 폰에서 "안전하지 않음" 경고가 뜨는데,
"고급 > 계속 진행"(사파리는 "세부사항 보기 > 이 웹사이트 방문")을 누르면 된다.

지도 편집기(editor.html)가 만든 지도를 maps/ 폴더에 저장하는 기능도 여기에 있다.
저장은 이 노트북의 브라우저에서 보낸 요청만 받는다.

폰에서 ?debug=1 또는 ?slam=1 로 열면, 앱이 상태와 오류를 이 서버에 보내 diag/client.log 에 남긴다
(폰에서는 오류 내용을 보기 어렵기 때문). 이 서버가 내보낸 페이지에서 보낸 짧은 기록만 받는다.
"""

import datetime
import http.server
import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading

ROOT = os.path.dirname(os.path.abspath(__file__))
CERT_DIR = os.path.join(ROOT, ".cert")
MAPS_DIR = os.path.join(ROOT, "maps")
HTTP_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
HTTPS_PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8443
MAP_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,40}$")
MAX_MAP_BYTES = 2_000_000
MAX_IMAGE_BYTES = 25_000_000
DIAG_DIR = os.path.join(ROOT, "diag")
DIAG_LOG = os.path.join(DIAG_DIR, "client.log")
MAX_LOG_LINE_BYTES = 16_000
MAX_LOG_BYTES = 2_000_000
log_lock = threading.Lock()


def lan_ip():
    """다른 기기에서 이 노트북에 접속할 때 쓰는 IP"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # 실제로 패킷을 보내지는 않는다
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert(ip):
    """IP가 바뀌면 인증서를 다시 만든다"""
    os.makedirs(CERT_DIR, exist_ok=True)
    cert = os.path.join(CERT_DIR, "cert.pem")
    key = os.path.join(CERT_DIR, "key.pem")
    stamp = os.path.join(CERT_DIR, "ip.txt")
    if os.path.exists(cert) and os.path.exists(key) and os.path.exists(stamp):
        with open(stamp) as f:
            if f.read().strip() == ip:
                return cert, key
    conf = (
        "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n"
        "[dn]\nCN=iriro-dev\n"
        f"[v3]\nsubjectAltName=DNS:localhost,IP:127.0.0.1,IP:{ip}\n"
    )
    with tempfile.NamedTemporaryFile("w", suffix=".cnf", delete=False) as f:
        f.write(conf)
        conf_path = f.name
    try:
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30",
             "-keyout", key, "-out", cert, "-config", conf_path],
            check=True, capture_output=True,
        )
    finally:
        os.unlink(conf_path)
    with open(stamp, "w") as f:
        f.write(ip)
    return cert, key


def list_maps():
    """maps/ 폴더의 지도 목록: [{ id, name }]"""
    out = []
    for fn in sorted(os.listdir(MAPS_DIR)):
        if not fn.endswith(".json"):
            continue
        map_id = fn[:-5]
        name = ""
        try:
            with open(os.path.join(MAPS_DIR, fn), encoding="utf-8") as f:
                data = json.load(f)
            names = data.get("name") or {}
            name = names.get("ko") or names.get("en") or ""
        except (OSError, ValueError):
            pass
        out.append({"id": map_id, "name": name})
    return out


def save_map(map_id, data):
    """지도를 maps/<id>.json 으로 저장한다. 같은 이름이 있으면 이전 것을 maps/.backup/ 에 남긴다."""
    path = os.path.join(MAPS_DIR, map_id + ".json")
    backup = None
    if os.path.exists(path):
        # 내용이 그대로면 다시 쓰지 않는다 (저장을 여러 번 눌러도 백업이 쌓이지 않게)
        try:
            with open(path, encoding="utf-8") as f:
                if json.load(f) == data:
                    return None
        except (OSError, ValueError):
            pass
        backup_dir = os.path.join(MAPS_DIR, ".backup")
        os.makedirs(backup_dir, exist_ok=True)
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = os.path.join(backup_dir, f"{map_id}-{stamp}.json")
        shutil.copy2(path, backup)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    return backup


def append_client_log(entry):
    """폰에서 온 기록 한 줄을 diag/client.log 에 덧붙인다. 너무 커지면 이전 것을 client.log.1 로 넘긴다."""
    line = json.dumps(entry, ensure_ascii=False) + "\n"
    with log_lock:
        os.makedirs(DIAG_DIR, exist_ok=True)
        if os.path.exists(DIAG_LOG) and os.path.getsize(DIAG_LOG) > MAX_LOG_BYTES:
            os.replace(DIAG_LOG, DIAG_LOG + ".1")
        with open(DIAG_LOG, "a", encoding="utf-8") as f:
            f.write(line)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/serverinfo.json":
            # 테스트 화면과 편집기가 "폰에서 열 주소"를 만들 수 있게 이 노트북의 IP를 알려 준다
            self._json(200, {"ip": lan_ip(), "httpPort": HTTP_PORT, "httpsPort": HTTPS_PORT})
            return
        if path == "/maps/index.json":
            self._json(200, list_maps())
            return
        super().do_GET()

    def _client_log(self):
        """폰의 앱이 보낸 진단 기록. 이 서버가 내보낸 페이지에서 보낸 것만, 짧은 JSON만 받는다."""
        ip = lan_ip()
        allowed = {f"http://localhost:{HTTP_PORT}", f"http://127.0.0.1:{HTTP_PORT}"}
        allowed |= {f"https://{h}:{HTTPS_PORT}" for h in (ip, "localhost", "127.0.0.1")}
        origin = self.headers.get("Origin")
        if origin not in allowed:
            self._json(403, {"error": "forbidden"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_LOG_LINE_BYTES:
            self._json(400, {"error": "too large"})
            return
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._json(400, {"error": "not json"})
            return
        if not isinstance(data, dict):
            self._json(400, {"error": "not an object"})
            return
        entry = {"time": datetime.datetime.now().strftime("%H:%M:%S"), "from": self.client_address[0]}
        entry.update(data)
        try:
            append_client_log(entry)
        except OSError:
            self._json(500, {"error": "cannot write"})
            return
        self._json(200, {"ok": True})

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/client-log":
            self._client_log()
            return
        if path not in ("/save-map", "/save-floorplan"):
            self._json(404, {"error": "not found"})
            return
        # 이 노트북의 편집기에서 보낸 요청만 받는다 (같은 와이파이의 다른 기기나 다른 웹사이트는 거절)
        origin = self.headers.get("Origin")
        allowed = {f"http://localhost:{HTTP_PORT}", f"http://127.0.0.1:{HTTP_PORT}"}
        if self.client_address[0] not in ("127.0.0.1", "::1") or (origin and origin not in allowed):
            self._json(403, {"error": "지도 저장은 이 노트북에서 http://localhost 로 연 편집기에서만 할 수 있어요"})
            return
        m = re.search(r"[?&]id=([^&]+)", self.path)
        map_id = m.group(1) if m else ""
        if not MAP_ID.match(map_id):
            self._json(400, {"error": "지도 이름은 영어 소문자, 숫자, -, _ 만 쓸 수 있어요"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        limit = MAX_IMAGE_BYTES if path == "/save-floorplan" else MAX_MAP_BYTES
        if length <= 0 or length > limit:
            self._json(400, {"error": "보낸 데이터가 비었거나 너무 커요"})
            return
        body = self.rfile.read(length)
        if path == "/save-floorplan":
            # 지도의 배경 평면도 그림 (PNG)
            if not body.startswith(b"\x89PNG\r\n\x1a\n"):
                self._json(400, {"error": "PNG 그림이 아니에요"})
                return
            target = os.path.join(MAPS_DIR, map_id + ".png")
            try:
                with open(target + ".tmp", "wb") as f:
                    f.write(body)
                os.replace(target + ".tmp", target)
            except OSError as e:
                self._json(500, {"error": f"저장하지 못했어요: {e}"})
                return
            self._json(200, {"ok": True, "file": f"maps/{map_id}.png"})
            return
        try:
            data = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._json(400, {"error": "지도 데이터를 읽을 수 없어요"})
            return
        if not isinstance(data, dict) or not isinstance(data.get("nodes"), dict):
            self._json(400, {"error": "지도 형식이 아니에요"})
            return
        data["id"] = map_id
        try:
            backup = save_map(map_id, data)
        except OSError as e:
            self._json(500, {"error": f"저장하지 못했어요: {e}"})
            return
        self._json(200, {"ok": True, "file": f"maps/{map_id}.json",
                         "backup": os.path.relpath(backup, ROOT) if backup else None})

    def end_headers(self):
        # 고친 코드가 폰에 바로 반영되도록 캐시를 끈다
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # 요청마다 찍히는 로그는 생략


def main():
    ip = lan_ip()
    try:
        plain = http.server.ThreadingHTTPServer(("127.0.0.1", HTTP_PORT), Handler)
    except OSError:
        print(f"{HTTP_PORT}번 포트를 이미 쓰고 있어요. 다른 창에 serve.py가 켜져 있는지 확인하거나,")
        print(f"포트를 바꿔 실행하세요:  python3 serve.py {HTTP_PORT + 10} {HTTPS_PORT + 10}")
        return 1
    plain_thread = threading.Thread(target=plain.serve_forever, daemon=True)
    plain_thread.start()
    base = f"http://localhost:{HTTP_PORT}"
    print(f"노트북:      {base}/              (가상 역: {base}/?sim=1)")
    print(f"지도 편집기: {base}/editor.html")
    print(f"책상 테스트: {base}/test.html    (인쇄 없이 실제 폰으로 확인)")
    print(f"QR 인쇄:     {base}/markers.html?map=<지도 이름>")

    try:
        cert, key = ensure_cert(ip)
        secure = http.server.ThreadingHTTPServer(("0.0.0.0", HTTPS_PORT), Handler)
    except (OSError, subprocess.CalledProcessError) as e:
        print(f"https 로는 열지 못했어요 ({e}). 폰 접속 없이 노트북에서만 쓸 수 있어요.")
        try:
            while plain_thread.is_alive():
                plain_thread.join(1)
        except KeyboardInterrupt:
            pass
        return 0

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    secure.socket = ctx.wrap_socket(secure.socket, server_side=True)
    print(f"폰:          https://{ip}:{HTTPS_PORT}/   (경고가 뜨면 '계속 진행')")
    print("끝내려면 Ctrl+C")
    try:
        secure.serve_forever()
    except KeyboardInterrupt:
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
