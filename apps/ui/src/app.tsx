import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Toaster } from 'sonner';
import { RequireAuth } from '@/components/auth/require-auth';
import { AuthProvider } from '@/contexts/auth-context';
import { NetworkThemeProvider } from '@/theme/theme-provider';
import { ThemeModeProvider } from '@/theme/mode-provider';
import { HomePage } from './pages/home-page';
import { ProfileFormPage } from './pages/profile-form-page';
import { LoginPage } from './pages/auth/login-page';
import { OtpPage } from './pages/auth/otp-page';
import { MyActionsPage } from './pages/my-actions-page';
import { PrivacyPage } from './pages/legal/privacy-page';
import { TermsPage } from './pages/legal/terms-page';
import { PublicProfilePage } from './pages/public-profile-page';

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
       <ThemeModeProvider>
        <NetworkThemeProvider>
          <Toaster
            position="top-center"
            richColors
            closeButton
            offset={20}
            toastOptions={{ duration: 5000 }}
          />
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/profile/new" element={<RequireAuth><ProfileFormPage /></RequireAuth>} />
            <Route path="/profile/:id/edit" element={<RequireAuth><ProfileFormPage /></RequireAuth>} />
            <Route path="/auth/login" element={<LoginPage />} />
            <Route path="/auth/otp" element={<OtpPage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="/p/:network/:domain/:itemType/:itemId" element={<PublicProfilePage />} />
            <Route path="/my-actions" element={<RequireAuth><MyActionsPage /></RequireAuth>} />
            <Route path="/my-actions/*" element={<RequireAuth><MyActionsPage /></RequireAuth>} />
          </Routes>
        </NetworkThemeProvider>
       </ThemeModeProvider>
      </BrowserRouter>
    </AuthProvider>
  );
}
