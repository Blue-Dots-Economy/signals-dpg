import * as React from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import {
  acceptProfileConsent,
  issueProfileConsentOtp,
  verifyProfileConsentOtp,
  type ProfileConsentOtpItemRef,
} from '@/lib/consent-api';
import { isGuardianConsentRequiredDomain } from '@/lib/guardian-consent';
import { GuardianOtpDialog } from '@/components/actions/guardian-otp-dialog';
import { U18GuardianFlow } from '@/components/consent/u18/u18-guardian-flow';
import { useAuth } from '@/contexts/auth-context';
import type { DotNetworkSchema } from '@/engine/types';

export type ProfileConsentAcceptArgs = {
  network: string;
  brand: string | null;
  item: { item_id: string; item_domain: string; item_type: string };
  version: number;
  isMinor: boolean;
  /** Called after consent is recorded + caches updated (adult self-accept, or
   * after a successful guardian OTP). Consumers use it to set the active profile
   * / clear the prompt. */
  onDone: () => void;
  /**
   * Called after the guardian-capture flow resolves — either a guardian was
   * captured (`onComplete`) or the DOB step reclassified the ward as an adult
   * (`onNotMinor`). Mirrors home-page's `setU18StatusReload` bumps: the consumer
   * re-syncs its U18 status so the next accept runs with the corrected `isMinor`.
   * Optional — a consumer that doesn't track U18 status can omit it.
   */
  onGuardianStatusChanged?: () => void;
};

export interface UseProfileConsentAcceptResult {
  accept: (args: ProfileConsentAcceptArgs) => Promise<void>;
  /** Render once in the tree — hosts the guardian-OTP dialog + the guardian
   * capture flow used by the minor branch. */
  dialogs: React.ReactNode;
  isPending: boolean;
  /** True while a guardian dialog (OTP or capture) is open. A consumer that
   * shows its own blocking modal (e.g. home's ProfileConsentModal) gates on
   * `!guardianActive` so the two don't stack. */
  guardianActive: boolean;
}

/** The guardian branch keeps the item ref plus the caller's `onDone` so the OTP
 * success (which happens later, in the dialog) can run the same cache updates,
 * and the caller's `onGuardianStatusChanged` so the guardian-capture flow can
 * signal a U18-status re-sync once it resolves. */
interface GuardianPending {
  ref: ProfileConsentOtpItemRef;
  onDone: () => void;
  onGuardianStatusChanged?: () => void;
}

/**
 * Shared profile-creation-consent accept flow, extracted from `home-page.tsx`.
 *
 * - Adult (or a minor on an ungated domain) → `acceptProfileConsent` +
 *   cache updates + `onDone()`.
 * - Minor on a guardian-gated domain → issue a guardian OTP and hand off to
 *   `GuardianOtpDialog`; on `409 GUARDIAN_REQUIRED` run the `U18GuardianFlow`
 *   capture then re-issue. The ward never self-accepts on a gated domain.
 *
 * The gate needs the network schema (`guardian_consent_required` per domain);
 * it's a plain field on the raw config, so it's read from the React Query cache
 * that the consumer page already populated via `useNetworkConfig`. When the
 * config isn't cached we fail closed (treat as gated) so a minor is never
 * self-accepted by mistake.
 */
export function useProfileConsentAccept(): UseProfileConsentAcceptResult {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { signOut } = useAuth();
  const [isPending, setIsPending] = React.useState(false);
  const [guardian, setGuardian] = React.useState<GuardianPending | null>(null);
  const [guardianSetup, setGuardianSetup] = React.useState<GuardianPending | null>(null);

  // Shared cache updates for a recorded/promoted profile consent — mirrors the
  // adult accept handler on home-page: seed the profile-consent set directly
  // (not invalidate, so the derived set reflects the accepted profile in the
  // same render the caller closes the prompt) and refresh my-items (a
  // draft → live promotion leaves the cached list stale). Runs for BOTH the
  // adult self-accept and the post-guardian-OTP-success branches, so the
  // success toast lives here — exactly once per completed acceptance — rather
  // than in each caller.
  const recordAndFinish = React.useCallback(
    (network: string, itemId: string, onDone: () => void) => {
      queryClient.setQueryData<Set<string>>(
        queryKeys.profileConsent(network),
        (prev) => new Set([...(prev ?? []), itemId]),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.myItems(network) });
      toast.success(
        t('profile.guardian_consent_recorded', 'Consent recorded — your profile is now live'),
      );
      onDone();
    },
    [queryClient, t],
  );

  // Issue a MINOR's profile_creation guardian OTP for a ref and hand off to the
  // guardian-OTP dialog. No guardian on file (409 GUARDIAN_REQUIRED) → run the
  // capture flow, which re-invokes this for the same ref once a guardian exists.
  const issueOtp = React.useCallback(
    async (pending: GuardianPending) => {
      try {
        const { otpSent } = await issueProfileConsentOtp(pending.ref);
        if (otpSent) {
          setGuardian(pending);
        } else {
          // Server accepted the request but didn't send a code (nothing opens).
          // Surface it instead of failing silently so the user isn't stuck.
          toast.error(
            t(
              'u18.guardian_error_otp_unavailable',
              "Guardian confirmation isn't available on this instance right now.",
            ),
          );
        }
      } catch (err) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        const code = axios.isAxiosError(err)
          ? (err.response?.data as { error?: string } | undefined)?.error
          : undefined;
        if (status === 409 && code === 'GUARDIAN_REQUIRED') {
          setGuardianSetup(pending);
        } else if (status === 429) {
          toast.error(
            t('u18.guardian_error_rate_limited', 'Too many attempts. Please try again shortly.'),
          );
        } else if (status === 503) {
          toast.error(
            t(
              'u18.guardian_error_otp_unavailable',
              "Guardian confirmation isn't available on this instance right now.",
            ),
          );
        } else {
          toast.error(t('profile.error_generic_desc'));
        }
      }
    },
    [t],
  );

  const accept = React.useCallback(
    async (args: ProfileConsentAcceptArgs) => {
      const ref: ProfileConsentOtpItemRef = {
        network: args.network,
        brand: args.brand,
        item_domain: args.item.item_domain,
        item_type: args.item.item_type,
        item_id: args.item.item_id,
      };
      setIsPending(true);
      try {
        if (args.isMinor) {
          // A minor's profile_creation consent is GUARDIAN-given (D13): on a
          // gated domain issue a guardian OTP instead of self-accepting. Fail
          // closed when the network config isn't cached.
          const netConfig = queryClient.getQueryData<DotNetworkSchema>(
            queryKeys.networkConfig(args.network),
          );
          const gated = netConfig
            ? isGuardianConsentRequiredDomain(netConfig, args.item.item_domain)
            : true;
          if (gated) {
            await issueOtp({
              ref,
              onDone: args.onDone,
              onGuardianStatusChanged: args.onGuardianStatusChanged,
            });
            return;
          }
        }
        // Adult / ungated domain: the ward self-accepts.
        try {
          await acceptProfileConsent({
            network: args.network,
            brand: args.brand,
            item_domain: args.item.item_domain,
            item_type: args.item.item_type,
            item_id: args.item.item_id,
            version: args.version,
          });
          recordAndFinish(args.network, args.item.item_id, args.onDone);
        } catch {
          // Surface a generic error; the caller keeps its prompt open to retry.
          toast.error(t('profile.error_generic_desc'));
        }
      } finally {
        setIsPending(false);
      }
    },
    [issueOtp, queryClient, recordAndFinish, t],
  );

  const dialogs = (
    <>
      <GuardianOtpDialog
        open={!!guardian}
        onOpenChange={(open) => {
          if (!open) setGuardian(null);
        }}
        purpose={{ kind: 'profile' }}
        onLogout={() => {
          void signOut();
        }}
        onSubmitOtp={async (otp) => {
          const pending = guardian;
          if (!pending) return;
          // Throws on an invalid/expired code → GuardianOtpDialog shows the
          // inline error and keeps itself open for a retry. Do NOT catch here.
          await verifyProfileConsentOtp({ ...pending.ref, otp });
          recordAndFinish(pending.ref.network, pending.ref.item_id, pending.onDone);
          setGuardian(null);
        }}
      />
      {guardianSetup && (
        <U18GuardianFlow
          network={guardianSetup.ref.network}
          brand={guardianSetup.ref.brand ?? null}
          purpose={{ kind: 'profile' }}
          initialStep="guardian"
          onComplete={() => {
            const pending = guardianSetup;
            setGuardianSetup(null);
            // A guardian is now on file — mirror home-page's setU18StatusReload
            // bump so the consumer re-syncs U18 status, then re-issue the OTP.
            pending.onGuardianStatusChanged?.();
            void issueOtp(pending);
          }}
          onNotMinor={() => {
            const pending = guardianSetup;
            // The DOB step reclassified the ward as an adult. Close the flow (and
            // any stale OTP dialog) cleanly and signal a U18-status re-sync so the
            // consumer can re-drive `accept` with the corrected status — do NOT
            // dead-end. The ward never self-accepts here; the caller decides.
            setGuardianSetup(null);
            setGuardian(null);
            pending.onGuardianStatusChanged?.();
          }}
          onLogout={() => {
            void signOut();
          }}
        />
      )}
    </>
  );

  return { accept, dialogs, isPending, guardianActive: !!guardian || !!guardianSetup };
}
