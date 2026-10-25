import { useEffect, useState } from 'react';
import { Redirect, Route, Router, Switch } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { AppShell } from '@/components/app-shell';
import { DEFAULT_EXAMPLE_ID, examplePath } from '@/examples';
import { ExamplePage } from '@/pages/example';
import { HomePage } from '@/pages/home';
import { SandboxPage } from '@/pages/sandbox';

const DEFAULT_EXAMPLE = examplePath(DEFAULT_EXAMPLE_ID);

export function App() {
  const [dark, setDark] = useState(true);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }, [dark]);

  return (
    <Router hook={useHashLocation}>
      <AppShell dark={dark} onToggleTheme={() => setDark((value) => !value)}>
        <Switch>
          <Route path="/">
            <HomePage />
          </Route>

          <Route path="/examples">
            <Redirect to={DEFAULT_EXAMPLE} />
          </Route>
          <Route path="/examples/:id">
            <ExamplePage dark={dark} />
          </Route>

          <Route path="/sandbox">
            <SandboxPage />
          </Route>

          <Route>
            <Redirect to="/" />
          </Route>
        </Switch>
      </AppShell>
    </Router>
  );
}
