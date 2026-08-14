
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
  source_id?: string;
  page_id?: string;
  chunk_id?: string;
  sheet_name?: string;
  row_number?: number;
}

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ImageInput {
  mimeType: ImageMimeType;
  data: string;
  source_name: string;
  page_number?: number;
  source_id?: string;
  page_id?: string;
  chunk_id?: string;
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
  antipattern_absence_status?: AntiPatternAbsenceStatus;
  coverage_reason?: string;
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
  antipattern_clearance: number;
  antipattern_coverage: number;
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
  verified_antipattern_absences: string[];
  unknown_antipattern_absences: string[];
  silent_areas: string[];
  category_scores: Record<string, number>;
  evidence_category_totals?: Partial<Record<EvidenceCategory, number>>;
  crawl_walk_run: 'Insufficient evidence' | 'Crawl' | 'Walk' | 'Walk with significant friction' | 'Run';
}

export type AntiPatternAbsenceStatus =
  | 'confirmed_present'
  | 'partially_present'
  | 'tested_absent'
  | 'unknown_absent';

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
  antipattern_absence_status?: AntiPatternAbsenceStatus;
  coverage_reason?: string;
  adjudication_unresolved?: boolean;
  verification_unresolved?: boolean;
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
  adjudication_model_used?: string;
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

export type PipelineProgressStage =
  | 'extraction'
  | 'packetization'
  | 'privacy'
  | 'knowledge'
  | 'analysis'
  | 'evidence'
  | 'calculation'
  | 'synthesis'
  | 'verification'
  | 'finalization';

export type PipelineProgressStatus = 'pending' | 'in_progress' | 'completed' | 'completed_with_warnings' | 'failed';

export interface PipelineProgressUpdate {
  stage: PipelineProgressStage;
  status: PipelineProgressStatus;
  completed?: number;
  total?: number;
  domain_id?: string;
}

export interface RemediationStep {
  phase: string;
  why?: string;
  what?: string;
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
  run_id?: string;
  document_analyzed: string;
  timestamp: string;
  engine_version: string;
  source_parse_warnings?: string[];
  source_registry?: SourceRegistryRuntimeStatus;
  knowledge_base?: KnowledgeBaseRuntimeStatus;
  run_trace?: RunTrace;
  run_trace_summary?: RunTraceSummary;
  acquisition_quality?: AcquisitionQualitySnapshot;
  evidence_privacy?: EvidencePrivacyDecision;
  model_mode?: string;
  model_routing_policy_version?: string;
  primary_model_provider?: 'ANTHROPIC' | 'OPENAI' | 'QWEN' | null;
  fallback_model_provider?: 'ANTHROPIC' | 'OPENAI' | 'QWEN' | 'NONE' | null;
  model_config: {
    forensic_audit: string;
    targeted_rescan?: string;
    evidence_check: string;
    evidence_adjudication?: string;
    synthesis: string;
    roadmap_synthesis?: string;
    fact_check: string;
    fact_check_high?: string;
    validators: string;
  };
}

export interface SourceExtractionMetadata {
  unit: 'document' | 'page' | 'row';
  total_units: number;
  processed_units: number;
  text_coverage_ratio?: number;
  sparse_units?: number;
  truncated: boolean;
  quality?: 'good' | 'mixed' | 'poor';
}

export interface SourceExtractionQuality {
  overall_completeness: number;
  status: 'COMPLETE' | 'PARTIAL' | 'FAILED';
  warning_count: number;
  sources: Array<{
    source_id: string;
    source_name: string;
    kind: SourceRecord['kind'];
    completeness: number;
    status: 'COMPLETE' | 'PARTIAL' | 'FAILED';
    unit: SourceExtractionMetadata['unit'];
    total_units: number;
    processed_units: number;
    text_coverage_ratio?: number;
    sparse_units?: number;
    truncated: boolean;
    quality?: SourceExtractionMetadata['quality'];
    warning_count: number;
    warning_codes: Array<'PARSE_WARNING' | 'TRUNCATED' | 'SPARSE_CONTENT' | 'MIXED_QUALITY' | 'POOR_QUALITY'>;
  }>;
  blocking_reasons: string[];
}

export interface AcquisitionQualitySnapshot {
  schema_version: 'acquisition_quality_snapshot_v1';
  formula_version: 'acquisition_quality_formula_v1';
  enforcement: 'observability_only';
  extraction: SourceExtractionQuality;
  evidence: {
    coverage: {
      overall: number;
      maturity: number;
      antipattern: number;
      covered_items: number;
      total_items: number;
      by_domain: Record<string, { covered_items: number; total_items: number; completeness: number }>;
    };
    density: {
      overall: number;
      verified_strength: number;
      source_diversity: number;
      category_diversity: number;
      covered_items: number;
    };
    provenance: {
      integrity: number;
      source_backed_count: number;
      derived_count: number;
      asserted_count: number;
      unresolved_criterion_ids: string[];
    };
  };
  knowledge: {
    completeness: number;
    ready: boolean;
    source: KnowledgeBaseRuntimeStatus['source'];
    expected_document_count: number;
    loaded_document_count: number;
    missing_document_count: number;
    blocking_reasons: string[];
  };
  security: {
    status: 'PASS' | 'WARN' | 'BLOCK';
    high_risk_hit_count: number;
    caution_hit_count: number;
    scanned_chunk_count: number;
  };
  readiness: {
    evidence_packet: 'READY' | 'NOT_READY';
    knowledge_packet: 'READY' | 'NOT_READY';
    acquisition: 'READY' | 'NOT_READY';
    blocking_reasons: string[];
  };
}

export interface AcquisitionQualityPersistence {
  schema_version: 'acquisition_quality_snapshot_v1';
  formula_version: 'acquisition_quality_formula_v1';
  extraction_completeness: number;
  evidence_coverage: number;
  evidence_density: number;
  provenance_integrity: number;
  kb_completeness: number;
  evidence_packet_status: 'READY' | 'NOT_READY';
  knowledge_packet_status: 'READY' | 'NOT_READY';
  acquisition_status: 'READY' | 'NOT_READY';
  security_status: 'PASS' | 'WARN' | 'BLOCK';
  extraction_incomplete_count: number;
  weak_source_packet_count: number;
  kb_blocking_count: number;
  unresolved_provenance_count: number;
}

export interface ShadowTelemetryPersistence {
  schema_version: 'shadow_telemetry_v1';
  retrieval_policy_version: 'bounded_retrieval_policy_v1';
  derived_evidence_schema_version: 'derived_analytical_evidence_v1';
  analyzer_version: 'tagging_allocation_v1@1.1.0';
  scale_registry_version: 'data_signal_registry_v1';
  retrieval_domain_count: number;
  retrieval_triggered_domain_count: number;
  retrieval_pass_1_count: number;
  retrieval_pass_2_count: number;
  retrieval_selected_candidate_count: number;
  retrieval_average_gain_points: number;
  retrieval_max_gain_points: number;
  stop_sufficient_baseline_count: number;
  stop_minimum_gain_not_met_count: number;
  stop_no_new_candidates_count: number;
  stop_max_passes_reached_count: number;
  derived_evidence_count: number;
  derived_observed_count: number;
  derived_insufficient_signal_count: number;
  derived_full_table_count: number;
  derived_bounded_prefix_count: number;
  scale_total_object_count: number;
  scale_analyzer_available_count: number;
  scale_unsupported_count: number;
}

export interface KnowledgeBaseRuntimeStatus {
  source: 'remote_blob' | 'fallback' | 'built_in';
  prefix?: string;
  document_count: number;
  failure_count: number;
  domains?: Record<string, number>;
  delivery?: {
    sectioned_document_count: number;
    page_limit_document_count: number;
    sparse_page_count: number;
    duplicate_section_heading_count: number;
    invalid_section_order_document_count: number;
    missing_expected_document_count: number;
    unexpected_document_count: number;
    duplicate_document_count: number;
    shadow_ready: boolean;
  };
  shadow_packets?: Record<string, {
    stage: KnowledgePacketStage;
    domain_id?: string;
    readiness: 'READY' | 'NOT_READY';
    packet_hash: string;
    document_count: number;
    char_count: number;
    missing_requirement_count: number;
    coverage_issue_count: number;
    oversized_section_count: number;
    page_limit_document_count: number;
  }>;
  loaded_at?: string;
}

export type SourceChunkType = 'text' | 'pdf_page' | 'table_profile' | 'table_row' | 'image' | 'metadata';
export type SourceRelevanceTier = 'high' | 'medium' | 'low' | 'unknown';

export interface SourcePage {
  schema_version: 'source_page_v1';
  page_id: string;
  page_number: number;
  text: string;
}

export type EvidenceSourceFormat = 'pdf' | 'html' | 'csv' | 'tsv' | 'json' | 'xlsx' | 'png' | 'jpeg' | 'webp';

export interface EvidenceSourceAcquisition {
  schema_version: 'evidence_source_acquisition_v1';
  source_role: 'CUSTOMER_EVIDENCE';
  original_sha256: string;
  byte_size: number;
  declared_media_type: string;
  detected_media_type: string;
  format: EvidenceSourceFormat;
  detection_method: 'magic_bytes' | 'structured_text';
  validation_status: 'PASS' | 'BLOCK';
  validation_codes: string[];
  extraction_method: 'not_started' | 'browser_pdfjs' | 'browser_dom' | 'browser_delimited' | 'browser_json' | 'browser_xlsx_worker' | 'local_ocr';
  extraction_version: string;
  extraction_status: 'PENDING' | 'PASS' | 'BLOCK';
}

export interface StructuredTableData {
  schema_version: 'structured_table_v1';
  sheet_name?: string;
  sheet_visibility?: 'visible' | 'hidden' | 'very_hidden';
  /** Hidden/non-evidence workbook sheets are scanned locally but never routed to model context. */
  model_eligible?: boolean;
  source_range?: string;
  header_row_number?: number;
  headers: string[];
  /** Bounded, cell-clipped rows eligible for model context. */
  rows: string[][];
  /** Complete normalized population retained only for local deterministic analysis and privacy scanning. */
  analysis_rows?: string[][];
  analysis_row_numbers?: number[];
  sampled_row_numbers?: number[];
  sampled_row_reasons?: string[][];
  sample_strategy_version?: 'deterministic_table_sample_v1';
  sample_seed_hash?: string;
  deterministic_inspection?: DeterministicTableInspection;
  total_row_count: number;
  analysis_complete?: boolean;
  formula_cell_count?: number;
  formula_cached_value_missing_count?: number;
  merged_range_count?: number;
  native_charts?: NativeChartEvidenceUnit[];
  unsupported_objects?: string[];
  /** Describes bounded model context, not deterministic analysis population. */
  truncated: boolean;
}

export interface DeterministicTableInspection {
  schema_version: 'deterministic_table_inspection_v1';
  population_scope: 'FULL_TABLE';
  row_count: number;
  column_count: number;
  duplicate_row_count: number | null;
  duplicate_row_rate_percent: number | null;
  duplicate_calculation_state: 'EXACT' | 'NOT_CALCULATED_LIMIT';
  duplicate_definition: 'REPEATED_ROWS_AFTER_FIRST_OCCURRENCE';
  type_consistency_definition: 'DOMINANT_NON_EMPTY_TYPE_SHARE';
  columns: Array<{
    column_index: number;
    inferred_type: 'EMPTY' | 'STRING' | 'INTEGER' | 'DECIMAL' | 'BOOLEAN' | 'DATE' | 'MIXED';
    non_empty_count: number;
    blank_count: number;
    blank_rate_percent: number;
    type_consistency_percent: number | null;
    distinct_value_count: number;
    distinct_count_state: 'EXACT' | 'LOWER_BOUND';
    detected_currencies: string[];
  }>;
}

export interface NativeChartEvidenceUnit {
  schema_version: 'native_chart_evidence_unit_v1';
  chart_id: string;
  chart_part: string;
  sheet_name?: string;
  chart_type: string;
  title?: string;
  axis_titles: string[];
  series: Array<{
    name?: string;
    category_range?: string;
    value_range?: string;
    categories: string[];
    values: Array<number | null>;
  }>;
  extraction_status: 'COMPLETE' | 'PARTIAL';
  warnings: string[];
}

export interface SourceRecord {
  schema_version: 'source_record_v1';
  source_id: string;
  source_name: string;
  kind: 'text' | 'pdf' | 'html' | 'csv' | 'tsv' | 'json' | 'xlsx' | 'image';
  text?: string;
  pages?: SourcePage[];
  structured_table?: StructuredTableData;
  structured_tables?: StructuredTableData[];
  parse_warnings?: string[];
  extraction?: SourceExtractionMetadata;
  acquisition?: EvidenceSourceAcquisition;
  visual_units?: VisualEvidenceUnit[];
}

export interface VisualEvidenceUnit {
  schema_version: 'visual_evidence_unit_v1';
  unit_id: string;
  source_id?: string;
  extraction_method: 'local_ocr';
  engine_version: 'tesseract.js@7.0.0';
  language: 'eng';
  width: number;
  height: number;
  confidence: number;
  text: string;
  words: Array<{
    text: string;
    confidence: number;
    bounding_box: { x0: number; y0: number; x1: number; y1: number };
  }>;
  post_ocr_redaction_status: 'PENDING' | 'PASSED' | 'PASSED_WITH_REDACTIONS';
  visual_interpretation_status: 'OCR_TEXT_ONLY';
  withheld_regions: Array<{
    bounding_box: { x0: number; y0: number; x1: number; y1: number };
    reason: 'UNINSPECTED_VISUAL_REGION';
  }>;
}

export type EvidencePrivacyFindingKind =
  | 'email'
  | 'phone'
  | 'ip'
  | 'billing_identifier'
  | 'invoice_identifier'
  | 'cloud_key'
  | 'api_key'
  | 'private_key'
  | 'credential_assignment'
  | 'bearer_token'
  | 'government_identifier'
  | 'personal_financial_identifier'
  | 'home_address'
  | 'sensitive_financial_value';

export interface EvidencePrivacyFinding {
  kind: EvidencePrivacyFindingKind;
  severity: 'redact' | 'block';
  count: number;
  source_ids: string[];
}

export interface EvidencePrivacyDecision {
  schema_version: 'evidence_privacy_decision_v1';
  policy_version: 'deterministic_evidence_privacy_v1';
  decision: 'PASS' | 'PASS_WITH_REDACTIONS' | 'BLOCK';
  scanned_source_count: number;
  scanned_text_unit_count: number;
  scanned_table_cell_count: number;
  redaction_count: number;
  findings: EvidencePrivacyFinding[];
  blocking_codes: string[];
}

export interface SourceChunkRoutingHint {
  domain: string;
  score: number;
  tier: SourceRelevanceTier;
  reasons: string[];
}

export interface SourceChunk {
  chunk_id: string;
  source_id: string;
  source_name: string;
  type: SourceChunkType;
  text: string;
  page_id?: string;
  page_number?: number;
  sheet_name?: string;
  row_number?: number;
  visual_unit_id?: string;
  bounding_box?: { x0: number; y0: number; x1: number; y1: number };
  ocr_confidence?: number;
  char_start?: number;
  char_end?: number;
  parse_warnings?: string[];
  routing: SourceChunkRoutingHint[];
  image?: ImageInput;
}

export interface SourceRegistry {
  source_count: number;
  chunk_count: number;
  chunks: SourceChunk[];
  source_acquisition?: Array<{
    source_id: string;
    original_sha256?: string;
    byte_size?: number;
    declared_media_type?: string;
    detected_media_type?: string;
    format: SourceRecord['kind'];
    validation_status: 'PASS' | 'NOT_RECORDED';
    extraction_method?: EvidenceSourceAcquisition['extraction_method'];
    extraction_version?: string;
    extraction_status?: EvidenceSourceAcquisition['extraction_status'];
  }>;
  warnings: string[];
  extraction: SourceExtractionQuality;
}

export interface SourcePacketManifestItem {
  chunk_id: string;
  source_id: string;
  page_id?: string;
  page_number?: number;
  sheet_name?: string;
  row_number?: number;
  visual_unit_id?: string;
  bounding_box?: { x0: number; y0: number; x1: number; y1: number };
  type: SourceChunkType;
  relevance: SourceRelevanceTier;
  routed_domains: string[];
}

export interface RoutedSourcePacket {
  domain_id: string;
  title: string;
  text: string;
  images: ImageInput[];
  manifest: SourcePacketManifestItem[];
  included_chunk_count: number;
  total_candidate_chunks: number;
  weak_coverage: boolean;
  coverage_notes: string[];
  char_count: number;
}

export interface EvidenceLaneStagePacket {
  schema_version: 'evidence_lane_stage_packet_v1';
  domain_id: string;
  source_role: 'CUSTOMER_EVIDENCE';
  evidence: SourcePacketManifestItem[];
  sanitized_visual_evidence: SourcePacketManifestItem[];
  derived_evidence: DerivedAnalyticalEvidence[];
  knowledge_context: [];
  coverage: {
    weak: boolean;
    signal_state: 'ROUTED_EVIDENCE' | 'ACQUIRED_SOURCE_SILENCE';
    candidate_chunks: number;
    included_chunks: number;
    omitted_relevant_chunks: number;
    notes: string[];
  };
  withheld_content: {
    shadow_derived_evidence_count: number;
    uninspected_visual_region_count: number;
    raw_image_payload_count: 0;
    reasons: string[];
  };
  policy: {
    permitted_uses: string[];
    forbidden_uses: string[];
  };
  privacy_decision: EvidencePrivacyDecision['decision'];
  acquisition_readiness: SourceRegistryRuntimeStatus['acquisition_readiness']['status'];
  acquisition_binding: {
    registry_hash: string;
    packet_manifest_hash: string;
    source_packet_hash: string;
    privacy_decision_hash: string;
  };
  integrity_hash: string;
  text: string;
  images: [];
}

export interface DlpPatternHit {
  kind: 'email' | 'phone' | 'ip' | 'secret' | 'cloud_key' | 'private_key' | 'financial_caution';
  count: number;
  chunk_ids: string[];
  severity: 'block' | 'caution';
}

export interface DlpScanResult {
  scanned_chunk_count: number;
  high_risk_hits: DlpPatternHit[];
  caution_hits: DlpPatternHit[];
  blocked: boolean;
  warnings: string[];
}

export interface SourceRegistryRuntimeStatus {
  source_count: number;
  chunk_count: number;
  dlp_review_chunk_count: number;
  dlp_high_risk_hits: number;
  dlp_caution_hits: number;
  acquisition_readiness: {
    status: 'READY' | 'READY_WITH_WARNINGS' | 'BLOCKED';
    reasons: string[];
    privacy_decision: EvidencePrivacyDecision['decision'];
    registry_hash: string;
    packet_manifest_hash: string;
  };
  extraction: SourceExtractionQuality;
  packets: Record<string, {
    included_chunk_count: number;
    total_candidate_chunks: number;
    weak_coverage: boolean;
    char_count: number;
  }>;
}

export interface RunTraceSummary {
  stage_count: number;
  source_count: number;
  chunk_count: number;
  evidence_path_count: number;
  score_path_count: number;
  tactic_path_count: number;
  quality_gate_decision: QualityGateDecision;
}

export interface RunTrace {
  run_id: string;
  engine_version: string;
  taxonomy_version?: string;
  taxonomy_hash: string;
  kb_index_hash?: string;
  kb_version_hashes: Record<string, string>;
  tactic_db_version: string;
  tactic_db_hash: string;
  playbook_hash: string;
  created_at: string;
  input_manifest: SourceManifestTrace[];
  context_packets: ContextPacketTrace[];
  table_inspections?: TableInspectionTrace[];
  derived_analytical_evidence?: DerivedAnalyticalEvidence[];
  data_signal_coverage?: DataSignalCoverageReport;
  bounded_retrieval?: BoundedRetrievalTrace;
  dlp: {
    scanned_chunk_count: number;
    model_review_chunk_count: number;
    high_risk_hit_count: number;
    caution_hit_count: number;
    blocked: boolean;
    warnings: string[];
  };
  stages: StageTrace[];
  evidence_paths: EvidencePathTrace[];
  score_paths: ScorePathTrace[];
  tactic_paths: TacticPathTrace[];
  quality_gate: QualityGateTrace;
  usage_summary: ModelUsageSummary;
  privacy: {
    raw_source_included: false;
    full_prompts_included: false;
    api_keys_included: false;
    note: string;
  };
}

export interface TableInspectionTrace {
  source_id: string;
  sheet_name?: string;
  model_eligible: boolean;
  inspection: DeterministicTableInspection;
}

export interface DataSignalCoverageReport {
  schema_version: 'data_signal_coverage_v1';
  registry_version: 'data_signal_registry_v1';
  mode: 'shadow';
  total_object_count: 60;
  analyzer_available_count: number;
  unsupported_count: number;
  objects: Array<{
    domain_id: string;
    stream: 'maturity' | 'antipattern';
    criterion_id: string;
    status: 'SHADOW_ANALYZER_AVAILABLE' | 'NO_AUTHORITATIVE_ANALYZER_SEMANTICS';
    analyzer_ids: string[];
  }>;
}

export type RetrievalStopReason = 'SUFFICIENT_BASELINE' | 'MINIMUM_GAIN_NOT_MET' | 'NO_NEW_CANDIDATES' | 'MAX_PASSES_REACHED';

export interface BoundedRetrievalTrace {
  schema_version: 'bounded_retrieval_trace_v1';
  policy_version: 'bounded_retrieval_policy_v1';
  mode: 'shadow';
  max_passes: 2;
  minimum_gain_points: 5;
  domains: Array<{
    domain_id: string;
    baseline_coverage: number;
    final_coverage: number;
    stop_reason: RetrievalStopReason;
    passes: Array<{
      pass: 1 | 2;
      strategy: 'omitted_routed_candidates' | 'neutral_gap_expansion';
      coverage_before: number;
      coverage_after: number;
      gain_points: number;
      candidate_count: number;
      selected_chunk_ids: string[];
    }>;
  }>;
}

export interface DataSignalRegistryEntry {
  readonly signal_id: string;
  analyzer_id: 'tagging_allocation_v1';
  readonly targets: ReadonlyArray<{ readonly stream: 'maturity' | 'antipattern'; readonly criterion_id: 'A1' }>;
  readonly canonical_fields: readonly string[];
}

export interface EvidenceAnalysisRegistryEntry {
  readonly analyzer_id: 'tagging_allocation_v1';
  readonly analyzer_version: '1.1.0';
  readonly registry_version: 'evidence_analysis_registry_v1';
  readonly approval_status: 'SHADOW_ONLY' | 'APPROVED';
  readonly approved_for_model_packet: boolean;
  readonly accepted_source_kinds: readonly ['csv', 'tsv', 'xlsx'];
  readonly targets: ReadonlyArray<{ readonly stream: 'maturity' | 'antipattern'; readonly criterion_id: 'A1' }>;
  readonly calculations: ReadonlyArray<{
    readonly calculation_id: string;
    readonly formula: string;
    readonly output_fields: readonly string[];
    readonly eligibility_rule: string;
  }>;
  readonly forbidden_interpretations: readonly string[];
}

export interface DerivedAnalyticalEvidence {
  schema_version: 'derived_analytical_evidence_v1';
  mode: 'shadow' | 'authoritative';
  evidence_id: string;
  evidence_type: 'deterministic_analytical';
  source_id: string;
  targets: Array<{ stream: 'maturity' | 'antipattern'; criterion_id: 'A1' }>;
  derivation: {
    analyzer_id: 'tagging_allocation_v1';
    analyzer_version: '1.1.0';
    registry_version: 'evidence_analysis_registry_v1';
    method: 'tagging_allocation_coverage_analysis';
    calculation_ids: string[];
  };
  result: {
    status: 'OBSERVED' | 'INSUFFICIENT_SIGNAL';
    source_row_count: number;
    analyzed_row_count: number;
    eligible_row_count: number;
    excluded_total_row_count: number;
    row_scope: 'full_table' | 'bounded_prefix';
    row_truncated: boolean;
    detected_signal_count: number;
    mapping_population_coverage: number | null;
    tagging_population_coverage: number | null;
    allocation_population_coverage: number | null;
    field_coverage: Array<{
      field: 'owner' | 'cost_center' | 'product' | 'application' | 'environment' | 'tagging' | 'allocation';
      state: 'FIELD_NOT_PRESENT' | 'FIELD_PRESENT_EMPTY' | 'FIELD_PRESENT_PARTIAL' | 'FIELD_PRESENT_VALID' | 'FIELD_PRESENT_AMBIGUOUS' | 'FIELD_PRESENT_INVALID' | 'INSUFFICIENT_COVERAGE';
      column_indexes: number[];
      eligible_row_count: number;
      valid_row_count: number;
      invalid_placeholder_count: number;
      row_coverage_percent: number | null;
      eligible_cost: number | null;
      valid_cost: number | null;
      uncovered_cost: number | null;
      cost_coverage_percent: number | null;
      distinct_valid_value_count: number | null;
      valid_value_cardinality_percent: number | null;
      conflicting_assignment_count: number | null;
      top_uncovered_contributors: Array<{
        row_number: number;
        cost: number;
        eligible_cost_percent: number;
      }>;
    }>;
    cost_basis: {
      state: 'NOT_PRESENT' | 'VALID' | 'AMBIGUOUS_CURRENCY' | 'INVALID_VALUES';
      column_index: number | null;
      currencies: string[];
      excluded_row_count: number;
    };
    reconciliation: {
      state: 'NOT_AVAILABLE' | 'PASSED' | 'FAILED' | 'AMBIGUOUS';
      calculated_total: number | null;
      declared_total: number | null;
      difference: number | null;
    };
  };
  locator: { sheet?: string; range?: string; header_row?: number };
  eligibility: {
    state: 'SHADOW_ONLY' | 'INELIGIBLE' | 'ELIGIBLE';
    reasons: string[];
  };
  unit_fingerprint: string;
  report_eligible: boolean;
  raw_value_exposure: false;
}

export interface SourceManifestTrace {
  source_id: string;
  source_name: string;
  source_hash: string;
  chunk_count: number;
  chunk_ids: string[];
  page_count?: number;
  sheet_count?: number;
  row_count?: number;
  types: SourceChunkType[];
  parse_warnings?: string[];
}

export interface ContextPacketTrace {
  packet_id: string;
  domain_id: string;
  title: string;
  context_packet_hash: string;
  evidence_stage_packet_hash?: string;
  evidence_stage_packet_schema?: EvidenceLaneStagePacket['schema_version'];
  acquisition_readiness?: EvidenceLaneStagePacket['acquisition_readiness'];
  privacy_decision?: EvidenceLaneStagePacket['privacy_decision'];
  included_chunk_ids: string[];
  included_chunk_count: number;
  total_candidate_chunks: number;
  char_count: number;
  image_count: number;
  weak_coverage: boolean;
  coverage_notes: string[];
  manifest: SourcePacketManifestItem[];
}

export interface StageTrace {
  stage_id: string;
  provider?: string;
  model?: string;
  fallback_chain: string[];
  attempt_count: number;
  prompt_hash?: string;
  context_packet_hash?: string;
  input_char_count?: number;
  output_char_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  input_token_estimate?: number;
  output_token_estimate?: number;
  duration_ms?: number;
  status: 'ok' | 'error';
  fallback_reason?: string;
  error?: string;
  failed_attempts?: Array<{ model: string; provider: string; error: string }>;
  started_at?: string;
  completed_at?: string;
}

export interface EvidencePathTrace {
  path_id: string;
  stream: 'maturity' | 'antipattern';
  criterion_id: string;
  evidence_check_status?: EvidenceCheckStatus;
  antipattern_absence_status?: AntiPatternAbsenceStatus;
  source_id?: string;
  page_id?: string;
  chunk_id?: string;
  source_document?: string;
  page_number?: number;
  sheet_name?: string;
  row_number?: number;
  evidence_category?: EvidenceCategory;
  quote_snippet: string;
  original_count?: number;
  verified_count?: number;
  final_count: number;
  score_effect: string;
}

export interface ScorePathTrace {
  stream: 'maturity' | 'antipattern';
  criterion_id: string;
  final_count: number;
  status: AuditItem['status'];
  evidence_check_status?: EvidenceCheckStatus;
  antipattern_absence_status?: AntiPatternAbsenceStatus;
  has_quote_backed_coverage: boolean;
  metric_effect: string;
}

export interface TacticPathTrace {
  phase?: string;
  action_index: number;
  action_snippet: string;
  tactic_ids: string[];
  linked_findings: string[];
  reference_kind: 'tactic_reference' | 'playbook_reference' | 'kb_reference' | 'customer_evidence';
  grounding_status: 'grounded' | 'withheld' | 'quarantined' | 'unknown';
  notes?: string[];
}

export interface QualityGateTrace {
  decision: QualityGateDecision;
  blocking_reasons: string[];
  warnings: string[];
  fact_check?: {
    attempts: number;
    supported_count: number;
    total_claims: number;
    unsupported_count: number;
    failed: boolean;
    trajectory?: FactCheckPassSnapshot[];
  };
  sanitation?: {
    removed: number;
    rewritten: number;
    quarantined: number;
    remaining_unsupported: number;
  };
  final_export_status: 'available';
}

export interface ModelUsageSummary {
  stage_calls: number;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  by_model: Record<string, {
    calls: number;
    estimated_input_tokens: number;
    estimated_output_tokens: number;
    output_chars: number;
  }>;
}

export interface RemoteKnowledgeBaseDocument {
  pathname: string;
  url?: string;
  downloadUrl?: string;
  size?: number;
  uploadedAt?: string;
  pdf_sha256?: string;
  extracted_text_sha256?: string;
  kb_id?: string;
  version?: string;
  domain_id: string;
  domain_name: string;
  stream: 'maturity' | 'antipattern';
  criterion_id: string;
  capability_id: string;
  title: string;
  evidence_categories: string[];
  allowed_uses: string[];
  forbidden_uses: string[];
  legacy_ids: string[];
  extraction?: {
    total_pages?: number;
    processed_pages?: number;
    sparse_pages: number[];
    page_limit_reached: boolean;
    section_count: number;
    duplicate_section_headings: string[];
    section_order_valid: boolean;
  };
  sections?: Record<string, string>;
  body_excerpt: string;
}

export type KnowledgePacketStage = 'forensic_audit' | 'evidence_check' | 'synthesis' | 'roadmap_synthesis';

export interface ShadowKnowledgePacket {
  schema_version: 'shadow_knowledge_packet_v1';
  mode: 'shadow';
  stage: KnowledgePacketStage;
  domain_id?: string;
  source: KnowledgeBaseRuntimeStatus['source'];
  readiness: 'READY' | 'NOT_READY';
  packet_hash: string;
  document_count: number;
  char_count: number;
  missing_requirements: string[];
  coverage_issues: string[];
  oversized_sections: string[];
  page_limit_documents: string[];
  documents: Array<{
    kb_id?: string;
    version?: string;
    domain_id: string;
    capability_id: string;
    criterion_id: string;
    stream: 'maturity' | 'antipattern';
    pdf_sha256?: string;
    extracted_text_sha256?: string;
    allowed_uses: string[];
    forbidden_uses: string[];
    extraction_complete: boolean;
    extraction_warnings: string[];
    included_sections: string[];
    omitted_sections: string[];
    text: string;
  }>;
}

export interface RemoteKnowledgeBaseIndex {
  status: KnowledgeBaseRuntimeStatus;
  documents: RemoteKnowledgeBaseDocument[];
  failures: Array<{ pathname: string; reason: string }>;
  cached?: boolean;
}

export type QualityGateDecision = 'GO' | 'WARN' | 'BLOCK';

export type ClaimClassification = 'supported_by_source' | 'supported_by_audit' | 'supported_by_tactics_db' | 'unsupported';

export type ClaimFailureType =
  | 'fabricated_number'
  | 'unverifiable_entity'
  | 'unsupported_org_claim'
  | 'out_of_scope'
  | 'other';

export type ClaimSeverity =
  | 'BLOCKING_UNSUPPORTED_FACT'
  | 'BLOCKING_UNSAFE_ROADMAP'
  | 'WARN_MISCLASSIFIED_BUT_REAL'
  | 'WARN_TACTIC_HYGIENE'
  | 'SUPPORTED';

export type ClaimSourceLocation = PersonaId | 'diagnosis' | 'planning_decision' | 'roadmap';

export interface FactCheckClaim {
  claim: string;
  classification: ClaimClassification;
  rationale: string;
  failure_type?: ClaimFailureType;
  severity?: ClaimSeverity;
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

export type StrategySanitationAction = 'removed' | 'rewritten' | 'quarantined';

export interface StrategySanitationItem {
  action: StrategySanitationAction;
  claim: string;
  rationale: string;
  source_location?: ClaimSourceLocation;
  failure_type?: ClaimFailureType;
  severity?: ClaimSeverity;
}

export interface FactCheckResult {
  attempts: number;
  total_claims: number;
  supported_count: number;
  unsupported_claims: FactCheckClaim[];
  sanitized_claims?: StrategySanitationItem[];
  failed: boolean;
  failure_reason?: string;
  partial_failure_reason?: string;
  // Per-pass trajectory accumulated across the fact-check + regen loop.
  // Populated by the analysis orchestrator, not by parseFactCheckResponse.
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
export type DomainId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
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
  category: 'Visibility' | 'Optimization' | 'Governance' | 'Architecture' | 'Culture' | 'GenAI';
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

export interface TacticActivityPlaybookEntry {
  tactic_id: string;
  maturity_criteria: string[];
  antipattern_criteria: string[];
  activity_goal: string;
  when_to_use: string[];
  when_not_to_use: string[];
  prerequisite_evidence: string[];
  implementation_activities: string[];
  owner_roles: string[];
  expected_artifacts: string[];
  acceptance_criteria: string[];
  risks_and_controls: string[];
}
