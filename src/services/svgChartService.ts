
import { AuditItem, Phase1AuditLogs } from '../types';

export const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface GaugeSpec {
  value: number;
  label: string;
  color: string;
  description: string;
  trend: 'positive' | 'negative';
  size?: 'small' | 'large';
}

export const svgGaugeCard = (g: GaugeSpec): string => {
  const v = Math.max(0, Math.min(100, g.value));
  const isLarge = g.size === 'large';
  const w = isLarge ? 240 : 180;
  const r = isLarge ? 80 : 56;
  const stroke = isLarge ? 12 : 8;
  const cx = w / 2;
  const cy = r + stroke;
  const svgH = cy + 24;
  const arcLen = Math.PI * r;
  const filled = (v / 100) * arcLen;
  const empty = arcLen - filled;
  const trendLabel = g.trend === 'positive' ? 'Target: High' : 'Target: Low';

  return `
  <div class="gauge-card ${isLarge ? 'gauge-large' : 'gauge-small'}">
    <svg viewBox="0 0 ${w} ${svgH}" class="gauge-svg" preserveAspectRatio="xMidYMid meet">
      <path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}"
            fill="none" stroke="#e2e8f0" stroke-width="${stroke}" stroke-linecap="round" />
      <path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}"
            fill="none" stroke="${g.color}" stroke-width="${stroke}" stroke-linecap="round"
            stroke-dasharray="${filled.toFixed(2)} ${empty.toFixed(2)}" />
      <text x="${cx}" y="${cy - 4}" text-anchor="middle"
            font-family="system-ui, -apple-system, sans-serif" font-weight="800"
            font-size="${isLarge ? 40 : 28}" fill="#0f172a">${Math.round(v)}<tspan font-size="${isLarge ? 20 : 14}" font-weight="500" fill="#64748b" dx="2">%</tspan></text>
    </svg>
    <h3 class="gauge-label">${escapeXml(g.label)}</h3>
    <p class="gauge-desc">${escapeXml(g.description)}</p>
    <div class="gauge-trend">${trendLabel}</div>
  </div>`;
};

const CATEGORY_LABELS: Record<string, string> = {
  A: 'Visibility',
  B: 'Optimization',
  C: 'Governance',
  D: 'Architecture',
  E: 'Culture'
};

const computeCategoryScores = (logs: Record<string, AuditItem>): Record<string, number> => {
  const scores: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  Object.entries(logs).forEach(([k, item]) => {
    const c = k.charAt(0);
    if (scores[c] !== undefined && typeof item.count === 'number') {
      scores[c] += Math.max(item.count, 0);
    }
  });
  return scores;
};

export const svgRadar = (phase1: Phase1AuditLogs): string => {
  const cats = ['A', 'B', 'C', 'D', 'E'];
  const w = 400;
  const h = 380;
  const cx = w / 2;
  const cy = 180;
  const maxRadius = 120;
  const max = 15;

  const mScores = computeCategoryScores(phase1.maturity);
  const aScores = computeCategoryScores(phase1.antipattern);

  const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / 5;
  const point = (i: number, valueRatio: number): [number, number] => {
    const a = angle(i);
    const r = maxRadius * Math.max(0, Math.min(1, valueRatio));
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };

  const gridPaths = [0.25, 0.5, 0.75, 1.0]
    .map(level => {
      const pts = cats.map((_, i) => point(i, level).map(n => n.toFixed(2)).join(','));
      return `<polygon points="${pts.join(' ')}" fill="none" stroke="#e2e8f0" stroke-width="1" />`;
    })
    .join('');

  const axisLines = cats
    .map((_, i) => {
      const [px, py] = point(i, 1);
      return `<line x1="${cx}" y1="${cy}" x2="${px.toFixed(2)}" y2="${py.toFixed(2)}" stroke="#e2e8f0" stroke-width="1" />`;
    })
    .join('');

  const mPts = cats.map((c, i) => point(i, mScores[c] / max).map(n => n.toFixed(2)).join(','));
  const aPts = cats.map((c, i) => point(i, aScores[c] / max).map(n => n.toFixed(2)).join(','));
  const mPoly = `<polygon points="${mPts.join(' ')}" fill="#10b981" fill-opacity="0.3" stroke="#10b981" stroke-width="2" />`;
  const aPoly = `<polygon points="${aPts.join(' ')}" fill="#f43f5e" fill-opacity="0.25" stroke="#f43f5e" stroke-width="2" />`;

  const labelEls = cats
    .map((c, i) => {
      const labelRadius = maxRadius + 28;
      const a = angle(i);
      const lx = cx + labelRadius * Math.cos(a);
      const ly = cy + labelRadius * Math.sin(a);
      return `<text x="${lx.toFixed(2)}" y="${ly.toFixed(2)}" text-anchor="middle" dominant-baseline="middle" font-family="system-ui" font-size="11" font-weight="700" fill="#334155">${c} · ${CATEGORY_LABELS[c]}</text>`;
    })
    .join('');

  return `
  <svg viewBox="0 0 ${w} ${h}" class="chart-svg" preserveAspectRatio="xMidYMid meet">
    ${gridPaths}
    ${axisLines}
    ${aPoly}
    ${mPoly}
    ${labelEls}
    <g transform="translate(${cx - 100}, ${h - 30})">
      <rect x="0" y="0" width="14" height="14" fill="#10b981" fill-opacity="0.3" stroke="#10b981" stroke-width="2"/>
      <text x="20" y="11" font-family="system-ui" font-size="11" font-weight="700" fill="#334155">Maturity</text>
      <rect x="90" y="0" width="14" height="14" fill="#f43f5e" fill-opacity="0.25" stroke="#f43f5e" stroke-width="2"/>
      <text x="110" y="11" font-family="system-ui" font-size="11" font-weight="700" fill="#334155">Anti-Patterns</text>
    </g>
  </svg>`;
};

export const svgScatter = (readiness: number, burden: number): string => {
  const w = 400;
  const h = 360;
  const padding = 56;
  const plotW = w - 2 * padding;
  const plotH = h - 2 * padding;
  const xVal = Math.max(0, Math.min(100, readiness));
  const yVal = Math.max(0, Math.min(100, burden));
  const px = padding + (xVal / 100) * plotW;
  const py = padding + (1 - yVal / 100) * plotH;

  const quadW = plotW / 2;
  const quadH = plotH / 2;

  return `
  <svg viewBox="0 0 ${w} ${h}" class="chart-svg" preserveAspectRatio="xMidYMid meet">
    <rect x="${padding}" y="${padding}" width="${quadW}" height="${quadH}" fill="#fef2f2" />
    <rect x="${padding + quadW}" y="${padding}" width="${quadW}" height="${quadH}" fill="#fffbeb" />
    <rect x="${padding}" y="${padding + quadH}" width="${quadW}" height="${quadH}" fill="#f1f5f9" />
    <rect x="${padding + quadW}" y="${padding + quadH}" width="${quadW}" height="${quadH}" fill="#ecfdf5" />
    <text x="${padding + quadW / 2}" y="${padding + 16}" text-anchor="middle" font-size="10" font-weight="700" fill="#be123c" font-family="system-ui">COST BLINDNESS</text>
    <text x="${padding + 1.5 * quadW}" y="${padding + 16}" text-anchor="middle" font-size="10" font-weight="700" fill="#b45309" font-family="system-ui">FINOPS THEATER</text>
    <text x="${padding + quadW / 2}" y="${padding + plotH - 8}" text-anchor="middle" font-size="10" font-weight="700" fill="#475569" font-family="system-ui">CHAOS ZONE</text>
    <text x="${padding + 1.5 * quadW}" y="${padding + plotH - 8}" text-anchor="middle" font-size="10" font-weight="700" fill="#059669" font-family="system-ui">FINOPS EXCELLENCE</text>
    <line x1="${padding + quadW}" y1="${padding}" x2="${padding + quadW}" y2="${padding + plotH}" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3 3" />
    <line x1="${padding}" y1="${padding + quadH}" x2="${padding + plotW}" y2="${padding + quadH}" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3 3" />
    <rect x="${padding}" y="${padding}" width="${plotW}" height="${plotH}" fill="none" stroke="#cbd5e1" stroke-width="1" />
    <text x="${w / 2}" y="${h - 18}" text-anchor="middle" font-size="11" font-weight="700" fill="#334155" font-family="system-ui">FinOps Readiness →</text>
    <text x="18" y="${h / 2}" text-anchor="middle" font-size="11" font-weight="700" fill="#334155" font-family="system-ui" transform="rotate(-90 18 ${h / 2})">Anti-Pattern Burden →</text>
    <text x="${padding}" y="${padding + plotH + 16}" text-anchor="middle" font-size="10" fill="#94a3b8" font-family="system-ui">0%</text>
    <text x="${padding + plotW}" y="${padding + plotH + 16}" text-anchor="middle" font-size="10" fill="#94a3b8" font-family="system-ui">100%</text>
    <text x="${padding - 8}" y="${padding + 3}" text-anchor="end" dominant-baseline="middle" font-size="10" fill="#94a3b8" font-family="system-ui">100%</text>
    <text x="${padding - 8}" y="${padding + plotH}" text-anchor="end" dominant-baseline="middle" font-size="10" fill="#94a3b8" font-family="system-ui">0%</text>
    <circle cx="${px.toFixed(2)}" cy="${py.toFixed(2)}" r="12" fill="#0f172a" fill-opacity="0.12" />
    <circle cx="${px.toFixed(2)}" cy="${py.toFixed(2)}" r="7" fill="#0f172a" stroke="#fff" stroke-width="2" />
    <text x="${px.toFixed(2)}" y="${(py - 16).toFixed(2)}" text-anchor="middle" font-size="11" font-weight="700" fill="#0f172a" font-family="system-ui">${Math.round(xVal)}% / ${Math.round(yVal)}%</text>
  </svg>`;
};

export const SVG_CSS = `
.gauge-card { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 1.5rem 1rem; background: #fff; border: 1px solid #e2e8f0; border-radius: 1rem; }
.gauge-card.gauge-large { padding: 2rem 1.5rem; }
.gauge-svg { width: 100%; height: auto; max-width: 240px; }
.gauge-label { font-size: 0.7rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; color: #475569; margin-top: 0.75rem; }
.gauge-large .gauge-label { font-size: 0.85rem; }
.gauge-desc { font-size: 0.7rem; color: #64748b; margin-top: 0.5rem; line-height: 1.45; max-width: 18rem; }
.gauge-large .gauge-desc { font-size: 0.8rem; max-width: 22rem; }
.gauge-trend { display: inline-block; margin-top: 0.75rem; font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #64748b; background: #f1f5f9; padding: 0.25rem 0.6rem; border-radius: 999px; }
.chart-svg { width: 100%; height: auto; max-width: 400px; display: block; margin: 0 auto; }
.chart-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 1rem; padding: 1.5rem; }
.chart-card h3 { font-size: 1.1rem; font-weight: 700; color: #0f172a; margin-bottom: 0.5rem; }
.chart-card p.chart-desc { font-size: 0.8rem; color: #64748b; margin-bottom: 1rem; line-height: 1.5; }
`;
