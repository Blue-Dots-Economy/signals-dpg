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
  /** Called after consent is recorded and caches updated (adult self-accept,
   * or a successful guardian OTP). */
  onDone: () => void;
  /**
   * Called when the guardian-capture flow resolves (guardian captured, or the
   * DOB step reclassified the ward as an adult), so the consumer re-syncs its
   * U18 status before the next accept.
   */
  onGuardianStatusChanged?: () => void;
};

export interface UseProfileConsentAcceptResult {
  accept: (args: ProfileConsentAcceptArgs) => Promise<void>;
  /** Render once in the tree: hosts the guardian-OTP dialog and capture flow. */
  dialogs: React.ReactNode;
  isPending: boolean;
  /** True while a guardian dialog is open. A consumer with its own blocking
   * modal gates on `!guardianActive` so the two don't stack. */
  guardianActive: boolean;
}

/** Kept so the later OTP success (in the dialog) can run the same cache updates
 * and the capture flow can signal a U18-status re-sync. */
interface GuardianPending {
  ref: ProfileConsentOtpItemRef;
  onDone: () => void;
  onGuardianStatusChanged?: () => void;
}

/**
 * Shared profile-creation consent accept flow.
 *
 * - Adult, or a minor on an ungated domain: `acceptProfileConsent`, cache
 *   updates, `onDone()`.
 * - Minor on a guardian-gated domain: issue a guardian OTP and open
 *   `GuardianOtpDialog`; on `409 GUARDIAN_REQUIRED` run the `U18GuardianFlow`
 *   capture first. The ward never self-accepts on a gated domain.
 *
 * The gate reads `guardian_consent_required` from the cached network config and
 * fails closed (treats the domain as gated) when it is not cached.
 */
export function useProfileConsentAccept(): UseProfileConsentAcceptResult {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { signOut } = useAuth();
  const [isPending, setIsPending] = React.useState(false);
  const [guardian, setGuardian] = React.useState<GuardianPending | null>(null);
  const [guardianSetup, setGuardianSetup] = React.useState<GuardianPending | null>(null);

  // Seeds the profile-consent set directly (not invalidate) so the accepted
  // profile shows in the same render the caller closes the prompt, and
  // refreshes my-items (draft → live leaves the list stale). Shared by both
  // branches, so the success toast fires exactly once per acceptance.
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

  // Issues a minor's profile_creation guardian OTP. With no guardian on file
  // (409 GUARDIAN_REQUIRED) the capture flow runs and re-invokes this.
  const issueOtp = React.useCallback(
    async (pending: GuardianPending) => {
      try {
        const { otpSent } = await issueProfileConsentOtp(pending.ref);
        if (otpSent) {
          setGuardian(pending);
        } else {
          // Accepted but no code sent: say so rather than leave the user stuck.
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
          // A minor's profile_creation consent is guardian-given on a gated
          // domain. Fail closed when the network config isn't cached.
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
          // The caller keeps its prompt open to retry.
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
          // Throws on an invalid/expired code; GuardianOtpDialog shows the
          // inline error and stays open, so do not catch here.
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
            // A guardian is now on file: re-sync U18 status, then re-issue.
            pending.onGuardianStatusChanged?.();
            void issueOtp(pending);
          }}
          onNotMinor={() => {
            const pending = guardianSetup;
            // The DOB step reclassified the ward as an adult. Close the flow and
            // any stale OTP dialog and signal a re-sync; the caller re-drives
            // `accept`.
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
