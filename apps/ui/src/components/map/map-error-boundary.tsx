import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { MapPinOff } from 'lucide-react';

/**
 * Contains a map-provider failure to the map area so the rest of the browse
 * page survives. Known causes: a misconfigured `VITE_MAP_PROVIDER` throws
 * during render, and a Google `RefererNotAllowedMapError` leaves the Maps API
 * half-initialized so every `<AdvancedMarker>` throws.
 *
 * `heightClassName` mirrors `MapView`'s so the layout does not jump. A class
 * component because `componentDidCatch` has no hook equivalent.
 */
interface MapErrorBoundaryProps {
  children: React.ReactNode;
  heightClassName?: string;
}

interface MapErrorBoundaryState {
  error: Error | null;
}

export class MapErrorBoundary extends React.Component<
  MapErrorBoundaryProps,
  MapErrorBoundaryState
> {
  state: MapErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): MapErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error) {
    // The message is the only place the provider name or Maps error code
    // survives.
    console.error('Map provider failed; rendering the fallback instead:', error);
  }

  render() {
    if (this.state.error) {
      return <MapFailureNotice heightClassName={this.props.heightClassName} />;
    }
    return this.props.children;
  }
}

function MapFailureNotice({ heightClassName }: Readonly<{ heightClassName?: string }>) {
  const { t } = useTranslation();
  return (
    // <output> for the native implicit status role (Sonar S6819).
    <output
      data-testid="map-failure-notice"
      className={`flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center ${
        heightClassName ?? 'h-[calc(100dvh-8rem)] min-h-[400px]'
      }`}
    >
      <MapPinOff className="h-6 w-6 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium text-foreground">{t('map.unavailable_title')}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{t('map.unavailable_body')}</p>
    </output>
  );
}
