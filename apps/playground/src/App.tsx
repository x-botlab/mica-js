import { useEffect, useState } from 'react';
import { AppShell, PAGES, type PageId } from '@/components/app-shell';
import { navigate, useHashRoute } from '@/lib/router';
import { HomePage } from '@/pages/home';
import { SandboxPage } from '@/pages/sandbox';
import { SchematicPage } from '@/pages/schematic';

const ROUTES = PAGES.map((page) => ({ id: page.id, path: `#/${page.id}` }));

export function App() {
  const route = useHashRoute<PageId>(ROUTES, 'home');
  const [dark, setDark] = useState(true);
  const page = PAGES.find((candidate) => candidate.id === route) ?? PAGES[0]!;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }, [dark]);

  return (
    <AppShell
      page={page}
      dark={dark}
      onNavigate={navigate}
      onToggleTheme={() => setDark((value) => !value)}
    >
      {route === 'schematic' ? (
        <SchematicPage dark={dark} />
      ) : route === 'sandbox' ? (
        <SandboxPage />
      ) : (
        <HomePage />
      )}
    </AppShell>
  );
}
