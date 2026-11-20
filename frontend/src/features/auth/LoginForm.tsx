import { useState } from 'react';
import type { SubmitEvent } from 'react';
import { AuthRequestError, login } from './api';
import type { AuthUser } from './api';

function loginErrorMessage(error: unknown) {
  if (error instanceof AuthRequestError) {
    switch (error.status) {
      case 400:
        return '이메일과 비밀번호의 입력 형식을 확인하세요.';
      case 401:
        return '이메일 또는 비밀번호가 올바르지 않습니다.';
      case 429:
        return '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.';
    }
  }
  return '로그인할 수 없습니다. 잠시 후 다시 시도하세요.';
}

export function LoginForm({ onLogin }: { onLogin: (user: AuthUser) => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const form = new FormData(event.currentTarget);
    const email = String(form.get('email')).trim();
    const password = String(form.get('password'));
    setPending(true);
    setError('');

    try {
      onLogin(await login(email, password));
    } catch (error) {
      setError(loginErrorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <div className="auth-field">
        <label htmlFor="email">이메일</label>
        <input id="email" name="email" type="email" autoComplete="username" maxLength={254} required />
      </div>
      <div className="auth-field">
        <label htmlFor="password">비밀번호</label>
        <input id="password" name="password" type="password" autoComplete="current-password" maxLength={256} required />
      </div>
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button className="auth-button" type="submit" disabled={pending}>
        {pending ? '로그인 중…' : '로그인'}
      </button>
    </form>
  );
}
