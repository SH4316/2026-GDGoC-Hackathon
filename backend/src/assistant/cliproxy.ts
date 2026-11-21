import { BadGatewayException, GatewayTimeoutException, HttpException, ServiceUnavailableException } from '@nestjs/common';

export async function chatCompletion(options: { messages: object[]; [key: string]: unknown }, signal: AbortSignal,
                                     model = process.env.CLIPROXY_MODEL?.trim()) {
  const base = process.env.CLIPROXY_BASE_URL?.trim();
  if (!base || !model) throw new ServiceUnavailableException('서버에 CLIProxyAPI 주소와 모델을 설정해 주세요.');
  const key = process.env.CLIPROXY_API_KEY?.trim();
  try {
    const response = await fetch(base.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
      body: JSON.stringify({ ...options, model, stream: false }),
    });
    if (response.status === 429) throw new HttpException('요청이 많습니다. 잠시 후 다시 시도해 주세요.', 429);
    if ([401, 403, 404, 503].includes(response.status))
      throw new ServiceUnavailableException('CLIProxyAPI의 인증과 사용 가능한 모델을 확인해 주세요.');
    if (!response.ok) throw new BadGatewayException('모델 요청을 처리하지 못했습니다. 서버의 모델 설정을 확인해 주세요.');
    return await response.json();
  } catch (error) {
    if (signal.aborted) throw new GatewayTimeoutException('모델 응답 시간이 초과되었습니다. 다시 시도해 주세요.');
    if (error instanceof HttpException) throw error;
    throw new BadGatewayException('CLIProxyAPI 응답을 읽을 수 없습니다. 프록시 연결을 확인해 주세요.');
  }
}
