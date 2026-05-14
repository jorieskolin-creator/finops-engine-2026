import React, { useState, useMemo } from 'react';
import { ResponsiveContainer, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, Legend, Tooltip } from 'recharts';
import { AuditCategory, AuditItem, QualityGateResult, RemediationStep } from '../types';
import { BATCH_DEFINITIONS, MASTER_BINGO_FINOPS } from '../knowledge_base';

interface GaugeProps {
  value: number;
  label: string;
  color: string;
  trend?: 'positive' | 'negative';
  size?: 'small' | 'large';
  subLabel?: string;
  description?: string;
}

interface AuditGridProps {
  title: string;
  data: AuditCategory;
  isAntipattern?: boolean;
}

interface RoadmapProps {
  steps: RemediationStep[];
}

interface RadarProps {
  maturity: AuditCategory;
  antipattern: AuditCategory;
}

interface BenchmarkingProps {
  x: number;
  y: number;
}

const ALL_CRITERIA_IDS = [
  'A1', 'A2', 'A3', 'A4', 'A5',
  'B1', 'B2', 'B3', 'B4', 'B5',
  'C1', 'C2', 'C3', 'C4', 'C5',
  'D1', 'D2', 'D3', 'D4', 'D5',
  'E1', 'E2', 'E3', 'E4', 'E5'
];

export const MarkdownRenderer: React.FC<{ content: string; textColor?: string }> = ({ content, textColor = "text-slate-200" }) => {
  if (!content) return null;
  const blocks = content.split(/\n\n+/);

  const parseInline = (text: string) => {
    let cleanText = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
    const parts = cleanText.split(/(\*\*.*?\*\*)/g);
    return parts.map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={i} className={`font-bold ${textColor === 'text-slate-900' ? 'text-black' : 'text-white'}`}>{part.slice(2, -2)}</strong>;
      }
      const subParts = part.split(/(\*.*?\*)/g);
      return subParts.map((subPart, j) => {
        if (subPart.startsWith('*') && subPart.endsWith('*') && subPart.length > 2) {
          return <strong key={`${i}-${j}`} className="font-medium text-emerald-400">{subPart.slice(1, -1)}</strong>;
        }
        return subPart;
      });
    });
  };

  return (
    <div className="space-y-6">
      {blocks.map((block, index) => {
        const trimmed = block.trim();
        if (trimmed.startsWith('###')) return <h4 key={index} className={`text-lg font-display font-bold mt-8 mb-2 border-b pb-2 ${textColor === 'text-slate-900' ? 'text-slate-800 border-slate-300' : 'text-white border-slate-700/50'}`}>{parseInline(trimmed.replace(/^###\s*/, ''))}</h4>;
        if (trimmed.startsWith('##')) return <h3 key={index} className={`text-xl font-bold mt-6 mb-3 ${textColor === 'text-slate-900' ? 'text-slate-900' : 'text-slate-100'}`}>{parseInline(trimmed.replace(/^##\s*/, ''))}</h3>;
        if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
          const items = trimmed.split('\n').map(l => l.replace(/^[-*]\s*/, ''));
          return <ul key={index} className="space-y-3">{items.map((it, i) => <li key={i} className={`flex items-start gap-3 ${textColor}`}><span className="mt-2 w-1 h-1 rounded-full bg-emerald-400 shrink-0"></span><span className="leading-relaxed">{parseInline(it)}</span></li>)}</ul>;
        }
        if (/^\d+\./.test(trimmed)) {
          const items = trimmed.split('\n').map(l => l.replace(/^\d+\.\s*/, ''));
          return <ol key={index} className={`list-decimal pl-5 space-y-2 ${textColor}`}>{items.map((it, i) => <li key={i}>{parseInline(it)}</li>)}</ol>;
        }
        return <p key={index} className={`${textColor} leading-relaxed font-normal text-base text-justify`}>{parseInline(trimmed)}</p>;
      })}
    </div>
  );
};

const parseDefinitions = (xmlString: string) => {
  const items: { id: string; title: string; description: string; criteria: string }[] = [];
  const itemRegex = /<item id="([^"]+)">([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xmlString)) !== null) {
    const id = match[1];
    const content = match[2];
    const titleMatch = content.match(/<title>([\s\S]*?)<\/title>/);
    const descMatch = content.match(/<description>([\s\S]*?)<\/description>/);
    const criteriaMatch = content.match(/<criteria>([\s\S]*?)<\/criteria>/);
    items.push({
      id,
      title: titleMatch ? titleMatch[1].trim() : "Unknown",
      description: descMatch ? descMatch[1].trim() : "",
      criteria: criteriaMatch ? criteriaMatch[1].trim() : ""
    });
  }
  return items;
};

const useAuditMetadata = (isAntipattern: boolean) => {
  return useMemo(() => {
    const map = new Map<string, { title: string; description: string }>();
    if (BATCH_DEFINITIONS) {
      Object.entries(BATCH_DEFINITIONS).forEach(([, defs]) => {
        const xml = isAntipattern ? defs.antipattern : defs.maturity;
        const items = parseDefinitions(xml);
        items.forEach(item => map.set(item.id, { title: item.title, description: item.description }));
      });
    }
    return map;
  }, [isAntipattern]);
};

export const NeuralLoadingGrid: React.FC<{ progress: number; stage: string }> = ({ progress, stage }) => {
  const steps = [
    { id: 'A', label: 'VISIBILITY', sub: 'Allocation' },
    { id: 'B', label: 'OPTIMIZE', sub: 'Rate & Usage' },
    { id: 'C', label: 'GOVERN', sub: 'Policy' },
    { id: 'D', label: 'ARCHITECT', sub: 'Engineering' },
    { id: 'E', label: 'CULTURE', sub: 'Organization' },
  ];

  const activeIndex = stage === 'audit'
    ? Math.floor(progress / 20)
    : 5;

  return (
    <div className="flex items-center justify-center min-h-[500px] font-sans">
      <div className="relative w-full max-w-4xl bg-slate-900/40 backdrop-blur-2xl rounded-[3rem] p-12 md:p-16 border border-white/10 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.5)] overflow-hidden">
        <div className="flex justify-center mb-8">
          <div className="inline-flex items-center gap-2 px-6 py-2 rounded-full bg-slate-800/50 border border-slate-700/50 shadow-sm backdrop-blur-sm">
            <span className={`w-2 h-2 rounded-full ${stage === 'strategy' ? 'bg-violet-500 animate-pulse shadow-[0_0_15px_rgba(139,92,246,0.5)]' : 'bg-emerald-400 animate-pulse shadow-[0_0_15px_rgba(52,211,153,0.5)]'}`}></span>
            <span className="text-xs font-bold uppercase tracking-[0.2em] text-slate-300">
              {stage === 'strategy' ? 'PHASE 3: STRATEGIC SYNTHESIS (Opus 4.7)' : 'PHASE 1: FORENSIC AUDIT (Gemini Pro)'}
            </span>
          </div>
        </div>
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-display font-bold text-white mb-3 tracking-tight">
            {stage === 'strategy' ? 'Synthesizing Roadmap...' : 'Analyzing FinOps Streams...'}
          </h2>
          <p className="text-slate-300 font-medium text-lg">
            {stage === 'strategy' ? 'Claude Opus 4.7 - Strategy Engine Active' : 'Gemini 2.5 Pro - Parallel Batching Active'}
          </p>
        </div>
        <div className="flex justify-center gap-4 md:gap-8 mb-20 relative">
          {steps.map((step, idx) => {
            const isActive = idx === activeIndex && stage === 'audit';
            const isDone = idx < activeIndex || stage === 'calc' || stage === 'strategy';
            return (
              <div key={step.id} className="flex flex-col items-center gap-4 group">
                <div className={`w-16 h-16 md:w-20 md:h-20 rounded-[1.5rem] flex items-center justify-center text-xl md:text-2xl font-bold font-display transition-all duration-500 ease-out border ${isActive ? 'bg-emerald-500/10 border-emerald-400 text-emerald-400 shadow-[0_0_30px_rgba(52,211,153,0.3)] scale-110 z-10' : isDone ? 'bg-slate-800 border-slate-700 text-white shadow-xl scale-100' : 'bg-slate-900/50 border-slate-800 text-slate-500 scale-95'}`}>
                  {isDone ? (
                    <svg className="w-6 h-6 md:w-8 md:h-8 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                  ) : step.id}
                </div>
                <span className={`text-[10px] md:text-xs font-bold uppercase tracking-widest transition-colors duration-300 ${isActive || isDone ? 'text-slate-200' : 'text-slate-500'}`}>{step.label}</span>
              </div>
            );
          })}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12 md:gap-24 px-4 md:px-12 relative">
          <div className="relative">
            <div className="flex items-center gap-3 mb-3">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shadow-[0_0_10px_rgba(251,191,36,0.6)]"></span>
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-300">FinOps Knowledge Base</span>
            </div>
            <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full bg-amber-400 w-full animate-[loading_2s_ease-in-out_infinite] shadow-[0_0_10px_rgba(251,191,36,0.5)]"></div>
            </div>
          </div>
          <div className="relative">
            <div className="flex items-center gap-3 mb-3">
              <span className="w-2 h-2 rounded-full bg-violet-500 animate-pulse shadow-[0_0_10px_rgba(139,92,246,0.6)]"></span>
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Evidence Context</span>
            </div>
            <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full bg-violet-500 transition-all duration-1000 ease-out shadow-[0_0_10px_rgba(139,92,246,0.5)]" style={{ width: `${progress}%` }}></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export const TransferProtocol: React.FC = () => (
  <div className="mt-12 mb-12 py-10 relative">
    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-emerald-500/5 to-transparent rounded-full blur-3xl -z-10"></div>
    <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-8 flex items-center justify-center gap-2 font-mono">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
      FinOps Action Protocol
    </h4>
    <div className="grid grid-cols-1 md:grid-cols-4 gap-6 relative max-w-4xl mx-auto">
      <div className="hidden md:block absolute top-6 left-[15%] right-[15%] h-px bg-gradient-to-r from-slate-800 via-emerald-900 to-slate-800 z-0"></div>
      {[
        { id: 1, title: "Save Report", desc: "Download HTML" },
        { id: 2, title: "Share Findings", desc: "Stakeholder Brief" },
        { id: 3, title: "Plan Roadmap", desc: "Crawl-Walk-Run" },
        { id: 4, title: "Execute", desc: "Optimize & Track", color: "emerald" }
      ].map((step) => (
        <div key={step.id} className="relative z-10 group cursor-default">
          <div className={`w-12 h-12 mx-auto rounded-2xl flex items-center justify-center font-bold text-sm mb-4 border transition-all duration-500 ${step.color === 'emerald' ? 'bg-emerald-950/30 text-emerald-400 border-emerald-900 group-hover:bg-emerald-500 group-hover:text-white group-hover:shadow-[0_0_20px_rgba(16,185,129,0.3)]' : 'bg-slate-900 text-slate-400 border-slate-700 group-hover:bg-emerald-600 group-hover:text-white group-hover:border-emerald-500 group-hover:shadow-[0_0_20px_rgba(16,185,129,0.3)]'}`}>
            {step.id}
          </div>
          <div className="text-center">
            <h5 className="text-xs font-bold text-slate-200 uppercase tracking-wide mb-1">{step.title}</h5>
            <p className="text-[10px] text-slate-400 font-medium">{step.desc}</p>
          </div>
        </div>
      ))}
    </div>
  </div>
);

export const BenchmarkingChart: React.FC<BenchmarkingProps> = ({ x, y }) => {
  const [hoveredQuadrant, setHoveredQuadrant] = useState<string | null>(null);
  const xPos = Math.min(Math.max(x, 0), 100);
  const yPos = Math.min(Math.max(y, 0), 100);
  const isHighUp = yPos > 50;
  const isLeft = xPos < 50;

  const quadrants = [
    { id: 'q1', label: 'Cost Blindness', sub: 'Reactive Spend', desc: 'High anti-pattern burden with low maturity. Cloud costs are unmanaged, unoptimized, and invisible to stakeholders.', position: 'top-0 left-0', style: 'bg-gradient-to-br from-rose-950/30 via-slate-900/50 to-transparent border-r border-b border-white/5', text: 'text-rose-400' },
    { id: 'q2', label: 'FinOps Theater', sub: 'Process Without Outcomes', desc: 'Some maturity exists but anti-patterns persist. FinOps meetings happen but optimization outcomes are minimal.', position: 'top-0 right-0', style: 'bg-gradient-to-bl from-amber-950/30 via-slate-900/50 to-transparent border-b border-white/5', text: 'text-amber-400' },
    { id: 'q3', label: 'Chaos Zone', sub: 'No Discipline', desc: 'Neither maturity nor anti-patterns are strongly present. Cloud governance is absent — spend drifts without direction.', position: 'bottom-0 left-0', style: 'bg-gradient-to-tr from-slate-900/80 via-slate-900/50 to-transparent border-r border-white/5', text: 'text-slate-500' },
    { id: 'q4', label: 'FinOps Excellence', sub: 'The Goal', desc: 'High maturity with low anti-pattern burden. Cost optimization is embedded in culture, architecture, and automation.', position: 'bottom-0 right-0', style: 'bg-gradient-to-tl from-emerald-950/30 via-slate-900/50 to-transparent', text: 'text-emerald-400' }
  ];

  return (
    <div className="p-8 rounded-[2.5rem] relative flex flex-col h-full min-h-[550px] bg-slate-900/70 border border-white/10 shadow-lg backdrop-blur-sm">
      <div className="flex justify-between items-start mb-2 relative z-20 pointer-events-none">
        <div>
          <h3 className="text-white font-display font-bold text-2xl tracking-tight pointer-events-auto">FinOps Maturity Matrix</h3>
          <div className="flex items-center gap-2 mt-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            <p className="text-slate-300 text-[11px] font-bold uppercase tracking-widest">Maturity (X) vs. Anti-Pattern Burden (Y)</p>
          </div>
        </div>
      </div>
      <div className="relative flex-1 w-auto h-full mt-8 mb-8 ml-8 mr-8 z-10">
        <div className="absolute inset-0 rounded-xl overflow-hidden border border-white/5 shadow-inner bg-slate-950/30">
          {quadrants.map((q) => (
            <div key={q.id} onMouseEnter={() => setHoveredQuadrant(q.id)} onMouseLeave={() => setHoveredQuadrant(null)} className={`absolute w-1/2 h-1/2 ${q.position} ${q.style} transition-all duration-500 group cursor-default flex flex-col justify-center items-center p-6 text-center backdrop-blur-[2px]`}>
              <div className="transition-all duration-300 group-hover:-translate-y-4 group-hover:scale-90 group-hover:opacity-0 delay-75">
                <span className={`text-xs font-black uppercase tracking-widest ${q.text} opacity-80`}>{q.label}</span>
              </div>
              <div className="absolute inset-0 bg-slate-900/95 backdrop-blur-md opacity-0 group-hover:opacity-100 transition-all duration-300 flex flex-col items-center justify-center p-8 text-center z-10 translate-y-4 group-hover:translate-y-0 border border-white/10">
                <span className={`text-xs font-black uppercase tracking-widest mb-1 ${q.text}`}>{q.label}</span>
                <span className="text-[10px] font-bold text-slate-300 uppercase tracking-wide mb-3">{q.sub}</span>
                <p className="text-xs text-slate-200 leading-relaxed font-medium">{q.desc}</p>
              </div>
            </div>
          ))}
          <div className="absolute top-1/2 left-0 right-0 h-px bg-white/10 z-0 border-t border-dashed border-white/20"></div>
          <div className="absolute left-1/2 top-0 bottom-0 w-px bg-white/10 z-0 border-l border-dashed border-white/20"></div>
          <div className="absolute left-3 bottom-3 text-[10px] font-bold text-slate-500 font-mono z-20 pointer-events-none">Low Burden</div>
          <div className="absolute left-3 top-3 text-[10px] font-bold text-slate-500 font-mono z-20 pointer-events-none">High Burden</div>
          <div className="absolute right-3 bottom-3 text-[10px] font-bold text-slate-500 font-mono z-20 pointer-events-none">High Maturity</div>
        </div>
        <div
          className={`absolute z-50 cursor-pointer group/dot transition-all duration-500 ease-out -translate-x-1/2 translate-y-1/2 ${hoveredQuadrant ? 'opacity-0 pointer-events-none scale-50' : 'opacity-100 scale-100'}`}
          style={{ left: `${xPos}%`, bottom: `${yPos}%` }}
        >
          <div className="absolute -inset-6 bg-emerald-400/20 rounded-full blur-xl opacity-70 animate-pulse pointer-events-none"></div>
          <div className="absolute -inset-8 border border-emerald-400/10 rounded-full animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite] pointer-events-none"></div>
          <div className="absolute -inset-1.5 bg-white/10 backdrop-blur-sm rounded-full shadow-sm"></div>
          <div className="relative w-8 h-8 rounded-full shadow-[0_0_20px_rgba(16,185,129,0.8)] border-[2px] border-white bg-gradient-to-br from-emerald-400 via-teal-500 to-cyan-600 group-hover/dot:scale-110 transition-transform duration-300 flex items-center justify-center">
            <div className="w-2 h-2 bg-white rounded-full shadow-[0_0_5px_white]"></div>
          </div>
          <div className={`absolute ${!isHighUp ? 'bottom-full mb-6' : 'top-full mt-6'} ${isLeft ? 'left-1/2 -translate-x-4' : 'right-1/2 translate-x-4'} bg-slate-900/95 backdrop-blur-xl text-white rounded-2xl shadow-2xl border border-white/10 p-5 min-w-[200px] transition-all duration-300 z-50`}>
            <div className="flex items-center gap-2 border-b border-white/10 pb-3 mb-3">
              <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.6)]"></div>
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Current Position</span>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between items-center gap-6"><span className="text-xs font-bold text-slate-300">Maturity</span><div className="flex items-center gap-2"><div className="w-16 h-1.5 bg-slate-800 rounded-full overflow-hidden border border-slate-700"><div className="h-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]" style={{ width: `${xPos}%` }}></div></div><span className="text-sm font-bold font-mono text-emerald-400">{Math.round(x)}%</span></div></div>
              <div className="flex justify-between items-center gap-6"><span className="text-xs font-bold text-slate-300">Burden</span><div className="flex items-center gap-2"><div className="w-16 h-1.5 bg-slate-800 rounded-full overflow-hidden border border-slate-700"><div className="h-full bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.5)]" style={{ width: `${yPos}%` }}></div></div><span className="text-sm font-bold font-mono text-rose-400">{Math.round(y)}%</span></div></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export const QualityGateBanner: React.FC<{ gate: QualityGateResult }> = ({ gate }) => {
  const [expanded, setExpanded] = useState(gate.decision === 'BLOCK');

  if (gate.decision === 'GO') {
    return (
      <div className="glass-panel p-4 mb-6 flex items-start gap-3 border-l-4 border-l-emerald-500 bg-emerald-950/10 backdrop-blur-md">
        <svg className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        <div className="text-sm">
          <span className="font-bold text-emerald-300">Quality Gate: GO</span>
          <span className="text-slate-400 ml-2">{gate.notes[0] ?? 'All checks passed.'}</span>
        </div>
      </div>
    );
  }

  const isBlock = gate.decision === 'BLOCK';
  const palette = isBlock
    ? { border: 'border-l-rose-500', bg: 'bg-rose-950/10', dot: 'text-rose-400', label: 'text-rose-300', chip: 'bg-rose-900/40 text-rose-200 border-rose-500/30' }
    : { border: 'border-l-amber-500', bg: 'bg-amber-950/10', dot: 'text-amber-400', label: 'text-amber-300', chip: 'bg-amber-900/40 text-amber-200 border-amber-500/30' };

  const totalIssues = gate.blocking_reasons.length + gate.warnings.length;

  return (
    <div className={`glass-panel p-6 mb-8 border-l-4 ${palette.border} ${palette.bg} backdrop-blur-md`}>
      <div className="flex items-start gap-4">
        <div className={`p-2 rounded-full bg-slate-900/40 ${palette.dot} flex-shrink-0`}>
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap mb-2">
            <h4 className={`font-bold text-lg font-display ${palette.label}`}>
              Quality Gate: {gate.decision}
            </h4>
            <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full border uppercase tracking-wide ${palette.chip}`}>
              {gate.blocking_reasons.length > 0 && `${gate.blocking_reasons.length} blocking`}
              {gate.blocking_reasons.length > 0 && gate.warnings.length > 0 && ' · '}
              {gate.warnings.length > 0 && `${gate.warnings.length} warning${gate.warnings.length === 1 ? '' : 's'}`}
            </span>
          </div>
          <p className="text-sm text-slate-300 leading-relaxed mb-3">{gate.notes[0]}</p>
          <button
            type="button"
            onClick={() => setExpanded(e => !e)}
            className="text-xs font-bold uppercase tracking-wider text-slate-400 hover:text-slate-200 transition-colors"
          >
            {expanded ? 'Hide details' : `Show ${totalIssues} issue${totalIssues === 1 ? '' : 's'}`}
          </button>
          {expanded && (
            <div className="mt-4 space-y-3 text-sm">
              {gate.blocking_reasons.length > 0 && (
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-rose-400 mb-2">Blocking</p>
                  <ul className="space-y-1.5">
                    {gate.blocking_reasons.map((r, i) => (
                      <li key={i} className="text-slate-300 pl-3 border-l-2 border-rose-700/60">{r}</li>
                    ))}
                  </ul>
                </div>
              )}
              {gate.warnings.length > 0 && (
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-amber-400 mb-2">Warnings</p>
                  <ul className="space-y-1.5">
                    {gate.warnings.map((w, i) => (
                      <li key={i} className="text-slate-300 pl-3 border-l-2 border-amber-700/60">{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              {gate.fact_check && !gate.fact_check.failed && gate.fact_check.unsupported_claims.length > 0 && (
                <div className="pt-3 border-t border-slate-700/50">
                  <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
                    Unverified claims ({gate.fact_check.unsupported_claims.length} survived {gate.fact_check.attempts} pass{gate.fact_check.attempts === 1 ? '' : 'es'})
                  </p>
                  <ul className="space-y-2">
                    {gate.fact_check.unsupported_claims.map((c, i) => (
                      <li key={i} className="text-slate-300 pl-3 border-l-2 border-slate-600">
                        <span className="italic">&ldquo;{c.claim}&rdquo;</span>
                        {c.rationale && <span className="block text-xs text-slate-500 mt-0.5">{c.rationale}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export const GaugeCard: React.FC<GaugeProps> = ({ value, label, color, trend = 'positive', size = 'small', subLabel, description }) => {
  const radius = size === 'large' ? 60 : 36;
  const stroke = size === 'large' ? 8 : 5;
  const normalizedValue = Math.min(Math.max(value, 0), 100);
  const circumference = radius * Math.PI;
  const strokeDashoffset = circumference - (normalizedValue / 100) * circumference;

  return (
    <div className={`glass-panel flex flex-col items-center justify-center relative overflow-hidden glass-card-hover group transition-all duration-300 hover:shadow-[0_0_30px_rgba(255,255,255,0.05)] hover:scale-[1.01] border-white/5 h-full ${size === 'large' ? 'p-10 rounded-[3rem]' : 'p-6 rounded-[2rem]'}`}>
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-48 h-48 bg-current opacity-[0.03] blur-3xl rounded-full pointer-events-none" style={{ color }}></div>
      <div className={`relative mb-4 overflow-hidden ${size === 'large' ? 'w-64 h-32' : 'w-40 h-20'}`}>
        <svg className={`${size === 'large' ? 'w-64 h-64' : 'w-40 h-40'} transform origin-bottom`} viewBox="0 0 140 140">
          <defs><linearGradient id={`grad-${label.replace(/\s/g, '')}`} x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" style={{ stopColor: color, stopOpacity: 0.2 }} /><stop offset="50%" style={{ stopColor: color, stopOpacity: 0.8 }} /><stop offset="100%" style={{ stopColor: color, stopOpacity: 1 }} /></linearGradient><filter id="glow"><feGaussianBlur stdDeviation="3.5" result="coloredBlur"/><feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
          <circle cx="70" cy="70" r={radius} fill="none" stroke="#1e293b" strokeWidth={stroke} strokeLinecap="round" className="opacity-50"/>
          <circle cx="70" cy="70" r={radius} fill="none" stroke={`url(#grad-${label.replace(/\s/g, '')})`} strokeWidth={stroke} strokeDasharray={circumference} strokeDashoffset={strokeDashoffset} strokeLinecap="round" className="transition-all duration-[2000ms] cubic-bezier(0.2, 0.8, 0.2, 1)" transform="rotate(180 70 70)" filter="url(#glow)"/>
        </svg>
        <div className="absolute bottom-0 w-full text-center flex flex-col items-center">
          <span className={`${size === 'large' ? 'text-7xl' : 'text-4xl'} font-black font-display tracking-tighter text-white drop-shadow-md`}>{Math.round(value)}</span>
          <span className="text-xs font-bold text-slate-400 -mt-1">%</span>
        </div>
      </div>
      <h3 className={`uppercase tracking-widest text-slate-400 font-bold border-t border-white/5 pt-4 w-full text-center ${size === 'large' ? 'text-sm mt-2' : 'text-[10px]'}`}>{label}</h3>
      {subLabel && <p className="text-slate-500 text-[10px] mt-1 font-medium">{subLabel}</p>}
      {description && (
        <p className={`text-slate-400 mt-2 px-1 text-center leading-snug ${size === 'large' ? 'text-xs max-w-xs' : 'text-[10px] max-w-[14rem]'}`}>
          {description}
        </p>
      )}
      <div className={`mt-3 text-[9px] font-bold uppercase tracking-wider text-slate-400 opacity-80 bg-white/5 px-3 py-1 rounded-full border border-white/5 ${size === 'large' ? 'scale-110' : ''}`}>
        {trend === 'positive' ? 'Target: High' : 'Target: Low'}
      </div>
    </div>
  );
};

export const AuditGrid: React.FC<AuditGridProps> = ({ title, data, isAntipattern = false }) => {
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const metadataMap = useAuditMetadata(isAntipattern);

  const getStatusStyle = (item: AuditItem, isAnti: boolean) => {
    if (item.is_silent) return 'bg-slate-900/30 border-slate-800 text-slate-500';
    const s = (item.status || "NOK").toUpperCase();
    if (isAnti) return s === 'NOK' ? 'bg-rose-950/20 border-rose-900/50 hover:shadow-[0_0_15px_rgba(244,63,94,0.1)]' : s === 'PARTIAL' ? 'bg-orange-950/20 border-orange-900/50' : 'bg-emerald-950/20 border-emerald-900/50';
    return s === 'OK' ? 'bg-emerald-950/20 border-emerald-900/50 hover:shadow-[0_0_15px_rgba(16,185,129,0.1)]' : s === 'PARTIAL' ? 'bg-teal-950/20 border-teal-900/50' : 'bg-slate-900/50 border-slate-800';
  };

  const getStatusLabelColor = (item: AuditItem, isAnti: boolean) => {
    const s = (item.status || "NOK").toUpperCase();
    if (item.is_silent) return "bg-slate-800 text-slate-500 border border-slate-700";
    if (isAnti) return s === 'NOK' ? "bg-rose-950/40 text-rose-400 border border-rose-900" : s === 'PARTIAL' ? "bg-orange-950/40 text-orange-400 border border-orange-900" : "bg-emerald-950/40 text-emerald-400 border border-emerald-900";
    return s === 'OK' ? "bg-emerald-950/40 text-emerald-400 border border-emerald-900" : s === 'PARTIAL' ? "bg-teal-950/40 text-teal-400 border border-teal-900" : "bg-slate-800 text-slate-400 border border-slate-700";
  };

  const topOffenders = useMemo(() => {
    const candidates = (Object.entries(data) as [string, AuditItem][]).filter(([, item]) => !item.is_silent);
    if (isAntipattern) return candidates.filter(([, item]) => item.count > 0).sort((a, b) => b[1].count - a[1].count).slice(0, 3).map(([id, item]) => ({ id, ...item, title: metadataMap.get(id)?.title || "Anti-Pattern Detected" }));
    return candidates.filter(([, item]) => item.count < 3).sort((a, b) => a[1].count - b[1].count).slice(0, 3).map(([id, item]) => ({ id, ...item, title: metadataMap.get(id)?.title || "Maturity Gap" }));
  }, [data, isAntipattern, metadataMap]);

  return (
    <div className="glass-panel p-10 rounded-[3rem]">
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-10 gap-4">
        <div>
          <h3 className={`text-3xl font-display font-bold flex items-center gap-4 ${isAntipattern ? 'text-rose-400' : 'text-emerald-400'}`}>
            <span className={`w-3 h-3 rounded-full ${isAntipattern ? 'bg-rose-500' : 'bg-emerald-500'} shadow-[0_0_12px_currentColor]`}></span>
            {title}
          </h3>
          {topOffenders.length > 0 && (
            <button onClick={() => setIsDetailsOpen(!isDetailsOpen)} className={`mt-2 text-xs font-bold uppercase tracking-widest flex items-center gap-2 transition-colors ${isAntipattern ? 'text-rose-500 hover:text-rose-400' : 'text-emerald-500 hover:text-emerald-400'}`}>
              {isDetailsOpen ? 'Hide Score Details' : `View ${topOffenders.length} ${isAntipattern ? 'Critical Anti-Patterns' : 'Maturity Gaps'}`}
              <svg className={`w-3 h-3 transition-transform ${isDetailsOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
          )}
        </div>
        <div className="text-xs font-mono text-slate-400 uppercase tracking-widest">N = 25 Checkpoints</div>
      </div>

      {isDetailsOpen && (
        <div className={`mb-10 animate-fade-in-up space-y-4 border-l-2 pl-6 ${isAntipattern ? 'border-rose-900/50' : 'border-emerald-900/50'}`}>
          <h4 className="text-sm font-bold text-slate-300 uppercase tracking-wide mb-4">{isAntipattern ? 'Deep Dive: Top 3 Anti-Patterns' : 'Deep Dive: Top 3 Maturity Gaps'}</h4>
          {topOffenders.map((item) => (
            <div key={item.id} className={`p-5 rounded-2xl border ${isAntipattern ? 'bg-rose-950/20 border-rose-900/30' : 'bg-emerald-950/20 border-emerald-900/30'}`}>
              <div className="flex items-center gap-3 mb-2">
                <span className={`text-xs font-mono font-bold ${isAntipattern ? 'text-rose-400' : 'text-emerald-400'}`}>{item.id}</span>
                <h5 className="text-sm font-bold text-slate-200">{item.title}</h5>
                <span className={`ml-auto text-[10px] font-bold px-2 py-0.5 rounded uppercase ${isAntipattern ? 'bg-rose-900/50 text-rose-300' : 'bg-slate-800 text-slate-400'}`}>{item.status}</span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed italic mb-3">"{item.reasoning}"</p>
              {item.evidence_quotes && item.evidence_quotes.length > 0 && (
                <div className="mb-3 space-y-2">
                  {item.evidence_quotes.map((eq, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs bg-slate-800/50 p-2 rounded-lg border border-white/5">
                      <span className="text-amber-400 mt-0.5">"</span>
                      <span className="text-slate-300 italic">{eq.quote}</span>
                      {eq.section && <span className="text-slate-500 ml-auto text-[10px] whitespace-nowrap">[{eq.section}]</span>}
                    </div>
                  ))}
                </div>
              )}
              <div className={`flex items-start gap-2 text-xs font-medium p-3 rounded-lg ${isAntipattern ? 'text-rose-300 bg-rose-900/20' : 'text-emerald-300 bg-emerald-900/20'}`}>
                <span className="text-lg leading-none">&#9889;</span>
                <span><strong>Action:</strong> {isAntipattern ? `Address ${item.title.toLowerCase()} to reduce anti-pattern burden.` : `Implement ${item.title.toLowerCase()} to advance FinOps maturity.`}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        {ALL_CRITERIA_IDS.map((key) => {
          const item = data[key] || { count: 0, status: isAntipattern ? "OK" : "NOK", evidence: "", evidence_quotes: [], is_silent: true };
          const def = metadataMap.get(key) || { title: "Unknown", description: "No definition found." };
          const statusStyle = getStatusStyle(item, isAntipattern);
          const labelColor = getStatusLabelColor(item, isAntipattern);
          const firstSentence = def.description.split('. ')[0] + '.';
          return (
            <div key={key} className={`p-5 rounded-2xl border flex flex-col justify-between ${statusStyle} min-h-[160px] group transition-all duration-300 hover:scale-[1.02] hover:shadow-lg relative overflow-hidden`}>
              {!item.is_silent && <div className={`absolute -right-10 -top-10 w-24 h-24 rounded-full blur-2xl opacity-10 pointer-events-none ${isAntipattern ? 'bg-rose-500' : 'bg-emerald-500'}`}></div>}
              <div className="mb-2 relative z-10">
                <div className="flex justify-between items-start mb-2">
                  <span className="font-mono text-xs font-bold opacity-50">{key}</span>
                  {!item.is_silent && <span className={`text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md ${labelColor}`}>{item.status}</span>}
                </div>
                <h4 className="font-display font-bold text-sm leading-tight mb-2 text-slate-200">{def.title}</h4>
                <p className="text-xs text-slate-300 leading-relaxed opacity-90">{firstSentence}</p>
              </div>
              <div className="flex gap-1.5 mt-auto opacity-80">
                {[1, 2, 3].map(i => (
                  <div key={i} className={`h-1 flex-1 rounded-full transition-all duration-500 ${i <= item.count && !item.is_silent ? (isAntipattern ? 'bg-rose-500 shadow-[0_0_5px_rgba(244,63,94,0.5)]' : 'bg-emerald-500 shadow-[0_0_5px_rgba(16,185,129,0.5)]') : 'bg-slate-700/50'}`}></div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const StrategicRoadmap: React.FC<RoadmapProps> = ({ steps }) => (
  <div className="space-y-8 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-slate-700 before:to-transparent">
    {steps.map((step, index) => (
      <div key={index} className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active">
        <div className="flex items-center justify-center w-10 h-10 rounded-full border-4 border-slate-900 bg-slate-800 text-slate-400 shadow-lg shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 group-[.is-active]:bg-emerald-500 group-[.is-active]:text-white group-[.is-active]:shadow-[0_0_15px_rgba(16,185,129,0.5)] transition-all">
          <span className="font-bold text-xs">{index + 1}</span>
        </div>
        <div className="w-[calc(100%-4rem)] md:w-[calc(50%-2.5rem)] bg-slate-900/50 backdrop-blur-md p-6 rounded-2xl border border-white/10 shadow-sm hover:shadow-md hover:border-emerald-500/30 transition-all">
          <h4 className="font-display font-bold text-lg text-slate-100 mb-4 flex items-center gap-2">{step.phase}</h4>
          <ul className="space-y-3">
            {step.actions.map((action, i) => (
              <li key={i} className="flex items-start gap-3 text-sm text-slate-300 leading-relaxed">
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0 shadow-[0_0_5px_rgba(52,211,153,0.5)]"></span>
                <div className="flex-1"><MarkdownRenderer content={action} /></div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    ))}
  </div>
);

export const ComparisonChart: React.FC<RadarProps> = ({ maturity, antipattern }) => {
  const data = useMemo(() => {
    const categories = [
      { id: 'A', label: 'Visibility' },
      { id: 'B', label: 'Optimization' },
      { id: 'C', label: 'Governance' },
      { id: 'D', label: 'Architecture' },
      { id: 'E', label: 'Culture' }
    ];
    return categories.map(cat => {
      let mScore = 0; let aScore = 0;
      Object.entries(maturity).forEach(([key, item]) => { const ai = item as AuditItem; if (key.startsWith(cat.id)) mScore += ai.count; });
      Object.entries(antipattern).forEach(([key, item]) => { const ai = item as AuditItem; if (key.startsWith(cat.id)) aScore += ai.count; });
      return { subject: cat.label, Maturity: Math.round((mScore / 15) * 100), 'Anti-Patterns': Math.round((aScore / 15) * 100), fullMark: 100 };
    });
  }, [maturity, antipattern]);

  return (
    <div className="w-full h-full min-h-[300px] relative">
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart cx="50%" cy="50%" outerRadius="70%" data={data}>
          <PolarGrid stroke="#334155" />
          <PolarAngleAxis dataKey="subject" tick={{ fill: '#cbd5e1', fontSize: 10, fontWeight: 'bold' }} />
          <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} axisLine={false} />
          <Radar name="Maturity" dataKey="Maturity" stroke="#10b981" strokeWidth={2} fill="#10b981" fillOpacity={0.3} />
          <Radar name="Anti-Patterns" dataKey="Anti-Patterns" stroke="#f43f5e" strokeWidth={2} fill="#f43f5e" fillOpacity={0.3} />
          <Legend iconType="circle" wrapperStyle={{ fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase', paddingTop: '20px', color: '#cbd5e1' }} />
          <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderRadius: '12px', border: '1px solid #1e293b', boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.5)', color: '#fff' }} itemStyle={{ fontSize: '12px', fontWeight: 'bold' }} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
};

export const ReferenceLibrary: React.FC = () => {
  const [activeStream, setActiveStream] = useState<'maturity' | 'antipattern'>('maturity');
  const [dataset, setDataset] = useState<'criteria' | 'signals'>('criteria');

  const batches = useMemo(() => {
    if (!BATCH_DEFINITIONS) return [];
    return Object.entries(BATCH_DEFINITIONS).map(([key, def]) => {
      const xml = activeStream === 'maturity' ? def.maturity : def.antipattern;
      const items = parseDefinitions(xml);
      return { id: key, title: def.title, items };
    });
  }, [activeStream]);

  return (
    <div className="max-w-[90rem] mx-auto animate-fade-in pb-32">
      <div className="text-center mb-12 relative z-10 px-4">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-slate-900/50 border border-slate-700 mb-6 shadow-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
          <span className="text-[11px] font-bold uppercase tracking-widest text-slate-400">Knowledge Base</span>
        </div>
        <h2 className="text-5xl md:text-7xl font-display font-black text-white mb-6 tracking-tight drop-shadow-lg">FinOps Forensic Lens</h2>
        <p className="text-xl text-slate-300 max-w-3xl mx-auto leading-relaxed font-light">
          The specific behavioral signals used by the AI to detect <strong className="text-emerald-400 font-bold">FinOps Maturity</strong> vs. <strong className="text-rose-400 font-bold">Anti-Patterns</strong>.
        </p>
      </div>

      <div className="sticky top-4 z-40 px-4 flex flex-col items-center gap-6 mb-16">
        <div className="glass-panel p-2 rounded-2xl inline-flex bg-slate-900/80 backdrop-blur-xl shadow-2xl border border-white/10 ring-1 ring-black/50">
          <button onClick={() => setActiveStream('maturity')} className={`px-6 md:px-10 py-3 md:py-4 rounded-xl text-sm font-bold transition-all duration-300 flex items-center gap-3 ${activeStream === 'maturity' ? 'bg-emerald-500 text-white shadow-[0_0_20px_rgba(16,185,129,0.4)]' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`}>
            <span className={`w-2 h-2 rounded-full ${activeStream === 'maturity' ? 'bg-white shadow-[0_0_10px_white]' : 'bg-emerald-500'}`}></span>
            Stream A: Maturity
          </button>
          <button onClick={() => setActiveStream('antipattern')} className={`px-6 md:px-10 py-3 md:py-4 rounded-xl text-sm font-bold transition-all duration-300 flex items-center gap-3 ${activeStream === 'antipattern' ? 'bg-rose-500 text-white shadow-[0_0_20px_rgba(244,63,94,0.4)]' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`}>
            <span className={`w-2 h-2 rounded-full ${activeStream === 'antipattern' ? 'bg-white shadow-[0_0_10px_white]' : 'bg-rose-500'}`}></span>
            Stream B: Anti-Patterns
          </button>
        </div>

        <div className="inline-flex bg-slate-800/80 backdrop-blur-sm p-1 rounded-xl shadow-inner border border-white/5">
          <button onClick={() => setDataset('criteria')} className={`px-5 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${dataset === 'criteria' ? 'bg-slate-700 text-white shadow-sm border border-white/10' : 'text-slate-500 hover:text-slate-300 hover:bg-slate-700/50'}`}>Active Audit Logic (A1-E5)</button>
          <button onClick={() => setDataset('signals')} className={`px-5 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${dataset === 'signals' ? 'bg-slate-700 text-white shadow-sm border border-white/10' : 'text-slate-500 hover:text-slate-300 hover:bg-slate-700/50'}`}>Signal Corpus (50 Items)</button>
        </div>
      </div>

      {dataset === 'criteria' ? (
        <div className="space-y-32 px-6 md:px-12 animate-fade-in-up">
          {batches.map((batch) => (
            <div key={batch.id} className="relative">
              <div className="flex flex-col md:flex-row md:items-end justify-between mb-12 border-b border-slate-800 pb-8">
                <div>
                  <div className={`flex items-center gap-3 mb-2 font-mono text-sm font-bold ${activeStream === 'maturity' ? 'text-emerald-400' : 'text-rose-400'}`}>
                    <span className={`w-8 h-8 rounded-lg flex items-center justify-center text-white shadow-lg ${activeStream === 'maturity' ? 'bg-emerald-500 shadow-emerald-500/20' : 'bg-rose-500 shadow-rose-500/20'}`}>{batch.id}</span>
                    <span className="uppercase tracking-widest opacity-90">Domain {batch.id}</span>
                  </div>
                  <h3 className="text-4xl font-display font-bold text-white">{batch.title}</h3>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-6">
                {batch.items.map((item, idx) => (
                  <div key={idx} className={`flex flex-col h-full p-6 rounded-3xl border transition-all duration-500 hover:-translate-y-2 hover:shadow-2xl bg-slate-900/60 backdrop-blur-sm ${activeStream === 'maturity' ? 'border-emerald-900/30 hover:border-emerald-500/50 hover:shadow-emerald-900/20' : 'border-rose-900/30 hover:border-rose-500/50 hover:shadow-rose-900/20'}`}>
                    <div className="mb-6">
                      <div className="flex justify-between items-start mb-4">
                        <span className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded-lg uppercase tracking-wider border ${activeStream === 'maturity' ? 'bg-emerald-950/30 text-emerald-300 border-emerald-900/50' : 'bg-rose-950/30 text-rose-300 border-rose-900/50'}`}>{item.id}</span>
                      </div>
                      <h4 className="font-display font-bold text-slate-100 text-lg leading-tight mb-3">{item.title}</h4>
                      <p className="text-sm text-slate-300 leading-relaxed">{item.description}</p>
                    </div>
                    <div className={`mt-auto pt-6 border-t border-dashed ${activeStream === 'maturity' ? 'border-emerald-900/30' : 'border-rose-900/30'}`}>
                      <span className="text-[9px] font-bold uppercase tracking-widest text-slate-400 mb-3 block">Audit Criteria</span>
                      <div className="space-y-3">
                        {item.criteria.split('\n').filter(l => l.trim()).map((line, i) => (
                          <div key={i} className="flex gap-3 items-start group/line">
                            <span className={`flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold mt-0.5 transition-colors ${activeStream === 'maturity' ? 'bg-emerald-950 text-emerald-500 group-hover/line:bg-emerald-500 group-hover/line:text-white' : 'bg-rose-950 text-rose-500 group-hover/line:bg-rose-500 group-hover/line:text-white'}`}>{i + 1}</span>
                            <p className="text-[11px] text-slate-400 leading-snug group-hover/line:text-slate-200 transition-colors">{line.replace(/^\d+\.\s*/, '')}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-6 md:px-12 animate-fade-in-up">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {(activeStream === 'maturity' ? MASTER_BINGO_FINOPS.maturity : MASTER_BINGO_FINOPS.antipattern).map((item) => (
              <div key={item.id} className={`p-6 rounded-2xl border transition-all duration-300 hover:shadow-lg group bg-slate-900/60 backdrop-blur-sm ${activeStream === 'maturity' ? 'border-emerald-900/30 hover:border-emerald-500/50 hover:bg-emerald-950/20' : 'border-rose-900/30 hover:border-rose-500/50 hover:bg-rose-950/20'}`}>
                <div className="flex items-center justify-between mb-3">
                  <span className={`text-[10px] font-black font-mono px-2 py-1 rounded border ${activeStream === 'maturity' ? 'bg-emerald-950/40 text-emerald-300 border-emerald-900' : 'bg-rose-950/40 text-rose-300 border-rose-900'}`}>{item.id}</span>
                </div>
                <h4 className="font-bold text-slate-200 mb-2 leading-snug">{item.title}</h4>
                <p className="text-xs text-slate-400 leading-relaxed opacity-90 group-hover:opacity-100">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
