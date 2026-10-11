import { pcmToWav } from '@avanvu/core';

const SAMPLE_RATE = 22_050;

/**
 * Builds a fictional, speech-shaped test file for the playback spike (SPEC §15 M1 spike b): short tone
 * bursts that stand in for speech, separated by silence, so seeking, pauses and lock-screen position
 * are easy to hear. Contains no athlete data.
 */
export function buildSpikeWav(totalSeconds = 300): Uint8Array {
  const samples = new Int16Array(totalSeconds * SAMPLE_RATE);
  const burst = 3 * SAMPLE_RATE;
  const period = 8 * SAMPLE_RATE; // 3 s tone, 5 s silence
  for (let i = 0; i < samples.length; i++) {
    const inPeriod = i % period;
    if (inPeriod >= burst) continue;
    const bar = Math.floor(i / period) % 4; // pitch changes each burst so progress is audible
    const freq = [196, 220, 247, 262][bar] ?? 220;
    const env = Math.min(1, inPeriod / 2000, (burst - inPeriod) / 2000);
    samples[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * 6000 * env);
  }
  return pcmToWav(samples, SAMPLE_RATE);
}
