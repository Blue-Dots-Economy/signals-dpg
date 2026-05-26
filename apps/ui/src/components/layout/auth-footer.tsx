import { useNetworkTheme } from '@/theme/theme-provider';

export function AuthFooter() {
  const { theme } = useNetworkTheme();

  return (
    <footer className="px-6 pb-6 pt-4 sm:px-10 lg:px-14 text-xs text-muted-foreground">
      <p className="mb-3">
        By continuing you agree to the{' '}
        <a href="/privacy" className="underline underline-offset-2 hover:text-foreground">
          Privacy Policy
        </a>{' '}
        and{' '}
        <a href="/terms" className="underline underline-offset-2 hover:text-foreground">
          Terms
        </a>
        .
      </p>
      <div className="flex items-center justify-between">
        <span>{theme.inviteLine}</span>
        <a href="mailto:support@onest.network" className="hover:text-foreground hover:underline">
          Need help?
        </a>
      </div>
    </footer>
  );
}
