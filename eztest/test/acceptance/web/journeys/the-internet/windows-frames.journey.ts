/**
 * Windows and frames from code (the-internet.herokuapp.com): read a value in a popup and check it on the main page,
 * read every frame of a frameset, and count broken images through the raw page.
 */
import { expect, journey, step, ui } from '@mohammed-a-khan/eztest/sdk';

journey('Windows, frames and images from code', { tags: ['@the-internet', '@code'], baseUrl: 'https://the-internet.herokuapp.com' }, async () => {
  await step('A popup: read its heading, close it, carry on in the main window', async () => {
    await ui.open('/windows');
    const before = await ui.title();
    await ui.click('the "Click Here" link');
    await ui.switchToTab('new');
    await expect.ui.url().toContain('/windows/new');
    const heading = await ui.text('the "New Window" heading');
    await ui.closeTab();
    await expect(await ui.title()).toBe(before);
    await expect.ui.page().toContainText('Opening a new window');
    await expect(heading).toBe('New Window');
  });

  await step('Each frame of a frameset says where it is', async () => {
    await ui.open('/nested_frames');
    const words: string[] = [];
    for (const inner of ['frame-left', 'frame-middle', 'frame-right']) {
      words.push(await ui.inFrame(['frame-top', inner], () => ui.text('css=body')));
    }
    words.push(await ui.inFrame('frame-bottom', () => ui.text('css=body')));
    await expect(words).toEqual(['LEFT', 'MIDDLE', 'RIGHT', 'BOTTOM']);
    // Back in the page after the frames.
    await expect(await ui.count('css=frameset')).toBeGreaterThan(0);
  });

  await step('Two of the three images are broken', async () => {
    await ui.open('/broken_images');
    const broken = await ui.page().evaluate(() =>
      Array.from(document.querySelectorAll('#content img')).filter((i) => !(i as HTMLImageElement).naturalWidth).length);
    await expect(broken).toBe(2);
  });

  await step('Answer a prompt from code and check what the page did with it', async () => {
    await ui.open('/javascript_alerts');
    await ui.acceptNextDialog('typed in a prompt');
    await ui.click('the "Click for JS Prompt" button', { expect: { text: 'You entered: typed in a prompt' } });
    await ui.perform('Dismiss the next confirm dialog');
    await ui.click('the "Click for JS Confirm" button', { expect: { text: 'You clicked: Cancel' } });
  });
});
