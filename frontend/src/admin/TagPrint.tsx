import { updateUrl, useQuery } from '../urlState';
import { LanguageSelect, useLanguage } from '../i18n/LanguageSelect';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import atlasUrl from './tag36h11.png';
import './tag-print.css';

// The 3D view uses this same 32-column atlas. Each 10-cell tile contains
// an 8-cell black-edged marker and one white cell on every side.
async function readAtlas() {
  const image = new Image();
  image.src = atlasUrl;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('도안을 읽을 수 없습니다.');
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function markerPath(id: number, atlas: ImageData) {
  const x0 = (id % 32) * 10 + 1;
  const y0 = Math.floor(id / 32) * 10 + 1;
  const cells: string[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (atlas.data[4 * ((y0 + y) * atlas.width + x0 + x)] < 128)
        cells.push('M' + x + ' ' + y + 'h1v1h-1z');
    }
  }
  return cells.join('');
}

const paperSizes = [
  { name: 'A4', w: 210, h: 297 }, { name: 'A3', w: 297, h: 420 },
  { name: 'A2', w: 420, h: 594 }, { name: 'A1', w: 594, h: 841 },
  { name: 'A0', w: 841, h: 1189 },
];

// CSS defines 1in as 96 CSS pixels on screen. Panel dimensions in physical
// millimeters are unavailable, so this is a print-scale reference.
const cssPixelsPerMm = 96 / 25.4;

export function TagPrint({ ids, sideM, needsSave, close }: { ids: number[]; sideM: number; needsSave: boolean; close: () => void }) {
  const { t, locale } = useLanguage();
  const [atlas, setAtlas] = useState<ImageData>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pdfUrl, setPdfUrl] = useState('');
  const [pdfFailed, setPdfFailed] = useState(false);
  const [pdfAttempt, setPdfAttempt] = useState(0);
  const sheets = useMemo(() => atlas ? ids.map(id => ({ id, path: markerPath(id, atlas) })) : [], [ids, atlas]);
  const back = useRef<HTMLButtonElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const currentPage = useRef(0);
  const fitScreen = useQuery().get('scale') !== 'print';
  const setFitScreen = (fit: boolean) => updateUrl({ scale: fit ? null : 'print' });
  const [area, setArea] = useState<{ width: number; height: number }>();
  const side = sideM * 1000;
  const withMargin = side * 1.25 + 10;
  const paper = paperSizes.find(p => p.w >= withMargin) ??
    { name: '사용자 지정', w: Math.ceil(withMargin), h: Math.ceil(withMargin + 90) };

  useLayoutEffect(() => {
    const viewport = pages.current!;
    // Measure the reading area after the controls have taken their space.
    // The observer also handles rotation, browser zoom and moving the window.
    const observer = new ResizeObserver(([{ contentRect }]) => {
      if (contentRect.width < 1 || contentRect.height < 1) return;
      setArea({ width: contentRect.width, height: contentRect.height });
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const fitScale = area ? Math.min(1, area.width / (paper.w * cssPixelsPerMm),
    area.height / (side * 1.25 * cssPixelsPerMm)) : 1;
  const screenScale = fitScreen ? fitScale : 1;
  const screenStyle = { '--preview-width': paper.w * cssPixelsPerMm * screenScale + 'px' } as CSSProperties;

  // Keep the marker and its quiet zone in view even when the page margins
  // extend beyond the viewport. Keep the current tag when resizing a batch.
  useLayoutEffect(() => {
    const viewport = pages.current!;
    const sheet = viewport.children[currentPage.current];
    if (!sheet) return;
    const bounds = sheet.getBoundingClientRect();
    const frame = viewport.getBoundingClientRect();
    viewport.scrollTop += bounds.top - frame.top + Math.max(0, (bounds.height - viewport.clientHeight) / 2);
    viewport.scrollLeft = Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2);
  }, [screenScale, fitScreen, sheets, area]);

  function rememberPage() {
    const viewport = pages.current;
    if (!viewport || viewport.children.length < 2) return;
    const first = viewport.children[0].getBoundingClientRect();
    const step = viewport.children[1].getBoundingClientRect().top - first.top;
    if (step <= 0) return;
    const middle = viewport.getBoundingClientRect().top + viewport.clientHeight / 2;
    currentPage.current = Math.min(sheets.length - 1, Math.max(0, Math.floor((middle - first.top) / step)));
  }

  useEffect(() => {
    back.current?.focus();
    window.scrollTo(0, 0);
  }, []);
  useEffect(() => {
    let active = true;
    setFailed(false);
    void readAtlas().then(data => { if (active) setAtlas(data); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [attempt]);

  useEffect(() => {
    if (!sheets.length) return;
    let active = true;
    let url = '';
    setPdfUrl('');
    setPdfFailed(false);
    async function prepare() {
      const { createTagPdf } = await import('./tagPdf');
      if (!active) return;
      const blob = await createTagPdf(sheets, paper.w, paper.h, side);
      if (active) {
        url = URL.createObjectURL(blob);
        setPdfUrl(url);
      }
    }
    void prepare().catch(() => { if (active) setPdfFailed(true); });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [sheets, paper.w, paper.h, side, pdfAttempt]);

  const filename = 'AprilTag-36h11-' + (ids.length === 1 ? 'ID-' + ids[0] : ids.length + '-tags') + '-' + side + 'mm.pdf';

  return <main className="tag-print-view">
    <style>{`@page { size: ${paper.w}mm ${paper.h}mm; margin: 0; }
      @media print { .tag-sheet { width: ${paper.w}mm; height: ${paper.h - 2}mm; } }`}</style>
    <header className="tag-print-tools">
      <div>
        <button type="button" className="admin-text-button" ref={back} onClick={close}>{t('공간 관리로 돌아가기')}</button>
        <h1>{t('AprilTag 인쇄')}</h1>
        <p>{t(paper.name)} ({paper.w} × {paper.h} mm) · {t('{count}장 · 인쇄 배율을 실제 크기(100%)로 설정하세요.', { count: ids.length })}</p>
        {needsSave && <p>{t('설치하기 전에 배치를 저장해 이 공간의 태그 번호를 확정하세요.')}</p>}
      </div>
      <div className="tag-print-actions">
        <LanguageSelect />
        {pdfUrl ? <a className="admin-button" href={pdfUrl} download={filename}>{t('PDF 다운로드')}</a>
          : <button type="button" className="admin-button" disabled={!pdfFailed}
              onClick={() => setPdfAttempt(n => n + 1)}>{pdfFailed ? t('PDF 다시 준비') : t('PDF 준비 중…')}</button>}
        <button type="button" className="admin-button admin-primary" disabled={!atlas} onClick={() => window.print()}>{t('인쇄')}</button>
      </div>
    </header>
    {pdfFailed && <p className="tag-print-status" role="alert">{t('PDF 파일을 만들지 못했습니다. 다시 시도하세요.')}</p>}
    {!atlas && <p className="tag-print-status" role="status">{failed ? t('인쇄 도안을 불러오지 못했습니다.') : t('인쇄 도안 생성 중…')}
      {failed && <button type="button" className="admin-button" onClick={() => setAttempt(n => n + 1)}>{t('다시 시도')}</button>}
    </p>}
    <div className="tag-preview-options">
      <div role="group" aria-label={t('미리보기 배율')} className="admin-view-switch">
        <button type="button" aria-pressed={fitScreen} onClick={() => setFitScreen(true)}>{t('자동 맞춤')}</button>
        <button type="button" aria-pressed={!fitScreen} onClick={() => setFitScreen(false)}>{t('인쇄 기준 100%')}</button>
      </div>
      <span aria-live="polite">{t('표시 배율')} {Math.round(screenScale * 100)}%</span>
      <small>{t('화면의 mm는 모니터에 따라 실측 길이와 차이가 날 수 있습니다.')}</small>
    </div>
    <div className="tag-preview-pages" ref={pages} style={screenStyle} onScroll={rememberPage} role="region" aria-label={t('태그 용지 미리보기')} tabIndex={0}>
    {sheets.map(({ id, path }) => <svg key={id} className="tag-sheet" role="img" aria-label={t('인쇄용 AprilTag ID {id}', { id })}
      width={paper.w + 'mm'} height={paper.h - 2 + 'mm'} viewBox={`0 0 ${paper.w} ${paper.h - 2}`}>
      <rect width={paper.w} height={paper.h} fill="white" />
      <g textAnchor="middle" fill="black">
        <text x={paper.w / 2} y={16} fontSize="7" fontWeight="700">AprilTag · ID {id}</text>
        <text x={paper.w / 2} y={24} fontSize="3.8">{t('tag36h11 · 검은 테두리 한 변')} {side.toLocaleString(locale, { maximumFractionDigits: 4 })} mm</text>
        <text x={paper.w / 2} y={(paper.h - side * 1.25) / 2 - 4} fontSize="4">↑ UP</text>
      </g>
      <g transform={`translate(${(paper.w - side) / 2} ${(paper.h - side) / 2}) scale(${side / 8})`}>
        <path d={path} fill="black" shapeRendering="crispEdges" />
      </g>
      <g transform={`translate(${(paper.w - 100) / 2} ${paper.h - 17})`}>
        <path d="M0 -2v4m0 -2h100m0 -2v4" fill="none" stroke="black" strokeWidth=".25" />
        <text x="50" y="7" fontSize="3.5" fill="black" textAnchor="middle">100 mm</text>
      </g>
    </svg>)}
    </div>
  </main>;
}
