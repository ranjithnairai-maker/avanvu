import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useCallback, useEffect, useRef, useState } from 'react';
import { dictationAvailable } from '@avanvu/core';

const LOCALE = 'en-US';

/**
 * Optional dictation (SPEC §4.4). The microphone is offered only when on-device recognition is available for this
 * device and locale; audio then never leaves the phone. The recognised text goes into the composer for editing and
 * is sent through the same endpoint as typed text. Recognised text is never logged.
 */
export function useDictation(onText: (text: string) => void) {
  const [available, setAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  const cb = useRef(onText);
  cb.current = onText;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const recognitionAvailable = ExpoSpeechRecognitionModule.isRecognitionAvailable();
        const supportsOnDevice = ExpoSpeechRecognitionModule.supportsOnDeviceRecognition();
        const { installedLocales } = await ExpoSpeechRecognitionModule.getSupportedLocales({});
        const localeInstalledOnDevice = installedLocales.some(
          (l) => l.replace('_', '-').toLowerCase() === LOCALE.toLowerCase(),
        );
        if (alive)
          setAvailable(
            dictationAvailable({ recognitionAvailable, supportsOnDevice, localeInstalledOnDevice }),
          );
      } catch {
        if (alive) setAvailable(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useSpeechRecognitionEvent('start', () => setListening(true));
  useSpeechRecognitionEvent('end', () => setListening(false));
  useSpeechRecognitionEvent('error', () => setListening(false));
  useSpeechRecognitionEvent('result', (e) => {
    const best = e.results[0]?.transcript;
    if (best) cb.current(best);
  });

  const start = useCallback(async () => {
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) return;
    ExpoSpeechRecognitionModule.start({
      lang: LOCALE,
      interimResults: true,
      requiresOnDeviceRecognition: true,
    });
  }, []);
  const stop = useCallback(() => ExpoSpeechRecognitionModule.stop(), []);
  return { available, listening, start, stop };
}
