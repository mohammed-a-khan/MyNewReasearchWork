/** A code journey that kills its own process (a native crash stand-in), for the process-worker tests. Synthetic. */
import { journey, step } from 'eztest/sdk';

journey('Crashes its process', { id: 'crashes' }, async ({ ui }) => {
  await ui.open('/login');
  await step('Abort the process', async () => {
    process.abort();
  });
});

journey('Burns the CPU', { id: 'burns' }, async ({ ui }) => {
  await ui.open('/login');
  await step('Busy for two seconds', async () => {
    const end = Date.now() + 2000;
    while (Date.now() < end) {
      // a CPU-bound code step: only its own worker is busy
    }
  });
});
