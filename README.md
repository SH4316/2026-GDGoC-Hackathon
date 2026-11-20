# 인증 앱

`backend`는 NestJS TypeScript 프로젝트이며 `src/auth`의 `AuthModule`에서 계정 검증과 세션을 처리합니다. `frontend`는 Vite React TypeScript 프로젝트이며 로그인 화면과 API 연동을 `src/features/auth`에 둡니다.

## Docker Compose로 실행

Docker Engine과 Docker Compose 플러그인이 설치된 환경에서 실행합니다.

```bash
./scripts/compose-up.sh
```

첫 실행은 프로젝트 루트의 `.env`에 로그인 계정, 임의 로그인 비밀번호와 MySQL 비밀번호를 생성합니다. 이후 실행에는 같은 파일을 사용합니다. 아래 명령으로 생성된 로그인 계정을 확인할 수 있습니다.

```bash
sed -n -e '/^AUTH_EMAIL=/p' -e '/^COMPOSE_AUTH_PASSWORD=/p' .env
```

로컬에서는 `http://localhost:8080`을 엽니다. 로컬 포트를 변경하려면 `.env`에 `APP_PORT`를 지정합니다. 외부에서 접속할 때는 아래 로그에 표시되는 `https://…trycloudflare.com` 주소를 사용합니다. Quick Tunnel은 Cloudflare 계정이나 도메인 없이 시작하며, 터널을 다시 만들면 주소가 바뀝니다. [Cloudflare Quick Tunnel 문서](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

```bash
docker compose logs -f cloudflared
```

Nginx가 프런트엔드를 제공하고 같은 호스트의 `/api/` 요청을 NestJS로 전달합니다. 터널은 Nginx로 연결됩니다. MySQL 8.4는 `db:3306`에서 백엔드에 제공되며, 데이터는 `mysql-data` 볼륨에 보존됩니다. 백엔드 컨테이너에는 `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`가 설정됩니다. 현재 로그인은 환경 변수의 계정과 메모리 세션을 사용합니다.

MySQL 콘솔에서 `hackathon` 데이터베이스를 확인하려면 다음 명령을 실행하고 `.env`의 `MYSQL_PASSWORD`를 입력합니다.

```bash
docker compose exec db sh -c 'exec mysql -u "$MYSQL_USER" -p "$MYSQL_DATABASE"'
```

종료하려면 `docker compose down`을 실행합니다. MySQL 볼륨과 `.env`는 다음 실행에서 재사용합니다.

## Node.js로 로컬 개발

Node.js 24 LTS(24.15 이상)와 npm을 사용합니다.

터미널 1에서 계정을 설정하고 백엔드를 실행합니다.

```bash
cd backend
npm ci
cp -n .env.example .env
read -rsp '비밀번호 (12~128자): ' login_password
printf '\n'
printf '%s' "$login_password" | npm run --silent auth:hash
unset login_password
```

`backend/.env`에 사용할 이메일(`AUTH_EMAIL`)과 출력된 해시(`AUTH_PASSWORD_HASH`)를 넣습니다. 설정 가능한 계정은 한 개입니다.

```bash
npm run start:dev
```

터미널 2에서 프런트엔드를 실행한 뒤 브라우저에서 `http://localhost:5173`을 엽니다.

```bash
cd frontend
npm ci
npm run dev
```

Vite는 `/api`를 `http://127.0.0.1:3000`으로 전달합니다. 백엔드 포트를 바꾸면 프런트엔드 실행 시 `API_PROXY_TARGET`도 새 주소로 설정합니다.

## 인증 API

| 메서드 | 경로 | 동작 |
| --- | --- | --- |
| `POST` | `/api/auth/login` | JSON `{ email, password }`를 검증하고 세션 쿠키와 사용자 이메일을 반환합니다. |
| `GET` | `/api/auth/session` | 세션이 유효하면 사용자 이메일을 반환합니다. |
| `POST` | `/api/auth/logout` | JSON `{}`를 받아 세션과 쿠키를 삭제합니다. |

세션은 8시간 동안 유효하며 백엔드를 재시작하면 삭제됩니다. 두 프로젝트 모두 `npm run build`로 빌드할 수 있습니다. 배포 시 프런트엔드와 `/api`를 같은 HTTPS 출처로 제공하고 백엔드에 `NODE_ENV=production`을 지정하면 `Secure` 세션 쿠키를 사용합니다.
