import { useEffect, useRef } from 'react';
import { openPassage } from './ar/camera';

export function App() {
  const video = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);

  useEffect(() => openPassage(video.current!, overlay.current!), []);

  return (
    <main aria-label="역사 통로 AR">
      <video ref={video} autoPlay playsInline muted disablePictureInPicture aria-label="후면 카메라" />
      <canvas ref={overlay} aria-label="바닥 안내 화살표" />
    </main>
  );
}
