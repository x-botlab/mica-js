import { useEffect, useState } from 'react';
import { AppShell, resolveNavigation } from '@/components/app-shell';
import { navigate, useHashPath } from '@/lib/router';
import { CanvasPage } from '@/pages/canvas';
import { HomePage } from '@/pages/home';
import { SchematicPage } from '@/pages/schematic';

/** The sidebar and the rendered page read the same hash path, so a link cannot drift. */
export function App() {
  const path = useHashPath();
  const { group, entry } = resolveNavigation(path);
  const [dark, setDark] = useState(true);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }, [dark]);

  return (
    <AppShell
      page={group}
      entry={entry}
      dark={dark}
      onNavigate={navigate}
      onToggleTheme={() => setDark((value) => !value)}
    >
      {group.id === 'schematic' && entry?.page === 'schematic' ? (
        <SchematicPage dark={dark} exampleId={entry.exampleId} />
      ) : group.id === 'canvas' && entry?.page === 'canvas' ? (
        <CanvasPage exampleId={entry.exampleId} />
      ) : (
        <HomePage />
      )}
    </AppShell>
  );
}
