import { describe, expect, it } from '../support/testkit.js';
import { journeyBaseUrl } from '../../src/recorder/recorder.js';

describe('recorded journeys keep the site they were recorded on', () => {
  it('writes the recording origin when the project has no baseUrl', () => {
    expect(journeyBaseUrl('https://app.example.test')).toBe('https://app.example.test');
  });
  it('writes it when the project points somewhere else', () => {
    expect(journeyBaseUrl('https://app.example.test', 'https://staging.example.test/')).toBe('https://app.example.test');
  });
  it('leaves it out when the project baseUrl is the same origin, so environments can switch', () => {
    expect(journeyBaseUrl('https://app.example.test', 'https://app.example.test/web/')).toBeUndefined();
  });
  it('writes it when the project baseUrl is not a valid URL', () => {
    expect(journeyBaseUrl('https://app.example.test', 'not a url')).toBe('https://app.example.test');
  });
});
