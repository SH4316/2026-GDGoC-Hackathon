// 방향 안내 화살표 그림. 상단 안내 카드와 AR 표지판이 같은 그림을 쓴다.

/**
 * 100x100 기준 좌표로 그린 꺾은선 화살표를 size 크기로 그린다.
 * kind: straight, left, right, slightLeft, slightRight, sharpLeft, sharpRight, uturn, arrive
 */
export function drawTurnGlyph(ctx, kind, size, color = '#fff', background = '#1e6bff') {
  const k = size / 100;
  ctx.save();
  ctx.scale(k, k);
  if (/Right$/.test(kind) || kind === 'right') {
    ctx.translate(100, 0);
    ctx.scale(-1, 1);
  }
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 12;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (kind === 'arrive') {
    // 목적지 핀: 가운데 구멍은 바탕색으로 칠한다
    ctx.beginPath();
    ctx.arc(50, 40, 24, Math.PI * 0.85, Math.PI * 0.15, false);
    ctx.lineTo(50, 90);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = background;
    ctx.beginPath();
    ctx.arc(50, 40, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  // 왼쪽 기준으로 정의하고, 오른쪽은 위에서 좌우를 뒤집어 그린다
  const base = kind.replace('Right', 'Left').replace('right', 'left');
  let pts;
  ctx.beginPath();
  if (base === 'uturn') {
    ctx.moveTo(68, 86);
    ctx.lineTo(68, 44);
    ctx.arc(52, 44, 16, 0, Math.PI, true);
    ctx.lineTo(36, 54);
    pts = [[36, 44], [36, 54]];
  } else {
    if (base === 'left') pts = [[64, 86], [64, 46], [40, 46]];
    else if (base === 'slightLeft') pts = [[60, 86], [60, 58], [42, 40]];
    else if (base === 'sharpLeft') pts = [[62, 86], [62, 36], [42, 54]];
    else pts = [[50, 86], [50, 36]];
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  }
  ctx.stroke();

  // 화살촉: 마지막 선분 방향으로
  const [ax, ay] = pts[pts.length - 2];
  const [bx, by] = pts[pts.length - 1];
  const len = Math.hypot(bx - ax, by - ay) || 1;
  const ux = (bx - ax) / len;
  const uy = (by - ay) / len;
  const head = 22;
  const half = 17;
  ctx.beginPath();
  ctx.moveTo(bx + ux * head, by + uy * head);
  ctx.lineTo(bx - uy * half, by + ux * half);
  ctx.lineTo(bx + uy * half, by - ux * half);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
