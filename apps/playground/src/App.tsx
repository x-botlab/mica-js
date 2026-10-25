import { useEffect, useState } from 'react';
import { Redirect, Route, Router, Switch } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { AppShell } from '@/components/app-shell';
import { BasicWidgetsPage } from '@/pages/canvas-examples/basic-widgets';
import { SimpleCanvasPage } from '@/pages/canvas-examples/simple-canvas';
import { HomePage } from '@/pages/home';
import { SandboxPage } from '@/pages/sandbox';
import { BasicIoPage } from '@/pages/schematic-examples/basic-io';
import { LedBlinkPage } from '@/pages/schematic-examples/led-blink';
import { SegmentDisplayPage } from '@/pages/schematic-examples/segment-display';

const DEFAULT_SCHEMATIC_EXAMPLE = '/schematic-examples/led-blink';
const DEFAULT_CANVAS_EXAMPLE = '/canvas-examples/basic-widgets';

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

          <Route path="/schematic-examples">
            <Redirect to={DEFAULT_SCHEMATIC_EXAMPLE} />
          </Route>
          <Route path="/schematic-examples/led-blink">
            <LedBlinkPage dark={dark} />
          </Route>
          <Route path="/schematic-examples/segment-display">
            <SegmentDisplayPage dark={dark} />
          </Route>
          <Route path="/schematic-examples/basic-io">
            <BasicIoPage dark={dark} />
          </Route>

          <Route path="/canvas-examples">
            <Redirect to={DEFAULT_CANVAS_EXAMPLE} />
          </Route>
          <Route path="/canvas-examples/basic-widgets">
            <BasicWidgetsPage dark={dark} />
          </Route>
          <Route path="/canvas-examples/simple-canvas">
            <SimpleCanvasPage dark={dark} />
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
