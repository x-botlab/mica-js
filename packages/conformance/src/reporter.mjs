export default async function* executionReporter(events) {
  for await (const event of events) {
    if (!['test:pass', 'test:fail'].includes(event.type)) continue;
    const { name, skip, todo } = event.data;
    const status = skip || todo ? 'skipped' : event.type === 'test:pass' ? 'passed' : 'failed';
    yield `${JSON.stringify({ name, status })}\n`;
  }
}
