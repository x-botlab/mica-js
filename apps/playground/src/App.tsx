import { useEffect, useState } from 'react';
import { AppShell, PAGES, type PageId } from '@/components/app-shell';
import { navigate, useHashRoute } from '@/lib/router';
import { CanvasPage } from '@/pages/canvas';
import { HomePage } from '@/pages/home';
import { SandboxPage } from '@/pages/sandbox';
import { SchematicPage } from '@/pages/schematic';
import { SimulatorPage } from '@/pages/simulator';

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
      ) : route === 'canvas' ? (
        <CanvasPage />
      ) : route === 'sandbox' ? (
        <SandboxPage />
      ) : route === 'simulator' ? (
        <SimulatorPage />
      ) : (
        <HomePage />
      )}
    </AppShell>
  );
}
