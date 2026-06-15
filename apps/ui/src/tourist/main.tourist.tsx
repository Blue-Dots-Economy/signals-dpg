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

// Browser tab title — configurable per deployment via VITE_TOURIST_APP_TITLE
// (runtime config /config.js, else build-time env), defaulting to "OneTAC".
document.title = getRuntimeEnv('VITE_TOURIST_APP_TITLE')?.trim() || 'OneTAC';

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
