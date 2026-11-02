import type { RJSFSchema } from '@rjsf/utils';
import type { LucideIcon } from 'lucide-react';
import type { GoLiveGate } from '@dpg/schemas';

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
  reveals_pii_on_status?: string[];
}

/**
 * A status rule from the network config. `when` is a server-evaluated predicate
 * or the literal "default" (always-match fallback, must be last).
 */
export interface StatusRule {
  status: string;
  /** Human-readable label for display. Falls back to `status` when absent. */
  label?: string;
  /** Longer description for tooltips / filter panel copy. */
  description?: string;
  /** Server-evaluated; the client treats it as opaque. */
  when: Record<string, unknown> | 'default';
}

/**
 * Per-domain card display config (network.json `card` block). All fields are
 * optional; the UI falls back to a best guess when a domain has no `card` block.
 */
export interface DotCardConfig {
  /** Field key whose value is the card heading. */
  title_field?: string;
  /** Field key rendered as a secondary line under the title. */
  subtitle_field?: string;
  /** Field key used to derive avatar initials (defaults to title_field). */
  avatar_from?: string;
  /** Ordered field keys shown collapsed; everything else moves behind "view more". */
  default_fields?: string[];
  /**
   * Field keys revealed behind "view more". When set, only these (in this
   * order) are shown as extra rows. When omitted, all remaining non-empty
   * schema fields are shown in schema order.
   */
  extra_fields?: string[];
}

export interface DotNetworkDomain {
  id: string;
  description: string;
  /** Display label; falls back to the title-cased id when unset. */
  label?: string;
  /**
   * Per-domain heading for the sidebar "My Profile(s)" group (e.g. "My Jobs");
   * falls back to the generic label when unset.
   */
  my_items_label?: string;
  default_item_schemas?: {
    profile: RJSFSchema;
  };
  item_schemas?: Record<string, RJSFSchema>;
  /**
   * Lifecycle status rules for items in this domain. The UI does not read
   * these today.
   */
  status_rules?: StatusRule[];
  card?: DotCardConfig;
  /**
   * When true, a minor holding a profile in this domain goes through the
   * guardian consent flow instead of the adult consent gate.
   */
  guardian_consent_required?: boolean;
  /**
   * Go-live gate tokens (network.json `go_live_required`). When present without
   * `consent_required`, the UI skips the Terms/Privacy gate at signup for this
   * domain. Absent means consent is required.
   *
   * Typed from @dpg/schemas so a new token cannot drift from this union.
   */
  go_live_required?: GoLiveGate[];
  /**
   * Per-domain "why complete your profile" prompt on the create/edit page;
   * a generic i18n fallback is used when unset. Presentational only.
   */
  profile_completion_prompt?: {
    heading: string;
    body: string;
  };
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
  /** Bulk-export eligibility: which side(s) may export the counterparty. */
  export?: { requester_domains: string[] };
  /** Status buckets; `create` = still waiting on the receiver. */
  metric_categories?: {
    create?: string[];
    accept?: string[];
    reject?: string[];
    cancel?: string[];
  } | null;
  /** Fields of each side shown to the other in My Actions (server-filtered to non-private). */
  column_fields?: { from?: string[]; to?: string[] };
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
  /** Shows the "Pause profile" control. Absent means enabled. */
  pause_enabled?: boolean;
  domains: DotNetworkDomain[];
  instances?: DotNetworkInstance[];
  actions: Record<string, DotNetworkAction>;
}

export type SchemaInput =
  | RJSFSchema
  | DotProfileSchema
  | DotNetworkSchema
  | DotActionSchema
  | string
  | { url: string }
  | { api: string; baseUrl?: string };

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

export type MapMarkerPrecision = 'exact' | 'geocoded_full_address';

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  label: string;
  data: Record<string, unknown>;
  precision: MapMarkerPrecision;
  geocodedFrom?: string;
  /** The item's domain (e.g. "seeker"); picks the marker icon. */
  domain?: string;
}

export interface MapProviderProps {
  center: [number, number];
  zoom: number;
  markers: MapMarker[];
  onMarkerClick?: (id: string) => void;
  /** When true, the provider does not auto-fit bounds on first render. */
  initialViewSet?: boolean;
  /**
   * Counter bumped on an explicit "recenter" intent. The provider recenters on
   * `center` even when the coordinate is unchanged, so re-selecting the same
   * anchor after panning still snaps back. Ignored when `initialViewSet` is false.
   */
  focusNonce?: number;
  /**
   * Counter bumped to close any open marker popup, e.g. before a modal opens:
   * the popup sits in a map overlay and would otherwise cover a mobile
   * bottom-sheet modal.
   */
  closePopupNonce?: number;
  /**
   * The user's own location (see `useUserLocation`). When set, the provider
   * renders a separate, non-clustered, non-clickable "You are here" marker.
   */
  selfLocation?: { lat: number; lng: number } | null;
  children?: React.ReactNode;
  /** Custom popup renderer; falls back to MarkerPopupCard. */
  renderPopup?: (marker: MapMarker) => React.ReactNode;
  /**
   * Draw the provider's own marker popup. Default true. The phone home map turns
   * it off and shows details in a bottom sheet via `onMarkerClick`.
   */
  showPopup?: boolean;
  /**
   * Per-marker icon resolver. Defaults to a domain-based lucide icon
   * (`getIconForDomain`); the tourist app keys on `data.category`.
   */
  resolveIcon?: (marker: MapMarker) => LucideIcon;
  /**
   * Per-marker image resolver. A returned URL renders that image in a white
   * circle instead of the icon pin (the tourist app's RubiX favicon).
   */
  resolveMarkerImage?: (marker: MapMarker) => string | null | undefined;
  /**
   * Called with the viewport on debounced (~300ms) `moveend`/`idle`. When
   * unset (e.g. the tourist app) the provider attaches no listener.
   */
  onViewportChange?: (viewport: MapViewport) => void;
}

export interface MapProvider {
  name: string;
  component: React.ComponentType<MapProviderProps>;
}

/**
 * The map's viewport, reported on debounced pan/zoom settle (Leaflet `moveend`
 * / Google `idle`). `radiusMeters` is the half-diagonal (center to a bounds
 * corner), a provider-agnostic proxy for visible area.
 *
 * `zoom` and the bbox corners are optional because hand-built viewports (the
 * list's distance path, tests) carry only center + radius. Both live providers
 * always populate them. Callers that need the bbox (`useMapMarkers`, the
 * markers query key) fall back to the radius shape when they are unset.
 */
export interface MapViewport {
  lat: number;
  lng: number;
  radiusMeters: number;
  zoom?: number;
  minLat?: number;
  minLng?: number;
  maxLat?: number;
  maxLng?: number;
}

export interface RendererPlugin {
  name: string;
  components: Map<string, React.ComponentType<Record<string, unknown>>>;
}

export type ViewMode = 'list' | 'map';

export interface FilterState {
  search: string;
  selectedDomain: string | null;
  viewMode: ViewMode;
  /** Active status filter values; empty means no status filter. */
  selectedStatuses: string[];
  /**
   * Domain filter values for the map filters panel (multi-select, separate from
   * the sidebar's single-domain tab). Empty means all domains.
   */
  selectedDomains: string[];
}
