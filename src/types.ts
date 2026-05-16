
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
  evidence_check_status?: EvidenceCheckStatus;
  original_count?: number;
  verified_count?: number;
  adjustment_reason?: string;
  rescan_attempted?: boolean;
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
  uncapped_readiness?: number;
  readiness_cap?: number;
  readiness_cap_reason?: string;
  antipattern_burden_confidence?: 'confirmed' | 'unknown';
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
  crawl_walk_run: 'Insufficient evidence' | 'Crawl' | 'Walk' | 'Walk with significant friction' | 'Run';
}

export type EvidenceCheckStatus = 'supported' | 'weak' | 'unsupported' | 'missing';

export interface EvidenceCheckItem {
  stream: 'maturity' | 'antipattern';
  id: string;
  status: EvidenceCheckStatus;
  original_count: number;
  verified_count: number;
  rationale: string;
  rescan_recommended?: boolean;
  quote_supported?: boolean;
}

export interface EvidenceCheckAdjustment {
  stream: 'maturity' | 'antipattern';
  id: string;
  original_count: number;
  verified_count: number;
  status: EvidenceCheckStatus;
  reason: string;
  rescan_attempted: boolean;
}

export interface EvidenceCheckResult {
  batch_id?: string;
  model_used?: string;
  total_items: number;
  supported_count: number;
  weak_count: number;
  unsupported_count: number;
  missing_count: number;
  downgraded_count: number;
  rescan_count: number;
  items: EvidenceCheckItem[];
  adjustments: EvidenceCheckAdjustment[];
  failed?: boolean;
  failure_reason?: string;
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


export interface AssessmentEvidenceSummary {
  // Fact-only synopsis. Must be grounded in Phase 1 quotes or Phase 2 metrics;
  // no tactic IDs, case studies, or implementation directives.
  headline: string;
  maturity_classification: Phase2Validation['crawl_walk_run'];
  key_metrics: string[];
  confirmed_strengths: string[];
  confirmed_gaps: string[];
  confirmed_antipatterns: string[];
  silent_or_missing_evidence: string[];
}

export interface AssessmentDiagnosis {
  // Interpretation of the evidence summary. This explains why the assessed
  // state exists, but still does not prescribe an implementation plan.
  primary_bottleneck: string;
  root_causes: string[];
  domain_diagnosis: Record<string, string>;
  confidence: 'high' | 'medium' | 'low';
  confidence_rationale: string;
}

export interface PlanningDecision {
  // Prognosis / actionability gate for the plan. GO means roadmap can be used;
  // CONDITIONAL_GO means act only on high-confidence phases; NO_GO means gather
  // evidence before executing recommendations.
  decision: 'GO' | 'CONDITIONAL_GO' | 'NO_GO';
  rationale: string;
  safe_to_act_on: string[];
  evidence_needed_before_action: string[];
}

export interface Phase3Strategy {
  // Backward-compatible summary fields now represent evidence-only summaries.
  // They should not contain tactic IDs or implementation directives.
  executive_summary: string;
  executive_summaries: Record<PersonaId, string>;
  active_persona: PersonaId;
  evidence_summary?: AssessmentEvidenceSummary;
  diagnosis?: AssessmentDiagnosis;
  planning_decision?: PlanningDecision;
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
    evidence_check: string;
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

export type ClaimSourceLocation = PersonaId | 'diagnosis' | 'planning_decision' | 'roadmap';

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
  evidence_check?: EvidenceCheckResult;
  llm_explanation?: QualityGateLlmExplanation;
}

export interface DiagnosticResult {
  meta: AnalysisMeta;
  phase_1_audit_logs: Phase1AuditLogs;
  evidence_check: EvidenceCheckResult;
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


export type KnowledgeStream = 'maturity' | 'antipattern';
export type DomainId = 'A' | 'B' | 'C' | 'D' | 'E';
export type CapabilityId = `${DomainId}${1 | 2 | 3 | 4 | 5}`;

export interface KnowledgeDomain {
  id: DomainId;
  name: string;
  capabilities: CapabilityId[];
}

export interface KnowledgeTaxonomyRegistry {
  version: string;
  description: string;
  domains: KnowledgeDomain[];
  streams: KnowledgeStream[];
  evidence_categories: EvidenceCategory[];
  kb_document_naming: {
    pattern: string;
    examples: string[];
    required_front_matter: {
      forbidden_uses: string[];
    };
  };
  usage_boundaries: {
    reference_kb_allowed_uses: string[];
    reference_kb_forbidden_uses: string[];
  };
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
