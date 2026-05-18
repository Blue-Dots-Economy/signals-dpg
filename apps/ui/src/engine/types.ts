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
  event_schema: RJSFSchema;
}

export interface DotNetworkDomain {
  id: string;
  description: string;
  default_item_schemas?: {
    profile: RJSFSchema;
  };
  item_schemas?: Record<string, RJSFSchema>;
}

export interface DotNetworkInteraction {
  from_domain: string;
  to_domain: string;
  requirement_schema: RJSFSchema;
  event_schema: RJSFSchema;
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

// ─── Privacy ───────────────────────────────────────────────────

export type PrivacyMode = 'all' | 'public-only';

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
}

export interface MapProviderProps {
  center: [number, number];
  zoom: number;
  markers: MapMarker[];
  onMarkerClick?: (id: string) => void;
  children?: React.ReactNode;
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
}
