import type { RJSFSchema } from '@rjsf/utils';

// ─── Schema Types ───────────────────────────────────────────────

export interface DotProfileSchema {
  info: string;
  name: string;
  version: string;
  details: {
    dot: string;
    domain: string;
  };
  schema_type: 'profile';
  schema: RJSFSchema;
}

export interface DotActionSchema {
  action_type: string;
  from_domain: string;
  to_domain: string;
  requirement_schema: RJSFSchema;
  event_schema?: RJSFSchema;
  consent_text_initiator?: string;
  consent_text_receiver?: string;
  reveals_pii_on_status?: string[];
}

// ─── Status Rules ──────────────────────────────────────────────

/**
 * A single status rule from the network config. The `when` field is either a
 * predicate object (evaluated by the server) or the literal string "default"
 * (always-match fallback, must be last in the array).
 */
export interface StatusRule {
  status: string;
  /** Human-readable label for display. Falls back to `status` when absent. */
  label?: string;
  /** Optional longer description for tooltips / filter panel copy. */
  description?: string;
  /**
   * Predicate evaluated by the server. The client receives this opaquely; it
   * is used only to enumerate the distinct status values for the filter panel.
   */
  when: Record<string, unknown> | 'default';
}

/**
 * Per-domain card display config (network.json `card` block). Controls which
 * fields a card shows by default and which become "view more" rows, plus the
 * heading / avatar source. All fields optional — the UI falls back to a
 * best-guess when a domain has no `card` block.
 */
export interface DotCardConfig {
  /** Field key whose value is the card heading. */
  title_field?: string;
  /** Optional field key rendered as a secondary line under the title. */
  subtitle_field?: string;
  /** Field key used to derive avatar initials (defaults to title_field). */
  avatar_from?: string;
  /** Ordered field keys shown collapsed; everything else moves behind "view more". */
  default_fields?: string[];
}

export interface DotNetworkDomain {
  id: string;
  description: string;
  default_item_schemas?: {
    profile: RJSFSchema;
  };
  item_schemas?: Record<string, RJSFSchema>;
  /**
   * Lifecycle status rules for items in this domain. Defined in network.json
   * per-domain. The client uses these to enumerate filter options and to
   * derive a best-effort status for each item client-side (see item-status.ts).
   */
  status_rules?: StatusRule[];
  /** Card display config — see {@link DotCardConfig}. */
  card?: DotCardConfig;
}

export interface DotNetworkInteraction {
  from_network?: string;
  from_domain: string;
  from_items?: string[];
  to_network?: string;
  to_domain: string;
  to_items?: string[];
  requirement_schema: RJSFSchema;
  event_schema?: RJSFSchema;
  reveals_pii_on_status?: string[];
  consent_text_initiator?: string;
  consent_text_receiver?: string;
}

export interface DotNetworkInstance {
  domain_id: string;
  instance_name?: string;
  instance_url: string;
  custom_item_schema_urls?: Record<string, string>;
}

export interface DotNetworkAction {
  description: string;
  interactions: DotNetworkInteraction[];
}

export interface DotNetworkSchema {
  id: string;
  display_name: string;
  description: string;
  schema_standard: string;
  domains: DotNetworkDomain[];
  instances?: DotNetworkInstance[];
  actions: Record<string, DotNetworkAction>;
}

// ─── Schema Input Types ────────────────────────────────────────

export type SchemaInput =
  | RJSFSchema
  | DotProfileSchema
  | DotNetworkSchema
  | DotActionSchema
  | string
  | { url: string }
  | { api: string; baseUrl?: string };

// ─── Card Types ────────────────────────────────────────────────

export interface CardField {
  key: string;
  label: string;
  value: unknown;
  type: string;
  format?: string;
}

export interface ActionButton {
  type: string;
  label: string;
  actionSchema: DotActionSchema;
}

// ─── Map Types ─────────────────────────────────────────────────

export type MapMarkerPrecision = 'exact' | 'geocoded_pincode' | 'geocoded_full_address' | 'geocoded_city_only';

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  label: string;
  data: Record<string, unknown>;
  precision: MapMarkerPrecision;
  geocodedFrom?: string;
  /** The item's domain string (e.g. "seeker", "provider"). Used to pick the marker icon. */
  domain?: string;
}

export interface MapProviderProps {
  center: [number, number];
  zoom: number;
  markers: MapMarker[];
  onMarkerClick?: (id: string) => void;
  /** When true, the provider should NOT auto-fit bounds on first render */
  initialViewSet?: boolean;
  children?: React.ReactNode;
  /** Optional custom popup renderer; falls back to the default MarkerPopupCard. */
  renderPopup?: (marker: MapMarker) => React.ReactNode;
}

export interface MapProvider {
  name: string;
  component: React.ComponentType<MapProviderProps>;
}

// ─── Plugin Types ──────────────────────────────────────────────

export interface RendererPlugin {
  name: string;
  components: Map<string, React.ComponentType<Record<string, unknown>>>;
}

// ─── View Mode ─────────────────────────────────────────────────

export type ViewMode = 'list' | 'map';

// ─── Filter State ──────────────────────────────────────────────

export interface FilterState {
  search: string;
  selectedDomain: string | null;
  viewMode: ViewMode;
  /**
   * Active status filter values (e.g. ["new", "active"]). An empty array means
   * "show all" (no status filter applied).
   */
  selectedStatuses: string[];
  /**
   * Active domain filter values for the map filters panel (multi-select,
   * separate from the sidebar's single-domain tab selector).
   * An empty array means "show all domains".
   */
  selectedDomains: string[];
}
