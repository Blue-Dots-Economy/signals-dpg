import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../i18n';
import '../index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 0, retry: 2 } },
});

function TouristApp() {
  return <div data-testid="tourist-root">Tourist UI</div>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TouristApp />
    </QueryClientProvider>
  </React.StrictMode>,
);
