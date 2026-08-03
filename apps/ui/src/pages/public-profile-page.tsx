import * as React from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { RJSFSchema } from '@rjsf/utils';
import { useResolvedNetwork } from '@/hooks/use-network-config';
import { useItemDetail } from '@/hooks/use-item-detail';
import { DomainCard } from '@/components/cards/domain-card';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function titleCaseDomain(id: string): string {
  return id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Centered standalone chrome for every state (themed by NetworkThemeProvider). */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}

function Message({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-background p-6 text-center shadow-sm">
      <h1 className="text-lg font-semibold text-foreground">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * Public, unauthenticated single-profile view for a shared link
 * (`/p/:network/:domain/:itemType/:itemId`). Fetches the one profile via the
 * public, masked, jittered, live-only item endpoint (through `useItemDetail`)
 * and renders it with the shared `DomainCard`. Never exposes PII or a raw
 * error: empty/invalid → "unavailable"; transient failure → "try again".
 */
export function PublicProfilePage() {
  const { t } = useTranslation();
  const { network, domain, itemType, itemId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  // Keep the theme aligned to the link's network (the theme provider reads the
  // `?network=` query param; our own links include it, but sync it defensively
  // for links that lost the query string).
  React.useEffect(() => {
    if (network && searchParams.get('network') !== network) {
      const next = new URLSearchParams(searchParams);
      next.set('network', network);
      setSearchParams(next, { replace: true });
    }
  }, [network, searchParams, setSearchParams]);

  const keyValid = Boolean(network && domain && itemType && itemId && UUID_RE.test(itemId));

  const { data: net, isLoading: netLoading } = useResolvedNetwork(keyValid ? network! : null);
  const { item, isLoading: itemLoading, isError } = useItemDetail(
    keyValid ? network! : null,
    keyValid ? { item_id: itemId!, item_domain: domain!, item_type: itemType! } : null,
  );

  if (!keyValid) {
    return (
      <Shell>
        <Message title={t('public_profile.unavailable_title', 'Profile unavailable')} body={t('public_profile.unavailable_body', 'This profile is no longer available, or the link is invalid.')} />
      </Shell>
    );
  }

  if (netLoading || itemLoading) {
    return (
      <Shell>
        <div className="rounded-2xl bg-background p-6 text-center text-sm text-muted-foreground shadow-sm">
          {t('public_profile.loading', 'Loading profile…')}
        </div>
      </Shell>
    );
  }

  if (isError) {
    return (
      <Shell>
        <Message
          title={t('public_profile.error_title', 'Something went wrong')}
          body={t('public_profile.error_body', "We couldn't load this profile. Please try again.")}
          action={
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              {t('public_profile.retry', 'Try again')}
            </button>
          }
        />
      </Shell>
    );
  }

  // Live-only endpoint: a returned item is live. Guard defensively anyway.
  if (!item || (item.lifecycle_status && item.lifecycle_status !== 'live')) {
    return (
      <Shell>
        <Message title={t('public_profile.unavailable_title', 'Profile unavailable')} body={t('public_profile.unavailable_body', 'This profile is no longer available, or the link is invalid.')} />
      </Shell>
    );
  }

  const domainCfg = net?.domains.find((d) => d.id === domain);
  const schema = (domainCfg?.item_schemas?.[itemType!] ??
    (domainCfg?.item_schemas ? Object.values(domainCfg.item_schemas)[0] : undefined)) as
    | RJSFSchema
    | undefined;

  return (
    <Shell>
      <DomainCard
        schema={(schema ?? { type: 'object', properties: {} }) as RJSFSchema}
        cardConfig={domainCfg?.card ?? null}
        data={item.item_state}
        domainLabel={titleCaseDomain(domain!)}
      />
    </Shell>
  );
}

export default PublicProfilePage;
