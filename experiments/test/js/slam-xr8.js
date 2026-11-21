// 8th Wall 엔진(XR8)을 카메라 움직임 추적기로 쓰기 위한 연결 부분.
//
// 엔진은 vendor/xr8/ 에 원본 그대로 들어 있다 (Niantic Spatial의 배포용 바이너리, vendor/xr8/LICENSE 참고).
// 엔진이 카메라를 직접 열고 영상을 캔버스에 그리며, 프레임마다 카메라의 위치와 자세를 알려 준다.
// 이 앱은 그 가운데 위치의 변화(이동량)만 쓰고, QR 인식과 방향 계산은 엔진이 그린 화면을 복사해서 한다.
//
// 주의: 이 파일은 엔진 문서(https://8thwall.org/docs/api/engine/)의 설명대로 작성했다.
// 문서와 실제 동작이 다를 수 있는 곳마다 상태와 오류를 그대로 알려서 화면에서 확인할 수 있게 했다.

const ENGINE_URL = new URL('../vendor/xr8/xr.js', import.meta.url).href;
const START_HEIGHT = 1.4; // 시작할 때 카메라가 바닥에서 이만큼 위에 있다고 엔진에 알려 준다 (엔진의 길이 단위 기준)

let loading = null;

/**
 * 엔진이 준비되면 window.XR8을 돌려준다.
 * 엔진의 script 태그는 index.html이 페이지를 읽을 때 써 넣는다 (?slam=1일 때). 태그가 없으면 여기서 만든다.
 */
function loadEngine(timeoutMs) {
  if (window.XR8) return Promise.resolve(window.XR8);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      if (window.__xr8Failed) {
        reject(new Error('engine file could not be loaded'));
        return;
      }
      const tag = document.querySelector('script[src*="xr8/xr.js"]');
      const timer = setTimeout(
        () => reject(new Error(tag ? 'engine did not get ready in time' : 'engine load timeout')),
        timeoutMs
      );
      const fail = () => {
        clearTimeout(timer);
        window.__xr8Failed = true;
        reject(new Error('engine file could not be loaded'));
      };
      window.addEventListener(
        'xrloaded',
        () => {
          clearTimeout(timer);
          resolve(window.XR8);
        },
        { once: true }
      );
      if (tag) {
        tag.addEventListener('error', fail);
        return;
      }
      const s = document.createElement('script');
      s.src = ENGINE_URL;
      s.async = true;
      s.setAttribute('data-preload-chunks', 'slam');
      s.onerror = fail;
      document.head.appendChild(s);
    }).catch((e) => {
      loading = null; // 다음에 다시 시도할 수 있게
      throw e;
    });
  }
  return loading;
}

/** 엔진이 던지는 오류는 Error가 아닌 객체일 때도 있다. 화면에 보여 줄 수 있는 글로 바꾼다. */
export function describeError(e) {
  if (!e) return 'unknown error';
  if (typeof e === 'string') return e;
  const parts = [];
  if (e.name && e.name !== 'Error') parts.push(e.name);
  if (e.message) parts.push(e.message);
  if (!parts.length) {
    try {
      parts.push(JSON.stringify(e));
    } catch (x) {
      parts.push(String(e));
    }
  }
  return parts.join(': ').slice(0, 300);
}

/**
 * 추적을 시작한다.
 *  canvas: 엔진이 카메라 영상을 그릴 캔버스
 *  onFrame({ q, p, proj, normal, reason }): 프레임마다. q는 [x, y, z, w], p는 [x, y, z], proj는 4x4 투영 행렬(16개)
 *  onInfo(text): 진행 상황 (디버그 표시용)
 *  onError(error): 시작한 뒤에 엔진이 오류를 냈을 때
 * 첫 프레임을 받으면 끝나는 Promise를 돌려준다. 값은 { stop, resize, snapshot }.
 */
export async function startXr8({ canvas, onFrame, onInfo = () => {}, onError = () => {} }) {
  onInfo('loading engine');
  const XR8 = await loadEngine(20000);
  onInfo(`engine ${typeof XR8.version === 'function' ? XR8.version() : 'loaded'}`);
  // 움직임 추적 부분이 따로 나뉘어 있어서, 다 받아졌는지 확인하고 시작한다
  if (typeof XR8.loadChunk === 'function') {
    try {
      await XR8.loadChunk('slam');
    } catch (e) {
      onInfo(`loadChunk: ${describeError(e)}`);
    }
  }
  if (!XR8.XrController || !XR8.GlTextureRenderer) throw new Error('engine has no tracking module');
  try {
    if (XR8.XrDevice && XR8.XrDevice.isDeviceBrowserCompatible) {
      const okDevice = XR8.XrDevice.isDeviceBrowserCompatible({ allowedDevices: XR8.XrConfig.device().MOBILE });
      onInfo(`device compatible: ${okDevice}`);
      if (!okDevice && XR8.XrDevice.incompatibleReasons) {
        onInfo(`incompatible: ${JSON.stringify(XR8.XrDevice.incompatibleReasons({ allowedDevices: XR8.XrConfig.device().MOBILE }))}`);
      }
    }
  } catch (e) {
    onInfo(`compat check: ${describeError(e)}`);
  }

  let wantSnap = null;
  let lastQ = null; // 가장 최근 프레임의 카메라 자세 (엔진이 그 프레임의 영상과 짝지어 준 값)
  let started = false;
  let stopped = false;
  let first = null;
  const firstFrame = new Promise((resolve, reject) => {
    first = { resolve, reject };
  });
  // 카메라 권한 창이 떠 있는 동안은 사용자가 누를 때까지 기다려야 하므로 넉넉히 잡고,
  // 카메라가 열린 뒤에는 10초 안에 첫 프레임이 와야 한다.
  let timer = setTimeout(() => first.reject(new Error('the engine did not start')), 60000);
  const expectFrameSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => first.reject(new Error('no tracking frame from the engine')), 10000);
  };

  const module = {
    name: 'iriro',
    onStart: ({ canvasWidth, canvasHeight, videoWidth, videoHeight }) => {
      onInfo(`camera ${videoWidth}x${videoHeight} canvas ${canvasWidth}x${canvasHeight}`);
      // 시작 위치와 방향. 방향은 어차피 지도와 무관하므로 기본값을 쓴다. 실패해도 엔진의 기본값으로 계속한다.
      try {
        XR8.XrController.updateCameraProjectionMatrix({
          origin: { x: 0, y: START_HEIGHT, z: 0 },
          facing: { w: 1, x: 0, y: 0, z: 0 },
        });
      } catch (e) {
        onInfo(`start pose: ${describeError(e)}`);
      }
    },
    onCameraStatusChange: ({ status }) => {
      onInfo(`camera ${status}`);
      if (started) return;
      if (status === 'failed') first.reject(new Error('camera failed (permission denied or camera in use)'));
      else if (status === 'hasStream' || status === 'hasVideo') expectFrameSoon();
    },
    onUpdate: ({ processCpuResult }) => {
      const r = processCpuResult && processCpuResult.reality;
      if (!r || !r.rotation || !r.position) return;
      if (!started) {
        started = true;
        clearTimeout(timer);
        first.resolve();
      }
      lastQ = [r.rotation.x, r.rotation.y, r.rotation.z, r.rotation.w];
      onFrame({
        q: lastQ,
        p: [r.position.x, r.position.y, r.position.z],
        proj: r.intrinsics,
        normal: r.trackingStatus === 'NORMAL',
        reason: r.trackingReason || '',
      });
    },
    // 엔진이 카메라 영상을 그린 직후: 화면 복사 요청이 있으면 지금 복사한다
    onRender: () => {
      const f = wantSnap;
      if (f) {
        wantSnap = null;
        f();
      }
    },
    onException: (e) => {
      onInfo(`exception: ${describeError(e)}`);
      if (!started) first.reject(new Error(`engine error: ${describeError(e)}`));
      else if (!stopped) onError(e);
    },
  };

  XR8.XrController.configure({ scale: 'responsive' });
  XR8.addCameraPipelineModules([
    XR8.GlTextureRenderer.pipelineModule(), // 카메라 영상을 캔버스에 그린다
    XR8.XrController.pipelineModule(), // 움직임 추적 (SLAM)
    module,
  ]);
  try {
    XR8.run({
      canvas,
      allowedDevices: XR8.XrConfig.device().MOBILE,
      // 그린 화면을 나중에도 복사할 수 있게 한다 (QR 인식용)
      glContextConfig: { preserveDrawingBuffer: true },
    });
  } catch (e) {
    clearTimeout(timer);
    XR8.clearCameraPipelineModules();
    throw e;
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    try {
      XR8.stop();
      XR8.clearCameraPipelineModules();
    } catch (e) {
      /* 이미 멈춘 상태 */
    }
  };

  try {
    await firstFrame;
  } catch (e) {
    stop();
    throw e;
  }

  return {
    stop,
    /** 캔버스의 그리기 해상도를 화면 크기에 맞춘다 (CSS 픽셀 기준 크기를 넣는다) */
    resize(cssW, cssH) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(2, Math.round(cssW * dpr));
      const h = Math.max(2, Math.round(cssH * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    },
    /**
     * 엔진이 그린 카메라 화면을 target(2D 캔버스)에 복사한다. target의 크기에 맞춰 줄여 넣는다.
     * 다음 그리기 직후에 복사하고, 엔진이 알려 주지 않으면 조금 기다렸다가 지금 화면을 복사한다.
     * 값: { q } 그 화면을 찍은 순간의 카메라 자세 (추적기 좌표계, [x, y, z, w])
     */
    snapshot(target) {
      return new Promise((resolve) => {
        let done = false;
        const copy = () => {
          if (done) return;
          done = true;
          const q = lastQ;
          try {
            target.getContext('2d', { willReadFrequently: true }).drawImage(canvas, 0, 0, target.width, target.height);
          } catch (e) {
            /* 캔버스가 아직 준비되지 않았다 */
          }
          resolve({ q });
        };
        wantSnap = copy;
        setTimeout(copy, 120);
      });
    },
  };
}
