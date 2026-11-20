import { useEffect, useRef, useState } from 'react';
import { getSession, logout } from './api';
import type { AuthUser } from './api';
import { LoginForm } from './LoginForm';
import './auth.css';

type SessionState =
  | { status: 'checking' | 'signed-out' | 'unavailable' }
  | { status: 'signed-in'; user: AuthUser };

export function AuthScreen() {
  const [session, setSession] = useState<SessionState>({ status: 'checking' });
  const [checkAttempt, setCheckAttempt] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const focusHeading = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    getSession(controller.signal).then((user) => {
      if (controller.signal.aborted) return;
      setSession(user ? { status: 'signed-in', user } : { status: 'signed-out' });
    }).catch(() => {
      if (!controller.signal.aborted) setSession({ status: 'unavailable' });
    });
    return () => controller.abort();
  }, [checkAttempt]);

  const title = session.status === 'signed-in' ? '내 계정' : '로그인';

  useEffect(() => {
    document.title = title;
    if (session.status !== 'checking' && focusHeading.current) {
      heading.current?.focus();
      focusHeading.current = false;
    }
  }, [session.status, title]);

  function handleLogin(user: AuthUser) {
    focusHeading.current = true;
    setSession({ status: 'signed-in', user });
  }

  function retrySession() {
    focusHeading.current = true;
    setSession({ status: 'checking' });
    setCheckAttempt((attempt) => attempt + 1);
  }

  async function handleLogout() {
    setLoggingOut(true);
    setLogoutError('');
    try {
      await logout();
      focusHeading.current = true;
      setSession({ status: 'signed-out' });
    } catch {
      setLogoutError('로그아웃할 수 없습니다. 다시 시도하세요.');
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-panel" aria-labelledby="auth-title">
        <h1 id="auth-title" ref={heading} tabIndex={-1}>{title}</h1>

        {session.status === 'checking' && (
          <p className="auth-status" role="status">로그인 상태 확인 중…</p>
        )}

        {session.status === 'unavailable' && (
          <div className="auth-actions">
            <p className="auth-error" role="alert">로그인 상태를 확인할 수 없습니다.</p>
            <button className="auth-button" onClick={retrySession}>다시 시도</button>
          </div>
        )}

        {session.status === 'signed-out' && <LoginForm onLogin={handleLogin} />}

        {session.status === 'signed-in' && (
          <div className="auth-actions">
            <dl className="auth-account">
              <dt>이메일</dt>
              <dd>{session.user.email}</dd>
            </dl>
            {logoutError && <p className="auth-error" role="alert">{logoutError}</p>}
            <button className="auth-button" onClick={handleLogout} disabled={loggingOut}>
              {loggingOut ? '로그아웃 중…' : '로그아웃'}
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
