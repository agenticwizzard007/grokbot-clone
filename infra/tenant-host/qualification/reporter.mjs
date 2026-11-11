// Only synthetic fixture test names/results are exported. No process environment,
// Docker info dump, credentials, stack traces or arbitrary diagnostic properties.
export default async function* reporter(source) {
  for await (const event of source) {
    if (event.type === 'test:summary') {
      yield JSON.stringify({ type: event.type, data: { success: event.data.success, counts: event.data.counts } }) + '\n';
    } else if (['test:pass', 'test:fail'].includes(event.type)) {
      const { name, nesting, skip, todo } = event.data;
      yield JSON.stringify({ type: event.type, data: { name, nesting, skip, todo } }) + '\n';
    }
  }
}
