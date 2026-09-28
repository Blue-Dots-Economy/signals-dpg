import * as React from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { CircleHelp, PlayCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuth } from '@/contexts/auth-context';
import { hasSeenTour, isTourRunning, markTourSeen, runTour } from './run-tour';
import { TOURS, findTour, type GuideTour } from './tours';

/**
 * Top-bar "?" menu: lists the tours for this page first, then the rest.
 * Also auto-starts a first-visit tour and honours `?tour=<id>` links. SPIKE.
 */
export function GuideButton() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { isAuthenticated } = useAuth();

  const available = TOURS.filter((tour) => !tour.requiresAuth || isAuthenticated);
  const here = available.filter((tour) => tour.matches(pathname, searchParams));
  const elsewhere = available.filter((tour) => !tour.matches(pathname, searchParams));

  const start = React.useCallback(
    (tour: GuideTour, opts?: { replace?: boolean }) => {
      markTourSeen(tour.id);
      if (!tour.matches(pathname, searchParams)) {
        navigate(tourTarget(tour, pathname, searchParams), { replace: opts?.replace });
      }
      void runTour(tour);
    },
    [navigate, pathname, searchParams],
  );

  // `?tour=<id>` deep link — e.g. a link in a training email.
  const requested = searchParams.get('tour');
  React.useEffect(() => {
    if (!requested) return;
    const tour = findTour(requested);
    // One navigation, not two: when the tour needs another page or view, its
    // target URL already drops `tour`; a separate param update would race it.
    if (tour && !tour.matches(pathname, searchParams)) {
      if (!isTourRunning()) start(tour, { replace: true });
      return;
    }
    setSearchParams(
      (prev) => {
        prev.delete('tour');
        return prev;
      },
      { replace: true },
    );
    if (tour && !isTourRunning()) start(tour);
  }, [requested, pathname, searchParams, setSearchParams, start]);

  // First visit: play the page's auto-start tour once. Skipped under test
  // runners and browser automation, where an overlay would block the run.
  React.useEffect(() => {
    if (requested || import.meta.env.MODE === 'test' || navigator.webdriver) return;
    const tour = TOURS.find((t) => t.autoStart && t.matches(pathname, searchParams));
    if (tour && !hasSeenTour(tour.id) && !isTourRunning()) start(tour);
  }, [pathname, searchParams, requested, start]);

  const label = t('guide.menu', 'Help and tours');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button data-tour="guide-button" variant="ghost" size="icon" aria-label={label} title={label}>
          <CircleHelp className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {here.length > 0 && (
          <>
            <DropdownMenuLabel>{t('guide.this_page', 'On this page')}</DropdownMenuLabel>
            {here.map((tour) => (
              <TourItem key={tour.id} tour={tour} onSelect={start} />
            ))}
          </>
        )}
        {here.length > 0 && elsewhere.length > 0 && <DropdownMenuSeparator />}
        {elsewhere.length > 0 && (
          <>
            <DropdownMenuLabel>{t('guide.how_do_i', 'How do I…')}</DropdownMenuLabel>
            {elsewhere.map((tour) => (
              <TourItem key={tour.id} tour={tour} onSelect={start} />
            ))}
          </>
        )}
        {!isAuthenticated && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            {t('guide.login_for_more', 'Log in to see guides for profiles and requests.')}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The tour's start URL; on the same page, its query is merged into the current one. */
function tourTarget(tour: GuideTour, pathname: string, current: URLSearchParams): string {
  const target = new URL(tour.path, window.location.origin);
  if (target.pathname !== pathname) return tour.path;
  const merged = new URLSearchParams(current);
  merged.delete('tour');
  target.searchParams.forEach((value, key) => merged.set(key, value));
  return `${pathname}?${merged.toString()}`;
}

function TourItem({ tour, onSelect }: Readonly<{ tour: GuideTour; onSelect: (t: GuideTour) => void }>) {
  return (
    <DropdownMenuItem data-tour-item={tour.id} onSelect={() => onSelect(tour)}>
      <PlayCircle className="h-4 w-4" />
      {tour.title}
    </DropdownMenuItem>
  );
}
