import catalog from '../../knowledge_base/finops_theme_bindings.json';

export type ThemeBindingStatus = 'live' | 'planned';
export type ThemeBindingPhase = 'F0' | 'F1' | 'F2';
export type ThemeDetection =
  | 'paired_ratio'
  | 'numeric_series'
  | 'segment_weights'
  | 'adoption_flag'
  | 'process_records'
  | 'exception_flag'
  | 'association_pair'
  | 'declared_cadence';

export interface ThemeBinding {
  binding_id: string;
  criterion_id: string;
  family: string;
  priority: 'must' | 'should';
  status: ThemeBindingStatus;
  phase: ThemeBindingPhase;
  theme: string;
  semantic_type?: 'ratio' | 'count' | 'duration';
  higher_is?: 'better' | 'worse';
  minimum_observations?: number;
  detection: ThemeDetection;
  match_mode?: 'header_token' | 'substring';
  match_scope?: 'column' | 'headers_joined';
  series_name?: string;
  non_negative?: boolean;
  allow_cost_header?: boolean;
  left_patterns?: string[];
  right_patterns?: string[];
  header_patterns: string[];
  theme_patterns?: string[];
  pair_id?: string;
  aliases?: string[];
  never?: string[];
}

type CatalogFile = {
  version: string;
  phase: string;
  registry_id: string;
  description: string;
  never_default_criterion: boolean;
  families: string[];
  shared_never: string[];
  bindings: ThemeBinding[];
};

const DATA = catalog as CatalogFile;

export const THEME_BINDING_CATALOG_VERSION = DATA.version;
export const THEME_BINDING_REGISTRY_ID = DATA.registry_id;
export const THEME_BINDING_FAMILIES = Object.freeze([...DATA.families]);
export const THEME_BINDINGS: readonly ThemeBinding[] = Object.freeze(
  DATA.bindings.map(binding => Object.freeze({
    ...binding,
    header_patterns: Object.freeze([...(binding.header_patterns || [])]),
    theme_patterns: binding.theme_patterns ? Object.freeze([...binding.theme_patterns]) : undefined,
    left_patterns: binding.left_patterns ? Object.freeze([...binding.left_patterns]) : undefined,
    right_patterns: binding.right_patterns ? Object.freeze([...binding.right_patterns]) : undefined,
    aliases: binding.aliases ? Object.freeze([...binding.aliases]) : undefined,
    never: binding.never ? Object.freeze([...binding.never]) : undefined,
  }))
);

export const liveThemeBindings = (family?: string): ThemeBinding[] =>
  THEME_BINDINGS.filter(binding =>
    binding.status === 'live' && (!family || binding.family === family)
  );

export const plannedThemeBindings = (family?: string): ThemeBinding[] =>
  THEME_BINDINGS.filter(binding =>
    binding.status === 'planned' && (!family || binding.family === family)
  );

export const bindingTarget = (binding: ThemeBinding): { stream: 'maturity'; criterion_id: string } => ({
  stream: 'maturity',
  criterion_id: binding.criterion_id,
});
