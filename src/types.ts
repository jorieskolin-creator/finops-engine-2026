
export type EvidenceCategory =
  | 'Policy'
  | 'Process'
  | 'Operational'
  | 'Automation'
  | 'Accountability'
  | 'Financial-Integration'
  | 'Cultural';

export const EVIDENCE_CATEGORIES: EvidenceCategory[] = [
  'Policy',
  'Process',
  'Operational',
  'Automation',
  'Accountability',
  'Financial-Integration',
  'Cultural'
];

export interface EvidenceQuote {
  quote: string;
  source_document?: string;
  section?: string;
  category?: EvidenceCategory;
  evidence_source?: 'text' | 'image';
  page_number?: number;
}

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ImageInput {
  mimeType: ImageMimeType;
  data: string;
  source_name: string;
  page_number?: number;
}

export interface AuditItem {
  count: number;
  status: "OK" | "Partial" | "NOK";
  evidence: string;
  evidence_quotes: EvidenceQuote[];
  reasoning?: string;
  is_silent?: boolean;
  category_footprint?: Partial<Record<EvidenceCategory, number>>;
}

export interface AuditCategory {
  [key: string]: AuditItem;
}

export interface Phase1AuditLogs {
  maturity: AuditCategory;
  antipattern: AuditCategory;
}

export interface Metrics {
  maturity_ratio: number;
  antipattern_ratio: number;
  maturity_depth: number;
  antipattern_burden: number;
  finops_readiness: number;
  delivery_integrity: number;
  evidence_density: number;
}

export interface RawCounts {
  maturity_sub_criteria_met: number;
  antipattern_sub_criteria_met: number;
}

export interface Phase2Validation {
  metrics: Metrics;
  raw_counts: RawCounts;
  maturity_gaps: string[];
  antipattern_findings: string[];
  silent_areas: string[];
  category_scores: Record<string, number>;
  evidence_category_totals?: Partial<Record<EvidenceCategory, number>>;
  crawl_walk_run: 'Crawl' | 'Walk' | 'Walk with significant friction' | 'Run';
}

export interface RemediationStep {
  phase: string;
  actions: string[];
  // Populated when synthesis ran in CAUTIOUS (MEDIUM bracket) mode.
  confidence?: 'high' | 'medium' | 'low';
  assumptions?: string[];
}

// Output of the FINDINGS synthesis mode (LOW bracket): evidence-backed
// observations and an explicit validation plan, NOT a directive roadmap.
// No tactic IDs, no case studies, no claimed outcomes.
export interface FindingsModeOutput {
  evidence_backed_findings: string[];
  candidate_themes: string[];
  missing_evidence: string[];
  validation_plan: string[];
}

export type ConfidenceBracket = 'HIGH' | 'MEDIUM' | 'LOW';

export interface VisualScorecard {
  headline: string;
  maturity_score: string;
  burden_score: string;
}

export type PersonaId = 'finops_lead' | 'cfo' | 'engineering_lead';

export const PERSONA_IDS: PersonaId[] = ['finops_lead', 'cfo', 'engineering_lead'];

export const PERSONA_LABELS: Record<PersonaId, string> = {
  finops_lead: 'FinOps Lead',
  cfo: 'CFO',
  engineering_lead: 'Engineering Lead'
};

export interface Phase3Strategy {
  executive_summary: string;
  executive_summaries: Record<PersonaId, string>;
  active_persona: PersonaId;
  visual_scorecard: VisualScorecard;
  remediation_roadmap: RemediationStep[];
  // Bracket the synthesis was instructed to operate in, derived from Phase 2
  // metrics before the LLM call. HIGH=directive, MEDIUM=cautious, LOW=findings.
  confidence_bracket?: ConfidenceBracket;
  // After fact-check, this may downgrade to LOW if QG flips to BLOCK. The UI
  // renders based on effective_bracket so a poor fact-check result hides
  // case studies and directive language even if synthesis produced them.
  effective_bracket?: ConfidenceBracket;
  // Populated only when synthesis ran in FINDINGS mode (LOW bracket).
  findings_mode?: FindingsModeOutput;
}

export interface AnalysisMeta {
  document_analyzed: string;
  timestamp: string;
  engine_version: string;
  model_config: {
    preflight: string;
    forensic_audit: string;
    synthesis: string;
    fact_check: string;
    validators: string;
  };
}

export type QualityGateDecision = 'GO' | 'WARN' | 'BLOCK';

export type ClaimClassification = 'supported_by_source' | 'supported_by_audit' | 'supported_by_tactics_db' | 'unsupported';

export type ClaimFailureType =
  | 'fabricated_number'
  | 'unverifiable_entity'
  | 'unsupported_org_claim'
  | 'out_of_scope'
  | 'other';

export type ClaimSourceLocation = PersonaId | 'roadmap';

export interface FactCheckClaim {
  claim: string;
  classification: ClaimClassification;
  rationale: string;
  failure_type?: ClaimFailureType;
  missing_material?: string;
  source_location?: ClaimSourceLocation;
}

export interface FactCheckPassSnapshot {
  attempt: number;
  total_claims: number;
  supported_count: number;
  unsupported_count: number;
  // First ~80 chars of each unsupported claim. Lets the UI diff passes to
  // show whether regen is making progress or stuck on the same claims.
  unsupported_signatures: string[];
}

export interface FactCheckResult {
  attempts: number;
  total_claims: number;
  supported_count: number;
  unsupported_claims: FactCheckClaim[];
  failed: boolean;
  failure_reason?: string;
  // Per-pass trajectory accumulated across the fact-check + regen loop.
  // Populated by the orchestrator (geminiService), not by parseFactCheckResponse.
  trajectory?: FactCheckPassSnapshot[];
}

export interface QualityGateExplanationItem {
  reason: string;
  explanation: string;
  quote?: string;
  source_location?: string;
}

export interface QualityGateLlmExplanation {
  summary: string;
  blocking_details: QualityGateExplanationItem[];
  warning_details: QualityGateExplanationItem[];
  model_used?: string;
  failed?: boolean;
  failure_reason?: string;
}

export interface QualityGateResult {
  decision: QualityGateDecision;
  blocking_reasons: string[];
  warnings: string[];
  notes: string[];
  thresholds: {
    evidence_density_block: number;
    evidence_density_warn: number;
    silent_areas_warn: number;
    unsupported_claims_block: number;
  };
  fact_check?: FactCheckResult;
  llm_explanation?: QualityGateLlmExplanation;
}

export interface DiagnosticResult {
  meta: AnalysisMeta;
  phase_1_audit_logs: Phase1AuditLogs;
  phase_2_validation: Phase2Validation;
  phase_3_strategy: Phase3Strategy;
  quality_gate: QualityGateResult;
}

export interface ScanResult {
  score: number;
  status: 'Ready' | 'Weak' | 'Insufficient' | 'PassWithWarning';
  message: string;
  details: string[];
  canRun: boolean;
  confidence_warning?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  repaired?: boolean;
}

export interface StrategicTactic {
  id: string;
  category: 'Visibility' | 'Optimization' | 'Governance' | 'Architecture' | 'Culture';
  // Short, stable human-readable name. Used to anchor model output: "Implement
  // the {canonical_name} [{id}] modeled on {company}". Distinct from the
  // longer solution_mechanism prose. Required for all DB entries.
  canonical_name?: string;
  problem_pattern: string;
  solution_mechanism: string;
  case_study: string;
  prerequisites?: string[];
  owner_persona?: string;
  expected_outcome?: string;
  risk_notes?: string;
  resource_label?: string;
  resource_url?: string;
}
