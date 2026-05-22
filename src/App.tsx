import React, { useState, useRef, useEffect } from 'react';
import { analyzeDocument } from './services/geminiService';
import { scanInputText, sanitizeInput } from './services/preFlightService';
import { extractPagesFromPdf, imageFileToInput } from './services/pdfService';
import type { PdfParseQuality } from './services/pdfService';
import { renderDelimitedTableForAnalysis } from './services/tableService';
import { downloadMasterDataReport, downloadSummaryReport } from './services/exportService';
import { forensicSanitizeImport } from './services/securityService';
import { extractDiagnosticResultFromHtmlReport, isDiagnosticResultPayload, parseDiagnosticResultJson, serializeDiagnosticResultForHtml } from './services/reportImportService';
import { PerformanceMonitor } from './services/debugService';
import { runFullDriftSuite } from './services/driftDetectionService';
import { DiagnosticResult, ScanResult, PersonaId, PERSONA_IDS, PERSONA_LABELS, ImageInput } from './types';
import { METRIC_DESCRIPTIONS } from './constants';
import { GaugeCard, AuditGrid, StrategicRoadmap, ComparisonChart, ReferenceLibrary, QualityGateBanner, BenchmarkingChart, TransferProtocol, MarkdownRenderer, NeuralLoadingGrid } from './components/DashboardComponents';
import { ReportView } from './components/ReportView';
import { LoginModal } from './components/LoginModal';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { checkSession, logout } from './services/authService';
import goldenCrawl from '../test/golden-crawl.txt?raw';
import goldenWalk from '../test/golden-walk.txt?raw';
import goldenRun from '../test/golden-run.txt?raw';
import tier1GovernancePolicy from '../test/tier1-governance-policy.txt?raw';
import tier1TaggingPolicy from '../test/tier1-tagging-policy.txt?raw';
import tier1CoeCharter from '../test/tier1-coe-charter.txt?raw';
import tier1CloudStrategy from '../test/tier1-cloud-strategy.txt?raw';
import tier1RiSpStrategy from '../test/tier1-ri-sp-strategy.txt?raw';
import tier1CostOptReview from '../test/tier1-cost-optimization-review.txt?raw';
import demoSimulation from '../test/demo-simulation.txt?raw';

const DRIFT_FIXTURES = [
  { name: 'golden-crawl.txt', text: goldenCrawl },
  { name: 'golden-walk.txt', text: goldenWalk },
  { name: 'golden-run.txt', text: goldenRun },
];
const DRIFT_LABEL = 'Drift Test — Combined Golden Fixtures';
const DEMO_SIMULATION_LABEL = 'Engine Simulation — Northstar Retail Demo Pack';
const SAVED_ASSESSMENT_KEY = 'finops:last-assessment:v1';

const readSavedAssessment = (): DiagnosticResult | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(SAVED_ASSESSMENT_KEY);
    if (!raw) return null;
    const parsed = parseDiagnosticResultJson(raw);
    return parsed.kind === 'report' ? parsed.result : null;
  } catch {
    return null;
  }
};

const saveAssessmentToSession = (result: DiagnosticResult) => {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(SAVED_ASSESSMENT_KEY, serializeDiagnosticResultForHtml(result));
  } catch (error) {
    console.warn('[FinOps] Could not save assessment recovery payload', error);
  }
};

const clearSavedAssessment = () => {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(SAVED_ASSESSMENT_KEY);
  } catch {
    // Ignore unavailable browser storage.
  }
};

const TIER1_FIXTURES: Array<{ pack_id: string; name: string; label: string; text: string }> = [
  { pack_id: 'tier1-governance-policy', name: 'tier1-governance-policy.txt', label: 'Cloud Governance / FinOps Policy', text: tier1GovernancePolicy },
  { pack_id: 'tier1-tagging-policy', name: 'tier1-tagging-policy.txt', label: 'Tagging & Cost Allocation Policy', text: tier1TaggingPolicy },
  { pack_id: 'tier1-coe-charter', name: 'tier1-coe-charter.txt', label: 'FinOps CoE Charter', text: tier1CoeCharter },
  { pack_id: 'tier1-cloud-strategy', name: 'tier1-cloud-strategy.txt', label: 'Cloud Strategy (3-Year Plan)', text: tier1CloudStrategy },
  { pack_id: 'tier1-ri-sp-strategy', name: 'tier1-ri-sp-strategy.txt', label: 'RI / Savings Plan Strategy', text: tier1RiSpStrategy },
  { pack_id: 'tier1-cost-optimization-review', name: 'tier1-cost-optimization-review.txt', label: 'Quarterly Cost Optimization Review', text: tier1CostOptReview }
];

const PER_PACK_FIXTURES: Array<{ pack_id: string; name: string; label: string; text: string }> = [
  { pack_id: 'golden-crawl', name: 'golden-crawl.txt', label: 'Golden — Crawl-stage org', text: goldenCrawl },
  { pack_id: 'golden-walk', name: 'golden-walk.txt', label: 'Golden — Walk-stage org', text: goldenWalk },
  { pack_id: 'golden-run', name: 'golden-run.txt', label: 'Golden — Run-stage org', text: goldenRun },
  ...TIER1_FIXTURES
];

interface UploadedFile {
  id: string;
  name: string;
  size: number;
  text: string;
  images?: ImageInput[];
  kind?: 'pdf' | 'html' | 'image' | 'csv' | 'tsv' | 'json';
  status: 'parsed' | 'error';
  scan?: ScanResult;
  parseMetadata?: {
    totalPages?: number;
    parsedTextPages?: number;
    renderedImagePages?: number;
    rowCount?: number;
    parseQuality?: PdfParseQuality;
    warnings: string[];
  };
}

const extractTextFromHtml = (html: string): string => {
  const cleanHtml = forensicSanitizeImport(html);
  const parser = new DOMParser();
  const doc = parser.parseFromString(cleanHtml, 'text/html');
  doc.querySelectorAll('script, style').forEach(s => s.remove());
  return doc.body.textContent || "";
};

const PrivacyProtocolCard = () => (
  <div className="max-w-[85rem] mx-auto mt-12 mb-20 animate-fade-in relative z-10 px-4">
    <div className="flex items-center justify-center gap-2 mb-8 opacity-90">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_10px_rgba(16,185,129,0.8)]"></span>
      <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-emerald-400">Zero-Retention Protocol Active</span>
    </div>
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
      {[
        { icon: 'M13 10V3L4 14h7v7l9-11h-7z', title: "Ephemeral", desc: "RAM Only" },
        { icon: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z', title: "Local-First", desc: "Client Parsing" },
        { icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z', title: "No Retention", desc: "Stateless API" },
        { icon: 'M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88', title: "Financial Safety", desc: "DLP Scanning" }
      ].map((item, idx) => (
        <div key={idx} className="bg-slate-900/70 backdrop-blur-sm p-4 rounded-2xl border border-white/10 flex items-center gap-4 shadow-sm hover:shadow-[0_0_15px_rgba(255,255,255,0.05)] transition-all hover:bg-slate-800/70">
          <div className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center text-slate-400 border border-white/5">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d={item.icon} /></svg>
          </div>
          <div>
            <h5 className="text-xs font-bold text-slate-200 uppercase tracking-wide">{item.title}</h5>
            <p className="text-[10px] text-slate-400 font-medium">{item.desc}</p>
          </div>
        </div>
      ))}
    </div>
  </div>
);

const App: React.FC = () => {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [parsing, setParsing] = useState(false);
  const [aggregatedText, setAggregatedText] = useState('');
  const [aggregatedImages, setAggregatedImages] = useState<ImageInput[]>([]);
  const [result, setResult] = useState<DiagnosticResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState<'audit' | 'calc' | 'strategy' | null>(null);
  const [auditProgress, setAuditProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'audit' | 'strategy' | 'reference'>('overview');
  const [viewMode, setViewMode] = useState<'dashboard' | 'report'>('dashboard');
  const [scanResult, setScanResult] = useState<ScanResult>({ score: 0, status: 'Insufficient', message: 'Waiting...', details: [], canRun: false });
  const [authenticated, setAuthenticated] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [activePersona, setActivePersona] = useState<PersonaId>('finops_lead');
  const [deepMode, setDeepMode] = useState(false);
  const [perPackRunning, setPerPackRunning] = useState(false);
  const [perPackCurrent, setPerPackCurrent] = useState<number>(0);
  const [perPackCurrentLabel, setPerPackCurrentLabel] = useState<string>('');
  const [perPackReport, setPerPackReport] = useState<ReturnType<typeof runFullDriftSuite> | null>(null);
  const [perPackError, setPerPackError] = useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [hasSavedAssessment, setHasSavedAssessment] = useState(false);
  const pendingAnalyzeRef = useRef(false);
  const pendingDriftRef = useRef(false);
  const pendingPerPackRef = useRef(false);
  const pendingSimulationRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const clearFileInput = () => {
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  useEffect(() => {
    checkSession().then(setAuthenticated);
    const saved = readSavedAssessment();
    setHasSavedAssessment(Boolean(saved));
    if (saved) {
      setResult(saved);
      setRecoveryNotice('Restored the last completed assessment from this browser session.');
    }
  }, []);

  useEffect(() => {
    if (!result) return;
    saveAssessmentToSession(result);
    setHasSavedAssessment(true);
  }, [result]);

  const MIN_FILES = 2;
  const MAX_FILES = 20;
  const MAX_TOTAL_UPLOAD_MB = 25;
  const MAX_IMAGE_FILES = 5;
  const MAX_TOTAL_UPLOAD_BYTES = MAX_TOTAL_UPLOAD_MB * 1024 * 1024;

  const makeLowRelevanceWarning = (scan: ScanResult, kind?: UploadedFile['kind']): ScanResult => ({
    ...scan,
    status: 'PassWithWarning',
    message: kind === 'csv' || kind === 'tsv' ? 'Tabular input accepted' : 'Low relevance warning',
    canRun: true,
    confidence_warning: scan.confidence_warning || 'This file has weak FinOps keyword signal. The assessment will run, but unsupported areas should be treated as insufficient evidence.',
    details: [
      ...scan.details,
      'Accepted as parseable source material; evidence gates will determine whether it supports FinOps findings.'
    ]
  });

  const scanParseableFile = (text: string, kind?: UploadedFile['kind'], hasImages = false): ScanResult => {
    const scan = scanInputText(text);
    if (scan.canRun) return scan;
    if (hasImages || text.trim().length > 0) return makeLowRelevanceWarning(scan, kind);
    return scan;
  };

  const parseQualityLabel = (quality?: PdfParseQuality['quality']): string | null => {
    if (quality === 'good') return 'Good text extraction';
    if (quality === 'mixed') return 'Mixed extraction: some visual/scanned pages included';
    if (quality === 'poor') return 'Poor extraction: likely scanned/image-heavy PDF';
    return null;
  };

  const buildParseQualitySourceNote = (file: UploadedFile): string => {
    const parseQuality = file.parseMetadata?.parseQuality;
    if (!parseQuality || parseQuality.quality === 'good') return '';
    const warnings = parseQuality.warnings.length > 0
      ? parseQuality.warnings.join(' ')
      : 'PDF text extraction may be incomplete.';
    return [
      '[SOURCE_PARSE_QUALITY]',
      `PDF parse quality: ${parseQuality.quality}.`,
      `Text coverage ratio: ${Math.round(parseQuality.textCoverageRatio * 100)}%.`,
      `Sparse text pages: ${parseQuality.sparseTextPages}.`,
      `Visual pages included: ${parseQuality.visualPagesIncluded}; visual candidates skipped: ${parseQuality.visualPagesSkipped}.`,
      `Likely scanned PDF: ${parseQuality.likelyScannedPdf ? 'yes' : 'no'}.`,
      `Warning: ${warnings}`,
      'Use source evidence cautiously where PDF text extraction may be incomplete; do not treat this parse-quality note as a FinOps maturity finding.',
      '[/SOURCE_PARSE_QUALITY]'
    ].join('\n');
  };

  const sourceParseWarningsForFiles = (sourceFiles: UploadedFile[]): string[] => {
    return sourceFiles
      .filter(file => file.parseMetadata?.parseQuality && file.parseMetadata.parseQuality.quality !== 'good')
      .flatMap(file => {
        const parseQuality = file.parseMetadata!.parseQuality!;
        const warnings = parseQuality.warnings.length > 0
          ? parseQuality.warnings
          : ['PDF text extraction may be incomplete.'];
        return warnings.map(warning => `${file.name}: ${warning}`);
      });
  };

  useEffect(() => {
    const combined = files
      .filter(f => f.text && f.text.length > 0)
      .map(f => {
        const parseQualityNote = buildParseQualitySourceNote(f);
        return `\n<DOCUMENT name="${f.name}">\n${parseQualityNote ? `${parseQualityNote}\n\n` : ''}${f.text}\n</DOCUMENT>\n`;
      })
      .join('\n');
    setAggregatedText(combined);
    const images = files.flatMap(f => f.images || []);
    setAggregatedImages(images);
  }, [files]);

  useEffect(() => {
    if (!aggregatedText && aggregatedImages.length === 0) {
      setScanResult({ score: 0, status: 'Insufficient', message: 'Upload Required', details: [], canRun: false });
      return;
    }
    const timer = setTimeout(() => {
      PerformanceMonitor.start('GlobalScan');
      const hasImages = aggregatedImages.length > 0;
      const globalScan = aggregatedText
        ? scanInputText(aggregatedText)
        : { score: 60, status: 'PassWithWarning' as const, message: 'Image-only input', details: [`${aggregatedImages.length} image(s) submitted; LLM DLP will validate relevance.`], canRun: true };
      if (hasImages && !globalScan.canRun) {
        globalScan.canRun = true;
        globalScan.status = 'PassWithWarning';
        globalScan.message = globalScan.message || 'Image content present';
        globalScan.details = [...globalScan.details, `${aggregatedImages.length} image(s) attached; text keyword scan bypassed.`];
      } else if (!globalScan.canRun && files.length > 0) {
        globalScan.canRun = true;
        globalScan.status = 'PassWithWarning';
        globalScan.message = 'Low relevance warning';
        globalScan.confidence_warning = globalScan.confidence_warning || 'Input appears weak or generic. The engine will run and evidence gates should classify unsupported areas as insufficient evidence.';
        globalScan.details = [
          ...globalScan.details,
          'Parseable source material is accepted; low relevance is handled by Phase 1 evidence checks and Phase 2 quality gates.'
        ];
      }
      const fileCountValid = files.length >= MIN_FILES && files.length <= MAX_FILES;
      if (!fileCountValid) {
        globalScan.canRun = false;
        globalScan.message = files.length < MIN_FILES ? "Need more files" : "Too many files";
      }
      const lowSignalFiles = files.filter(f => f.kind !== 'image' && f.scan && (f.scan.status === 'Insufficient' || f.scan.status === 'PassWithWarning'));
      if (lowSignalFiles.length > 0) {
        globalScan.status = globalScan.status === 'Ready' ? 'PassWithWarning' : globalScan.status;
        globalScan.details.push(`${lowSignalFiles.length} file(s) have low FinOps keyword signal and will be assessed with evidence-gated confidence.`);
      }
      setScanResult(globalScan);
      PerformanceMonitor.end('GlobalScan');
    }, 300);
    return () => clearTimeout(timer);
  }, [aggregatedText, aggregatedImages, files]);

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files) return;
    const newFiles = Array.from(event.target.files);

    if (newFiles.length === 1) {
      const file = newFiles[0];
      if (file.type === 'text/html' || file.name.endsWith('.html')) {
        const text = await file.text();
        const imported = extractDiagnosticResultFromHtmlReport(text);
        if (imported.kind === 'report') {
          setResult(imported.result);
          setViewMode('dashboard');
          setRecoveryNotice('Imported a saved FinOps report from HTML.');
          setError(null);
          clearFileInput();
          return;
        }
        if (imported.kind === 'invalid_report') {
          setError(imported.error);
          clearFileInput();
          return;
        }
      } else if (file.type === 'application/json' || file.name.endsWith('.json')) {
        try {
          const text = await file.text();
          const json = JSON.parse(text);
          if (isDiagnosticResultPayload(json)) {
            setResult(json);
            setViewMode('dashboard');
            setRecoveryNotice('Imported a saved FinOps report from JSON.');
            setError(null);
            clearFileInput();
            return;
          }
        } catch (e) { console.error("Failed to parse JSON file", e); }
      }
    }

    if (result) {
      setError('A completed assessment is currently open. Use Reset Session before uploading new source material; the current report is preserved.');
      clearFileInput();
      return;
    }

    if (files.length + newFiles.length > MAX_FILES) {
      setError(`Maximum ${MAX_FILES} documents allowed.`);
      return;
    }

    const totalUploadBytes = files.reduce((sum, file) => sum + file.size, 0) + newFiles.reduce((sum, file) => sum + file.size, 0);
    if (totalUploadBytes > MAX_TOTAL_UPLOAD_BYTES) {
      setError(`Maximum ${MAX_TOTAL_UPLOAD_MB} MB total upload set allowed.`);
      return;
    }

    // Reject composite drift fixtures. These describe three DIFFERENT
    // archetype organizations (Crawl / Walk / Run) and were never meant to
    // be assessed together — doing so produces a "consolidated audit across
    // the corpus" that mixes the three orgs' evidence into one fictional
    // composite. Route them to the Drift Test panel instead.
    const driftFixturePattern = /^golden-(crawl|walk|run)\.txt$/i;
    const driftFiles = [...files, ...newFiles].filter(f => driftFixturePattern.test(('name' in f ? f.name : '')));
    if (driftFiles.length >= 2) {
      setError(`Multiple drift fixtures detected (${driftFiles.map(f => f.name).join(', ')}). These describe DIFFERENT archetype organizations and must not be combined into one assessment. Use the Drift Test panel for comparison runs.`);
      return;
    }

    // Cap on JPEG/PNG screenshot files (independent of PDF-derived images,
    // which scale with the source document). Counted across existing +
    // incoming images so a second upload can't sneak past the limit.
    const existingImageCount = files.filter(f => f.kind === 'image').length;
    const incomingImageCount = newFiles.filter(f => f.type.startsWith('image/')).length;
    if (existingImageCount + incomingImageCount > MAX_IMAGE_FILES) {
      setError(`Maximum ${MAX_IMAGE_FILES} image files (PNG/JPG) per assessment. You have ${existingImageCount}; trying to add ${incomingImageCount}.`);
      return;
    }

    setParsing(true);
    setError(null);
    const processedFiles: UploadedFile[] = [];
    try {
      for (const file of newFiles) {
        let text = "";
        let images: ImageInput[] | undefined;
        let kind: UploadedFile['kind'] = undefined;
        let parseMetadata: UploadedFile['parseMetadata'] | undefined;
        const lowerName = file.name.toLowerCase();

        if (file.type === 'application/pdf' || lowerName.endsWith('.pdf')) {
          const { text: pdfText, images: pdfImages, metadata } = await extractPagesFromPdf(file);
          text = pdfText;
          images = pdfImages;
          kind = 'pdf';
          parseMetadata = {
            totalPages: metadata.totalPages,
            parsedTextPages: metadata.parsedTextPages,
            renderedImagePages: metadata.renderedImagePages,
            parseQuality: metadata.parseQuality,
            warnings: metadata.warnings
          };
        } else if (file.type === 'text/html' || lowerName.endsWith('.html')) {
          const rawHtml = await file.text();
          text = extractTextFromHtml(rawHtml);
          kind = 'html';
        } else if (file.type === 'text/csv' || lowerName.endsWith('.csv')) {
          const raw = await file.text();
          const rendered = renderDelimitedTableForAnalysis(raw, { fileName: file.name, delimiter: ',' });
          text = rendered.text;
          kind = 'csv';
          parseMetadata = { rowCount: Number(text.match(/^Rows: (\d+)/m)?.[1] || 0), warnings: rendered.warnings };
        } else if (file.type === 'text/tab-separated-values' || lowerName.endsWith('.tsv')) {
          const raw = await file.text();
          const rendered = renderDelimitedTableForAnalysis(raw, { fileName: file.name, delimiter: '\t' });
          text = rendered.text;
          kind = 'tsv';
          parseMetadata = { rowCount: Number(text.match(/^Rows: (\d+)/m)?.[1] || 0), warnings: rendered.warnings };
        } else if (file.type === 'application/json' || lowerName.endsWith('.json')) {
          const raw = await file.text();
          text = `Format: JSON\n\n${raw}`;
          kind = 'json';
        } else if (file.type.startsWith('image/')) {
          const img = await imageFileToInput(file);
          images = [img];
          text = `[Image input: ${file.name}]`;
          kind = 'image';
        } else {
          throw new Error(`File ${file.name} is not a supported format (PDF, HTML, CSV, TSV, JSON, PNG, JPG).`);
        }

        processedFiles.push({
          id: Math.random().toString(36).substr(2, 9),
          name: file.name,
          size: file.size,
          text,
          images,
          kind,
          status: 'parsed',
          scan: scanParseableFile(text, kind, Boolean(images?.length)),
          parseMetadata
        });
      }
      setFiles(prev => [...prev, ...processedFiles]);
    } catch (e: any) {
      setError(e.message || "Failed to parse files.");
    } finally {
      setParsing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const removeFile = (id: string) => setFiles(files.filter(f => f.id !== id));

  const runAnalyze = async (opts?: { textOverride?: string; imagesOverride?: ImageInput[]; label?: string }) => {
    setLoading(true);
    setLoadingStage('audit');
    setAuditProgress(0);
    setError(null);
    PerformanceMonitor.start('FullAnalysis');
    try {
      const safeText = opts?.textOverride ?? sanitizeInput(aggregatedText);
      const images = opts?.imagesOverride ?? aggregatedImages;
      const data = await analyzeDocument(safeText, images, (stage, progress) => {
        setLoadingStage(stage);
        if (progress !== undefined) setAuditProgress(progress);
      }, { deepMode });
      if (!data.phase_2_validation?.metrics) throw new Error("Analysis returned incomplete data.");
      if (opts?.label) {
        data.meta = { ...data.meta, document_analyzed: opts.label };
      }
      const source_parse_warnings = sourceParseWarningsForFiles(files);
      if (source_parse_warnings.length > 0) {
        data.meta = { ...data.meta, source_parse_warnings };
      }
      setResult(data);
    } catch (e: any) {
      setError(e.message || "Analysis failed.");
    } finally {
      setLoading(false);
      setLoadingStage(null);
      PerformanceMonitor.end('FullAnalysis');
    }
  };

  const startDriftTest = () => {
    const combined = DRIFT_FIXTURES
      .map(f => `\n<DOCUMENT name="${f.name}">\n${f.text}\n</DOCUMENT>\n`)
      .join('\n');
    runAnalyze({ textOverride: sanitizeInput(combined), imagesOverride: [], label: DRIFT_LABEL });
  };

  const startTier1Fixture = (packId: string) => {
    if (loading) return;
    const fixture = TIER1_FIXTURES.find(f => f.pack_id === packId);
    if (!fixture) return;
    if (!authenticated) {
      pendingDriftRef.current = true;
      setShowLogin(true);
      return;
    }
    const wrapped = `\n<DOCUMENT name="${fixture.name}">\n${fixture.text}\n</DOCUMENT>\n`;
    runAnalyze({ textOverride: sanitizeInput(wrapped), imagesOverride: [], label: `Tier 1 Fixture — ${fixture.label}` });
  };

  const startPerPackDrift = async () => {
    setPerPackRunning(true);
    setPerPackReport(null);
    setPerPackError(null);
    setPerPackCurrent(0);
    setPerPackCurrentLabel('');
    PerformanceMonitor.start('PerPackDriftSuite');

    const accumulated: Array<{
      packId: string;
      phase1Logs: { maturity: Record<string, any>; antipattern: Record<string, any> };
      classification: string;
      readiness: number;
    }> = [];

    try {
      for (let i = 0; i < PER_PACK_FIXTURES.length; i++) {
        const fixture = PER_PACK_FIXTURES[i];
        setPerPackCurrent(i + 1);
        setPerPackCurrentLabel(fixture.label);
        console.log(`[PerPackDrift] (${i + 1}/${PER_PACK_FIXTURES.length}) ${fixture.pack_id}`);
        const safeText = sanitizeInput(`\n<DOCUMENT name="${fixture.name}">\n${fixture.text}\n</DOCUMENT>\n`);
        const data = await analyzeDocument(safeText, [], () => {});
        if (!data.phase_2_validation?.metrics) {
          throw new Error(`Analysis for ${fixture.pack_id} returned incomplete data.`);
        }
        accumulated.push({
          packId: fixture.pack_id,
          phase1Logs: data.phase_1_audit_logs,
          classification: data.phase_2_validation.crawl_walk_run,
          readiness: data.phase_2_validation.metrics.finops_readiness
        });
      }
      const report = runFullDriftSuite(accumulated);
      console.log(report.report);
      setPerPackReport(report);
    } catch (err: any) {
      setPerPackError(err?.message || 'Per-Pack Drift Suite failed.');
      console.error('[PerPackDrift] Failed:', err);
    } finally {
      setPerPackRunning(false);
      setPerPackCurrent(0);
      setPerPackCurrentLabel('');
      PerformanceMonitor.end('PerPackDriftSuite');
    }
  };

  const handlePerPackDrift = () => {
    if (loading || perPackRunning) return;
    if (!authenticated) {
      pendingPerPackRef.current = true;
      setShowLogin(true);
      return;
    }
    const confirmMsg = `Per-Pack Drift will run ${PER_PACK_FIXTURES.length} sequential analyses (3 maturity-stratified + 6 Tier 1 fixtures). ` +
      `Each analysis is a full Phase 1+2+3 pass. Expect ~10–15 minutes and meaningful API cost. Proceed?`;
    if (!window.confirm(confirmMsg)) return;
    startPerPackDrift();
  };

  const handleAnalyze = async () => {
    if ((!aggregatedText && aggregatedImages.length === 0) || !scanResult.canRun) return;
    if (!authenticated) {
      pendingAnalyzeRef.current = true;
      setShowLogin(true);
      return;
    }
    await runAnalyze();
  };

  const handleDriftTest = () => {
    if (loading) return;
    if (!authenticated) {
      pendingDriftRef.current = true;
      setShowLogin(true);
      return;
    }
    startDriftTest();
  };

  const startEngineSimulation = () => {
    runAnalyze({
      textOverride: sanitizeInput(demoSimulation),
      imagesOverride: [],
      label: DEMO_SIMULATION_LABEL
    });
  };

  const handleEngineSimulation = () => {
    if (loading) return;
    if (!authenticated) {
      pendingSimulationRef.current = true;
      setShowLogin(true);
      return;
    }
    startEngineSimulation();
  };

  const reset = () => {
    setResult(null);
    setFiles([]);
    setAggregatedText('');
    setAggregatedImages([]);
    setError(null);
    setLoadingStage(null);
    setActiveTab('overview');
    setViewMode('dashboard');
    setRecoveryNotice(null);
    setHasSavedAssessment(false);
    clearSavedAssessment();
  };

  const restoreSavedAssessment = () => {
    const saved = readSavedAssessment();
    if (!saved) {
      setHasSavedAssessment(false);
      setError('No saved assessment was found in this browser session.');
      return;
    }
    setResult(saved);
    setViewMode('dashboard');
    setActiveTab('overview');
    setRecoveryNotice('Restored the last completed assessment from this browser session.');
    setError(null);
    setHasSavedAssessment(true);
  };

  const clearSavedAssessmentAndRestart = () => {
    clearSavedAssessment();
    setHasSavedAssessment(false);
    setRecoveryNotice(null);
    reset();
  };

  const downloadSavedAssessment = () => {
    const saved = readSavedAssessment();
    if (!saved) {
      setHasSavedAssessment(false);
      return;
    }
    const blob = new Blob([JSON.stringify(saved, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `FinOps_Recovered_Assessment_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const showReference = !result && activeTab === 'reference';

  if (result && viewMode === 'report') {
    return (
      <AppErrorBoundary
        hasSavedAssessment={hasSavedAssessment}
        onRestoreSaved={restoreSavedAssessment}
        onDownloadSaved={downloadSavedAssessment}
        onClearSaved={clearSavedAssessmentAndRestart}
      >
        <ReportView
          result={result}
          onBack={() => setViewMode('dashboard')}
          onDownloadSummary={() => downloadSummaryReport(result)}
          onDownloadMaster={() => downloadMasterDataReport(result)}
        />
      </AppErrorBoundary>
    );
  }

  return (
    <AppErrorBoundary
      hasSavedAssessment={hasSavedAssessment}
      onRestoreSaved={restoreSavedAssessment}
      onDownloadSaved={downloadSavedAssessment}
      onClearSaved={clearSavedAssessmentAndRestart}
    >
    <div className="min-h-screen font-sans relative overflow-x-hidden selection:bg-emerald-500/30 selection:text-white flex flex-col">
      <header className="sticky top-0 z-50 glass-panel border-b border-white/5 transition-all duration-300 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3 cursor-pointer group" onClick={() => setActiveTab('overview')}>
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-600 to-teal-700 border border-white/10 flex items-center justify-center font-bold text-white shadow-lg shadow-emerald-900/20 text-xl transition-all duration-300 group-hover:scale-105 group-hover:rotate-3 group-hover:shadow-emerald-500/20 group-hover:border-emerald-500/50">
              F
            </div>
            <div className="leading-tight">
              <h1 className="text-lg font-display font-bold tracking-tight text-white group-hover:text-emerald-400 transition-colors">FinOps Engine</h1>
              <span className="text-[10px] uppercase tracking-widest text-emerald-200 font-semibold group-hover:text-white transition-colors">Assessment Suite v1.0</span>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-950/30 border border-emerald-900/50 shadow-sm">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-400">System Online</span>
            </div>

            <button
              onClick={async () => {
                if (authenticated) {
                  await logout();
                  setAuthenticated(false);
                } else {
                  pendingAnalyzeRef.current = false;
                  setShowLogin(true);
                }
              }}
              className={`hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full border text-[10px] font-bold uppercase tracking-widest transition-colors ${
                authenticated
                  ? 'bg-emerald-950/30 border-emerald-900/50 text-emerald-400 hover:text-white hover:border-emerald-500'
                  : 'bg-slate-900/50 border-slate-700 text-slate-400 hover:text-white hover:border-amber-500'
              }`}
              title={authenticated ? 'Click to log out' : 'Click to log in'}
            >
              <span>{authenticated ? '🔓' : '🔒'}</span>
              <span>{authenticated ? 'Unlocked' : 'Locked'}</span>
            </button>

            {!result && (
              <button onClick={() => setActiveTab(activeTab === 'reference' ? 'overview' : 'reference')} className="text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-white transition-colors px-4 py-2 rounded-lg hover:bg-white/5">
                {activeTab === 'reference' ? 'Close Reference' : 'View Criteria'}
              </button>
            )}

            {authenticated && !loading && !result && (
              <button
                onClick={handleDriftTest}
                className="text-xs font-bold uppercase tracking-widest text-amber-300 hover:text-white bg-amber-950/30 hover:bg-amber-700/40 border border-amber-700/40 hover:border-amber-400 transition-colors px-4 py-2 rounded-lg"
                title="Run the assessment against the bundled golden fixtures (crawl + walk + run combined)"
              >
                Drift Test
              </button>
            )}

            {authenticated && !loading && !result && (
              <select
                onChange={(e) => { if (e.target.value) { startTier1Fixture(e.target.value); e.target.value = ''; } }}
                defaultValue=""
                className="text-xs font-bold uppercase tracking-widest text-sky-300 hover:text-white bg-sky-950/30 hover:bg-sky-700/40 border border-sky-700/40 hover:border-sky-400 transition-colors px-4 py-2 rounded-lg cursor-pointer"
                title="Run the assessment against a single Tier 1 document-type fixture to test narrow-doc behavior"
              >
                <option value="" disabled>Tier 1 Fixture…</option>
                {TIER1_FIXTURES.map(f => (
                  <option key={f.pack_id} value={f.pack_id}>{f.label}</option>
                ))}
              </select>
            )}

            {authenticated && !loading && !result && (
              <button
                onClick={handlePerPackDrift}
                disabled={perPackRunning}
                className="text-xs font-bold uppercase tracking-widest text-fuchsia-300 hover:text-white bg-fuchsia-950/30 hover:bg-fuchsia-700/40 border border-fuchsia-700/40 hover:border-fuchsia-400 transition-colors px-4 py-2 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
                title="Run each golden fixture (3 maturity + 6 Tier 1) sequentially through the full pipeline, then compare scores against per-criterion expected ranges in golden_baselines.json. ~10–15 minutes."
              >
                {perPackRunning ? `Drift ${perPackCurrent}/${PER_PACK_FIXTURES.length}…` : 'Per-Pack Drift'}
              </button>
            )}

            {(result || files.length > 0) && (
              <button onClick={reset} disabled={loading} className={`text-sm font-bold transition-all duration-300 flex items-center gap-2 group px-4 py-2 rounded-full border shadow-lg ${loading ? 'bg-slate-800 border-slate-700 text-slate-500 cursor-not-allowed' : 'bg-white text-slate-900 border-white hover:border-rose-500 hover:bg-rose-500 hover:text-white hover:shadow-rose-500/40'}`}>
                <span className={`transition-transform duration-500 ${!loading && 'group-hover:-rotate-180'}`}>&#8635;</span>
                {loading ? 'Analyzing...' : 'Reset Session'}
              </button>
            )}
          </div>
        </div>
      </header>

      {recoveryNotice && (
        <div className="relative z-30 mx-auto mt-4 w-[calc(100%-2rem)] max-w-7xl rounded-2xl border border-emerald-500/30 bg-emerald-950/80 px-5 py-3 text-sm text-emerald-100 shadow-lg shadow-emerald-950/20 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <span>{recoveryNotice}</span>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setRecoveryNotice(null)}
              className="rounded-lg border border-emerald-400/30 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-emerald-100 hover:bg-emerald-400/10"
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={() => {
                clearSavedAssessment();
                setHasSavedAssessment(false);
                setRecoveryNotice(null);
              }}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-slate-300 hover:bg-white/10"
            >
              Clear saved assessment
            </button>
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-6 pt-12 flex-grow w-full relative z-20">
        {!result && !showReference && (
          <div className="max-w-5xl mx-auto mt-8 transition-all duration-500 ease-in-out animate-fade-in-up">
            {!loading ? (
              <>
                <div className="text-center mb-16 relative">
                  <h2 className="text-6xl md:text-8xl font-display font-black text-white mb-6 tracking-tight leading-[0.9] drop-shadow-xl">
                    FinOps <br />
                    <span className="text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 via-teal-400 to-cyan-400 animate-gradient-x drop-shadow-none filter brightness-110">Assessment Engine</span>
                  </h2>
                  <p className="text-lg md:text-xl text-slate-300 font-light max-w-3xl mx-auto leading-relaxed">
                    Your cloud spend is either a strategic asset or a hidden liability. This <strong>forensic assessment tool</strong> interrogates your FinOps documentation against <strong>25 maturity vectors and 25 anti-pattern indicators</strong> to determine your Crawl-Walk-Run classification.
                  </p>
                  <div className="mt-8 flex flex-col sm:flex-row justify-center items-center gap-3">
                      <a
                        href="https://honourable-peacock.static2.website/finops-engine-structure-thinking-14052026"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-emerald-300 hover:text-white bg-emerald-950/30 hover:bg-emerald-700/40 border border-emerald-700/40 hover:border-emerald-400 transition-colors px-5 py-2.5 rounded-full"
                      >
                        <span>How the FinOps Assessment Engine thinks</span>
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                        </svg>
                      </a>
                      <button
                        type="button"
                        onClick={handleEngineSimulation}
                        disabled={loading}
                        className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-cyan-300 hover:text-white bg-cyan-950/30 hover:bg-cyan-700/40 border border-cyan-700/40 hover:border-cyan-400 transition-colors px-5 py-2.5 rounded-full disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Run the real engine against a bundled synthetic FinOps demo pack"
                      >
                        <span>Engine - Simulation</span>
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                      </button>
                    </div>
                </div>

                <div className={`glass-panel rounded-[3rem] shadow-[0_0_50px_rgba(0,0,0,0.3)] border relative overflow-hidden group transition-all duration-500 ${files.length >= MIN_FILES ? 'border-emerald-500/50 ring-2 ring-emerald-500/20 shadow-[0_0_50px_rgba(16,185,129,0.1)]' : 'border-white/10'}`}>
                  <div className="p-12 min-h-[320px] flex flex-col relative bg-gradient-to-b from-slate-900/60 to-slate-900/40">
                    {files.length > 0 ? (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-20">
                        {files.map((file) => (
                          <div key={file.id} className={`bg-slate-800/60 backdrop-blur-md p-5 rounded-2xl border flex items-center justify-between group/file transition-all animate-fade-in ${file.scan?.status === 'Insufficient' ? 'border-rose-900/50 shadow-[0_0_20px_rgba(244,63,94,0.1)]' : 'border-white/5 hover:border-emerald-500/30 hover:shadow-[0_0_20px_rgba(16,185,129,0.1)]'}`}>
                            <div className="flex items-center gap-4 overflow-hidden">
                              <div className={`w-12 h-12 rounded-xl flex items-center justify-center shadow-inner text-xl border border-white/5 ${file.scan?.status === 'Insufficient' ? 'bg-rose-950/50' : 'bg-slate-900'}`}>
                                {file.scan?.status === 'Insufficient' ? '⚠️' : '📄'}
                              </div>
                              <div className="truncate">
                                <div className={`text-sm font-bold truncate max-w-[180px] ${file.scan?.status === 'Insufficient' ? 'text-rose-400' : 'text-slate-200'}`}>{file.name}</div>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className={`w-1.5 h-1.5 rounded-full ${file.scan?.status === 'Insufficient' ? 'bg-rose-500' : file.scan?.status === 'Weak' || file.scan?.status === 'PassWithWarning' ? 'bg-amber-500' : 'bg-emerald-500'}`}></span>
                                  <div className="text-[10px] text-slate-400 uppercase tracking-wide font-medium">
                                    {file.scan?.status === 'Insufficient' ? 'Unreadable / Empty' : file.scan?.status === 'PassWithWarning' ? 'Low Relevance Warning' : file.scan?.status === 'Weak' ? 'Weak Signal' : 'Ready'} &bull; {(file.size / 1024).toFixed(0)} KB
                                  </div>
                                </div>
                                {file.parseMetadata && (
                                  <div className="text-[10px] text-slate-500 mt-1 truncate max-w-[240px]">
                                    {file.kind === 'pdf' && `${file.parseMetadata.parsedTextPages}/${file.parseMetadata.totalPages} pages parsed · ${file.parseMetadata.renderedImagePages} visual pages`}
                                    {(file.kind === 'csv' || file.kind === 'tsv') && `${file.parseMetadata.rowCount} table rows parsed`}
                                    {file.parseMetadata.warnings.length > 0 && ` · ${file.parseMetadata.warnings[0]}`}
                                  </div>
                                )}
                                {file.parseMetadata?.parseQuality && (
                                  <div className={`text-[10px] mt-1 font-bold uppercase tracking-wide ${
                                    file.parseMetadata.parseQuality.quality === 'poor'
                                      ? 'text-rose-300'
                                      : file.parseMetadata.parseQuality.quality === 'mixed'
                                        ? 'text-amber-300'
                                        : 'text-emerald-300'
                                  }`}>
                                    {parseQualityLabel(file.parseMetadata.parseQuality.quality)}
                                  </div>
                                )}
                              </div>
                            </div>
                            <button onClick={() => removeFile(file.id)} className="p-2 text-slate-500 hover:text-rose-400 transition-colors rounded-full hover:bg-rose-950/30">&times;</button>
                          </div>
                        ))}
                        {parsing && (
                          <div className="bg-slate-800/40 p-4 rounded-2xl border border-slate-700 border-dashed flex items-center justify-center animate-pulse">
                            <span className="text-xs font-bold text-emerald-400">Extracting text...</span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div onClick={() => fileInputRef.current?.click()} className="flex-1 flex flex-col items-center justify-center text-slate-500 border-2 border-dashed border-slate-700/50 rounded-[2rem] bg-slate-900/30 py-16 hover:bg-slate-900/50 hover:scale-[1.01] transition-all duration-300 hover:border-emerald-500/30 group/drop cursor-pointer relative overflow-hidden">
                        <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/0 via-emerald-500/0 to-emerald-500/5 opacity-0 group-hover/drop:opacity-100 transition-opacity duration-500 pointer-events-none"></div>
                        <div className="w-24 h-24 rounded-full bg-slate-800/80 border-4 border-slate-700 flex items-center justify-center mb-6 shadow-xl shadow-black/20 group-hover/drop:scale-110 group-hover/drop:shadow-emerald-500/20 group-hover/drop:border-emerald-500/30 transition-all duration-300 z-10 relative">
                          <div className="absolute inset-0 rounded-full border border-emerald-400 opacity-0 group-hover/drop:opacity-100 group-hover/drop:animate-ping"></div>
                          <svg className="w-10 h-10 text-slate-400 group-hover/drop:text-emerald-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
                        </div>
                        <h3 className="text-xl font-display font-bold text-slate-200 mb-2 z-10 group-hover/drop:text-white transition-colors">Drop FinOps Artifacts</h3>
                        <p className="text-sm font-medium text-slate-400 z-10 group-hover/drop:text-emerald-200/70 transition-colors text-center max-w-md">
                          Upload Cloud Cost Reports, FinOps Policies, Optimization Plans, Governance Docs, Architecture Reviews.
                        </p>
                        <div className="z-10 mt-4 flex flex-wrap justify-center gap-1.5 max-w-md">
                          {['PDF', 'HTML', 'CSV', 'TSV', 'JSON', 'PNG', 'JPG'].map(fmt => (
                            <span key={fmt} className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md bg-slate-800/80 border border-slate-700/60 text-slate-300">
                              {fmt}
                            </span>
                          ))}
                        </div>
                        <p className="z-10 text-xs text-slate-500 mt-3 text-center max-w-md">
                          {MAX_TOTAL_UPLOAD_MB} MB total set · {MIN_FILES}–{MAX_FILES} artifacts · PDFs parsed up to 100 pages · up to {MAX_IMAGE_FILES} PNG/JPG screenshots
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="flex justify-between items-center px-10 py-6 bg-slate-900/60 backdrop-blur-xl relative z-10 border-t border-white/5">
                    <div className="flex items-center gap-4">
                      <button onClick={() => fileInputRef.current?.click()} disabled={files.length >= MAX_FILES} className="text-sm font-bold text-slate-400 hover:text-white transition-colors flex items-center gap-2 hover:bg-white/5 px-4 py-2 rounded-lg">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
                        Add Files (PDF, HTML, CSV, TSV, JSON, PNG, JPG)
                      </button>
                      <label
                        title="Forces synthesis to use Opus 4.7 (slower, more expensive, deeper roadmap reasoning). Auto-enabled for crawl-stage orgs with high anti-pattern burden."
                        className="flex items-center gap-2 text-xs text-slate-400 hover:text-white cursor-pointer select-none px-3 py-2 rounded-lg hover:bg-white/5 transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={deepMode}
                          onChange={(e) => setDeepMode(e.target.checked)}
                          className="accent-emerald-500 cursor-pointer"
                        />
                        <span className="font-bold">Deep analysis (Opus 4.7)</span>
                      </label>
                    </div>
                    <input type="file" ref={fileInputRef} onChange={handleFileSelect} className="hidden" accept=".pdf,.html,.csv,.tsv,.json,.png,.jpg,.jpeg,text/csv,text/tab-separated-values,image/png,image/jpeg" multiple />
                    <button onClick={handleAnalyze} disabled={!scanResult.canRun || files.length < MIN_FILES || files.length > MAX_FILES} className={`px-8 py-4 rounded-xl font-bold shadow-2xl transition-all transform active:scale-[0.98] flex items-center gap-3 border ${!scanResult.canRun || files.length < MIN_FILES || files.length > MAX_FILES ? 'bg-slate-800 text-slate-500 border-slate-700 cursor-not-allowed shadow-none' : 'text-slate-900 bg-white border-white hover:bg-emerald-400 hover:border-emerald-400 hover:shadow-[0_0_30px_rgba(16,185,129,0.4)]'}`}>
                      {!scanResult.canRun || files.length < MIN_FILES || files.length > MAX_FILES ? (
                        <span>{files.length < MIN_FILES ? `Add ${MIN_FILES - files.length} more files` : files.length > MAX_FILES ? "Limit Exceeded" : "Checks Failed"}</span>
                      ) : (
                        <>
                          <span>Run FinOps Assessment</span>
                          <svg className="w-5 h-5 opacity-80" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg>
                        </>
                      )}
                    </button>
                  </div>
                </div>

                <PrivacyProtocolCard />
                {error && (
                  <div className="mt-6 p-6 rounded-2xl border flex items-start gap-4 shadow-sm animate-fade-in bg-rose-950/20 border-rose-900/50 text-rose-300">
                    <h4 className="font-bold">Error</h4>
                    <p>{error}</p>
                  </div>
                )}
              </>
            ) : (
              <NeuralLoadingGrid progress={auditProgress} stage={loadingStage || 'audit'} />
            )}
          </div>
        )}

        {result && viewMode === 'dashboard' && (
          <div className="animate-fade-in space-y-12 mb-20">
            <div className="flex justify-center mb-8">
              <div className="glass-panel p-1.5 rounded-2xl flex gap-1 bg-slate-900/60">
                {[
                  { id: 'overview', label: 'Summary & Diagnosis' },
                  { id: 'audit', label: 'Forensic Audit' },
                  { id: 'strategy', label: 'Optimization Roadmap' }
                ].map(tab => (
                  <button key={tab.id} onClick={() => setActiveTab(tab.id as any)} className={`px-8 py-3 rounded-xl text-sm font-bold transition-all duration-300 ${activeTab === tab.id ? 'bg-white text-slate-900 shadow-lg' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}>{tab.label}</button>
                ))}
              </div>
            </div>

            {activeTab === 'overview' && (
              <div className="animate-fade-in space-y-8">
                <div className="glass-panel p-10 md:p-14 rounded-[2rem] hover:bg-slate-900/60 transition-all duration-500">
                  <div className="flex items-start gap-6 mb-8">
                    <div className="flex items-center justify-center w-12 h-12 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-bold font-display text-lg shadow-[0_0_15px_rgba(16,185,129,0.2)] flex-shrink-0">01</div>
                    <div>
                      <h3 className="text-2xl font-display font-bold text-white mb-2">Evidence Summary</h3>
                      <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
                        Classification: <span className={`${result.phase_2_validation.crawl_walk_run.includes('Insufficient') || result.phase_2_validation.crawl_walk_run.includes('Crawl') ? 'text-rose-400' : result.phase_2_validation.crawl_walk_run.includes('Run') ? 'text-emerald-400' : 'text-amber-400'}`}>{result.phase_2_validation.crawl_walk_run}</span>
                      </p>
                    </div>
                  </div>
                  <div className="pl-4 md:pl-20 border-l-2 border-emerald-500/20">
                    <div className="mb-6 flex flex-wrap items-center gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mr-2">Persona Lens:</span>
                      {PERSONA_IDS.map(p => (
                        <button
                          key={p}
                          onClick={() => setActivePersona(p)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all duration-200 ${activePersona === p ? 'bg-emerald-500 text-slate-900 shadow-[0_0_15px_rgba(16,185,129,0.4)]' : 'bg-white/5 text-slate-300 hover:bg-white/10 border border-white/10'}`}
                        >
                          {PERSONA_LABELS[p]}
                        </button>
                      ))}
                    </div>
                    <MarkdownRenderer content={result.phase_3_strategy.executive_summaries?.[activePersona] || result.phase_3_strategy.executive_summary} />
                    {result.phase_3_strategy.evidence_summary && (
                      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-3">
                        {result.phase_3_strategy.evidence_summary.key_metrics?.map((metric, i) => (
                          <div key={i} className="p-3 rounded-lg bg-white/5 border border-white/10 text-xs text-slate-300">{metric}</div>
                        ))}
                      </div>
                    )}
                    {(() => {
                      const claims = result.quality_gate?.fact_check?.unsupported_claims || [];
                      const personaClaims = claims.filter(c => c.source_location === activePersona);
                      if (personaClaims.length === 0) return null;
                      return (
                        <div className="mt-6 p-5 rounded-xl bg-amber-500/10 border border-amber-500/30">
                          <div className="flex items-center gap-2 mb-3">
                            <svg className="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M4.93 19h14.14a2 2 0 001.74-3l-7.07-12a2 2 0 00-3.48 0L3.2 16a2 2 0 001.73 3z" /></svg>
                            <span className="text-xs font-bold uppercase tracking-widest text-amber-300">Confidence Notes — Unverified Claims</span>
                          </div>
                          <p className="text-xs text-amber-100/80 mb-3">The following statements in this summary could not be verified against your source after {result.quality_gate?.fact_check?.attempts || 0} regenerate pass(es). Treat with caution.</p>
                          <ul className="space-y-2">
                            {personaClaims.map((c, i) => (
                              <li key={i} className="text-sm text-amber-50">
                                <span className="italic">&ldquo;{c.claim}&rdquo;</span>
                                <span className="block text-xs text-amber-200/70 mt-0.5">{c.rationale}{c.failure_type ? ` · ${c.failure_type.replace(/_/g, ' ')}` : ''}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })()}
                  </div>
                  <TransferProtocol />
                  <div className="mt-12 flex flex-col md:flex-row justify-center items-center gap-6 w-full">
                    <button onClick={() => setViewMode('report')} className="group relative px-8 py-4 rounded-2xl bg-white hover:bg-emerald-50 border border-white shadow-[0_0_20px_rgba(255,255,255,0.1)] hover:shadow-[0_0_30px_rgba(16,185,129,0.4)] transition-all duration-300">
                      <div className="relative flex items-center gap-4">
                        <div className="w-10 h-10 rounded-full bg-slate-900 text-white flex items-center justify-center shadow-inner group-hover:bg-emerald-500 transition-colors">
                          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                        </div>
                        <div className="text-left">
                          <span className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 group-hover:text-emerald-600">Final Artifact</span>
                          <span className="block text-sm font-bold text-slate-900">Review & Download Report</span>
                        </div>
                      </div>
                    </button>
                  </div>
                </div>

                <QualityGateBanner gate={result.quality_gate} />

                {(() => {
                  const claims = result.quality_gate?.fact_check?.unsupported_claims || [];
                  const withMaterial = claims.filter(c => c.missing_material);
                  if (withMaterial.length === 0) return null;
                  const byType: Record<string, string[]> = {};
                  for (const c of withMaterial) {
                    const key = c.failure_type ? c.failure_type.replace(/_/g, ' ') : 'other';
                    (byType[key] ||= []).push(c.missing_material!);
                  }
                  return (
                    <div className="glass-panel p-8 md:p-10 rounded-[2rem] bg-slate-900/40 border border-amber-500/20">
                      <div className="flex items-start gap-4 mb-5">
                        <div className="flex items-center justify-center w-10 h-10 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold text-sm flex-shrink-0">!</div>
                        <div>
                          <h3 className="text-lg font-display font-bold text-white">Source Coverage Gaps</h3>
                          <p className="text-xs text-slate-400 mt-1">To strengthen the next assessment cycle, include the following kinds of evidence in the source document.</p>
                        </div>
                      </div>
                      <div className="space-y-4 pl-14">
                        {Object.entries(byType).map(([type, materials]) => (
                          <div key={type}>
                            <p className="text-[10px] font-bold uppercase tracking-widest text-amber-300 mb-2">{type}</p>
                            <ul className="space-y-1.5">
                              {Array.from(new Set(materials)).map((m, i) => (
                                <li key={i} className="flex items-start gap-2 text-sm text-slate-300">
                                  <span className="mt-1.5 w-1 h-1 rounded-full bg-amber-400 shrink-0"></span>
                                  <span>{m}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {result.phase_3_strategy.diagnosis && (
                  <div className="glass-panel p-8 md:p-10 rounded-[2rem] bg-slate-900/40 border border-white/10">
                    <div className="flex items-start gap-4 mb-5">
                      <div className="flex items-center justify-center w-10 h-10 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 font-bold text-sm flex-shrink-0">02</div>
                      <div>
                        <h3 className="text-lg font-display font-bold text-white">Diagnosis</h3>
                        <p className="text-xs text-slate-400 mt-1">Interpretation of the evidence. Recommendations remain separated in the roadmap tab.</p>
                      </div>
                    </div>
                    <div className="pl-14 space-y-4">
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-300 mb-2">Primary bottleneck</p>
                        <p className="text-sm text-slate-200">{result.phase_3_strategy.diagnosis.primary_bottleneck}</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-300 mb-2">Root causes</p>
                        <ul className="space-y-1.5">
                          {result.phase_3_strategy.diagnosis.root_causes?.map((cause, i) => (
                            <li key={i} className="flex items-start gap-2 text-sm text-slate-300"><span className="mt-1.5 w-1 h-1 rounded-full bg-cyan-400 shrink-0"></span><span>{cause}</span></li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                )}

                {result.phase_3_strategy.planning_decision && (
                  <div className="glass-panel p-8 md:p-10 rounded-[2rem] bg-slate-900/40 border border-emerald-500/20">
                    <div className="flex items-start gap-4 mb-5">
                      <div className="flex items-center justify-center w-10 h-10 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold text-sm flex-shrink-0">03</div>
                      <div>
                        <h3 className="text-lg font-display font-bold text-white">Planning Decision: {result.phase_3_strategy.planning_decision.decision?.replace('_', ' ')}</h3>
                        <p className="text-xs text-slate-400 mt-1">{result.phase_3_strategy.planning_decision.rationale}</p>
                      </div>
                    </div>
                  </div>
                )}


                <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                  <div className="md:col-span-2 md:row-span-2">
                    <GaugeCard
                      size="large"
                      value={result.phase_2_validation.metrics.finops_readiness}
                      label="Evidence-Gated Readiness"
                      color={result.quality_gate.decision === 'BLOCK' ? '#f43f5e' : '#10b981'}
                      trend="positive"
                      subLabel={result.phase_2_validation.metrics.readiness_cap_reason ? `Capped at ${Math.round(result.phase_2_validation.metrics.readiness_cap ?? result.phase_2_validation.metrics.finops_readiness)}%` : 'Validated Index'}
                      description={result.phase_2_validation.metrics.readiness_cap_reason || METRIC_DESCRIPTIONS.finops_readiness}
                    />
                  </div>
                  <div className="md:col-span-1">
                    <GaugeCard value={result.phase_2_validation.metrics.maturity_ratio} label="Maturity Level" color="#14b8a6" trend="positive" description={METRIC_DESCRIPTIONS.maturity_ratio} />
                  </div>
                  <div className="md:col-span-1">
                    <GaugeCard value={result.phase_2_validation.metrics.maturity_depth} label="Maturity Depth" color="#06b6d4" trend="positive" description={METRIC_DESCRIPTIONS.maturity_depth} />
                  </div>
                  <div className="md:col-span-1">
                    <GaugeCard value={result.phase_2_validation.metrics.antipattern_ratio} label="Anti-Pattern Level" color="#f43f5e" trend="negative" description={METRIC_DESCRIPTIONS.antipattern_ratio} />
                  </div>
                  <div className="md:col-span-1">
                    <GaugeCard value={result.phase_2_validation.metrics.antipattern_burden} label="Anti-Pattern Burden" color="#e11d48" trend="negative" description={METRIC_DESCRIPTIONS.antipattern_burden} />
                  </div>
                  <div className="md:col-span-1">
                    <GaugeCard value={result.phase_2_validation.metrics.antipattern_clearance} label="Anti-Pattern Clearance" color="#10b981" trend="positive" description={METRIC_DESCRIPTIONS.antipattern_clearance} />
                  </div>
                  <div className="md:col-span-1">
                    <GaugeCard value={result.phase_2_validation.metrics.antipattern_coverage} label="Anti-Pattern Coverage" color="#64748b" trend="positive" description={METRIC_DESCRIPTIONS.antipattern_coverage} />
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 h-full items-stretch">
                  <div className="h-full lg:col-span-3">
                    <BenchmarkingChart
                      x={result.phase_2_validation.metrics.maturity_depth}
                      y={result.phase_2_validation.metrics.antipattern_burden}
                      evidenceDensity={result.phase_2_validation.metrics.evidence_density}
                      antipatternCoverage={result.phase_2_validation.metrics.antipattern_coverage}
                      qualityGateDecision={result.quality_gate.decision}
                    />
                  </div>
                  <div className="glass-panel p-8 rounded-[2rem] bg-slate-900/50 flex flex-col lg:col-span-2 border-white/5">
                    <h3 className="text-xl font-display font-bold text-white mb-6">Domain Balance</h3>
                    <div className="flex-1 min-h-[300px]">
                      <ComparisonChart maturity={result.phase_1_audit_logs.maturity} antipattern={result.phase_1_audit_logs.antipattern} />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'audit' && (
              <div className="animate-fade-in grid grid-cols-1 gap-8">
                <AuditGrid title="FinOps Maturity Audit" data={result.phase_1_audit_logs.maturity} isAntipattern={false} />
                <AuditGrid title="Anti-Pattern Detection" data={result.phase_1_audit_logs.antipattern} isAntipattern={true} />
              </div>
            )}

            {activeTab === 'strategy' && (
              <div className="animate-fade-in">
                {!result.phase_3_strategy.remediation_roadmap.length ? (
                  <div className="text-center py-24 glass-panel rounded-[3rem]">
                    <h3 className="text-2xl font-bold text-slate-400">Strategy Aborted</h3>
                    <p className="text-slate-500 mt-2">Insufficient data to generate roadmap.</p>
                  </div>
                ) : (
                  <div className="glass-panel p-10 md:p-16 rounded-[3rem] bg-slate-900/40">
                    <div className="text-center mb-16 max-w-2xl mx-auto">
                      <span className="text-xs font-bold uppercase tracking-widest text-emerald-400 mb-3 block">Phase 3</span>
                      <h2 className="text-4xl font-display font-bold text-white mb-4">Optimization Roadmap</h2>
                      <p className="text-slate-400">A structured Crawl-Walk-Run path to FinOps excellence.</p>
                    </div>
                    <StrategicRoadmap steps={result.phase_3_strategy.remediation_roadmap} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {showReference && (
          <div className="mt-8 mb-20">
            <ReferenceLibrary />
          </div>
        )}
      </main>

      <footer className="border-t border-white/5 bg-slate-900/50 backdrop-blur-md mt-auto relative z-10">
        <div className="max-w-7xl mx-auto px-6 py-12 grid grid-cols-1 md:grid-cols-3 gap-8 items-center text-center md:text-left">
          <div className="space-y-4">
            <div className="flex items-center justify-center md:justify-start gap-3 opacity-60 hover:opacity-100 transition-opacity">
              <div className="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center font-bold text-white text-sm">F</div>
              <span className="font-display font-bold text-slate-300">FinOps Assessment Engine</span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed max-w-xs mx-auto md:mx-0">
              Assessment Suite v1.0<br />Multi-Model Architecture (Gemini Pro + Claude Opus)
            </p>
          </div>

          <div className="flex justify-center">
            <a href="https://www.linkedin.com/in/jori-santeri-eskolin-571055312/" target="_blank" rel="noopener noreferrer" className="group flex items-center gap-3 p-4 rounded-2xl bg-slate-800/50 border border-white/5 hover:border-emerald-500/50 hover:shadow-[0_0_20px_rgba(16,185,129,0.1)] transition-all duration-300">
              <div className="w-10 h-10 rounded-full bg-slate-900 flex items-center justify-center text-slate-500 group-hover:bg-[#0077b5] group-hover:text-white transition-colors border border-white/5">
                <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24"><path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z"/></svg>
              </div>
              <div className="text-left">
                <span className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 group-hover:text-emerald-400 transition-colors">Architect</span>
                <span className="text-sm font-bold text-slate-300 group-hover:text-white">Strategic Architecture by Jori Santeri Eskolin</span>
              </div>
            </a>
          </div>

          <div className="flex flex-col items-center md:items-end gap-3">
            <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-950/40 border border-emerald-900/60 text-[10px] font-bold text-emerald-400 uppercase tracking-widest cursor-default">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_5px_rgba(16,185,129,0.8)]"></span>
              Zero-Retention Protocol
            </div>
          </div>
        </div>
      </footer>

      {perPackRunning && (
        <div className="fixed inset-0 z-[60] bg-slate-950/85 backdrop-blur-md flex items-center justify-center px-6">
          <div className="max-w-xl w-full glass-panel rounded-3xl p-10 border border-fuchsia-500/30 bg-slate-900/70 text-center">
            <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-fuchsia-300 mb-3">Per-Pack Drift Suite</div>
            <h3 className="text-2xl font-display font-bold text-white mb-2">Running {perPackCurrent} of {PER_PACK_FIXTURES.length}</h3>
            <p className="text-sm text-slate-300 mb-6">{perPackCurrentLabel}</p>
            <div className="w-full h-2 bg-white/5 rounded-full overflow-hidden mb-6">
              <div
                className="h-full bg-gradient-to-r from-fuchsia-500 to-violet-500 transition-all duration-500"
                style={{ width: `${(perPackCurrent / PER_PACK_FIXTURES.length) * 100}%` }}
              />
            </div>
            <p className="text-xs text-slate-400">
              Each fixture runs through the full Phase 1 + 2 + 3 pipeline. Scores are accumulated and compared against per-criterion baselines once all fixtures complete.
            </p>
          </div>
        </div>
      )}

      {perPackReport && !perPackRunning && (
        <div className="fixed inset-0 z-[60] bg-slate-950/90 backdrop-blur-md flex items-start justify-center px-6 py-10 overflow-y-auto">
          <div className="max-w-5xl w-full glass-panel rounded-3xl p-10 border border-fuchsia-500/30 bg-slate-900/80">
            <div className="flex items-center justify-between gap-4 mb-6">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-fuchsia-300 mb-2">Per-Pack Drift Report</div>
                <h3 className="text-2xl font-display font-bold text-white">
                  Overall Status: <span className={
                    perPackReport.overall_status === 'CLEAN' ? 'text-emerald-400' :
                    perPackReport.overall_status === 'MINOR_VARIANCE' ? 'text-amber-300' :
                    'text-rose-400'
                  }>{perPackReport.overall_status.replace('_', ' ')}</span>
                </h3>
              </div>
              <button
                onClick={() => setPerPackReport(null)}
                className="text-xs font-bold uppercase tracking-widest text-slate-300 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 transition-colors px-4 py-2 rounded-lg"
              >
                Close
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
              {perPackReport.results.map(r => {
                const status = r.threshold_exceeded || !r.classification_match ? 'DRIFT' : r.criterion_violations.length > 0 ? 'VARIANCE' : 'CLEAN';
                const color = status === 'CLEAN' ? 'border-emerald-500/30 text-emerald-300 bg-emerald-500/5' : status === 'VARIANCE' ? 'border-amber-500/30 text-amber-300 bg-amber-500/5' : 'border-rose-500/30 text-rose-300 bg-rose-500/5';
                return (
                  <div key={r.pack_id} className={`p-4 rounded-xl border ${color}`}>
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <p className="font-mono text-[11px] text-slate-300 break-all">{r.pack_id}</p>
                      <span className="text-[10px] font-bold uppercase tracking-wider shrink-0">{status}</span>
                    </div>
                    <p className="text-xs text-slate-400 mb-1">
                      Classification: <span className="text-slate-200">{r.actual_classification}</span> (expected {r.expected_classification}) {r.classification_match ? '✓' : '✗'}
                    </p>
                    <p className="text-xs text-slate-400 mb-1">
                      Readiness: <span className="text-slate-200">{Math.round(r.actual_readiness)}%</span> (expected {r.expected_readiness_range[0]}–{r.expected_readiness_range[1]}%) {r.readiness_in_range ? '✓' : '✗'}
                    </p>
                    <p className="text-xs text-slate-400">
                      Violations: <span className="text-slate-200">{r.criterion_violations.length}</span> · Total deviation: <span className="text-slate-200">{r.total_deviation}</span>
                    </p>
                  </div>
                );
              })}
            </div>

            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">Full Report (console-format)</p>
              <pre className="text-xs text-slate-300 bg-slate-950/60 border border-white/5 rounded-xl p-4 overflow-x-auto whitespace-pre-wrap max-h-[500px] overflow-y-auto leading-relaxed">{perPackReport.report}</pre>
            </div>
          </div>
        </div>
      )}

      {perPackError && !perPackRunning && (
        <div className="fixed inset-0 z-[60] bg-slate-950/90 backdrop-blur-md flex items-center justify-center px-6">
          <div className="max-w-lg w-full glass-panel rounded-3xl p-10 border border-rose-500/30 bg-slate-900/80 text-center">
            <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-rose-300 mb-3">Per-Pack Drift Failed</div>
            <p className="text-sm text-slate-200 mb-6">{perPackError}</p>
            <button
              onClick={() => setPerPackError(null)}
              className="text-xs font-bold uppercase tracking-widest text-slate-300 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 transition-colors px-4 py-2 rounded-lg"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <LoginModal
        open={showLogin}
        onClose={() => {
          setShowLogin(false);
          pendingAnalyzeRef.current = false;
          pendingDriftRef.current = false;
          pendingPerPackRef.current = false;
          pendingSimulationRef.current = false;
        }}
        onSuccess={() => {
          setShowLogin(false);
          setAuthenticated(true);
          if (pendingAnalyzeRef.current) {
            pendingAnalyzeRef.current = false;
            runAnalyze();
          } else if (pendingDriftRef.current) {
            pendingDriftRef.current = false;
            startDriftTest();
          } else if (pendingPerPackRef.current) {
            pendingPerPackRef.current = false;
            startPerPackDrift();
          } else if (pendingSimulationRef.current) {
            pendingSimulationRef.current = false;
            startEngineSimulation();
          }
        }}
      />
    </div>
    </AppErrorBoundary>
  );
};

export default App;
