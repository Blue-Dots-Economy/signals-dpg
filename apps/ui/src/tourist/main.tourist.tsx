import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeModeProvider } from '@/theme/mode-provider';
import '../i18n';
import '../index.css';
import '@/components/map/providers';
import { TouristApp } from './tourist-app';
import { getRuntimeEnv } from '@/lib/runtime-env';
import { resolveBrandMeta } from '@/theme/brand-meta';
import { TOURIST_NETWORK_ID, TOURIST_BRAND } from './resolve-tourist-config';

// Browser tab title — sources in order:
//   1. resolved brand copy.title (e.g. "OneTAC" when onetac brand is active)
//   2. VITE_TOURIST_APP_TITLE runtime/build env
//   3. neutral default 'Signals'
const _meta = resolveBrandMeta(TOURIST_NETWORK_ID, TOURIST_BRAND);
document.title = _meta.copy['title'] || getRuntimeEnv('VITE_TOURIST_APP_TITLE')?.trim() || 'Signals';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 0, retry: 2 } } });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeModeProvider>
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <TouristApp />
        </QueryClientProvider>
      </TooltipProvider>
    </ThemeModeProvider>
  </React.StrictMode>,
);
